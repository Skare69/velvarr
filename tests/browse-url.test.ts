import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSE_KEYS,
  clearBrowseKeys,
  countActiveFilters,
  performerStashdbPatch,
  performerTpdbPatch,
  starredPatch,
  typePatch,
} from "../src/lib/browse-url.ts";
import { browseSortsFor, SORT_KEYS } from "../src/lib/sorts.ts";
import { parseBrowseQuery, planBrowseSides } from "../src/server/browse.ts";
import { AppError } from "../src/server/http.ts";
import { CATALOG_YEAR_MAX, CATALOG_YEAR_MIN } from "../src/lib/contracts.ts";
import fc from "fast-check";

test("BROWSE_KEYS is the 16 canonical browse keys, performerStarred included", () => {
  assert.deepEqual([...BROWSE_KEYS].sort(), [
    "date",
    "date_operation",
    "direction",
    "exclude",
    "include",
    "perPage",
    "performerStarred",
    "performerStashdb",
    "performerTpdb",
    "q",
    "sort",
    "studioMode",
    "studioStashdb",
    "studioTpdb",
    "type",
    "year",
  ]);
  assert.ok(BROWSE_KEYS.includes("performerStarred"));
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
    "performerStarred",
    "performerStashdb",
    "performerTpdb",
    "q",
    "sort",
    "studioMode",
    "studioStashdb",
    "studioTpdb",
    "year",
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

test("typePatch keeps a supported sort, drops an unsupported one", () => {
  assert.deepEqual(typePatch("all", "duration", "asc"), {
    type: null,
    sort: "duration",
    direction: "asc",
  });
  // recency is a merged All sort: kept, with its direction.
  assert.deepEqual(typePatch("all", "recency", "desc"), {
    type: null,
    sort: "recency",
    direction: "desc",
  });
  assert.deepEqual(typePatch("movie", "recency", "desc"), {
    type: "movie",
    sort: "recency",
    direction: "desc",
  });
  // relevance takes no direction: a stale direction is dropped, not sent.
  assert.deepEqual(typePatch("movie", "relevance", "desc"), {
    type: "movie",
    sort: "relevance",
    direction: null,
  });
  // A malformed direction value is dropped rather than sent into a 400.
  assert.deepEqual(typePatch("movie", "recency", "sideways"), {
    type: "movie",
    sort: "recency",
    direction: null,
  });
});

test("typePatch drops filmography-refused filters when a TPDB performer leaves Scenes", () => {
  // The filmography route only composes on the Scenes tab (the unified
  // pair runs the StashDB side there); moving to All/Movies drops exactly
  // what planBrowseSides refuses there, keeping the performer pick.
  assert.deepEqual(typePatch("movie", "duration", "desc", true), {
    type: "movie",
    q: null,
    year: null,
    date: null,
    date_operation: null,
    studioTpdb: null,
    sort: null,
    direction: null,
  });
  assert.deepEqual(typePatch("all", "duration", "desc", true), {
    type: null,
    q: null,
    year: null,
    date: null,
    date_operation: null,
    studioTpdb: null,
    sort: null,
    direction: null,
  });
  // On the Scenes tab the pair composes: the normal per-type sort path.
  assert.deepEqual(typePatch("scene", "duration", "desc", true), {
    type: "scene",
    sort: "duration",
    direction: "desc",
  });
});

test("starredPatch off is a single null; on drops both performer picks and clamps movies to All", () => {
  assert.deepEqual(starredPatch(false, "all", "duration", "asc"), {
    performerStarred: null,
  });
  assert.deepEqual(starredPatch(true, "movie", "duration", "asc"), {
    performerStarred: "1",
    performerTpdb: null,
    performerStashdb: null,
    type: null,
    sort: "duration",
    direction: "asc",
  });
  // relevance is not an all-tab sort: the clamp drops it.
  assert.deepEqual(starredPatch(true, "movie", "relevance", "desc"), {
    performerStarred: "1",
    performerTpdb: null,
    performerStashdb: null,
    type: null,
    sort: null,
    direction: null,
  });
  const scene = starredPatch(true, "scene", "title", "asc");
  assert.equal(scene.type, undefined);
  assert.equal(scene.performerTpdb, null);
  assert.equal(scene.performerStashdb, null);
});

test("performerTpdbPatch is the full filmography reset", () => {
  assert.deepEqual(performerTpdbPatch("p1", "scene"), {
    performerTpdb: "p1",
    performerStarred: null,
    q: null,
    include: null,
    exclude: null,
    year: null,
    date: null,
    date_operation: null,
    studioTpdb: null,
    studioStashdb: null,
    studioMode: null,
    sort: null,
    direction: null,
    // `name` is the facet tile's display heading; the reset drops the
    // studio/tag constraints it names, so the label dies with them
    // (a stale "Brazzers" heading must not survive a filmography jump).
    name: null,
    type: null,
  });
  // On the movie tab the type also stays out of the patch — the tab never
  // moves on a TPDB pick, only the scene tab drops to All.
  assert.equal("type" in performerTpdbPatch("p1", "movie"), false);
  // On the All tab the type stays out of the patch entirely — no flip.
  assert.equal("type" in performerTpdbPatch("p1", "all"), false);
});

test("performerStashdbPatch replaces starred and clamps movies to All", () => {
  assert.deepEqual(performerStashdbPatch("s1", "scene", "title", "asc"), {
    performerStashdb: "s1",
    performerStarred: null,
  });
  assert.deepEqual(performerStashdbPatch("s1", "movie", "duration", "desc"), {
    performerStashdb: "s1",
    performerStarred: null,
    type: null,
    sort: "duration",
    direction: "desc",
  });
  assert.deepEqual(performerStashdbPatch("s1", "movie", "relevance", "desc"), {
    performerStashdb: "s1",
    performerStarred: null,
    type: null,
    sort: null,
    direction: null,
  });
});

test("countActiveFilters counts scalars and tag arrays, skips type/perPage/direction/date_operation", () => {
  assert.equal(countActiveFilters({}), 0);
  assert.equal(
    countActiveFilters({
      q: "x",
      year: "2020",
      sort: "duration",
      performerStarred: true,
    }),
    4,
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

function assertPlanAccepts(patch: Record<string, string | null>): void {
  const plan = planBrowseSides(parseBrowseQuery(patchToQuery(patch)));
  assert.ok(Array.isArray(plan.sides));
}

test("mirror: patched queries always pass parseBrowseQuery + planBrowseSides", () => {
  // parseBrowseQuery validates provider ids as UUIDs, so the mirror uses
  // well-formed ones — the parser must accept what the patches emit.
  const tpdbId = "55b0c8d6-1111-4222-8333-444455556666";
  const stashId = "55b0c8d6-aaaa-4bbb-8ccc-ddddeeeeffff";
  // Exclusivity pair never forms: starred after a TPDB pick drops it.
  assertPlanAccepts(starredPatch(true, "movie", "duration", "asc"));
  // filmography refuses nothing it resets: TPDB pick on the scene tab.
  assertPlanAccepts(performerTpdbPatch(tpdbId, "scene"));
  // StashDB pick on the movie tab drops to All with a legal sort.
  assertPlanAccepts(
    performerStashdbPatch(stashId, "movie", "duration", "desc"),
  );
  // Tab switch off a Scenes filmography URL: the URL holds the unified
  // pair plus the filters and sort that tab allows; the patch to All or
  // Movies must strip everything the filmography route refuses before
  // parseBrowseQuery + planBrowseSides run.
  const scenesUrl = new URLSearchParams({
    type: "scene",
    performerTpdb: tpdbId,
    performerStashdb: stashId,
    q: "query",
    year: "2020",
    date: "2024-01-01",
    date_operation: ">=",
    studioTpdb: "55b0c8d6-2222-4333-8444-555566667777",
    sort: "duration",
    direction: "desc",
  });
  for (const target of ["all", "movie"] as const) {
    const params = new URLSearchParams(scenesUrl);
    const patch = typePatch(target, "duration", "desc", true);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const plan = planBrowseSides(parseBrowseQuery(params));
    assert.ok(plan.sides.length > 0);
    // On All both sides run the unified pair; on Movies only TPDB
    // qualifies (browse.ts sceneWanted is false there).
    if (target === "all") assert.ok(plan.sides.includes("stashdb"));
  }
});

// --- property tests (fast-check, global seed 42) ---

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
  // id fields: lowercase uuid; only studioTpdb also accepts a TPDB site
  // slug (mirrors SITE_SLUG_RE and the key check in parseId,
  // src/server/browse.ts).
  const idOrSlug = fc.option(
    fc.oneof(fc.uuid(), fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/)),
    { nil: undefined },
  );
  const idUuid = fc.option(fc.uuid(), { nil: undefined });
  // Labels stay [a-z0-9]: punctuation-only labels normalize to nothing and
  // are rejected by parseTagSelections; spaces would break the trim round trip.
  const selection = fc.record({
    name: fc.stringMatching(/^[a-z0-9]{1,20}$/),
    tpdb: fc.option(fc.uuid(), { nil: undefined }),
    stashdb: fc.option(fc.uuid(), { nil: undefined }),
  });
  const selectionList = fc.array(selection, { maxLength: 3 });

  fc.assert(
    fc.property(
      fc.record({
        type: fc.option(fc.constantFrom("all", "movie", "scene"), {
          nil: undefined,
        }),
        studioMode: fc.option(fc.constantFrom("exact", "withChildren"), {
          nil: undefined,
        }),
        sort: fc.option(fc.constantFrom(...SORT_KEYS), { nil: undefined }),
        direction: fc.option(fc.constantFrom("asc", "desc"), {
          nil: undefined,
        }),
        date: fc.option(isoDate, { nil: undefined }),
        dateOperation: fc.option(fc.constantFrom(...DATE_OPS), {
          nil: undefined,
        }),
        year: fc.option(
          fc.integer({ min: CATALOG_YEAR_MIN, max: CATALOG_YEAR_MAX }),
          { nil: undefined },
        ),
        page: fc.integer({ min: 1, max: 1000 }),
        perPage: fc.integer({ min: 1, max: 100 }),
        q: fc.option(
          fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.trim()),
          { nil: undefined },
        ),
        performerStarred: fc.option(fc.constant("1"), { nil: undefined }),
        studioTpdb: idOrSlug,
        studioStashdb: idUuid,
        performerTpdb: idUuid,
        performerStashdb: idUuid,
        include: fc.option(selectionList, { nil: undefined }),
        exclude: fc.option(selectionList, { nil: undefined }),
      }),
      (g) => {
        fc.pre(g.direction === undefined || g.sort !== undefined);
        fc.pre((g.date === undefined) === (g.dateOperation === undefined));
        fc.pre(g.q === undefined || g.q !== "");
        const params = new URLSearchParams();
        if (g.type !== undefined) params.set("type", g.type);
        if (g.studioMode !== undefined) params.set("studioMode", g.studioMode);
        if (g.sort !== undefined) params.set("sort", g.sort);
        if (g.direction !== undefined) params.set("direction", g.direction);
        if (g.date !== undefined) params.set("date", g.date);
        if (g.dateOperation !== undefined)
          params.set("date_operation", g.dateOperation);
        if (g.year !== undefined) params.set("year", String(g.year));
        params.set("page", String(g.page));
        params.set("perPage", String(g.perPage));
        if (g.q !== undefined) params.set("q", g.q);
        if (g.performerStarred !== undefined)
          params.set("performerStarred", g.performerStarred);
        for (const k of [
          "studioTpdb",
          "studioStashdb",
          "performerTpdb",
          "performerStashdb",
        ] as const) {
          const v = g[k];
          if (v !== undefined) params.set(k, v);
        }
        if (g.include !== undefined)
          params.set("include", JSON.stringify(g.include));
        if (g.exclude !== undefined)
          params.set("exclude", JSON.stringify(g.exclude));

        const p1 = parseBrowseQuery(params);
        const out = new URLSearchParams();
        out.set("type", p1.type);
        out.set("studioMode", p1.studioMode);
        out.set("page", String(p1.page));
        out.set("perPage", String(p1.perPage));
        if (p1.q !== undefined) out.set("q", p1.q);
        if (p1.include.length > 0)
          out.set("include", JSON.stringify(p1.include));
        if (p1.exclude.length > 0)
          out.set("exclude", JSON.stringify(p1.exclude));
        for (const k of [
          "studioTpdb",
          "studioStashdb",
          "performerTpdb",
          "performerStashdb",
        ] as const) {
          const v = p1[k];
          if (v !== undefined) out.set(k, v);
        }
        if (p1.performerStarred) out.set("performerStarred", "1");
        if (p1.date !== undefined && p1.dateOperation !== undefined) {
          out.set("date", p1.date);
          out.set("date_operation", p1.dateOperation);
        }
        if (p1.sort !== undefined) out.set("sort", p1.sort);
        if (p1.direction !== undefined) out.set("direction", p1.direction);
        if (p1.year !== undefined) out.set("year", String(p1.year));
        const p2 = parseBrowseQuery(out);
        assert.deepStrictEqual(p2, p1);
      },
    ),
  );
});
