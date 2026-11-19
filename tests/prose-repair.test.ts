import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFacetName as nf } from "../src/lib/contracts.ts";
import type { Cited, ProseDraft } from "../src/lib/prose-draft.ts";
import { mapProseDraft, type ProseLookups } from "../src/lib/prose-map.ts";
import {
  applyTagRepair,
  candidateWords,
  parseProseRepair,
  rankCandidates,
  type MissedTag,
  type RepairItem,
} from "../src/lib/prose-repair.ts";
import { repairMissedTags } from "../src/server/prose-search.ts";

// The grounded tag repair (docs/specs/prose-tag-repair.md): a phrase that
// matched no tag gets real candidate tags, and only real candidates apply.

const T = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const TAGS = {
  tpdb: [
    { id: T(1), name: "Older Man" },
    { id: T(2), name: "Twink" },
    { id: T(3), name: "Old/Young" },
    { id: T(4), name: "Anal" },
  ],
  stashdb: [
    { id: S(1), name: "Older Man" },
    { id: S(2), name: "Twink" },
    { id: S(3), name: "Old/Young" },
    // StashDB names it differently: no plain "Anal" there.
    { id: S(4), name: "Anal Sex" },
  ],
} as const;

/** Substring tag search over both providers, like the real searches. */
const lookups: ProseLookups = {
  configured: () => true,
  async searchTags(p, word) {
    return TAGS[p].filter((r) => nf(r.name).includes(nf(word)));
  },
  async searchNames() {
    return [];
  },
  async counterpart() {
    return undefined;
  },
};

const c = (value: string, source = value): Cited<string> => ({
  value,
  source,
});

const draft = (over: Partial<ProseDraft> = {}): ProseDraft => ({
  type: null,
  titleWords: null,
  include: [],
  exclude: [],
  performers: { mode: "all", names: [] },
  studios: { names: [], withChildren: null },
  followedPerformers: null,
  year: null,
  date: null,
  sort: null,
  skipped: [],
  ...over,
});

test("candidate words drop short words and stop words", () => {
  assert.deepEqual(candidateWords("lots of old men"), ["old", "men"]);
  assert.deepEqual(candidateWords("gets it by a guy"), ["guy"]);
});

test("candidates rank by matched phrase words, then shorter, merged per name with their catalogs", () => {
  assert.deepEqual(
    rankCandidates("old young", [
      { name: "Older Man", provider: "tpdb" },
      { name: "Old/Young", provider: "stashdb" },
      { name: "older man", provider: "stashdb" },
    ]),
    [
      { name: "Old/Young", catalogs: ["stashdb"] },
      { name: "Older Man", catalogs: ["tpdb", "stashdb"] },
    ],
  );
});

test("the repair reply applies only real candidates of offered phrases, at most 3", () => {
  const items: RepairItem[] = [
    {
      phrase: "old men",
      candidates: ["Older Man", "Old/Young", "Mature", "Old"].map((name) => ({
        name,
        catalogs: ["tpdb" as const],
      })),
    },
  ];
  const picks = parseProseRepair(
    {
      picks: [
        // Case folds to the candidate's own spelling; the 4th pick is over
        // the cap; an invented tag and an unknown phrase never apply.
        {
          phrase: "OLD MEN",
          tags: ["older man", "Invented", "Old/Young", "Mature", "Old"],
        },
        { phrase: "not offered", tags: ["Older Man"] },
      ],
    },
    items,
  );
  assert.deepEqual(
    [...picks],
    [["old men", ["Older Man", "Old/Young", "Mature"]]],
  );
  assert.equal(parseProseRepair("not json", items).size, 0);
});

