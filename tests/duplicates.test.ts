import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import fc from "fast-check";
import {
  duplicateMovies,
  duplicateMetadata,
  parseDuplicateMovie,
  posterDhash,
  posterDistance,
} from "../src/server/duplicates.ts";
import { resetMetaCache } from "../src/server/providers.ts";
import { AppError } from "../src/server/http.ts";
import { startFixture, sendJson, sendBytes, type Fixture } from "./fixture.ts";

const id = (n: number) =>
  `abcdefab-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sourceId = id(1);
const candidateId = id(2);
const performerId = id(100);
const hash = "abcdef0123456789";
let fixture: Fixture;
let source: Record<string, unknown>;
let candidates: unknown[];
let metadataFail = false;
let malformed = false;
const realFetch = globalThis.fetch;
let next: string | null = null;
const images = new Map<string, Buffer>();

function row(n: number): Record<string, unknown> {
  return {
    id: id(n),
    title: n === 1 ? "Originaltitel" : "Translated release",
    type: "Movie",
    date: "2024-06-01",
    duration: 1000,
    site: { name: `Distributor ${n}`, uuid: id(150 + n) },
    performers: [
      {
        id: performerId,
        name: "Synthetic performer",
        parent: { id: performerId, _id: 7, name: "Synthetic performer" },
      },
    ],
    tags: [{ id: 1, uuid: id(200), name: "Synthetic tag" }],
    posters: { full: "https://cdn.theporndb.net/zero.png" },
    hashes: [],
  };
}

function pattern(bits: number): Buffer {
  const data = Buffer.alloc(72);
  for (let y = 0; y < 8; y++) {
    data[y * 9] = 128;
    for (let x = 0; x < 8; x++)
      data[y * 9 + x + 1] = data[y * 9 + x]! + (y * 8 + x < bits ? -10 : 10);
  }
  return data;
}

before(async () => {
  process.env.TPDB_API_TOKEN = randomBytes(24).toString("hex");
  process.env.VELVARR_SECRET_KEY = randomBytes(32).toString("hex");
  fixture = await startFixture((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.endsWith(".png")) {
      assert.equal(req.headers.authorization, undefined);
      if (url.pathname === "/redirect.png") {
        res.writeHead(302, { location: `${fixture.origin}/zero.png` });
        res.end();
        return;
      }
      const image = images.get(url.pathname);
      return image
        ? sendBytes(res, 200, image, "image/png")
        : sendJson(res, 503, {});
    }
    assert.equal(
      req.headers.authorization,
      `Bearer ${process.env.TPDB_API_TOKEN}`,
    );
    if (url.pathname === `/movies/${sourceId}`)
      return sendJson(res, 200, { data: source });
    if (url.pathname === "/movies") {
      if (metadataFail && url.searchParams.has("performer_id"))
        return sendJson(res, 503, {});
      return sendJson(
        res,
        200,
        malformed ? { data: {} } : { data: candidates, links: { next } },
      );
    }
    sendJson(res, 404, {});
  });
  process.env.TPDB_BASE_URL = fixture.origin;
  for (const [name, bits] of [
    ["zero", 0],
    ["ten", 10],
    ["eleven", 11],
    ["opposite", 64],
  ] as const) {
    images.set(
      `/${name}.png`,
      await sharp(pattern(bits), { raw: { width: 9, height: 8, channels: 1 } })
        .png()
        .toBuffer(),
    );
  }
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return realFetch(
      url.origin === "https://cdn.theporndb.net"
        ? `${fixture.origin}${url.pathname}`
        : input,
      init,
    );
  };
  images.set("/broken.png", Buffer.from("not an image"));
});
after(async () => {
  globalThis.fetch = realFetch;
  await fixture.close();
});
beforeEach(() => {
  resetMetaCache();
  source = row(1);
  candidates = [row(2)];
  metadataFail = false;
  malformed = false;
  next = null;
  fixture.log.length = 0;
});

test("translated releases match without equal title or studio and preserve both rules", async () => {
  source.hashes = [{ type: "PHASH", hash }];
  candidates = [
    { ...row(2), hashes: [{ type: "PHASH", hash: hash.toUpperCase() }] },
    row(1),
    row(2),
  ];
  const result = await duplicateMovies(sourceId, []);
  assert.deepEqual(
    result.matches.map((m) => m.reference.id),
    [candidateId],
  );
  assert.deepEqual(result.matches[0]!.rules, ["hash", "metadata"]);
  assert.equal(result.matches[0]!.evidence.posterDistance, 0);
  assert.equal(result.matches[0]!.evidence.tagOverlap, 1);
  assert.deepEqual(result.errors, []);
  const query = new URL(
    fixture.log.find((r) => r.url.includes("performer_id"))!.url,
    fixture.origin,
  );
  assert.equal(query.searchParams.get("performer_id"), "7");
  assert.equal(query.searchParams.get("year"), "2024");
});

test("metadata gates have inclusive tag, duration, and poster boundaries", async () => {
  const a = parseDuplicateMovie(source).detail;
  const b = parseDuplicateMovie(row(2)).detail;
  b.credits.push({
    reference: { provider: "tpdb", kind: "performer", id: id(101) },
    name: "Another performer",
  });
  a.tags.push({ id: id(201), name: "Extra" });
  b.tags.push({ id: id(202), name: "Different" });
  b.durationSeconds = 900;
  assert.equal(duplicateMetadata(a, b)?.tagOverlap, 0.5);
  b.durationSeconds = 899;
  assert.equal(duplicateMetadata(a, b), undefined);
  b.durationSeconds = undefined;
  assert.equal(duplicateMetadata(a, b)?.sharedPerformerIds.length, 1);
  for (const [file, matches] of [
    ["ten", 1],
    ["eleven", 0],
    ["opposite", 0],
  ] as const) {
    resetMetaCache();
    candidates = [
      { ...row(2), posters: { full: `https://cdn.theporndb.net/${file}.png` } },
    ];
    assert.equal(
      (await duplicateMovies(sourceId, [])).matches.length,
      matches,
      file,
    );
  }
});

