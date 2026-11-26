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
// The metadata listing page that answers 503; 0 means none.
let metadataFailPage = 0;
let malformed = false;
const realFetch = globalThis.fetch;
// An endless listing: every page repeats `candidates` with a next link.
let endless = false;
// TPDB's full movie rows make a 100-row page pass the client's 2 MiB bound;
// the fixture answers any page above 24 rows with an oversized body.
const oversized = { data: [], padding: "x".repeat(2 * 1024 * 1024) };
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
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "25");
      if (perPage > 24) return sendJson(res, 200, oversized);
      if (page === metadataFailPage && url.searchParams.has("performer_id"))
        return sendJson(res, 503, {});
      if (malformed) return sendJson(res, 200, { data: {} });
      if (endless)
        return sendJson(res, 200, {
          data: candidates,
          links: { next: `https://api.theporndb.net/movies?page=${page + 1}` },
        });
      const end = page * perPage;
      return sendJson(res, 200, {
        data: candidates.slice(end - perPage, end),
        links: {
          next:
            end < candidates.length
              ? `https://api.theporndb.net/movies?page=${page + 1}`
              : null,
        },
      });
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
  metadataFailPage = 0;
  malformed = false;
  endless = false;
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
  metadataFailPage = 1;
  endless = true;
  const result = await duplicateMovies(sourceId, []);
  assert.ok(result.matches[0]!.rules.includes("hash"));
  assert.ok(result.errors.some((e) => e.provider === "tpdb"));
  assert.ok(result.incomplete.includes("checked 5 of 6 hashes"));
  // An endless listing of one-row pages stops at the five-page cap and says
  // how many candidates it read.
  assert.ok(
    result.incomplete.includes(
      "OSHASH candidates: only the first 5 candidates were checked",
    ),
  );
  const hashReads = fixture.log.filter((r) => r.url.includes("hash="));
  assert.equal(hashReads.filter((r) => r.url.includes("page=1&")).length, 5);
  assert.ok(hashReads.some((r) => r.url.includes("page=5&")));
  assert.ok(!hashReads.some((r) => r.url.includes("page=6&")));
});

test("candidates are read in 24-row pages, so a long listing never trips the 2 MiB bound", async () => {
  source.hashes = [{ type: "PHASH", hash }];
  candidates = Array.from({ length: 60 }, (_, n) => ({
    ...row(n + 2),
    hashes: [{ type: "PHASH", hash }],
  }));
  const result = await duplicateMovies(sourceId, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.matches.map((m) => m.reference.id).sort(),
    Array.from({ length: 60 }, (_, n) => id(n + 2)).sort(),
  );
  assert.ok(!result.incomplete.some((s) => s.includes("were checked")));
  const reads = fixture.log.filter((r) => r.url.includes("/movies?"));
  assert.ok(reads.every((r) => r.url.includes("per_page=24")));
  assert.ok(reads.some((r) => r.url.includes("page=3&")));
  assert.ok(!reads.some((r) => r.url.includes("page=4&")));
});

test("a failed later page keeps the rows already read and names the page", async () => {
  candidates = Array.from({ length: 30 }, (_, n) => row(n + 2));
  metadataFailPage = 2;
  const result = await duplicateMovies(sourceId, []);
  assert.ok(
    result.errors.some(
      (e) =>
        e.provider === "tpdb" &&
        e.message.startsWith("Metadata candidates: page 2: "),
    ),
  );
  assert.ok(
    result.incomplete.includes(
      "Metadata candidates: only the first 24 candidates were checked",
    ),
  );
  // The 24 page-one rows reached the poster comparison.
  assert.ok(
    result.incomplete.includes("posters compared for 10 of 24 candidates"),
  );
  assert.equal(result.matches.length, 10);
});

test("a listing longer than the 100-row budget keeps the budget message", async () => {
  candidates = Array.from({ length: 130 }, (_, n) => row(n + 2));
  const result = await duplicateMovies(sourceId, []);
  assert.ok(
    result.incomplete.includes(
      "Metadata candidates: only the first 100 candidates were checked",
    ),
  );
  assert.ok(
    result.incomplete.includes("posters compared for 10 of 100 candidates"),
  );
});

test("a page of 200,000 tiny rows inside the byte bound stays within the budget", async () => {
  // About 600 KB: below the 2 MiB bound, but too many rows to spread as
  // call arguments.
  candidates = Array.from({ length: 200_000 }, () => ({}));
  endless = true;
  const result = await duplicateMovies(sourceId, []);
  assert.ok(
    result.incomplete.includes(
      "Metadata candidates: only the first 100 candidates were checked",
    ),
  );
  assert.ok(result.errors.every((e) => e.code === "upstream_bad_response"));
  assert.ok(!fixture.log.some((r) => r.url.includes("page=2&")));
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
