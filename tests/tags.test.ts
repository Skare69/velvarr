// Pure merge for the performer page's tags overview: two provider sides come
// back as per-side count lists and must merge by the shared normalized-name
// tag pairing (a tag is its name — never applied to performers or studios).

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeTagCounts } from "../src/lib/contracts.ts";

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

test("mergeTagCounts of nothing is empty", () => {
  assert.deepEqual(mergeTagCounts([]), []);
});