test("hash evidence is same-type only and survives absent metadata", async () => {
  source = {
    ...row(1),
    performers: [],
    date: null,
    hashes: [{ type: "OSHASH", hash }],
  };
  candidates = [
    { ...row(2), performers: [], hashes: [{ type: "PHASH", hash }] },
  ];
  assert.deepEqual((await duplicateMovies(sourceId, [])).matches, []);
  resetMetaCache();
  candidates = [
    {
      ...row(2),
      performers: [],
      hashes: [{ type: "OSHASH", hash: hash.toUpperCase() }],
    },
  ];
  const result = await duplicateMovies(sourceId, []);
  assert.deepEqual(result.matches[0]!.rules, ["hash"]);
  assert.equal(result.incomplete.length, 2);
});

test("distinct hash cap, bounded pagination and partial failure remain visible", async () => {
  const hashes = Array.from({ length: 6 }, (_, n) => ({
    type: "OSHASH",
    hash: n.toString(16).padStart(16, "0"),
  }));
  source.hashes = [hashes[0], hashes[0], ...hashes.slice(1)];
  candidates = [{ ...row(2), hashes: [hashes[0]] }];
  metadataFail = true;
  next = "https://api.theporndb.net/movies?page=2";
  const result = await duplicateMovies(sourceId, []);
  assert.ok(result.matches[0]!.rules.includes("hash"));
  assert.ok(result.errors.some((e) => e.provider === "tpdb"));
  assert.ok(result.incomplete.includes("checked 5 of 6 hashes"));
  assert.ok(result.incomplete.some((s) => s.includes("first 100")));
  assert.equal(fixture.log.filter((r) => r.url.includes("hash=")).length, 5);
  assert.ok(!fixture.log.some((r) => r.url.includes("page=2")));
});

test("poster cap is deterministic and hidden records leave no evidence or errors", async () => {
  candidates = Array.from({ length: 12 }, (_, n) => row(n + 2)).reverse();
  const result = await duplicateMovies(sourceId, []);
  assert.equal(result.matches.length, 10);
  assert.deepEqual(
    result.matches.map((m) => m.reference.id),
    Array.from({ length: 10 }, (_, n) => id(n + 2)),
  );
  assert.ok(
    result.incomplete.includes("posters compared for 10 of 12 candidates"),
  );
  resetMetaCache();
  candidates = [
    {
      ...row(2),
      hashes: [{ type: "OSHASH", hash: "invalid" }],
      posters: { full: "https://cdn.theporndb.net/missing.png" },
    },
  ];
  const hidden = await duplicateMovies(sourceId, [
    { name: "Synthetic tag", tpdb: id(200) },
  ]);
  assert.deepEqual(hidden.matches, []);
  assert.deepEqual(hidden.errors, []);
  assert.ok(!JSON.stringify(hidden).includes(candidateId));
});

test("unavailable, invalid and redirected posters never become metadata matches", async () => {
  for (const name of ["missing", "broken", "redirect"]) {
    resetMetaCache();
    candidates = [
      { ...row(2), posters: { full: `https://cdn.theporndb.net/${name}.png` } },
    ];
    const result = await duplicateMovies(sourceId, []);
    assert.deepEqual(result.matches, []);
    assert.ok(
      result.errors.some((e) => e.message.includes(candidateId)),
      name,
    );
  }
  resetMetaCache();
  source.posters = {};
  candidates = [row(2)];
  const result = await duplicateMovies(sourceId, []);
  assert.deepEqual(result.matches, []);
  assert.ok(result.incomplete.some((s) => s.includes("poster unavailable")));
});