test("picks replace an include alternative as OR alternatives and an exclude word as separate words", () => {
  const d = draft({
    include: [{ alternatives: [c("old men"), c("anal")] }],
    exclude: [c("young guy")],
  });
  const missed: MissedTag[] = [
    {
      field: "include",
      term: 0,
      alt: 0,
      value: "old men",
      source: "old men",
      kind: "no_match",
    },
    {
      field: "exclude",
      term: 0,
      alt: 0,
      value: "young guy",
      source: "young guy",
      kind: "no_match",
    },
  ];
  const out = applyTagRepair(
    d,
    missed,
    new Map([
      ["old men", ["Older Man", "Old/Young"]],
      ["young guy", ["Twink"]],
    ]),
  );
  assert.deepEqual(out.include, [
    {
      alternatives: [
        c("Older Man", "old men"),
        c("Old/Young", "old men"),
        c("anal"),
      ],
    },
  ]);
  assert.deepEqual(out.exclude, [c("Twink", "young guy")]);
});

test("a missed phrase with real picks applies after the repair; one without picks keeps its note", async () => {
  const text = "young guy with old men";
  const d = draft({
    include: [
      { alternatives: [c("old men")] },
      { alternatives: [c("young guy")] },
    ],
  });
  const missed: MissedTag[] = [];
  const pass1 = await mapProseDraft(
    { prose: text, tab: "all", draft: d },
    lookups,
    missed,
  );
  assert.deepEqual(
    missed.map((m) => m.value),
    ["old men", "young guy"],
  );
  let offered: RepairItem[] = [];
  const result = await repairMissedTags({
    text,
    tab: "all",
    draft: d,
    missed,
    lookups,
    result: pass1,
    async repair(items) {
      offered = items;
      return new Map([["old men", ["Older Man"]]]);
    },
  });
  // Candidates are real tag names found by the phrase's own words.
  assert.ok(
    offered
      .find((i) => i.phrase === "old men")
      ?.candidates.some((c) => c.name === "Older Man"),
  );
  assert.ok(result.params?.include?.includes("Older Man"));
  const messages = result.notes.map((n) => n.message);
  assert.ok(messages.includes("Read 'old men' as Older Man"));
  assert.ok(messages.includes("Not applied: young guy (no matching tag)"));
});

test("a free-text term becomes an OR group of each provider's own tag", async () => {
  // "anal" is exact only on TPDB and only contained in StashDB's "Anal Sex",
  // so pass 1 applies it as free text that Browse must check page by page.
  const text = "anal";
  const d = draft({ include: [{ alternatives: [c("anal")] }] });
  const missed: MissedTag[] = [];
  const pass1 = await mapProseDraft(
    { prose: text, tab: "all", draft: d },
    lookups,
    missed,
  );
  assert.deepEqual(
    missed.map((m) => [m.value, m.kind]),
    [["anal", "free_text"]],
  );
  assert.deepEqual(JSON.parse(pass1.params!.include!), [{ name: "anal" }]);
  const result = await repairMissedTags({
    text,
    tab: "all",
    draft: d,
    missed,
    lookups,
    result: pass1,
    async repair() {
      return new Map([["anal", ["Anal", "Anal Sex"]]]);
    },
  });
  // Each pick anchors on the provider that publishes it, so both sides
  // filter natively instead of scanning for free text.
  assert.deepEqual(JSON.parse(result.params!.include!), [
    [
      { name: "Anal", tpdb: T(4) },
      { name: "Anal Sex", stashdb: S(4) },
    ],
  ]);
});

test("a failed repair keeps pass 1 and adds one note", async () => {
  const text = "old men";
  const d = draft({ include: [{ alternatives: [c("old men")] }] });
  const missed: MissedTag[] = [];
  const pass1 = await mapProseDraft(
    { prose: text, tab: "all", draft: d },
    lookups,
    missed,
  );
  const result = await repairMissedTags({
    text,
    tab: "all",
    draft: d,
    missed,
    lookups,
    result: pass1,
    async repair() {
      throw new Error("The chat server did not answer within 30 seconds.");
    },
  });
  assert.equal(result.params, pass1.params);
  assert.deepEqual(result.notes.slice(0, pass1.notes.length), pass1.notes);
  assert.deepEqual(result.notes.at(-1), {
    code: "lookup_failed",
    message:
      "Tag matching with the AI service failed: The chat server did not answer within 30 seconds.",
  });
});
