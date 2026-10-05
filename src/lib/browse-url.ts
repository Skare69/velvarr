// Client mirror of the server's planBrowseSides refusals (src/server/browse.ts):
// pure URL policy, no React, no IO. Every function returns a param patch for
// useParamsSetter — null deletes a key. The server side stays the authority;
// this module only keeps the URL from ever forming a request the server would
// 400. Adding a browse key is one edit in BROWSE_KEYS; changing an
// exclusivity rule is one function plus its test.

export type BrowseType = "all" | "movie" | "scene";

export type SortKey =
  | "relevance"
  | "recency"
  | "duration"
  | "title"
  | "date"
  | "trending"
  | "popularity"
  | "created"
  | "updated";

// type=all merges both sources, so only sorts both genuinely support are
// offered; per-source sorts appear only on their own type.
//
// Known drift, pinned as shipped (do not fix here): the server's MIXED_SORTS
// (browse.ts) allows recency+duration on All, this list pins date+duration —
// the All tab offers "date" (which the server refuses) and clamps the legal
// "recency". Fix belongs to its own card.
export function sortsFor(type: BrowseType): readonly SortKey[] {
  if (type === "movie") return ["relevance", "recency", "duration"];
  if (type === "scene")
    return [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ];
  return ["date", "duration"];
}

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
  const keep = (sortsFor(type) as readonly string[]).includes(sortRaw);
  return { sort: keep ? sortRaw : null, direction: keep ? dirRaw : null };
}

export function typePatch(
  t: BrowseType,
  sortRaw: string,
  dirRaw: string,
): Record<string, string | null> {
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
