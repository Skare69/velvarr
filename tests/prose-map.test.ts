import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { BROWSE_KEYS } from "../src/lib/browse-url.ts";
import type { BrowseTab } from "../src/lib/browse-entities.ts";
import { normalizeFacetName as nf } from "../src/lib/contracts.ts";
import {
  parseProseDraft,
  type Cited,
  type ProseDraft,
} from "../src/lib/prose-draft.ts";
import {
  mapProseDraft,
  type ProseLookups,
  type ProseNameRow,
  type ProseNote,
  type ProseSearchResult,
} from "../src/lib/prose-map.ts";
import { SORT_KEYS } from "../src/lib/sorts.ts";
import { parseBrowseQuery, planBrowseSides } from "../src/server/browse.ts";

// The map is tested only through its export and the injected lookups: the
// fakes below stand in for provider search, and every call they get is
// recorded so a test can prove "no lookup".

type Provider = "tpdb" | "stashdb";
type Kind = "performer" | "studio";

// Provider-shaped UUIDs: TPDB ids start with a, StashDB ids with b.
const T = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S = (n: number) =>
  `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type FakeOptions = {
  configured?: Provider[];
  tags?: Partial<Record<Provider, { id: string; name: string }[]>>;
  names?: Partial<Record<`${Provider}:${Kind}`, ProseNameRow[]>>;
  /** `${kind}:${provider}:${id}` → the other provider's id. */
  links?: Record<string, string>;
  failTags?: Provider[];
  failNames?: Provider[];
  /** Fails counterpart lookups made FROM this provider's record. */
  failLinks?: Provider[];
};

/** Provider search behaves like a substring search (the real searches
 * return near matches too), so tests also prove the exact-match rules. */
function fakeLookups(o: FakeOptions = {}) {
  const calls: string[] = [];
  const configured = new Set<Provider>(o.configured ?? ["tpdb", "stashdb"]);
  const lookups: ProseLookups = {
    configured: (p) => configured.has(p),
    async searchTags(p, word) {
      calls.push(`tags:${p}:${word}`);
      if (o.failTags?.includes(p)) throw new Error("HTTP 503");
      return (o.tags?.[p] ?? []).filter((r) => nf(r.name).includes(nf(word)));
    },
    async searchNames(p, kind, name) {
      calls.push(`names:${p}:${kind}:${name}`);
      if (o.failNames?.includes(p)) throw new Error("HTTP 502");
      const q = nf(name);
      return (o.names?.[`${p}:${kind}`] ?? []).filter((r) =>
        [r.name, ...r.aliases].some((n) => nf(n).includes(q)),
      );
    },
    async counterpart(kind, p, id) {
      calls.push(`link:${kind}:${p}:${id}`);
      if (o.failLinks?.includes(p)) throw new Error("timed out");
      return o.links?.[`${kind}:${p}:${id}`];
    },
  };
  return { lookups, calls };
}

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

const c = (value: string, source = value): Cited<string> => ({
  value,
  source,
});

const run = (
  prose: string,
  tab: BrowseTab,
  d: ProseDraft,
  fake = fakeLookups(),
): Promise<ProseSearchResult> =>
  mapProseDraft({ prose, tab, draft: d }, fake.lookups);

const JSON_KEYS = ["include", "exclude", "performers", "studios"];

/** The full replace patch: every browse key except perPage and type set or
 * nulled, plus `name: null`. JSON keys are given as parsed arrays. */
function patch(over: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { name: null };
  for (const key of BROWSE_KEYS) {
    if (key !== "perPage" && key !== "type") out[key] = null;
  }
  return { ...out, ...over };
}

/** params with the JSON keys parsed, so entry key order never matters. */
function decoded(
  params: ProseSearchResult["params"],
): Record<string, unknown> | null {
  if (params === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] =
      JSON_KEYS.includes(key) && typeof value === "string"
        ? JSON.parse(value)
        : value;
  }
  return out;
}

// A read_as note also carries its words and reading as data (the UI groups
// them); the fixtures spell them only once, in the message.
const note = (code: ProseNote["code"], message: string): ProseNote => {
  const read =
    code === "read_as" ? /^Read '(.*)' as (.*)$/.exec(message) : null;
  return read === null
    ? { code, message }
    : { code, message, read: { from: read[1]!, to: read[2]! } };
};

// Tags published on both providers. StashDB has no exact "outdoor".
const TAGS: FakeOptions["tags"] = {
  tpdb: [
    { id: T(1), name: "Blonde" },
    { id: T(2), name: "Redhead" },
    { id: T(3), name: "Anal" },
    { id: T(4), name: "Outdoor" },
  ],
  stashdb: [
    { id: S(1), name: "blonde" },
    { id: S(2), name: "Redhead" },
    { id: S(3), name: "Anal" },
    { id: S(4), name: "Outdoors" },
  ],
};
const BLONDE = { name: "Blonde", tpdb: T(1), stashdb: S(1) };
const REDHEAD = { name: "Redhead", tpdb: T(2), stashdb: S(2) };
const ANAL = { name: "Anal", tpdb: T(3), stashdb: S(3) };

const RILEY = { id: S(11), name: "Riley Reid", aliases: ["Riley R"] };
const MIA = { id: S(12), name: "Mia Malkova", aliases: [] };
const PEOPLE: FakeOptions = {
  names: {
    "stashdb:performer": [RILEY, MIA],
    "tpdb:performer": [{ id: T(11), name: "Riley Reid", aliases: [] }],
    "stashdb:studio": [{ id: S(21), name: "Vixen", aliases: [] }],
    "tpdb:studio": [
      { id: T(21), name: "Vixen", aliases: [] },
      { id: T(29), name: "Vixen Media Group", aliases: [] },
    ],
  },
  links: {
    [`performer:stashdb:${S(11)}`]: T(11),
    [`performer:tpdb:${T(11)}`]: S(11),
    [`studio:stashdb:${S(21)}`]: T(21),
    [`studio:tpdb:${T(21)}`]: S(21),
  },
};

// --- each filter kind ---

test("a cited type changes the tab and the patch carries type", async () => {
  const result = await run(
    "show me movies",
    "all",
    draft({ type: { value: "movie", source: "movies" } }),
  );
  assert.deepEqual(decoded(result.params), patch({ type: "movie" }));
  assert.deepEqual(result.notes, []);
});

test("a type change to All carries type null", async () => {
  const result = await run(
    "movies and scenes",
    "scene",
    draft({ type: { value: "all", source: "movies and scenes" } }),
  );
  assert.deepEqual(decoded(result.params), patch({ type: null }));
});

test("a type equal to the request tab applies nothing", async () => {
  const result = await run(
    "scenes",
    "scene",
    draft({ type: { value: "scene", source: "scenes" } }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, []);
});

test("title words become q, trimmed, and the patch has no type key", async () => {
  const result = await run(
    "scenes titled office party",
    "scene",
    draft({ titleWords: c(" office party ", "office party") }),
  );
  assert.ok(result.params);
  assert.ok(!("type" in result.params));
  assert.deepEqual(decoded(result.params), patch({ q: "office party" }));
  assert.deepEqual(result.notes, []);
});

test("an include word with an exact tag on both providers anchors on the TPDB name and both ids", async () => {
  const result = await run(
    "blonde scenes",
    "all",
    draft({ include: [{ alternatives: [c("blonde")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(decoded(result.params), patch({ include: [BLONDE] }));
  assert.deepEqual(result.notes, []);
});

test("an include word with an exact tag on one provider only is free text", async () => {
  const result = await run(
    "outdoor scenes",
    "all",
    draft({ include: [{ alternatives: [c("outdoor")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [{ name: "outdoor" }] }),
  );
  assert.deepEqual(result.notes, []);
});

test("a TPDB tag row with a non-UUID id cannot anchor", async () => {
  const result = await run(
    "lingerie",
    "all",
    draft({ include: [{ alternatives: [c("lingerie")] }] }),
    fakeLookups({
      tags: {
        tpdb: [{ id: "4512", name: "Lingerie" }],
        stashdb: [{ id: S(5), name: "Lingerie" }],
      },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [{ name: "lingerie" }] }),
  );
});

test("an exclude word anchors like an include word", async () => {
  const result = await run(
    "blonde scenes, no anal",
    "all",
    draft({ exclude: [c("anal")] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(decoded(result.params), patch({ exclude: [ANAL] }));
  assert.deepEqual(result.notes, []);
});

test("a word with no tag row is no_matching_tag and applies nothing", async () => {
  const result = await run(
    "zebra scenes",
    "all",
    draft({ include: [{ alternatives: [c("zebra")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("no_matching_tag", "Not applied: zebra (no matching tag)"),
  ]);
});

test("a tag word with no letters or digits, or over 120 chars, is no_matching_tag with no lookup", async () => {
  const long = "x".repeat(121);
  const fake = fakeLookups({ tags: TAGS });
  const result = await run(
    `!!! and ${long}`,
    "all",
    draft({ include: [{ alternatives: [c("!!!")] }], exclude: [c(long)] }),
    fake,
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("no_matching_tag", "Not applied: !!! (no matching tag)"),
    note("no_matching_tag", `Not applied: ${long} (no matching tag)`),
  ]);
  assert.deepEqual(fake.calls, []);
});

test("performers resolve on StashDB off Movies, take the TPDB counterpart, lowercase ids and keep mode any", async () => {
  const fake = fakeLookups({
    ...PEOPLE,
    links: { [`performer:stashdb:${S(11)}`]: T(11).toUpperCase() },
  });
  const result = await run(
    "scenes with Riley Reid or Mia Malkova",
    "scene",
    draft({
      performers: { mode: "any", names: [c("Riley Reid"), c("Mia Malkova")] },
    }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [
        { name: "Riley Reid", stashdb: S(11), tpdb: T(11) },
        { name: "Mia Malkova", stashdb: S(12) },
      ],
      performerMode: "any",
    }),
  );
  assert.deepEqual(result.notes, []);
  assert.ok(!fake.calls.some((call) => call.startsWith("names:tpdb:")));
});

test("performerMode any needs two applied performers", async () => {
  const result = await run(
    "Riley Reid or Nobody",
    "scene",
    draft({
      performers: { mode: "any", names: [c("Riley Reid"), c("Nobody")] },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11), tpdb: T(11) }],
    }),
  );
  assert.deepEqual(result.notes, [
    note("no_exact_match", "Not applied: Nobody (no exact match)"),
  ]);
});

test("a name with no exact record is no_exact_match; two exact records are ambiguous_name", async () => {
  const result = await run(
    "Riley and Mia",
    "scene",
    draft({ performers: { mode: "all", names: [c("Riley"), c("Mia")] } }),
    fakeLookups({
      names: {
        "stashdb:performer": [
          RILEY,
          { id: S(13), name: "Mia", aliases: [] },
          { id: S(14), name: "MIA", aliases: [] },
        ],
      },
    }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("no_exact_match", "Not applied: Riley (no exact match)"),
    note(
      "ambiguous_name",
      "Not applied: Mia (more than one record has this name)",
    ),
  ]);
});

test("the same record named twice applies once, and a counterpart id another entry uses is dropped", async () => {
  const result = await run(
    "Riley Reid, Riley R and Mia Malkova",
    "scene",
    draft({
      performers: {
        mode: "all",
        names: [c("Riley Reid"), c("Riley R"), c("Mia Malkova")],
      },
    }),
    fakeLookups({
      names: { "stashdb:performer": [RILEY, MIA] },
      links: {
        [`performer:stashdb:${S(11)}`]: T(11),
        // A second StashDB record links to the same TPDB performer.
        [`performer:stashdb:${S(12)}`]: T(11),
      },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [
        { name: "Riley Reid", stashdb: S(11), tpdb: T(11) },
        { name: "Mia Malkova", stashdb: S(12) },
      ],
    }),
  );
  // The duplicate and the shared counterpart are both silent.
  assert.deepEqual(result.notes, []);
});

test("studios resolve on TPDB on Movies by exact name and take the StashDB counterpart", async () => {
  const result = await run(
    "Vixen movies",
    "movie",
    draft({ studios: { names: [c("Vixen")], withChildren: null } }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ studios: [{ name: "Vixen", tpdb: T(21), stashdb: S(21) }] }),
  );
  assert.deepEqual(result.notes, []);
});

test("followed performers set performerStarred", async () => {
  const result = await run(
    "scenes with performers I follow",
    "scene",
    draft({ followedPerformers: { source: "performers I follow" } }),
  );
  assert.deepEqual(decoded(result.params), patch({ performerStarred: "1" }));
  assert.deepEqual(result.notes, []);
});

test("a single year sets year only, with no read_as for a year written out", async () => {
  const result = await run(
    "scenes from 2019",
    "all",
    draft({ year: { from: 2019, to: 2019, source: "2019" } }),
  );
  assert.deepEqual(decoded(result.params), patch({ year: "2019" }));
  assert.deepEqual(result.notes, []);
});

test("a year range sets year and yearTo, low bound first", async () => {
  const result = await run(
    "between 2015 and 2019",
    "all",
    draft({ year: { from: 2019, to: 2015, source: "between 2015 and 2019" } }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ year: "2015", yearTo: "2019" }),
  );
  assert.deepEqual(result.notes, []);
});

test("a year outside 1900..2100 is not_available", async () => {
  const result = await run(
    "from 1890",
    "all",
    draft({ year: { from: 1890, to: 1890, source: "1890" } }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("not_available", "Not applied: 1890 (years run from 1900 to 2100)"),
  ]);
});

test("a date sets date and date_operation", async () => {
  const result = await run(
    "released after 2020-03-01",
    "all",
    draft({
      date: { operation: ">", date: "2020-03-01", source: "after 2020-03-01" },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ date: "2020-03-01", date_operation: ">" }),
  );
  assert.deepEqual(result.notes, []);
});

test("a date not in the source is read_as its display", async () => {
  const result = await run(
    "scenes since last March",
    "scene",
    draft({
      date: {
        operation: ">=",
        date: "2025-03-01",
        source: "since last March",
      },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ date: "2025-03-01", date_operation: ">=" }),
  );
  assert.deepEqual(result.notes, [
    note("read_as", "Read 'since last March' as on or after 2025-03-01"),
  ]);
});

test("a date that is not a real calendar date is not_available", async () => {
  const result = await run(
    "on 2021-02-30",
    "all",
    draft({
      date: { operation: "=", date: "2021-02-30", source: "on 2021-02-30" },
    }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: on 2021-02-30 (not a real calendar date)",
    ),
  ]);
});

test("a sort with a direction sets sort and direction", async () => {
  const result = await run(
    "movies, longest first",
    "movie",
    draft({
      sort: { key: "duration", direction: "desc", source: "longest first" },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ sort: "duration", direction: "desc" }),
  );
  assert.deepEqual(result.notes, []);
});

test("a sort that takes no direction drops the drafted direction", async () => {
  const result = await run(
    "movies, best match",
    "movie",
    draft({
      sort: { key: "relevance", direction: "desc", source: "best match" },
    }),
  );
  assert.deepEqual(decoded(result.params), patch({ sort: "relevance" }));
});

test("recency on Scenes applies as date, and date on Movies as recency", async () => {
  const scenes = await run(
    "newest first",
    "scene",
    draft({
      sort: { key: "recency", direction: "desc", source: "newest first" },
    }),
  );
  assert.deepEqual(
    decoded(scenes.params),
    patch({ sort: "date", direction: "desc" }),
  );
  assert.deepEqual(scenes.notes, []);
  const movies = await run(
    "oldest first",
    "movie",
    draft({ sort: { key: "date", direction: "asc", source: "oldest first" } }),
  );
  assert.deepEqual(
    decoded(movies.params),
    patch({ sort: "recency", direction: "asc" }),
  );
});

test("a sort the tab does not offer is not_available under its label", async () => {
  const result = await run(
    "everything by title",
    "all",
    draft({ sort: { key: "title", direction: "asc", source: "by title" } }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: Title (this order is not available here)",
    ),
  ]);
});

test("a sort a merged source cannot carry is not_available", async () => {
  const result = await run(
    "Vixen or Blacked scenes and their sub-studios, by title",
    "scene",
    draft({
      studios: {
        names: [c("Vixen"), c("Blacked")],
        withChildren: { source: "sub-studios" },
      },
      sort: { key: "title", direction: "asc", source: "by title" },
    }),
    fakeLookups({
      names: {
        "stashdb:studio": [
          { id: S(21), name: "Vixen", aliases: [] },
          { id: S(22), name: "Blacked", aliases: [] },
        ],
      },
    }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      studios: [
        { name: "Vixen", stashdb: S(21) },
        { name: "Blacked", stashdb: S(22) },
      ],
      studioMode: "withChildren",
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: Title (this order is not available here)",
    ),
  ]);
});

// --- citations and read_as ---

test("uncited values are dropped with not_in_text and never looked up", async () => {
  const fake = fakeLookups({ ...PEOPLE, tags: TAGS });
  const result = await run(
    "blonde scenes",
    "all",
    draft({
      type: { value: "movie", source: "films" },
      titleWords: c("office"),
      include: [{ alternatives: [c("redhead")] }],
      performers: { mode: "all", names: [c("Riley Reid")] },
      followedPerformers: { source: "people I follow" },
    }),
    fake,
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("not_in_text", "Not applied: movies (not found in your text)"),
    note("not_in_text", "Not applied: office (not found in your text)"),
    note("not_in_text", "Not applied: redhead (not found in your text)"),
    note("not_in_text", "Not applied: Riley Reid (not found in your text)"),
    note(
      "not_in_text",
      "Not applied: people I follow (not found in your text)",
    ),
  ]);
  assert.deepEqual(fake.calls, []);
});

test("an empty source is never cited", async () => {
  const result = await run(
    "office party",
    "all",
    draft({ titleWords: c("office", "") }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("not_in_text", "Not applied: office (not found in your text)"),
  ]);
});

test("citation ignores case and runs of whitespace", async () => {
  const result = await run(
    "Blonde   SCENES",
    "all",
    draft({ include: [{ alternatives: [c("blonde", "blonde scenes")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(decoded(result.params), patch({ include: [BLONDE] }));
});

test("a name matched by alias notes read_as", async () => {
  const result = await run(
    "scenes with Riley R",
    "scene",
    draft({ performers: { mode: "all", names: [c("Riley R")] } }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11), tpdb: T(11) }],
    }),
  );
  assert.deepEqual(result.notes, [
    note("read_as", "Read 'Riley R' as Riley Reid"),
  ]);
});

test("a tag word anchored under another name notes read_as", async () => {
  const result = await run(
    "blondes",
    "all",
    draft({ include: [{ alternatives: [c("blonde", "blondes")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(decoded(result.params), patch({ include: [BLONDE] }));
  assert.deepEqual(result.notes, [note("read_as", "Read 'blondes' as Blonde")]);
});

test("a relative year notes read_as", async () => {
  const result = await run(
    "scenes from last year",
    "scene",
    draft({ year: { from: 2025, to: 2025, source: "last year" } }),
  );
  assert.deepEqual(decoded(result.params), patch({ year: "2025" }));
  assert.deepEqual(result.notes, [note("read_as", "Read 'last year' as 2025")]);
});

test("a decade notes read_as as a range with an en dash", async () => {
  const result = await run(
    "movies from the 2010s",
    "movie",
    draft({ year: { from: 2010, to: 2019, source: "the 2010s" } }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ year: "2010", yearTo: "2019" }),
  );
  assert.deepEqual(result.notes, [
    note("read_as", "Read 'the 2010s' as 2010–2019"),
  ]);
});

// --- "or" terms and caps ---

test("an or term with one miss becomes a group of the rest", async () => {
  const result = await run(
    "blonde, redhead or zebra",
    "all",
    draft({
      include: [{ alternatives: [c("blonde"), c("redhead"), c("zebra")] }],
    }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [[BLONDE, REDHEAD]] }),
  );
  assert.deepEqual(result.notes, [
    note("no_matching_tag", "Not applied: zebra (no matching tag)"),
  ]);
});

test("an or term with one match becomes a plain selection", async () => {
  const result = await run(
    "anal or zebra",
    "all",
    draft({ include: [{ alternatives: [c("anal"), c("zebra")] }] }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(decoded(result.params), patch({ include: [ANAL] }));
  assert.deepEqual(result.notes, [
    note("no_matching_tag", "Not applied: zebra (no matching tag)"),
  ]);
});

test("include dedupes a repeat inside a term, a repeated plain selection and a repeated group", async () => {
  const result = await run(
    "blonde or Blonde, blonde, redhead or anal, anal or redhead",
    "all",
    draft({
      include: [
        { alternatives: [c("blonde"), c("Blonde")] },
        { alternatives: [c("blonde")] },
        { alternatives: [c("redhead"), c("anal")] },
        { alternatives: [c("anal"), c("redhead")] },
      ],
    }),
    fakeLookups({ tags: TAGS }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [BLONDE, [REDHEAD, ANAL]] }),
  );
  assert.deepEqual(result.notes, []);
});

test("include stops at 25 tags: the rest get cap_reached with no lookup", async () => {
  const words = Array.from(
    { length: 30 },
    (_, i) => `alpha${String(i + 1).padStart(2, "0")}`,
  );
  const fake = fakeLookups({
    tags: {
      tpdb: words.map((name, i) => ({ id: T(100 + i), name })),
      stashdb: words.map((name, i) => ({ id: S(100 + i), name })),
    },
  });
  const result = await run(
    words.join(" "),
    "all",
    draft({
      include: [0, 10, 20].map((start) => ({
        alternatives: words.slice(start, start + 10).map((w) => c(w)),
      })),
    }),
    fake,
  );
  const selection = (i: number) => ({
    name: words[i],
    tpdb: T(100 + i),
    stashdb: S(100 + i),
  });
  const group = (start: number, length: number) =>
    Array.from({ length }, (_, i) => selection(start + i));
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [group(0, 10), group(10, 10), group(20, 5)] }),
  );
  assert.deepEqual(
    result.notes,
    words
      .slice(25)
      .map((w) =>
        note(
          "cap_reached",
          `Not applied: ${w} (Browse filters at most 25 tags)`,
        ),
      ),
  );
  for (const w of words.slice(25)) {
    assert.ok(!fake.calls.some((call) => call.endsWith(`:${w}`)), w);
  }
});

const SIX = [
  "Ava Addams",
  "Bree Olson",
  "Cory Chase",
  "Dani Daniels",
  "Eva Lovia",
  "Faye Reagan",
];

test("the sixth matched performer gets cap_reached with no lookup", async () => {
  const fake = fakeLookups({
    names: {
      "stashdb:performer": SIX.map((name, i) => ({
        id: S(31 + i),
        name,
        aliases: [],
      })),
    },
  });
  const result = await run(
    SIX.join(", "),
    "scene",
    draft({ performers: { mode: "all", names: SIX.map((n) => c(n)) } }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: SIX.slice(0, 5).map((name, i) => ({
        name,
        stashdb: S(31 + i),
      })),
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "cap_reached",
      "Not applied: Faye Reagan (Browse filters at most 5 performers)",
    ),
  ]);
  assert.ok(!fake.calls.some((call) => call.includes("Faye Reagan")));
  assert.ok(!fake.calls.some((call) => call.includes(S(36))));
});

test("the sixth matched studio gets cap_reached with no lookup", async () => {
  const fake = fakeLookups({
    names: {
      "tpdb:studio": SIX.map((name, i) => ({
        id: T(41 + i),
        name,
        aliases: [],
      })),
    },
  });
  const result = await run(
    SIX.join(", "),
    "movie",
    draft({ studios: { names: SIX.map((n) => c(n)), withChildren: null } }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      studios: SIX.slice(0, 5).map((name, i) => ({ name, tpdb: T(41 + i) })),
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "cap_reached",
      "Not applied: Faye Reagan (Browse filters at most 5 studios)",
    ),
  ]);
  assert.ok(!fake.calls.some((call) => call.includes("Faye Reagan")));
});

// --- lookup failures and unconfigured providers ---

test("a counterpart failure keeps the one-id entries and adds one aggregated link note", async () => {
  const result = await run(
    "Riley Reid and Mia Malkova",
    "scene",
    draft({
      performers: { mode: "all", names: [c("Riley Reid"), c("Mia Malkova")] },
    }),
    fakeLookups({ ...PEOPLE, failLinks: ["stashdb"] }),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [
        { name: "Riley Reid", stashdb: S(11) },
        { name: "Mia Malkova", stashdb: S(12) },
      ],
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "lookup_failed",
      "TPDB link lookup failed for Riley Reid and Mia Malkova",
    ),
  ]);
});

test("a tag provider failure is noted once and that provider is not searched again", async () => {
  const fake = fakeLookups({ tags: TAGS, failTags: ["tpdb"] });
  const result = await run(
    "blonde redhead, no anal",
    "all",
    draft({
      include: [
        { alternatives: [c("blonde")] },
        { alternatives: [c("redhead")] },
      ],
      exclude: [c("anal")],
    }),
    fake,
  );
  // Without a TPDB answer nothing anchors: StashDB's rows make free text.
  assert.deepEqual(
    decoded(result.params),
    patch({
      include: [{ name: "blonde" }, { name: "redhead" }],
      exclude: [{ name: "anal" }],
    }),
  );
  assert.deepEqual(result.notes, [
    note("lookup_failed", "TPDB search failed: HTTP 503"),
  ]);
  assert.equal(
    fake.calls.filter((call) => call.startsWith("tags:tpdb:")).length,
    1,
  );
  assert.equal(
    fake.calls.filter((call) => call.startsWith("tags:stashdb:")).length,
    3,
  );
});

test("a word whose every tag search failed is lookup_failed, not no_matching_tag", async () => {
  const result = await run(
    "blonde",
    "all",
    draft({ include: [{ alternatives: [c("blonde")] }] }),
    fakeLookups({ tags: TAGS, failTags: ["tpdb", "stashdb"] }),
  );
  assert.equal(result.params, null);
  const byMessage = (a: ProseNote, b: ProseNote) =>
    a.message.localeCompare(b.message);
  assert.deepEqual([...result.notes].sort(byMessage), [
    note("lookup_failed", "Not applied: blonde (tag search failed)"),
    note("lookup_failed", "StashDB search failed: HTTP 503"),
    note("lookup_failed", "TPDB search failed: HTTP 503"),
  ]);
});

test("a name provider failure is noted once and not searched again", async () => {
  const fake = fakeLookups({ ...PEOPLE, failNames: ["stashdb"] });
  const result = await run(
    "Riley Reid and Mia Malkova",
    "scene",
    draft({
      performers: { mode: "all", names: [c("Riley Reid"), c("Mia Malkova")] },
    }),
    fake,
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("lookup_failed", "StashDB search failed: HTTP 502"),
  ]);
  assert.equal(
    fake.calls.filter((call) => call.startsWith("names:stashdb:")).length,
    1,
  );
});

test("an unconfigured tag provider is noted once and never searched", async () => {
  const fake = fakeLookups({ tags: TAGS, configured: ["stashdb"] });
  const result = await run(
    "blonde redhead",
    "all",
    draft({
      include: [
        { alternatives: [c("blonde")] },
        { alternatives: [c("redhead")] },
      ],
    }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ include: [{ name: "blonde" }, { name: "redhead" }] }),
  );
  assert.deepEqual(result.notes, [
    note(
      "provider_not_configured",
      "TPDB is not configured, so it was not searched",
    ),
  ]);
  assert.ok(!fake.calls.some((call) => call.startsWith("tags:tpdb:")));
});

test("an unconfigured name provider is noted once and its names are not applied", async () => {
  const fake = fakeLookups({ ...PEOPLE, configured: ["stashdb"] });
  const result = await run(
    "movies with Riley Reid and Mia Malkova",
    "movie",
    draft({
      performers: { mode: "all", names: [c("Riley Reid"), c("Mia Malkova")] },
    }),
    fake,
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note(
      "provider_not_configured",
      "TPDB is not configured, so it was not searched",
    ),
  ]);
  assert.ok(!fake.calls.some((call) => call.startsWith("names:")));
});

test("an unconfigured counterpart provider is noted once and the entries keep one id", async () => {
  const fake = fakeLookups({ ...PEOPLE, configured: ["stashdb"] });
  const result = await run(
    "Riley Reid and Mia Malkova",
    "scene",
    draft({
      performers: { mode: "all", names: [c("Riley Reid"), c("Mia Malkova")] },
    }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [
        { name: "Riley Reid", stashdb: S(11) },
        { name: "Mia Malkova", stashdb: S(12) },
      ],
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "provider_not_configured",
      "TPDB is not configured, so it was not searched",
    ),
  ]);
  assert.ok(!fake.calls.some((call) => call.startsWith("link:")));
});

// --- conflicts ---

test("All: a TPDB performer with a year and a sort leaves out the TPDB ids", async () => {
  const result = await run(
    "Riley Reid from 2019, newest first",
    "all",
    draft({
      performers: { mode: "all", names: [c("Riley Reid")] },
      year: { from: 2019, to: 2019, source: "2019" },
      sort: { key: "recency", direction: "desc", source: "newest first" },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11) }],
      year: "2019",
      sort: "recency",
      direction: "desc",
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "left_out",
      "Left out the TPDB ids of Riley Reid: the TPDB performer filter cannot combine with a year and a sort",
    ),
  ]);
});

test("All: a TPDB performer with nothing that conflicts keeps the TPDB id", async () => {
  const result = await run(
    "Riley Reid",
    "all",
    draft({ performers: { mode: "all", names: [c("Riley Reid")] } }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11), tpdb: T(11) }],
    }),
  );
  assert.deepEqual(result.notes, []);
});

test("All: no left_out when the filmography does not run (mode all, one entry without a TPDB id)", async () => {
  const result = await run(
    "Riley Reid and Mia Malkova in 2019",
    "all",
    draft({
      performers: { mode: "all", names: [c("Riley Reid"), c("Mia Malkova")] },
      year: { from: 2019, to: 2019, source: "2019" },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [
        { name: "Riley Reid", stashdb: S(11), tpdb: T(11) },
        { name: "Mia Malkova", stashdb: S(12) },
      ],
      year: "2019",
    }),
  );
  assert.deepEqual(result.notes, []);
});

test("Scenes: a performer keeps the TPDB id beside a year", async () => {
  const result = await run(
    "Riley Reid scenes from 2019",
    "scene",
    draft({
      performers: { mode: "all", names: [c("Riley Reid")] },
      year: { from: 2019, to: 2019, source: "2019" },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11), tpdb: T(11) }],
      year: "2019",
    }),
  );
  assert.deepEqual(result.notes, []);
});

test("Movies: a performer refuses title words, studios, year, date and sort but keeps tags", async () => {
  const fake = fakeLookups({ ...PEOPLE, tags: TAGS });
  const result = await run(
    "blonde Riley Reid movies titled office from Vixen in 2019 after 2020-01-01 newest first",
    "movie",
    draft({
      titleWords: c("office"),
      include: [{ alternatives: [c("blonde")] }],
      performers: { mode: "all", names: [c("Riley Reid")] },
      studios: { names: [c("Vixen")], withChildren: null },
      year: { from: 2019, to: 2019, source: "2019" },
      date: { operation: ">", date: "2020-01-01", source: "after 2020-01-01" },
      sort: { key: "recency", direction: "desc", source: "newest first" },
    }),
    fake,
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      include: [BLONDE],
      performers: [{ name: "Riley Reid", tpdb: T(11), stashdb: S(11) }],
    }),
  );
  const suffix = "(cannot combine with the TPDB performer filter)";
  assert.deepEqual(result.notes, [
    note("cannot_combine", `Not applied: office ${suffix}`),
    note("cannot_combine", `Not applied: Vixen ${suffix}`),
    note("cannot_combine", `Not applied: 2019 ${suffix}`),
    note("cannot_combine", `Not applied: after 2020-01-01 ${suffix}`),
    note("cannot_combine", `Not applied: Release recency ${suffix}`),
  ]);
  assert.ok(!fake.calls.some((call) => call.includes(":studio:")));
});

test("followed performers with a named performer are cannot_combine", async () => {
  const result = await run(
    "Riley Reid or performers I follow",
    "scene",
    draft({
      performers: { mode: "all", names: [c("Riley Reid")] },
      followedPerformers: { source: "performers I follow" },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      performers: [{ name: "Riley Reid", stashdb: S(11), tpdb: T(11) }],
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "cannot_combine",
      "Not applied: performers I follow (cannot combine with a named performer)",
    ),
  ]);
});

test("followed performers on Movies are not_available", async () => {
  const result = await run(
    "movies with performers I follow",
    "movie",
    draft({ followedPerformers: { source: "performers I follow" } }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: performers I follow (followed performers apply to scenes only)",
    ),
  ]);
});

test("a date beside a year is cannot_combine", async () => {
  const result = await run(
    "from 2019 since 2020-01-01",
    "all",
    draft({
      year: { from: 2019, to: 2019, source: "2019" },
      date: { operation: ">=", date: "2020-01-01", source: "since 2020-01-01" },
    }),
  );
  assert.deepEqual(decoded(result.params), patch({ year: "2019" }));
  assert.deepEqual(result.notes, [
    note(
      "cannot_combine",
      "Not applied: on or after 2020-01-01 (cannot combine with a year)",
    ),
  ]);
});

test("child studios need a studio", async () => {
  const result = await run(
    "scenes from sub-studios",
    "scene",
    draft({ studios: { names: [], withChildren: { source: "sub-studios" } } }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: sub-studios (child studios need a studio)",
    ),
  ]);
});

test("child studios on Movies are not_available and the studio stays exact", async () => {
  const result = await run(
    "Vixen and its sub-studios",
    "movie",
    draft({
      studios: {
        names: [c("Vixen")],
        withChildren: { source: "its sub-studios" },
      },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({ studios: [{ name: "Vixen", tpdb: T(21), stashdb: S(21) }] }),
  );
  assert.deepEqual(result.notes, [
    note(
      "not_available",
      "Not applied: its sub-studios (child studios apply to StashDB scenes only)",
    ),
  ]);
});

test("child studios on Scenes set withChildren and drop the TPDB studio id silently", async () => {
  const result = await run(
    "Vixen and its sub-studios",
    "scene",
    draft({
      studios: {
        names: [c("Vixen")],
        withChildren: { source: "its sub-studios" },
      },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      studios: [{ name: "Vixen", stashdb: S(21) }],
      studioMode: "withChildren",
    }),
  );
  assert.deepEqual(result.notes, []);
});

test("child studios on All drop the TPDB studio id with left_out", async () => {
  const result = await run(
    "Vixen and its sub-studios",
    "all",
    draft({
      studios: {
        names: [c("Vixen")],
        withChildren: { source: "its sub-studios" },
      },
    }),
    fakeLookups(PEOPLE),
  );
  assert.deepEqual(
    decoded(result.params),
    patch({
      studios: [{ name: "Vixen", stashdb: S(21) }],
      studioMode: "withChildren",
    }),
  );
  assert.deepEqual(result.notes, [
    note(
      "left_out",
      "Left out the TPDB ids of Vixen: child studios apply to StashDB scenes only",
    ),
  ]);
});

// --- skipped, order, nothing applied, replace ---

test("skipped parts are listed only when cited", async () => {
  const result = await run(
    "rated 5 stars, something odd",
    "all",
    draft({
      skipped: [
        { text: "rated 5 stars", reason: "not_a_filter" },
        { text: "something odd", reason: "unclear" },
        { text: "in 4K", reason: "not_a_filter" },
      ],
    }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("not_a_filter", "Not applied: rated 5 stars (not a browse filter)"),
    note("unclear", "Not applied: something odd (unclear)"),
  ]);
});

test("notes come back in draft order", async () => {
  const result = await run(
    "blonde scenes with Nobody and Someone, by title, rated 5 stars",
    "all",
    draft({
      // Keys deliberately out of field order: the order is the field index.
      skipped: [{ text: "rated 5 stars", reason: "not_a_filter" }],
      sort: { key: "title", direction: "asc", source: "by title" },
      performers: { mode: "all", names: [c("Nobody"), c("Someone")] },
      include: [{ alternatives: [c("blonde")] }],
      titleWords: c("zzz"),
      type: { value: "movie", source: "films" },
    }),
  );
  assert.equal(result.params, null);
  assert.deepEqual(result.notes, [
    note("not_in_text", "Not applied: movies (not found in your text)"),
    note("not_in_text", "Not applied: zzz (not found in your text)"),
    note("no_matching_tag", "Not applied: blonde (no matching tag)"),
    note("no_exact_match", "Not applied: Nobody (no exact match)"),
    note("no_exact_match", "Not applied: Someone (no exact match)"),
    note(
      "not_available",
      "Not applied: Title (this order is not available here)",
    ),
    note("not_a_filter", "Not applied: rated 5 stars (not a browse filter)"),
  ]);
});

test("an empty draft applies nothing", async () => {
  const result = await run("hello there", "scene", draft());
  assert.deepEqual(result, { params: null, notes: [] });
});

test("a replace patch nulls every browse key except perPage and type, and sets name null", async () => {
  const result = await run(
    "office",
    "movie",
    draft({ titleWords: c("office") }),
  );
  assert.ok(result.params);
  const expected = [
    ...BROWSE_KEYS.filter((k) => k !== "perPage" && k !== "type"),
    "name",
  ].sort();
  assert.deepEqual(Object.keys(result.params).sort(), expected);
  for (const key of expected) {
    assert.equal(result.params[key], key === "q" ? "office" : null, key);
  }
  for (const legacy of [
    "performerTpdb",
    "performerStashdb",
    "studioTpdb",
    "studioStashdb",
  ]) {
    assert.equal(result.params[legacy], null, legacy);
  }
});

// --- property: whatever the model returns, the map stays honest ---

/** Deterministic echo provider: every tag word w has a TPDB and a StashDB tag
 * named exactly w, and every name n has exactly one record named n per
 * provider. Ids derive from (category, nf(value)); `owner` maps an id back
 * so the property can check where every applied id came from. Every third
 * record has no counterpart. */
function echoLookups() {
  const numbers = new Map<string, number>();
  const owner = new Map<string, string>();
  const idFor = (category: "tag" | Kind, provider: Provider, key: string) => {
    const slot = `${category}:${key}`;
    let n = numbers.get(slot);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(slot, n);
    }
    const lane = { tag: "0", performer: "1", studio: "2" }[category];
    const id = `${provider === "tpdb" ? "a" : "b"}${lane}000000-0000-4000-8000-${n
      .toString(16)
      .padStart(12, "0")}`;
    owner.set(id, slot);
    return id;
  };
  const lookups: ProseLookups = {
    configured: () => true,
    async searchTags(p, word) {
      return [{ id: idFor("tag", p, nf(word)), name: word }];
    },
    async searchNames(p, kind, name) {
      return [{ id: idFor(kind, p, nf(name)), name, aliases: [] }];
    },
    async counterpart(kind, p, id) {
      const slot = owner.get(id.toLowerCase());
      if (slot === undefined) return undefined;
      if (numbers.get(slot)! % 3 === 0) return undefined;
      const other = p === "tpdb" ? "stashdb" : "tpdb";
      return idFor(kind, other, slot.slice(kind.length + 1));
    },
  };
  return { lookups, owner };
}

const VOCAB = [
  "blonde",
  "redhead",
  "Riley Reid",
  "Mia Malkova",
  "Vixen",
  "Blacked",
  "2019",
  "the 2010s",
  "last year",
  "after 2020-03-01",
  "newest first",
  "by title",
  "movies",
  "scenes",
  "or",
  "and",
  "performers I follow",
  "sub-studios",
  "rated 5 stars",
];

const proseArb = fc
  .array(fc.oneof(fc.constantFrom(...VOCAB), fc.string({ maxLength: 10 })), {
    minLength: 1,
    maxLength: 12,
  })
  .map((parts) => parts.join(" "));

/** Draft-shaped values whose sources are mostly prose substrings, so many
 * values cite and reach the lookups. */
function draftArb(prose: string) {
  const source = fc.oneof(
    fc
      .tuple(fc.nat({ max: prose.length }), fc.integer({ min: 0, max: 30 }))
      .map(([start, length]) => prose.slice(start, start + length)),
    fc.constantFrom(...VOCAB),
    fc.string({ maxLength: 8 }),
  );
  const cited = fc.oneof(
    source.map((s) => ({ value: s, source: s })),
    fc.record({ value: fc.oneof(source, fc.constantFrom(...VOCAB)), source }),
  );
  const year = fc.integer({ min: 1890, max: 2110 });
  return fc.record({
    type: fc.option(
      fc.record({ value: fc.constantFrom("movie", "scene", "all"), source }),
      { nil: null },
    ),
    titleWords: fc.option(cited, { nil: null }),
    include: fc.array(
      fc.record({
        alternatives: fc.array(cited, { minLength: 1, maxLength: 4 }),
      }),
      { maxLength: 4 },
    ),
    exclude: fc.array(cited, { maxLength: 4 }),
    performers: fc.record({
      mode: fc.constantFrom("all", "any"),
      names: fc.array(cited, { maxLength: 7 }),
    }),
    studios: fc.record({
      names: fc.array(cited, { maxLength: 7 }),
      withChildren: fc.option(fc.record({ source }), { nil: null }),
    }),
    followedPerformers: fc.option(fc.record({ source }), { nil: null }),
    year: fc.option(fc.record({ from: year, to: year, source }), {
      nil: null,
    }),
    date: fc.option(
      fc.record({
        operation: fc.constantFrom("<", "<=", "=", ">=", ">"),
        date: fc.oneof(
          fc.constantFrom("2020-03-01", "2019-12-31", "2021-02-30"),
          fc.string({ maxLength: 10 }),
        ),
        source,
      }),
      { nil: null },
    ),
    sort: fc.option(
      fc.record({
        key: fc.constantFrom(...SORT_KEYS),
        direction: fc.constantFrom(null, "asc", "desc"),
        source,
      }),
      { nil: null },
    ),
    skipped: fc.array(
      fc.record({
        text: source,
        reason: fc.constantFrom("not_a_filter", "unclear"),
      }),
      { maxLength: 3 },
    ),
  });
}

const caseArb = fc
  .tuple(proseArb, fc.constantFrom<BrowseTab>("all", "movie", "scene"))
  .chain(([prose, tab]) =>
    fc.record({
      prose: fc.constant(prose),
      tab: fc.constant(tab),
      input: fc.oneof(
        { arbitrary: draftArb(prose) as fc.Arbitrary<unknown>, weight: 6 },
        {
          arbitrary: draftArb(prose).map((d) => ({
            ...d,
            extra: 1,
          })) as fc.Arbitrary<unknown>,
          weight: 1,
        },
        { arbitrary: fc.jsonValue() as fc.Arbitrary<unknown>, weight: 1 },
      ),
    }),
  );

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

test("property: a mapped draft yields only browse keys that Browse accepts, each from a cited value", async () => {
  const allowed = new Set<string>([
    ...BROWSE_KEYS.filter((k) => k !== "perPage"),
    "name",
  ]);
  await fc.assert(
    fc.asyncProperty(caseArb, async ({ prose, tab, input }) => {
      const parsed = parseProseDraft(input);
      if (!parsed.ok) return;
      const d = parsed.draft;
      const fake = echoLookups();
      const result = await mapProseDraft(
        { prose, tab, draft: d },
        fake.lookups,
      );
      assert.ok(Array.isArray(result.notes));
      const params = result.params;
      if (params === null) return;
      for (const key of Object.keys(params)) {
        assert.ok(allowed.has(key), `unexpected key ${key}`);
      }

      // The route's final check, built exactly as runProseSearch builds it.
      const sp = new URLSearchParams();
      const type = "type" in params ? params.type : tab;
      if (type && type !== "all") sp.set("type", type);
      for (const [key, value] of Object.entries(params)) {
        if (key !== "type" && value !== null && value !== "") {
          sp.set(key, value);
        }
      }
      planBrowseSides(parseBrowseQuery(sp));

      // Provenance: every applied value comes from a cited draft value.
      const isCited = (s: string) =>
        fold(s) !== "" && fold(prose).includes(fold(s));
      const citedKeys = (values: Cited<string>[]) =>
        new Set(
          values.filter((v) => isCited(v.source)).map((v) => nf(v.value)),
        );
      if ("type" in params) {
        assert.ok(d.type && isCited(d.type.source), "type from a cited type");
      }
      if (params.q != null) {
        assert.ok(d.titleWords && isCited(d.titleWords.source));
        assert.equal(params.q, d.titleWords.value.trim());
      }
      const tagLists: [string, Set<string>][] = [
        ["include", citedKeys(d.include.flatMap((t) => t.alternatives))],
        ["exclude", citedKeys(d.exclude)],
      ];
      for (const [key, keys] of tagLists) {
        const raw: string | null | undefined = params[key];
        if (raw == null) continue;
        const selections: Record<string, string>[] = (
          JSON.parse(raw) as (
            Record<string, string> | Record<string, string>[]
          )[]
        ).flat();
        for (const sel of selections) {
          const name = nf(sel.name ?? "");
          assert.ok(keys.has(name), `${key} ${sel.name} from a cited word`);
          for (const id of [sel.tpdb, sel.stashdb] as (string | undefined)[]) {
            if (id !== undefined)
              assert.equal(fake.owner.get(id), `tag:${name}`);
          }
        }
      }
      const entityLists: [string, Kind, Set<string>][] = [
        ["performers", "performer", citedKeys(d.performers.names)],
        ["studios", "studio", citedKeys(d.studios.names)],
      ];
      for (const [key, kind, keys] of entityLists) {
        const raw: string | null | undefined = params[key];
        if (raw == null) continue;
        for (const entry of JSON.parse(raw) as Record<string, string>[]) {
          for (const id of [entry.tpdb, entry.stashdb]) {
            if (id === undefined) continue;
            const slot: string = fake.owner.get(id) ?? "";
            assert.ok(slot.startsWith(`${kind}:`), `${key} id ${id}`);
            assert.ok(
              keys.has(slot.slice(kind.length + 1)),
              `${key} from a cited name`,
            );
          }
          if (entry.name !== undefined) {
            assert.ok(keys.has(nf(entry.name)), `${key} name ${entry.name}`);
          }
        }
      }
      for (const key of ["year", "yearTo"]) {
        if (params[key] == null) continue;
        assert.ok(d.year && isCited(d.year.source), `${key} from a cited year`);
        assert.ok(
          [d.year.from, d.year.to].includes(Number(params[key])),
          `${key} is a drafted bound`,
        );
      }
      if (params.date != null) {
        assert.ok(d.date && isCited(d.date.source));
        assert.equal(params.date, d.date.date);
      }
      if (params.sort != null) {
        assert.ok(d.sort && isCited(d.sort.source));
        const twin =
          d.sort.key === "recency"
            ? "date"
            : d.sort.key === "date"
              ? "recency"
              : d.sort.key;
        assert.ok([d.sort.key, twin].includes(params.sort as never));
      }
      if (params.performerStarred != null) {
        assert.ok(d.followedPerformers && isCited(d.followedPerformers.source));
      }
      if (params.studioMode != null) {
        assert.ok(
          d.studios.withChildren && isCited(d.studios.withChildren.source),
        );
      }
    }),
  );
});
