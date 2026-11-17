import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  tpdbMediaDetail,
  tpdbPerformerDetail,
} from "../src/server/provider-rows.ts";

const THUMB = "https://thumb.theporndb.net";
const CDN = "https://cdn.theporndb.net";
const GAMMA = "https://images02-openlife.gammacdn.com";

const PERFORMER_ID = "42386b25-d0f1-41dc-a53f-a132b2425acf";
const ALIAS_ID = "6263c88d-4bb5-4b41-b4a1-6e31a90308bd";
const MOVIE_ID = "71287a36-7079-44b6-938c-8096e4a681a9";

function performerRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: PERFORMER_ID,
    name: "Fixture Performer",
    ...over,
  };
}

function movieRow(performers: unknown): Record<string, unknown> {
  return {
    id: MOVIE_ID,
    title: "Fixture Movie",
    posters: { full: `${CDN}/m/full.jpg` },
    performers,
  };
}

test("the largest servable poster wins over the image chain", () => {
  const detail = tpdbPerformerDetail(
    performerRow({
      image: `${CDN}/a/image.jpg`,
      thumbnail: `${THUMB}/a/thumb.jpg`,
      posters: [
        { url: `${THUMB}/a/p1.jpg`, size: 1024 },
        { url: `${THUMB}/a/p2.jpg`, size: 4_096_000 },
        { url: `${THUMB}/a/p3.jpg`, size: 512_000 },
      ],
    }),
  );
  assert.equal(detail?.imageUrl, `${THUMB}/a/p2.jpg`);
});

test("invalid size metadata never replaces the fallback image", () => {
  const detail = tpdbPerformerDetail(
    performerRow({
      image: `${CDN}/a/image.jpg`,
      posters: [
        { url: `${THUMB}/a/zero.jpg`, size: 0 },
        { url: `${THUMB}/a/negative.jpg`, size: -12 },
        { url: `${THUMB}/a/string.jpg`, size: "1024000" },
        { url: `${THUMB}/a/nan.jpg`, size: Number.NaN },
        { url: `${THUMB}/a/infinity.jpg`, size: Number.POSITIVE_INFINITY },
        {
          url: `${THUMB}/a/negative-infinity.jpg`,
          size: Number.NEGATIVE_INFINITY,
        },
        { url: `${THUMB}/a/null.jpg`, size: null },
        { url: `${THUMB}/a/boolean.jpg`, size: true },
        { url: `${THUMB}/a/missing.jpg` },
      ],
    }),
  );
  assert.equal(detail?.imageUrl, `${CDN}/a/image.jpg`);
});

test("finite positive fractions beat malformed entries and invalid metadata", () => {
  const detail = tpdbPerformerDetail(
    performerRow({
      posters: [
        null,
        undefined,
        "junk",
        42,
        false,
        { url: `${THUMB}/a/string.jpg`, size: "1024000" },
        { url: `${THUMB}/a/infinity.jpg`, size: Number.POSITIVE_INFINITY },
        { url: `${THUMB}/a/nan.jpg`, size: Number.NaN },
        { url: `${THUMB}/a/negative.jpg`, size: -12 },
        { url: `${THUMB}/a/smaller.jpg`, size: 0.125 },
        { url: `${THUMB}/a/good.jpg`, size: 0.25 },
        { url: `${THUMB}/a/zero.jpg`, size: 0 },
        { url: `${THUMB}/a/missing.jpg` },
      ],
    }),
  );
  assert.equal(detail?.imageUrl, `${THUMB}/a/good.jpg`);
});

test("a poster whose URL fails the gate never wins", () => {
  const detail = tpdbPerformerDetail(
    performerRow({
      posters: [
        { url: `${GAMMA}/big.jpg`, size: 9_999_999 },
        { url: `${THUMB}/a/query.jpg?size=full`, size: 9_999_999 },
        { url: `http://thumb.theporndb.net/a/plain.jpg`, size: 9_999_999 },
        { url: `${THUMB}/a/small.jpg`, size: 700 },
      ],
    }),
  );
  assert.equal(detail?.imageUrl, `${THUMB}/a/small.jpg`);
});

test("equal sizes keep the earliest entry despite the order field", () => {
  const detail = tpdbPerformerDetail(
    performerRow({
      posters: [
        { url: `${THUMB}/a/first.jpg`, size: 2048, order: 99 },
        { url: `${THUMB}/a/second.jpg`, size: 2048, order: -99 },
      ],
    }),
  );
  assert.equal(detail?.imageUrl, `${THUMB}/a/first.jpg`);
});

test("no usable poster keeps the image, thumbnail, face fallback", () => {
  const image = `${CDN}/a/image.jpg`;
  const thumbnail = `${THUMB}/a/thumb.jpg`;
  const face = `${THUMB}/a/face.jpg`;
  const cases: [Record<string, unknown>, string | undefined][] = [
    [{ image, thumbnail, face, posters: null }, image],
    [{ thumbnail, face }, thumbnail],
    [{ image: `${GAMMA}/raw.jpg`, thumbnail, face }, thumbnail],
    [{ face, posters: [] }, face],
    [{ face, posters: { full: `${CDN}/ignored.jpg` } }, face],
    [{ posters: "junk" }, undefined],
  ];
  for (const [row, expected] of cases) {
    assert.equal(tpdbPerformerDetail(performerRow(row))?.imageUrl, expected);
  }
});

