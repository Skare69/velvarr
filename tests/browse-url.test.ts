import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSE_KEYS,
  clearBrowseKeys,
  countActiveFilters,
  performerModePatch,
  performersPatch,
  starredPatch,
  studiosPatch,
  typePatch,
  yearRangePatch,
  type BrowseEntryState,
} from "../src/lib/browse-url.ts";
import { browseSortsFor, SORT_KEYS } from "../src/lib/sorts.ts";
import {
  parseBrowseQuery,
  planBrowseSides,
  type BrowsePlan,
} from "../src/server/browse.ts";
import { AppError } from "../src/server/http.ts";
import {
  CATALOG_YEAR_MAX,
  CATALOG_YEAR_MIN,
  type BrowseEntity,
} from "../src/lib/contracts.ts";
import fc from "fast-check";

// The drawer's starting state for the patch builders: the URL's tab, sort
// and entity lists exactly as browse-url's BrowseEntryState carries them.
const state = (
  overrides: Partial<BrowseEntryState> = {},
): BrowseEntryState => ({
  type: "all",
  sortRaw: "duration",
  dirRaw: "asc",
  performerMode: "all",
  performers: [],
  studios: [],
  performerStarred: false,
  ...overrides,
});

test("BROWSE_KEYS is the 20 canonical browse keys; the four legacy scalars stay listed", () => {
  // Contract move (VELV-166): performers/studios became JSON-array keys
  // beside performerMode/yearTo. The four scalar keys stay listed so
  // clearBrowseKeys still deletes them — only the server's legacy parse
  // and legacyBrowsePatch read them.
  assert.deepEqual([...BROWSE_KEYS].sort(), [
    "date",
    "date_operation",
    "direction",
    "exclude",
    "include",
    "perPage",
    "performerMode",
    "performerStarred",
    "performerStashdb",
    "performerTpdb",
    "performers",
    "q",
    "sort",
    "studioMode",
    "studioStashdb",
    "studioTpdb",
    "studios",
    "type",
    "year",
    "yearTo",
  ]);
  assert.ok(BROWSE_KEYS.includes("performerStarred"));
  assert.ok(BROWSE_KEYS.includes("performers"));
  assert.ok(BROWSE_KEYS.includes("studios"));
  assert.ok(BROWSE_KEYS.includes("performerMode"));
  assert.ok(BROWSE_KEYS.includes("yearTo"));
});

test("clearBrowseKeys nulls every key; keep spares exactly the named keys", () => {
  const all = clearBrowseKeys();
  for (const key of BROWSE_KEYS) assert.equal(all[key], null);
  const kept = clearBrowseKeys(["type", "perPage"]);
  assert.deepEqual(Object.keys(kept).sort(), [
    "date",
    "date_operation",
    "direction",
    "exclude",
    "include",
    "performerMode",
    "performerStarred",
    "performerStashdb",
    "performerTpdb",
    "performers",
    "q",
    "sort",
    "studioMode",
    "studioStashdb",
    "studioTpdb",
    "studios",
    "year",
    "yearTo",
  ]);
  // Callers spread extras after: the extra wins.
  assert.equal({ ...clearBrowseKeys(), type: "scene" }.type, "scene");
});