test("malformed upstream pages and records fail visibly, missing movie returns 404", async () => {
  malformed = true;
  const invalidPage = await duplicateMovies(sourceId, []);
  assert.equal(invalidPage.errors[0]!.code, "upstream_bad_response");
  resetMetaCache();
  malformed = false;
  candidates = [{ id: "invalid", title: "Invalid" }, row(2)];
  const partial = await duplicateMovies(sourceId, []);
  assert.equal(partial.matches[0]!.reference.id, candidateId);
  assert.equal(partial.errors[0]!.code, "upstream_bad_response");
  await assert.rejects(
    duplicateMovies(id(999), []),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
});

test("poster dHash survives resizes and re-encoding but distinguishes an opposite image", async () => {
  const image = images.get("/zero.png")!;
  const copy = await sharp(image)
    .resize(180, 160)
    .jpeg({ quality: 90 })
    .toBuffer();
  const a = await posterDhash(image);
  assert.ok(posterDistance(a, await posterDhash(copy)) <= 10);
  assert.equal(
    posterDistance(a, await posterDhash(images.get("/opposite.png")!)),
    64,
  );
});

test("metadata symmetry and duplicate hash normalization hold for generated inputs", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 10 }),
      fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 10 }),
      fc.integer({ min: 1, max: 10000 }),
      (left, right, duration) => {
        const a = parseDuplicateMovie(row(1)).detail;
        const b = parseDuplicateMovie(row(2)).detail;
        a.tags = left.map((n) => ({ id: id(n + 200), name: "Tag" }));
        b.tags = right.map((n) => ({ id: id(n + 200), name: "Tag" }));
        b.durationSeconds = duration;
        assert.deepEqual(duplicateMetadata(a, b), duplicateMetadata(b, a));
        assert.equal(duplicateMetadata(a, a), undefined);
      },
    ),
  );
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (bits) => {
      const hash = bits.toString(16).padStart(16, "0");
      const parsed = parseDuplicateMovie({
        ...row(1),
        hashes: [
          { type: "OSHASH", hash },
          { type: "OSHASH", hash: hash.toUpperCase() },
          { type: "PHASH", hash },
        ],
      });
      assert.deepEqual(parsed.hashes, [
        { type: "OSHASH", hash },
        { type: "PHASH", hash },
      ]);
    }),
  );
});

test("repeated candidates preserve later hash evidence", async () => {
  source.hashes = [{ type: "OSHASH", hash }];
  candidates = [
    { ...row(2), date: null },
    { ...row(2), date: null, hashes: [{ type: "OSHASH", hash }] },
  ];
  const result = await duplicateMovies(sourceId, []);
  assert.deepEqual(
    result.matches.map((m) => m.rules),
    [["hash"]],
  );
});

test("an unavailable source poster does not claim ten completed comparisons", async () => {
  source.posters = {};
  candidates = Array.from({ length: 12 }, (_, n) => row(n + 2));
  const result = await duplicateMovies(sourceId, []);
  assert.ok(
    result.incomplete.includes("posters compared for 0 of 12 candidates"),
  );
});

test("invalid outside hashes cannot become identity evidence", () => {
  fc.assert(
    fc.property(
      fc.string().filter((value) => !/^[a-f0-9]{16}$/i.test(value)),
      (value) => {
        assert.throws(
          () =>
            parseDuplicateMovie({
              ...row(1),
              hashes: [{ type: "OSHASH", hash: value }],
            }),
          (error: unknown) =>
            error instanceof AppError && error.code === "upstream_bad_response",
        );
      },
    ),
  );
});

test("TPDB duplicate posters cannot fetch StashDB or arbitrary ports", async () => {
  // StashDB artwork never enters the duplicate check: imageHash refuses the
  // host, so the poster surfaces as an upstream error, not a match.
  resetMetaCache();
  candidates = [
    { ...row(2), posters: { full: "https://stashdb.org/images/fixture" } },
  ];
  const stash = await duplicateMovies(sourceId, []);
  assert.deepEqual(stash.matches, []);
  assert.ok(
    stash.errors.some((error) => error.code === "upstream_bad_response"),
  );

  // An allowlisted host on an explicit port is refused by the shared artwork
  // gate (VELV-216): the row mapper drops the poster before any fetch, so
  // the comparison notes the gap instead of reporting an upstream error.
  resetMetaCache();
  candidates = [
    { ...row(2), posters: { full: "https://cdn.theporndb.net:8443/zero.png" } },
  ];
  const ported = await duplicateMovies(sourceId, []);
  assert.deepEqual(ported.matches, []);
  assert.deepEqual(ported.errors, []);
  assert.ok(
    ported.incomplete.some((line) => line.startsWith("no poster to compare")),
  );
});