test("credits prefer the largest servable poster and keep canonical identity", () => {
  const detail = tpdbMediaDetail(
    "movie",
    movieRow([
      {
        id: ALIAS_ID,
        name: "Credited Name",
        image: `${GAMMA}/raw.jpg`,
        parent: {
          id: PERFORMER_ID,
          name: "Canonical Name",
          image: `${CDN}/p/canon.jpg`,
          posters: [{ url: `${CDN}/p/parent.jpg`, size: 99_999_999 }],
        },
        posters: [
          { url: `${THUMB}/p/small.jpg`, size: 1024 },
          { url: `${THUMB}/p/big.jpg`, size: 4_096_000 },
        ],
      },
      {
        id: PERFORMER_ID,
        name: "Duplicate Name",
        posters: [{ url: `${CDN}/p/duplicate.jpg`, size: 99_999_999 }],
      },
    ]),
  );
  assert.equal(detail?.credits.length, 1);
  assert.deepEqual(detail?.credits[0]?.reference, {
    provider: "tpdb",
    kind: "performer",
    id: PERFORMER_ID,
  });
  assert.equal(detail?.credits[0]?.name, "Credited Name");
  assert.equal(detail?.credits[0]?.imageUrl, `${THUMB}/p/big.jpg`);
  assert.equal(JSON.stringify(detail).includes("gammacdn"), false);
});

test("credits without a usable poster keep the canonical parent image", () => {
  const detail = tpdbMediaDetail(
    "movie",
    movieRow([
      {
        id: ALIAS_ID,
        name: "Credited Name",
        parent: {
          id: PERFORMER_ID,
          name: "Canonical Name",
          image: `${CDN}/p/canon.jpg`,
          posters: [{ url: `${CDN}/p/parent.jpg`, size: 99_999_999 }],
        },
        posters: [{ url: "https://evil.example/big.jpg", size: 9_999_999 }],
      },
    ]),
  );
  assert.deepEqual(detail?.credits[0]?.reference, {
    provider: "tpdb",
    kind: "performer",
    id: PERFORMER_ID,
  });
  assert.equal(detail?.credits[0]?.imageUrl, `${CDN}/p/canon.jpg`);
});

test("credits without canonical artwork keep the row image and identity", () => {
  for (const parent of [
    undefined,
    { id: PERFORMER_ID, image: `${GAMMA}/rejected.jpg` },
  ]) {
    const detail = tpdbMediaDetail(
      "movie",
      movieRow([
        {
          id: ALIAS_ID,
          name: "Credited Name",
          image: `${CDN}/p/row.jpg`,
          parent,
          posters: [null, { url: `${THUMB}/invalid.jpg`, size: Infinity }],
        },
      ]),
    );
    assert.equal(detail?.credits.length, 1);
    assert.deepEqual(detail?.credits[0]?.reference, {
      provider: "tpdb",
      kind: "performer",
      id: parent ? PERFORMER_ID : ALIAS_ID,
    });
    assert.equal(detail?.credits[0]?.name, "Credited Name");
    assert.equal(detail?.credits[0]?.imageUrl, `${CDN}/p/row.jpg`);
  }
});

test("property: both mappers select the stable usable maximum or their fallback", () => {
  const usableUrls = [
    `${THUMB}/p/first.jpg`,
    `${CDN}/p/second.jpg`,
    `${THUMB}/p/third.jpg`,
  ];
  const entryArb = fc.oneof(
    fc.constantFrom(null, undefined, true, false, 0, 42, "junk"),
    fc.record({
      url: fc.constantFrom(
        ...usableUrls,
        `${GAMMA}/rejected.jpg`,
        `${THUMB}/query.jpg?size=full`,
        "http://thumb.theporndb.net/plain.jpg",
        undefined,
        null,
        42,
      ),
      size: fc.oneof(
        fc.constantFrom(
          undefined,
          null,
          "1024000",
          "big",
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ),
        fc.integer({ min: -5, max: 5 }),
        fc.double({ min: Number.MIN_VALUE, max: 5_000_000, noNaN: true }),
      ),
      order: fc.integer(),
    }),
  );
  fc.assert(
    fc.property(fc.array(entryArb, { maxLength: 12 }), (posters) => {
      const expected = posters
        .filter(
          (entry): entry is { url: string; size: number; order: number } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.url === "string" &&
            usableUrls.includes(entry.url) &&
            typeof entry.size === "number" &&
            Number.isFinite(entry.size) &&
            entry.size > 0,
        )
        .toSorted((a, b) => b.size - a.size)[0]?.url;
      const performer = tpdbPerformerDetail(
        performerRow({ thumbnail: `${THUMB}/chain.jpg`, posters }),
      );
      const media = tpdbMediaDetail(
        "movie",
        movieRow([
          {
            id: ALIAS_ID,
            name: "Credited Name",
            image: `${CDN}/p/row.jpg`,
            parent: {
              id: PERFORMER_ID,
              name: "Canonical Name",
              image: `${CDN}/p/canon.jpg`,
              posters: [{ url: `${CDN}/p/parent.jpg`, size: Number.MAX_VALUE }],
            },
            posters,
          },
        ]),
      );
      assert.equal(performer?.imageUrl, expected ?? `${THUMB}/chain.jpg`);
      assert.equal(media?.credits.length, 1);
      assert.deepEqual(media?.credits[0]?.reference, {
        provider: "tpdb",
        kind: "performer",
        id: PERFORMER_ID,
      });
      assert.equal(media?.credits[0]?.name, "Credited Name");
      assert.equal(
        media?.credits[0]?.imageUrl,
        expected ?? `${CDN}/p/canon.jpg`,
      );
    }),
    {
      examples: [
        [[]],
        [
          [
            null,
            "junk",
            { url: usableUrls[0], size: Infinity, order: -100 },
            { url: usableUrls[0], size: undefined, order: -100 },
            { url: `${GAMMA}/rejected.jpg`, size: 1_000_000, order: -100 },
            { url: usableUrls[1], size: 0.25, order: 99 },
            { url: usableUrls[2], size: 0.25, order: -99 },
          ],
        ],
      ],
    },
  );
});