test("browseSortsFor offers exactly the shared table's per-tab sets", () => {
  // The offers derive from SORT_CAPABILITIES (lib/sorts.ts): the old All
  // pin (date+duration, drift against the server's mixed set) is gone —
  // All offers the merged set recency+duration, which the server accepts.
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

test("typePatch keeps a supported sort and drops an unsupported one", () => {
  // No entities: the patch is the plain tab-switch shape.
  assert.deepEqual(typePatch("all", "duration", "asc", [], "all", []), {
    type: null,
    sort: "duration",
    direction: "asc",
  });
  // recency is a merged All sort: kept, with its direction.
  assert.deepEqual(typePatch("all", "recency", "desc", [], "all", []), {
    type: null,
    sort: "recency",
    direction: "desc",
  });
  assert.deepEqual(typePatch("movie", "recency", "desc", [], "all", []), {
    type: "movie",
    sort: "recency",
    direction: "desc",
  });
  // relevance takes no direction: a stale direction is dropped, not sent.
  assert.deepEqual(typePatch("movie", "relevance", "desc", [], "all", []), {
    type: "movie",
    sort: "relevance",
    direction: null,
  });
  // A malformed direction value is dropped rather than sent into a 400.
  assert.deepEqual(typePatch("movie", "recency", "sideways", [], "all", []), {
    type: "movie",
    sort: "recency",
    direction: null,
  });
});

test("typePatch drops filmography-refused filters when TPDB entries leave the Scenes tab", () => {
  // The filmography route runs wherever TPDB qualifies (all/movie tabs);
  // moving there drops exactly what planBrowseSides refuses: query, year
  // range, date, sort — and the studios, unless a stashdb half survives
  // (that side still qualifies on All/Movies).
  const performer: BrowseEntity[] = [{ tpdb: "p1" }];
  assert.deepEqual(
    typePatch("movie", "duration", "desc", performer, "all", []),
    {
      type: "movie",
      q: null,
      year: null,
      yearTo: null,
      date: null,
      date_operation: null,
      sort: null,
      direction: null,
      studios: null,
    },
  );
  assert.deepEqual(typePatch("all", "duration", "desc", performer, "all", []), {
    type: null,
    q: null,
    year: null,
    yearTo: null,
    date: null,
    date_operation: null,
    sort: null,
    direction: null,
    studios: null,
  });
  // Studios rewrite to their stashdb halves (the URL carries JSON); a
  // tpdb-only studio drops out with the studio constraint it carried.
  const stashOnly: BrowseEntity[] = [{ stashdb: "s1" }];
  const unified: BrowseEntity[] = [
    { name: "Vixen", tpdb: "x1", stashdb: "s1" },
  ];
  assert.deepEqual(
    typePatch("movie", "duration", "desc", performer, "all", stashOnly).studios,
    JSON.stringify([{ stashdb: "s1" }]),
  );
  assert.deepEqual(
    typePatch("movie", "duration", "desc", performer, "all", unified).studios,
    JSON.stringify([{ name: "Vixen", stashdb: "s1" }]),
  );
  const tpdbOnlyStudio: BrowseEntity[] = [{ tpdb: "x1" }];
  assert.deepEqual(
    typePatch("movie", "duration", "desc", performer, "all", tpdbOnlyStudio)
      .studios,
    null,
  );
  // Any-mode performer pairs run the filmography route the same way.
  const pair: BrowseEntity[] = [{ tpdb: "p1" }, { tpdb: "p2" }];
  assert.deepEqual(
    typePatch("all", "title", "asc", pair, "any", []).sort,
    null,
  );
  // On the Scenes tab the pair composes: the stash side runs there, so the
  // normal per-type sort path applies — never the filmography reset.
  const unifiedPair: BrowseEntity[] = [{ tpdb: "p1", stashdb: "s1" }];
  assert.deepEqual(
    typePatch("scene", "duration", "desc", unifiedPair, "all", []),
    { type: "scene", sort: "duration", direction: "desc" },
  );
});

test("starredPatch off is a single null; on drops the performer entries and clamps movies to All", () => {
  assert.deepEqual(starredPatch(false, "all", "duration", "asc"), {
    performerStarred: null,
  });
  // Contract move (VELV-166): the picked performers ride the array keys —
  // the patch nulls the entries AND the legacy scalars.
  assert.deepEqual(starredPatch(true, "movie", "duration", "asc"), {
    performerStarred: "1",
    performers: null,
    performerMode: null,
    performerTpdb: null,
    performerStashdb: null,
    type: null,
    sort: "duration",
    direction: "asc",
  });
  // relevance is not an all-tab sort: the clamp drops it.
  assert.deepEqual(starredPatch(true, "movie", "relevance", "desc"), {
    performerStarred: "1",
    performers: null,
    performerMode: null,
    performerTpdb: null,
    performerStashdb: null,
    type: null,
    sort: null,
    direction: null,
  });
  const scene = starredPatch(true, "scene", "title", "asc");
  assert.equal(scene.type, undefined);
  assert.equal(scene.performers, null);
  assert.equal(scene.performerTpdb, null);
});

test("performersPatch replaces the list wholesale and drops starred", () => {
  // A stashdb-only pick on All keeps the scene side running with no other
  // clamp; a tpdb-known pick would start the filmography route (its reset
  // is pinned below).
  const next: BrowseEntity[] = [{ name: "Jane", stashdb: "s1" }];
  assert.deepEqual(performersPatch(next, state()), {
    performers: JSON.stringify(next),
    performerStarred: null,
  });
  // Emptying the list deletes the key; starred still drops (a change
  // always exits the starred filter, which refuses picked performers).
  assert.deepEqual(performersPatch([], state({ performerStarred: true })), {
    performers: null,
    performerStarred: null,
  });
  // An all-mode pair of one-sided entries qualifies NO side, even on All:
  // each source must know EVERY entry, so the patch clamps to the combined
  // browse (type already null on All; the sort re-clamps).
  const mixed: BrowseEntity[] = [{ tpdb: "p1" }, { stashdb: "s1" }];
  assert.deepEqual(performersPatch(mixed, state()), {
    performers: JSON.stringify(mixed),
    performerStarred: null,
    type: null,
    sort: "duration",
    direction: "asc",
  });
});

test("performersPatch clamps to All when no side qualifies on the tab", () => {
  // A tpdb-only pick on the Scenes tab: TPDB cannot run there and the
  // pick disqualifies stash — the grid would show an empty page naming
  // the wrong cause, so the patch drops to the combined browse.
  const next: BrowseEntity[] = [{ tpdb: "p1" }];
  assert.deepEqual(
    performersPatch(
      next,
      state({ type: "scene", sortRaw: "duration", dirRaw: "asc" }),
    ),
    {
      performers: JSON.stringify(next),
      performerStarred: null,
      type: null,
      sort: "duration",
      direction: "asc",
    },
  );
  // `title` is not an All sort: the clamp drops it, like starredPatch does.
  assert.deepEqual(
    performersPatch(
      next,
      state({ type: "scene", sortRaw: "title", dirRaw: "bad" }),
    ),
    {
      performers: JSON.stringify(next),
      performerStarred: null,
      type: null,
      sort: null,
      direction: null,
    },
  );
});

test("performersPatch applies the full filmography reset when the route runs after the change", () => {
  // Picking a tpdb-known performer on the Movies tab starts the filmography
  // route: it refuses query, includes, year range, date, studios and every
  // sort, so the same drop-set as before the array keys applies. The
  // current studios must keep a side alive (a stashdb-only studio would
  // disqualify the tpdb side in all mode and clamp instead).
  const next: BrowseEntity[] = [{ tpdb: "p1" }];
  const patch = performersPatch(
    next,
    state({
      type: "movie",
      performerMode: "any",
      studios: [{ tpdb: "x1" }],
    }),
  );
  assert.equal(patch.performers, JSON.stringify(next));
  assert.equal(patch.q, null);
  assert.equal(patch.include, null);
  assert.equal(patch.exclude, null);
  assert.equal(patch.year, null);
  assert.equal(patch.yearTo, null);
  assert.equal(patch.date, null);
  assert.equal(patch.date_operation, null);
  assert.equal(patch.studios, null);
  assert.equal(patch.studioMode, null);
  assert.equal(patch.sort, null);
  assert.equal(patch.direction, null);
  // `name` names the facet heading of the studio/tag constraints the reset
  // drops, so it dies with them.
  assert.equal(patch.name, null);
  // The tab stays out of the patch: Movies keeps running the route.
  assert.equal("type" in patch, false);
});

test("studiosPatch replaces the list; its only clamp is a tab neither source qualifies on", () => {
  const next: BrowseEntity[] = [{ stashdb: "s1" }];
  assert.deepEqual(studiosPatch(next, state()), {
    studios: JSON.stringify(next),
  });
  // Studios compose freely: no filmography reset, no starred interaction.
  const patch = studiosPatch(
    next,
    state({
      type: "scene",
      performers: [{ stashdb: "p1" }],
      performerMode: "any",
    }),
  );
  assert.deepEqual(patch, { studios: JSON.stringify(next) });
  // Clamps only when both sides die: a tpdb-only pick beside tpdb-only
  // performers on the Scenes tab.
  const tpdbOnly: BrowseEntity[] = [{ tpdb: "x1" }];
  const clamped = studiosPatch(
    tpdbOnly,
    state({
      type: "scene",
      performers: [{ tpdb: "p1" }],
      sortRaw: "duration",
      dirRaw: "asc",
    }),
  );
  assert.deepEqual(clamped, {
    studios: JSON.stringify(tpdbOnly),
    type: null,
    sort: "duration",
    direction: "asc",
  });
});

test("performerModePatch rides only the non-default mode", () => {
  // `all` is the default: it never rides the URL.
  assert.deepEqual(performerModePatch("all"), { performerMode: null });
  assert.deepEqual(performerModePatch("any"), { performerMode: "any" });
});

test("yearRangePatch writes the pair, deletes an absent or repeated upper bound, and refuses date windows", () => {
  // A real range keeps both bounds and drops any date window.
  assert.deepEqual(yearRangePatch("1990", "2000"), {
    year: "1990",
    yearTo: "2000",
    date: null,
    date_operation: null,
  });
  // An empty upper bound deletes yearTo (the range ends at year).
  assert.deepEqual(yearRangePatch("1990", ""), {
    year: "1990",
    yearTo: null,
    date: null,
    date_operation: null,
  });
  // A repeated year is a single-year window: yearTo stays off the URL.
  assert.deepEqual(yearRangePatch("1990", "1990"), {
    year: "1990",
    yearTo: null,
    date: null,
    date_operation: null,
  });
  // An empty lower bound clears the whole range.
  assert.deepEqual(yearRangePatch("", ""), {
    year: null,
    yearTo: null,
    date: null,
    date_operation: null,
  });
});

test("countActiveFilters counts scalars and arrays, skips the carriers and the new keys", () => {
  assert.equal(countActiveFilters({}), 0);
  assert.equal(
    countActiveFilters({
      q: "x",
      year: "2020",
      yearTo: "2021",
      sort: "duration",
      performerStarred: true,
    }),
    // yearTo is a range bound of `year`, not a filter of its own.
    4,
  );
  assert.equal(
    countActiveFilters({
      performers: [{}, {}, {}],
      studios: [{}, {}],
      performerMode: "any",
    }),
    // Entry arrays count their entries; performerMode is a carrier.
    5,
  );
  assert.equal(
    countActiveFilters({
      include: [{ name: "a", href: "#" }],
      exclude: [
        { name: "b", href: "#" },
        { name: "c", href: "#" },
      ],
    }),
    3,
  );
  assert.equal(
    countActiveFilters({
      type: "movie",
      perPage: "60",
      direction: "asc",
      date_operation: "=",
      performerMode: "any",
      yearTo: "2020",
    }),
    0,
  );
});

// Mirror test: every patch this module emits must parse into a query the
// server's planBrowseSides accepts — the client policy never forms a 400.
function patchToQuery(patch: Record<string, string | null>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null) params.set(key, value);
  }
  return params;
}

