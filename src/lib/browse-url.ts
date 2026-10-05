// Client mirror of the server's planBrowseSides refusals (src/server/browse.ts):
// pure URL policy, no React, no IO. Every function returns a param patch for
// useParamsSetter — null deletes a key. The server side stays the authority;
// this module only keeps the URL from ever forming a request the server would
// 400. Adding a browse key is one edit in BROWSE_KEYS; changing an
// exclusivity rule is one function plus its test.

// Sort capability is the shared SORT_CAPABILITIES table (sorts.ts) — the
// same source the server's acceptance derives from — so the offers here can
// never drift from what the server accepts.
import {
  browseSortIsDirectional,
  browseSortsFor,
  type SortKey,
} from "./sorts.ts";

export type BrowseType = "all" | "movie" | "scene";

export const BROWSE_KEYS = [
  "type",
  "q",
  "include",
  "exclude",
  "studioTpdb",
  "studioStashdb",
  "performerTpdb",
  "performerStashdb",
  "performerStarred",
  "studioMode",
  "year",
  "date",
  "date_operation",
  "sort",
  "direction",
  "perPage",
] as const;

export function clearBrowseKeys(
  keep: readonly string[] = [],
): Record<string, null> {
  const patch: Record<string, null> = {};
  for (const key of BROWSE_KEYS) {
    if (!keep.includes(key)) patch[key] = null;
  }
  return patch;
}

// Sorts are per-type: one the new type does not support is dropped.
// Filters never drop on a tab switch: a source-scoped filter on the wrong
// tab yields an honest empty page (the server runs no side), so the chips
// and the URL stay truthful while the tab shows no results.
function sortPair(
  type: BrowseType,
  sortRaw: string,
  dirRaw: string,
): { sort: string | null; direction: string | null } {
  const keep = (browseSortsFor(type) as readonly string[]).includes(sortRaw);
  // A direction rides only on a kept sort that takes one: a stale direction
  // next to a non-directional order (TPDB relevance), or a malformed value,
  // would 400 the search.
  const direction =
    keep &&
    browseSortIsDirectional(type, sortRaw as SortKey) &&
    (dirRaw === "asc" || dirRaw === "desc")
      ? dirRaw
      : null;
  return { sort: keep ? sortRaw : null, direction };
}

export function typePatch(
  t: BrowseType,
  sortRaw: string,
  dirRaw: string,
  tpdbPerformer = false,
): Record<string, string | null> {
  // A TPDB performer filmography only composes on the Scenes tab (the
  // unified pair runs the StashDB side there). Moving to All/Movies would
  // refuse the search, year, date, studio and sort the Scenes tab allowed
  // — drop exactly those, keeping the performer pick.
  if (tpdbPerformer && t !== "scene") {
    return {
      type: t === "all" ? null : t,
      q: null,
      year: null,
      date: null,
      date_operation: null,
      studioTpdb: null,
      sort: null,
      direction: null,
    };
  }
  const { sort, direction } = sortPair(t, sortRaw, dirRaw);
  return {
    type: t === "all" ? null : t,
    sort,
    direction,
  };
}

export function starredPatch(
  on: boolean,
  type: BrowseType,
  sortRaw: string,
  dirRaw: string,
): Record<string, string | null> {
  if (!on) return { performerStarred: null };
  // Turning starred on drops a picked performer (the server refuses the
  // pair) and cannot run on the movies tab — it drops to the combined
  // browse, the same visible clamp a tab switch applies in reverse.
  const { sort, direction } = sortPair("all", sortRaw, dirRaw);
  return {
    performerStarred: "1",
    performerTpdb: null,
    performerStashdb: null,
    ...(type === "movie"
      ? {
          type: null,
          sort,
          direction,
        }
      : {}),
  };
}

// TPDB's performer filter is the filmography route: everything else goes,
// including sort (the route rejects all of it).
export function performerTpdbPatch(
  id: string,
  type: BrowseType,
): Record<string, string | null> {
  return {
    performerTpdb: id,
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
    // A TPDB performer cannot constrain the scenes side: on that tab no
    // side would qualify and the grid would show an empty page that names
    // the wrong cause — drop to the combined browse, the same clamp
    // starredPatch applies in the other direction.
    ...(type === "scene" ? { type: null } : {}),
  };
}

export function performerStashdbPatch(
  id: string,
  type: BrowseType,
  sortRaw: string,
  dirRaw: string,
): Record<string, string | null> {
  // Starred and a picked performer refuse each other on the server; the
  // pick replaces the starred filter instead of letting the browse 400.
  // A StashDB performer cannot constrain the movies side: on that tab no
  // side would qualify and the grid would show an empty page that names
  // the wrong cause — drop to the combined browse, keeping the sort only
  // where the all tab supports it (the clamp starredPatch applies).
  const { sort, direction } = sortPair("all", sortRaw, dirRaw);
  return {
    performerStashdb: id,
    performerStarred: null,
    ...(type === "movie"
      ? {
          type: null,
          sort,
          direction,
        }
      : {}),
  };
}

// Tab, paging and the direction/date_operation carriers are not constraints
// of their own. Scalars truthy count, arrays count length, missing keys 0.
export function countActiveFilters(
  values: Record<string, string | boolean | readonly unknown[]>,
): number {
  let n = 0;
  for (const key of BROWSE_KEYS) {
    if (
      key === "type" ||
      key === "perPage" ||
      key === "direction" ||
      key === "date_operation"
    )
      continue;
    const v = values[key];
    if (Array.isArray(v)) n += v.length;
    else if (v) n += 1;
  }
  return n;
}
