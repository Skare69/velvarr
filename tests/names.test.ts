import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterName,
  seedDetail,
  seedFacetTile,
  seedName,
  seedPerformerPick,
} from "../src/lib/names.ts";

// The name cache is module-global, so every test uses fresh keys and never
// reads another test's leftovers.

test("filterName returns the seeded name for the exact provider reference", () => {
  seedName({ provider: "tpdb", kind: "movie", id: "n1" }, "A Title");
  seedName({ provider: "stashdb", kind: "movie", id: "n1" }, "Other");
  seedName({ provider: "tpdb", kind: "scene", id: "n1" }, "Scene");
  assert.equal(filterName("tpdb", "movie", "n1"), "A Title");
  assert.equal(filterName("stashdb", "movie", "n1"), "Other");
  assert.equal(filterName("tpdb", "scene", "n1"), "Scene");
});

test("an unseeded id labels as a truncated id, never a fake name", () => {
  assert.equal(filterName("tpdb", "movie", "abcdefghXYZ"), "#abcdefgh…");
  assert.equal(filterName("tpdb", "movie", "short"), "#short…");
});

test("seedPerformerPick seeds the performer name on its own side", () => {
  seedPerformerPick("stashdb", { reference: { id: "p1" }, title: "Jane Doe" });
  assert.equal(filterName("stashdb", "performer", "p1"), "Jane Doe");
});

test("seedDetail seeds the studio name, tags only for tag browsing, and credits", () => {
  seedDetail(
    {
      reference: { provider: "tpdb" },
      studio: { name: "Studio X" },
      tags: [{ id: "t1", name: "Tag One" }],
      credits: [
        {
          reference: { provider: "tpdb", kind: "performer", id: "c1" },
          name: "Alice",
        },
      ],
    },
    { provider: "tpdb", id: "s1" },
    true,
  );
  assert.equal(filterName("tpdb", "studio", "s1"), "Studio X");
  assert.equal(filterName("tpdb", "tag", "t1"), "Tag One");
  assert.equal(filterName("tpdb", "performer", "c1"), "Alice");
});

test("seedDetail keeps honest labels when facts are missing", () => {
  seedDetail(
    {
      reference: { provider: "stashdb" },
      studio: null,
      tags: [{ id: "t2", name: "Unbrowsed Tag" }],
      credits: [],
    },
    { provider: "stashdb", id: "s2" },
    false,
  );
  // An unnamed studio seeds its id as the label.
  assert.equal(filterName("stashdb", "studio", "s2"), "s2");
  // No tag browsing: the tag stays unseeded and labels as an id.
  assert.equal(filterName("stashdb", "tag", "t2"), "#t2…");
  // No studio reference at all: nothing is seeded.
  seedDetail(
    {
      reference: { provider: "stashdb" },
      studio: { name: "Ignored" },
      tags: [],
      credits: [],
    },
    null,
    true,
  );
  assert.equal(filterName("stashdb", "studio", "never-seeded"), "#never-se…");
});

test("seedFacetTile seeds the tile and its cross-provider counterpart", () => {
  seedFacetTile({
    provider: "tpdb",
    facet: "studio",
    id: "f1",
    name: "Facet Studio",
    linked: { provider: "stashdb", id: "f2" },
  });
  assert.equal(filterName("tpdb", "studio", "f1"), "Facet Studio");
  assert.equal(filterName("stashdb", "studio", "f2"), "Facet Studio");
  seedFacetTile({
    provider: "tpdb",
    facet: "tag",
    id: "f3",
    name: "Lone Facet",
  });
  assert.equal(filterName("tpdb", "tag", "f3"), "Lone Facet");
});