function applyPatch(
  params: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) out.delete(key);
    else out.set(key, value);
  }
  return out;
}

function assertPlanAccepts(params: URLSearchParams): BrowsePlan {
  const plan = planBrowseSides(parseBrowseQuery(params));
  assert.ok(Array.isArray(plan.sides));
  return plan;
}

test("mirror: patched queries always pass parseBrowseQuery + planBrowseSides", () => {
  // parseBrowseQuery validates provider ids as UUIDs, so the mirror uses
  // well-formed ones — the parser must accept what the patches emit.
  const tpdbId = "55b0c8d6-1111-4222-8333-444455556666";
  const stashId = "55b0c8d6-aaaa-4bbb-8ccc-ddddeeeeffff";
  // Exclusivity pair never forms: starring after picked performers drops
  // them.
  assertPlanAccepts(
    patchToQuery(starredPatch(true, "movie", "duration", "asc")),
  );
  // A performer pick on the Scenes tab: the patch clamps to All, and the
  // clamped URL plans with at least one side.
  const tpdbOnly: BrowseEntity[] = [{ tpdb: tpdbId }];
  const clamped = performersPatch(
    tpdbOnly,
    state({
      type: "scene",
      sortRaw: "title",
      dirRaw: "asc",
      performers: [],
    }),
  );
  const clampedPlan = assertPlanAccepts(patchToQuery(clamped));
  assert.ok(clampedPlan.sides.length > 0);
  // The filmography reset after a pick on Movies: the patched URL carries
  // the performer entries and nothing the route refuses. The current
  // studios stay tpdb-known so the route's side keeps qualifying (a
  // stashdb-only studio would disqualify it in all mode and clamp).
  const filmPatch = performersPatch(
    [{ tpdb: tpdbId, stashdb: stashId }],
    state({
      type: "movie",
      studios: [{ tpdb: tpdbId }],
      performers: [],
    }),
  );
  const filmParams = patchToQuery({
    ...filmPatch,
    performers: filmPatch.performers ?? "",
  });
  assert.equal(filmParams.get("studios"), null);
  assert.equal(filmParams.get("yearTo"), null);
  const filmPlan = assertPlanAccepts(filmParams);
  assert.equal(filmPlan.filmography, true);
  // Studios compose on a typed tab: the patch never clamps a qualified tab.
  const studioState = state({
    type: "scene",
    performers: [{ stashdb: stashId }],
    performerMode: "any",
  });
  const studioPatch = studiosPatch([{ stashdb: stashId }], studioState);
  const studioParams = new URLSearchParams({
    type: "scene",
    performers: JSON.stringify([{ stashdb: stashId }]),
    performerMode: "any",
  });
  // URLSearchParams never deep-equals a plain object (its entries are not
  // own properties) — compare the patch object itself.
  assert.deepEqual(studiosPatch([{ stashdb: stashId }], studioState), {
    studios: JSON.stringify([{ stashdb: stashId }]),
  });
  assertPlanAccepts(applyPatch(studioParams, studioPatch));
  // A year range on All survives the mirror: parse + plan accept the pair.
  assertPlanAccepts(patchToQuery(yearRangePatch("1990", "2000")));
  assertPlanAccepts(
    applyPatch(
      new URLSearchParams("year=1990"),
      yearRangePatch("1990", "2000"),
    ),
  );
  // The all/any toggle alone never forms a 400 — even beside entries.
  const anyModeUrl = applyPatch(
    new URLSearchParams({
      performers: JSON.stringify([{ tpdb: tpdbId }, { stashdb: stashId }]),
    }),
    performerModePatch("any"),
  );
  assertPlanAccepts(anyModeUrl);
});

