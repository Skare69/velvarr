import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSE_KEYS,
  clearBrowseKeys,
  countActiveFilters,
  performerStashdbPatch,
  performerTpdbPatch,
  sortsFor,
  starredPatch,
  typePatch,
} from "../src/lib/browse-url.ts";
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

test("sortsFor pins the per-type lists as shipped (server MIXED_SORTS is the authority; known drift on All)", () => {
  assert.deepEqual(sortsFor("all"), ["date", "duration"]);
  assert.deepEqual(sortsFor("movie"), ["relevance", "recency", "duration"]);
  assert.deepEqual(sortsFor("scene"), [
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
  assert.deepEqual(typePatch("all", "recency", "desc"), {
    type: null,
    sort: null,
    direction: null,
  });
  assert.deepEqual(typePatch("movie", "recency", "desc"), {
    type: "movie",
    sort: "recency",
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
});
