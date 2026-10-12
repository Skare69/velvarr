// The one sort-capability table, pinned directly: which provider implements
// which order for which kind, the vocabulary the browse 400 message lists,
// the options the client offers per tab, and the direction-toggle rule. This
// suite runs inside the mutation gate's scoped command; without it the
// table's mutants survive.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSE_MIXED_SORTS,
  SORT_KEYS,
  SORT_LABELS,
  browseSortIsDirectional,
  browseSortsFor,
  sortSpec,
} from "../src/lib/sorts.ts";

test("sortSpec: the implemented spec, undefined when nobody serves it", () => {
  assert.deepEqual(sortSpec("tpdb", "movie", "relevance"), {
    key: "relevance",
    directional: false,
  });
  assert.deepEqual(sortSpec("stashdb", "scene", "date"), {
    key: "date",
    directional: true,
  });
  // TPDB relevance is the one order without a direction.
  assert.equal(sortSpec("tpdb", "scene", "relevance")?.directional, false);
  // Unsupported combos: a StashDB-only key on TPDB, a kind StashDB does not
  // have, a StashDB-only key on TPDB scenes.
  assert.equal(sortSpec("tpdb", "movie", "title"), undefined);
  assert.equal(sortSpec("stashdb", "movie", "title"), undefined);
  assert.equal(sortSpec("tpdb", "scene", "trending"), undefined);
});

test("SORT_KEYS: every implemented key once, in table order", () => {
  assert.deepEqual(SORT_KEYS, [
    "relevance",
    "recency",
    "duration",
    "title",
    "date",
    "trending",
    "popularity",
    "created",
    "updated",
  ]);
  // A duplicate (duration is implemented by both providers) would shift a
  // position above, so the exact sequence also proves the dedupe that keeps
  // the browse 400 message reading each key once.
});

test("BROWSE_MIXED_SORTS: the merged All page offers exactly recency and duration", () => {
  assert.deepEqual(BROWSE_MIXED_SORTS, ["recency", "duration"]);
});

test("browseSortsFor: the tab's own source on typed tabs, the merge set on All", () => {
  assert.deepEqual(browseSortsFor("all"), ["recency", "duration"]);
  assert.deepEqual(browseSortsFor("movie"), [
    "relevance",
    "recency",
    "duration",
  ]);
  assert.deepEqual(browseSortsFor("scene"), [
    "title",
    "date",
    "duration",
    "trending",
    "popularity",
    "created",
    "updated",
  ]);
});

test("browseSortIsDirectional: the tab's side decides; All directions ride both sides", () => {
  // TPDB relevance takes no direction; its recency does.
  assert.equal(browseSortIsDirectional("movie", "relevance"), false);
  assert.equal(browseSortIsDirectional("movie", "recency"), true);
  // StashDB's date carries the recency order and takes a direction.
  assert.equal(browseSortIsDirectional("scene", "date"), true);
  // A mixed All sort takes a direction on both sources.
  assert.equal(browseSortIsDirectional("all", "recency"), true);
  assert.equal(browseSortIsDirectional("all", "duration"), true);
  // A sort the tab never offers takes no direction anywhere.
  assert.equal(browseSortIsDirectional("all", "title"), false);
  assert.equal(browseSortIsDirectional("movie", "trending"), false);
});

test("SORT_LABELS: the client-facing strings; recency is never called trending", () => {
  assert.deepEqual(SORT_LABELS, {
    relevance: "Best match",
    recency: "Release recency",
    duration: "Duration",
    title: "Title",
    date: "Release date",
    trending: "Trending (StashDB ordering)",
    popularity: "Popularity (StashDB ordering)",
    created: "Recently added (StashDB)",
    updated: "Last updated (StashDB)",
  });
});
