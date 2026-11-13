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

test("each group comes from one side whole, so partial facts never mix", () => {
  const a = base({
    person: {
      country: "DE",
      birthDate: "2001-01-01",
      deathDate: "2001-02-02",
      cupSize: "32C",
      careerStartYear: 2010,
      tattoos: ["None"],
    },
  });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    person: {
      gender: "Female",
      birthDate: "1994-09-21",
      birthDateAccuracy: "day",
      deathDate: "1999-09-09",
      deathDateAccuracy: "month",
      cupSize: "D",
      bandSize: 36,
      waistIn: 24,
      hipIn: 34,
      measurementsText: "36-24-34",
      careerStartYear: 2005,
      careerEndYear: 2020,
    },
  });
  // The primary's partial group wins as a whole: its missing group members
  // are deleted, never filled from the other side, and dropped keys are
  // absent, not present-but-undefined.
  assert.deepEqual(mergePerformerDetails(a, b).person, {
    country: "DE",
    gender: "Female",
    birthDate: "2001-01-01",
    deathDate: "2001-02-02",
    cupSize: "32C",
    careerStartYear: 2010,
    tattoos: ["None"],
  });
});

test("a one-sided person passes through unchanged", () => {
  const p = { country: "DE", cupSize: "32C" };
  const withPerson = base({ person: p });
  const without = base({});
  assert.deepEqual(mergePerformerDetails(withPerson, without).person, p);
  assert.deepEqual(mergePerformerDetails(without, withPerson).person, p);
});

test("equal-length mod lists keep the primary's; a missing list takes the other's", () => {
  const a = base({ person: { tattoos: ["None"] } });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    person: { tattoos: ["Left wrist: star"] },
  });
  assert.deepEqual(mergePerformerDetails(a, b).person?.tattoos, ["None"]);
  const c = base({ person: {} });
  assert.deepEqual(mergePerformerDetails(c, b).person?.tattoos, [
    "Left wrist: star",
  ]);
});

test("aliases dedupe on the trimmed lowercased name but keep the published text", () => {
  const a = base({ aliases: [" Jewelz "] });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    aliases: ["jewelz", "", "Jewelz Blue"],
  });
  assert.deepEqual(mergePerformerDetails(a, b).aliases, [
    " Jewelz ",
    "Jewelz Blue",
  ]);
});

test("one link per destination: case, www and extra slashes fold together", () => {
  const a = base({
    links: [
      { label: "IAFD", url: "https://WWW.IAFD.com/P/1//" },
      { label: "Broken", url: "not a url" },
      { label: "Broken too", url: "also broken" },
    ],
  });
  const b = base({
    reference: { provider: "stashdb", kind: "performer", id: "s1" },
    links: [{ label: "IAFD", url: "https://iafd.com/p/1" }],
  });
  // A malformed url cannot parse to a key, so it passes through on its own
  // raw string instead of crashing the merge or colliding with another
  // malformed link.
  assert.deepEqual(mergePerformerDetails(a, b).links, [
    { label: "IAFD", url: "https://WWW.IAFD.com/P/1//" },
    { label: "Broken", url: "not a url" },
    { label: "Broken too", url: "also broken" },
  ]);
});