// --- property tests (fast-check, fixed seed 42 per property) ---

// DATE_OPS is not exported from src/server/browse.ts; inlined from its
// definition there (const DATE_OPS, ~line 88).
const DATE_OPS = ["<", "<=", "=", ">", ">="] as const;

test("property: parseBrowseQuery never throws non-AppError on arbitrary junk params", () => {
  // Oracle: total function — every input either returns or throws AppError.
  const junkKeys = ["x", "1", "type ", "sort", "year", "perPage", "date"];
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.constantFrom(...BROWSE_KEYS, ...junkKeys),
        fc.string({ maxLength: 40 }),
        {
          maxKeys: 6,
        },
      ),
      (map) => {
        try {
          parseBrowseQuery(new URLSearchParams(map));
        } catch (err) {
          assert.ok(
            err instanceof AppError,
            `expected AppError, got ${String(err)}`,
          );
        }
      },
    ),
    { seed: 42, numRuns: 100 },
  );
});

test("property: canonical query round trips through parseBrowseQuery unchanged", () => {
  // Oracle: serialization is canonical — parse(serialize(parse(q))) === parse(q).
  const isoDate = fc
    .tuple(
      fc.integer({ min: 1600, max: 2800 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    )
    .map(
      ([y, m, d]) =>
        `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  // Per-kind ids must not repeat (the parser refuses duplicates with
  // invalid_search — that refusal is pinned separately in browse.test.ts).
  const entityList = (
    kind: "performer" | "studio",
  ): fc.Arbitrary<{ name?: string; tpdb?: string; stashdb?: string }[]> =>
    fc.nat(4).chain((extra) => {
      const n = 1 + extra;
      return fc
        .tuple(
          fc.uniqueArray(
            kind === "studio"
              ? fc.oneof(
                  fc.uuid(),
                  fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
                )
              : fc.uuid(),
            { minLength: n, maxLength: n },
          ),
          fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n }),
          fc.array(fc.constantFrom("tpdb", "stashdb", "both"), {
            minLength: n,
            maxLength: n,
          }),
          fc.array(
            fc.option(fc.stringMatching(/^[a-z0-9]{1,20}$/), {
              nil: undefined,
            }),
            {
              minLength: n,
              maxLength: n,
            },
          ),
        )
        .map(([tpdbs, stashdbs, shapes, names]) => {
          let ti = 0;
          let si = 0;
          const out: {
            name?: string;
            tpdb?: string;
            stashdb?: string;
          }[] = [];
          for (let i = 0; i < n; i++) {
            const e: { name?: string; tpdb?: string; stashdb?: string } = {};
            if (names[i] !== undefined) e.name = names[i];
            if (shapes[i] !== "stashdb") e.tpdb = tpdbs[ti++];
            if (shapes[i] !== "tpdb") e.stashdb = stashdbs[si++];
            out.push(e);
          }
          return out;
        });
    });
  // Labels stay [a-z0-9]: punctuation-only labels normalize to nothing and
  // are rejected by parseTagSelections; spaces would break the trim round trip.
  const selection = fc.record({
    name: fc.stringMatching(/^[a-z0-9]{1,20}$/),
    tpdb: fc.option(fc.uuid(), { nil: undefined }),
    stashdb: fc.option(fc.uuid(), { nil: undefined }),
  });
  // parseTagSelections consolidates selections sharing a folded label
  // (normalizeFacetName), so the generator emits distinct labels. Generated
  // names are [a-z0-9], where the fold is the identity — distinct labels
  // can never merge, and the exact compare below measures parsing, not
  // consolidation.
  const selectionList = fc
    .array(selection, { maxLength: 3 })
    .map((list) => [
      ...new Map(list.map((s) => [s.name, s] as const)).values(),
    ]);
  // Stashdb-only entries: every entry carries a stashdb id, so the
  // withChildren server rule (needs a stashdb studio, refuses tpdb studios)
  // holds by construction instead of by post-hoc filtering.
  const stashOnlyStudios: fc.Arbitrary<
    { name?: string; tpdb?: string; stashdb?: string }[]
  > = fc.nat(4).chain((extra) => {
    const n = 1 + extra;
    return fc
      .tuple(
        fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n }),
        fc.array(
          fc.option(fc.stringMatching(/^[a-z0-9]{1,20}$/), { nil: undefined }),
          {
            minLength: n,
            maxLength: n,
          },
        ),
      )
      .map(([stashdbs, names]) =>
        stashdbs.map((stashdb, i) => ({
          ...(names[i] !== undefined ? { name: names[i] } : {}),
          stashdb,
        })),
      );
  });
  // The exclusivity rules are encoded in GENERATION, not fc.pre filters: a
  // filtered combination space rejects so many samples that shrinking
  // dominates the run time. One boolean decides each pairwise-exclusive
  // branch (date window vs year range, starred vs picks, withChildren vs
  // free studios); the sort's direction rides only an existing sort.
  const canonicalQueryArb = fc
    .record({
      type: fc.option(fc.constantFrom("all", "movie", "scene"), {
        nil: undefined,
      }),
      sort: fc.option(fc.constantFrom(...SORT_KEYS), { nil: undefined }),
      performerStarred: fc.boolean(),
      withChildren: fc.boolean(),
      useDate: fc.boolean(),
      performerMode: fc.option(fc.constantFrom("all", "any"), {
        nil: undefined,
      }),
      performers: entityList("performer"),
      studios: entityList("studio"),
      stashStudios: stashOnlyStudios,
      page: fc.integer({ min: 1, max: 1000 }),
      perPage: fc.integer({ min: 1, max: 100 }),
      // [a-z0-9] never trims to nothing.
      q: fc.option(fc.stringMatching(/^[a-z0-9]{1,40}$/), { nil: undefined }),
      include: fc.option(selectionList, { nil: undefined }),
      exclude: fc.option(selectionList, { nil: undefined }),
    })
    .chain((flags) =>
      fc.record({
        type: fc.constant(flags.type),
        sort: fc.constant(flags.sort),
        performerStarred: fc.constant(
          flags.performerStarred ? ("1" as const) : undefined,
        ),
        // Starred refuses picked performers of any shape.
        performers: flags.performerStarred
          ? fc.constant<{ name?: string; tpdb?: string; stashdb?: string }[]>(
              [],
            )
          : fc.constant(flags.performers),
        // withChildren needs a stashdb studio and refuses tpdb studios.
        studioMode: flags.withChildren
          ? fc.constant<"exact" | "withChildren" | undefined>("withChildren")
          : fc.option(fc.constantFrom("exact", "withChildren"), {
              nil: undefined,
            }),
        studios: fc.constant(
          flags.withChildren ? flags.stashStudios : flags.studios,
        ),
        performerMode: fc.constant(flags.performerMode),
        direction:
          flags.sort !== undefined
            ? fc.option(fc.constantFrom("asc", "desc"), { nil: undefined })
            : fc.constant<"asc" | "desc" | undefined>(undefined),
        // A date window and a year range are different release-time
        // vocabularies and never combine.
        date: flags.useDate
          ? fc.option(isoDate, { nil: undefined })
          : fc.constant<string | undefined>(undefined),
        dateOperation: flags.useDate
          ? fc.option(fc.constantFrom(...DATE_OPS), { nil: undefined })
          : fc.constant<string | undefined>(undefined),
        years: flags.useDate
          ? fc.constant<[number, number] | undefined>(undefined)
          : fc.option(
              fc.tuple(
                fc.integer({ min: CATALOG_YEAR_MIN, max: CATALOG_YEAR_MAX }),
                fc.integer({ min: CATALOG_YEAR_MIN, max: CATALOG_YEAR_MAX }),
              ),
              { nil: undefined },
            ),
        page: fc.constant(flags.page),
        perPage: fc.constant(flags.perPage),
        q: fc.constant(flags.q),
        include: fc.constant(flags.include),
        exclude: fc.constant(flags.exclude),
      }),
    )
    // date and date_operation always travel as a pair; the option nils
    // could still split them, so normalize instead of reject.
    .map((g) =>
      g.date === undefined || g.dateOperation === undefined
        ? { ...g, date: undefined, dateOperation: undefined }
        : g,
    );

  fc.assert(
    fc.property(canonicalQueryArb, (g) => {
      // The years tuple is a range: the parser refuses an inverted pair.
      const year = g.years !== undefined ? Math.min(...g.years) : undefined;
      const yearTo = g.years !== undefined ? Math.max(...g.years) : undefined;
      const params = new URLSearchParams();
      if (g.type !== undefined) params.set("type", g.type);
      if (g.studioMode !== undefined) params.set("studioMode", g.studioMode);
      if (g.sort !== undefined) params.set("sort", g.sort);
      if (g.direction !== undefined) params.set("direction", g.direction);
      if (g.date !== undefined) params.set("date", g.date);
      if (g.dateOperation !== undefined)
        params.set("date_operation", g.dateOperation);
      if (year !== undefined) params.set("year", String(year));
      if (yearTo !== undefined && yearTo !== year)
        params.set("yearTo", String(yearTo));
      params.set("page", String(g.page));
      params.set("perPage", String(g.perPage));
      if (g.q !== undefined) params.set("q", g.q);
      if (g.performerStarred !== undefined)
        params.set("performerStarred", g.performerStarred);
      if (g.performerMode === "any") params.set("performerMode", "any");
      params.set("performers", JSON.stringify(g.performers));
      params.set("studios", JSON.stringify(g.studios));
      if (g.include !== undefined)
        params.set("include", JSON.stringify(g.include));
      if (g.exclude !== undefined)
        params.set("exclude", JSON.stringify(g.exclude));

      const p1 = parseBrowseQuery(params);
      // Input oracle: p1 must hold the generated fields themselves. The
      // p2 === p1 compare below cannot see a parser that drops a field —
      // a lossy parse round trips against itself.
      assert.equal(p1.type, g.type ?? "all");
      assert.equal(p1.studioMode, g.studioMode ?? "exact");
      assert.equal(p1.sort, g.sort);
      assert.equal(p1.direction, g.direction);
      assert.equal(p1.date, g.date);
      assert.equal(p1.dateOperation, g.dateOperation);
      assert.equal(p1.year, year);
      assert.equal(p1.yearTo, yearTo === year ? undefined : yearTo);
      assert.equal(p1.page, g.page);
      assert.equal(p1.perPage, g.perPage);
      assert.equal(p1.q, g.q);
      assert.equal(
        p1.performerStarred,
        g.performerStarred === "1" ? true : undefined,
      );
      assert.equal(p1.performerMode, g.performerMode === "any" ? "any" : "all");
      assert.deepEqual(
        p1.performers,
        g.performers.map((e) => ({
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.tpdb !== undefined ? { tpdb: e.tpdb } : {}),
          ...(e.stashdb !== undefined ? { stashdb: e.stashdb } : {}),
        })),
      );
      assert.deepEqual(
        p1.studios,
        g.studios.map((e) => ({
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.tpdb !== undefined ? { tpdb: e.tpdb } : {}),
          ...(e.stashdb !== undefined ? { stashdb: e.stashdb } : {}),
        })),
      );
      // fast-check records are null-prototype and deepStrictEqual compares
      // prototypes, so rebuild plain copies in the parser's own key shape
      // (ids present-but-undefined, as parseTagSelections emits).
      assert.deepEqual(
        p1.include,
        (g.include ?? []).map((s) => ({
          name: s.name,
          tpdb: s.tpdb,
          stashdb: s.stashdb,
        })),
      );
      assert.deepEqual(
        p1.exclude,
        (g.exclude ?? []).map((s) => ({
          name: s.name,
          tpdb: s.tpdb,
          stashdb: s.stashdb,
        })),
      );
      const out = new URLSearchParams();
      out.set("type", p1.type);
      out.set("studioMode", p1.studioMode);
      out.set("page", String(p1.page));
      out.set("perPage", String(p1.perPage));
      if (p1.q !== undefined) out.set("q", p1.q);
      if (p1.include.length > 0) out.set("include", JSON.stringify(p1.include));
      if (p1.exclude.length > 0) out.set("exclude", JSON.stringify(p1.exclude));
      out.set("performers", JSON.stringify(p1.performers));
      out.set("studios", JSON.stringify(p1.studios));
      if (p1.performerMode === "any") out.set("performerMode", "any");
      if (p1.performerStarred) out.set("performerStarred", "1");
      if (p1.date !== undefined && p1.dateOperation !== undefined) {
        out.set("date", p1.date);
        out.set("date_operation", p1.dateOperation);
      }
      if (p1.sort !== undefined) out.set("sort", p1.sort);
      if (p1.direction !== undefined) out.set("direction", p1.direction);
      if (p1.year !== undefined) out.set("year", String(p1.year));
      if (p1.yearTo !== undefined) out.set("yearTo", String(p1.yearTo));
      const p2 = parseBrowseQuery(out);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(p2)),
        JSON.parse(JSON.stringify(p1)),
      );
    }),
    { seed: 42, numRuns: 150 },
  );
});
