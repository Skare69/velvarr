// Unit tests for mergePageItems (browse endless scroll): append order,
// dedupe across and within pages, input immutability.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergePageItems } from "../src/lib/browse-items.ts";
import type { CatalogDetail } from "../src/lib/contracts.ts";

const item = (provider: string, kind: string, id: string): CatalogDetail =>
  ({ reference: { provider, kind, id } }) as unknown as CatalogDetail;

test("mergePageItems appends new items in incoming order", () => {
  const page1 = [item("tpdb", "movie", "1"), item("tpdb", "movie", "2")];
  const page2 = [item("stashdb", "scene", "9"), item("tpdb", "movie", "3")];
  assert.deepEqual(mergePageItems(page1, page2), [...page1, ...page2]);
});

test("mergePageItems drops items already on earlier pages", () => {
  const page1 = [item("tpdb", "movie", "1"), item("stashdb", "scene", "2")];
  const page2 = [
    item("tpdb", "movie", "1"), // provider reshuffled it forward
    item("tpdb", "movie", "5"),
  ];
  const merged = mergePageItems(page1, page2);
  assert.deepEqual(
    merged.map((it) => it.reference.id),
    ["1", "2", "5"],
  );
});

test("mergePageItems drops duplicates within the incoming page itself", () => {
  const page1: CatalogDetail[] = [];
  const page2 = [item("tpdb", "movie", "7"), item("tpdb", "movie", "7")];
  assert.equal(mergePageItems(page1, page2).length, 1);
});

test("mergePageItems does not mutate its inputs", () => {
  const page1 = [item("tpdb", "movie", "1")];
  const page2 = [item("tpdb", "movie", "1"), item("tpdb", "movie", "2")];
  mergePageItems(page1, page2);
  assert.equal(page1.length, 1);
  assert.equal(page2.length, 2);
});
