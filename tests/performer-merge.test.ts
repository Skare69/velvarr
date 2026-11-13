import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogDetail } from "../src/lib/contracts.ts";
import { mergePerformerDetails } from "../src/lib/performer-merge.ts";

// One performer page from two provider-linked records: the primary wins
// every field it has, the other fills gaps, and grouped facts never mix.

const base = (over: Partial<CatalogDetail>): CatalogDetail => ({
  reference: { provider: "tpdb", kind: "performer", id: "t1" },
  title: "Jewelz Blu",
  credits: [],
  tags: [],
  related: [],
  links: [],
  aliases: [],
  ...over,
});

const tpdb = base({
  description: "TPDB bio",
  imageUrl: "https://tpdb/img.jpg",
  aliases: ["Jewels Blu", "Jewelz Blue"],
  links: [{ label: "IAFD", url: "https://www.iafd.com/p/1" }],
  person: { country: "DE", cupSize: "32C" },
});
const stash = base({
  reference: { provider: "stashdb", kind: "performer", id: "s1" },
  imageUrl: "https://stash/img.jpg",
  aliases: ["jewelz blue", "Jewelz"],
  links: [
    { label: "IAFD", url: "https://iafd.com/p/1/" },
    { label: "OnlyFans", url: "https://onlyfans.com/jewelzblu" },
  ],
  person: {
    country: "US",
    gender: "Female",
    cupSize: "D",
    bandSize: 36,
    waistIn: 24,
    hipIn: 34,
    birthDate: "1994-09-21",
    birthDateAccuracy: "day",
  },
});

test("the primary wins scalar fields; the other only fills gaps", () => {
  const m = mergePerformerDetails(tpdb, stash);
  assert.equal(m.imageUrl, "https://tpdb/img.jpg");
  assert.equal(m.description, "TPDB bio");
  assert.equal(m.person?.country, "DE");
  assert.equal(m.person?.gender, "Female");
  assert.equal(m.person?.birthDate, "1994-09-21");
  assert.equal(m.person?.birthDateAccuracy, "day");
  assert.deepEqual(m.reference, tpdb.reference);
});

test("a measurement group comes whole from one side, never mixed", () => {
  const m = mergePerformerDetails(tpdb, stash);
  assert.equal(m.person?.cupSize, "32C");
  assert.equal(m.person?.bandSize, undefined);
  assert.equal(m.person?.waistIn, undefined);
});

test("aliases and links are deduplicated unions", () => {
  const m = mergePerformerDetails(tpdb, stash);
  assert.deepEqual(m.aliases, ["Jewels Blu", "Jewelz Blue", "Jewelz"]);
  assert.deepEqual(
    m.links.map((l) => l.url),
    ["https://www.iafd.com/p/1", "https://onlyfans.com/jewelzblu"],
  );
});

test("the longer tattoo list wins, so a TPDB one-liner never hides detail", () => {
  const a = base({ person: { tattoos: ["None"] } });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    person: { tattoos: ["Left wrist: star", "Back: script"] },
  });
  assert.deepEqual(mergePerformerDetails(a, b).person?.tattoos, [
    "Left wrist: star",
    "Back: script",
  ]);
});

test("a death date comes whole from one side, with its own accuracy", () => {
  const a = base({ person: { country: "US" } });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    person: { deathDate: "2020-05-01", deathDateAccuracy: "month" },
  });
  const p = mergePerformerDetails(a, b).person;
  assert.equal(p?.deathDate, "2020-05-01");
  assert.equal(p?.deathDateAccuracy, "month");
});
