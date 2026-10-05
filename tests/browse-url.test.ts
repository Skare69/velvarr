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
import { browseSortsFor } from "../src/lib/sorts.ts";
import { parseBrowseQuery, planBrowseSides } from "../src/server/browse.ts";

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
