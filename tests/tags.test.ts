// Pure merge for the performer page's tags overview: two provider sides come
// back as per-side count lists and must merge by the shared normalized-name
// tag pairing (a tag is its name — never applied to performers or studios).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogReference } from "../src/lib/contracts.ts";
import { mergeTagCounts, performerTagJump } from "../src/lib/contracts.ts";

test("mergeTagCounts merges by normalized label, sums counts, orders count desc then name", () => {
  const merged = mergeTagCounts([
    [
      { name: "Romance", count: 3 },
      { name: "Comedy", count: 1 },
    ],
    [
      { name: "romance", count: 2 },
      { name: "Dark", count: 4 },
    ],
  ]);
  assert.deepEqual(merged, [
    { name: "Romance", count: 5 },
    { name: "Dark", count: 4 },
    { name: "Comedy", count: 1 },
  ]);
});

test("mergeTagCounts keeps the first-seen spelling and folds separator differences", () => {
  const merged = mergeTagCounts([
    [{ name: "A B", count: 1 }],
    [{ name: "ab", count: 2 }],
  ]);
  assert.deepEqual(merged, [{ name: "A B", count: 3 }]);
});

test("mergeTagCounts breaks count ties by name ascending", () => {
  const merged = mergeTagCounts([
    [
      { name: "Zebra", count: 2 },
      { name: "Alpha", count: 2 },
    ],
  ]);
  assert.deepEqual(
    merged.map((t) => t.name),
    ["Alpha", "Zebra"],
  );
});

const TAG_ROMANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STASH_TAG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("mergeTagCounts of nothing is empty", () => {
  assert.deepEqual(mergeTagCounts([]), []);
});

test("mergeTagCounts keeps both provider ids when a label spans the two sides", () => {
  const merged = mergeTagCounts([
    [{ name: "Romance", count: 2, tpdb: TAG_ROMANCE }],
    [{ name: "Romance", count: 1, stashdb: STASH_TAG_ID }],
  ]);
  assert.deepEqual(merged, [
    {
      name: "Romance",
      count: 3,
      tpdb: TAG_ROMANCE,
      stashdb: STASH_TAG_ID,
    },
  ]);
});

// --- performerTagJump: where a tag chip's browse jump lands ---

const PAGE_TPDB: CatalogReference = {
  provider: "tpdb",
  kind: "performer",
  id: "11111111-1111-4111-8111-111111111111",
};
const LINKED_STASHDB: CatalogReference = {
  provider: "stashdb",
  kind: "performer",
  id: "22222222-2222-4222-8222-222222222222",
};

test("performerTagJump unions with the page performer for an own-side tag", () => {
  assert.deepEqual(
    performerTagJump(PAGE_TPDB, LINKED_STASHDB, {
      name: "Romance",
      tpdb: TAG_ROMANCE,
    }),
    {
      param: "performerTpdb",
      provider: "tpdb",
      id: PAGE_TPDB.id,
      counterpart: {
        param: "performerStashdb",
        id: LINKED_STASHDB.id,
      },
    },
  );
});

test("performerTagJump unions when the label spans both sides", () => {
  assert.deepEqual(
    performerTagJump(PAGE_TPDB, LINKED_STASHDB, {
      name: "Romance",
      tpdb: TAG_ROMANCE,
      stashdb: STASH_TAG_ID,
    }),
    {
      param: "performerTpdb",
      provider: "tpdb",
      id: PAGE_TPDB.id,
      counterpart: {
        param: "performerStashdb",
        id: LINKED_STASHDB.id,
      },
    },
  );
});

test("performerTagJump unions an other-side tag with the page performer", () => {
  // The reported card: a StashDB scene tag counted on her TPDB page landed
  // on the movie filmography, which provably runs no scene side. With a
  // linked counterpart the jump rides both ids and lands on browse All.
  assert.deepEqual(
    performerTagJump(PAGE_TPDB, LINKED_STASHDB, {
      name: "Anal Fingering During Sex",
      stashdb: STASH_TAG_ID,
    }),
    {
      param: "performerTpdb",
      provider: "tpdb",
      id: PAGE_TPDB.id,
      counterpart: {
        param: "performerStashdb",
        id: LINKED_STASHDB.id,
      },
    },
  );
});

test("performerTagJump keeps the single-side jump for an own-side tag without a linked counterpart", () => {
  assert.deepEqual(
    performerTagJump(PAGE_TPDB, undefined, {
      name: "Romance",
      tpdb: TAG_ROMANCE,
    }),
    { param: "performerTpdb", provider: "tpdb", id: PAGE_TPDB.id },
  );
});

test("performerTagJump sends an other-side tag alone without a linked counterpart", () => {
  assert.deepEqual(
    performerTagJump(PAGE_TPDB, undefined, {
      name: "Anal Fingering During Sex",
      stashdb: STASH_TAG_ID,
    }),
    { param: "include", provider: "stashdb" },
  );
});

test("performerTagJump mirrors from a StashDB page to the linked TPDB performer", () => {
  assert.deepEqual(
    performerTagJump(LINKED_STASHDB, PAGE_TPDB, {
      name: "Romance",
      tpdb: TAG_ROMANCE,
    }),
    {
      param: "performerStashdb",
      provider: "stashdb",
      id: LINKED_STASHDB.id,
      counterpart: {
        param: "performerTpdb",
        id: PAGE_TPDB.id,
      },
    },
  );
});
