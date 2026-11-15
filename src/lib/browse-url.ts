// Client mirror of the server's planBrowseSides refusals (src/server/browse.ts):
// pure URL policy, no React, no IO. Every function returns a param patch for
// useParamsSetter — null deletes a key. The server side stays the authority;
// this module only keeps the URL from ever forming a request the server would
// 400. Side qualification reads browse-entities.ts — the same functions the
// server planner reads — so the URL can never qualify a source the planner
// refuses. Adding a browse key is one edit in BROWSE_KEYS; changing an
// exclusivity rule is one function plus its test.

// Sort capability is the shared SORT_CAPABILITIES table (sorts.ts) — the
// same source the server's acceptance derives from — so the offers here can
// never drift from what the server accepts.
import {
  browseSortIsDirectional,
  browseSortsFor,
  type SortKey,
} from "./sorts.ts";
import {
  browseSideRuns,
  tpdbFilmographyRuns,
  type PerformerMode,
} from "./browse-entities.ts";
import type {
  BrowseEntity,
  CatalogProvider,
  CatalogTagSelection,
} from "./contracts.ts";

export type BrowseType = "all" | "movie" | "scene";

// performers / studios carry JSON arrays of 1..5 {name?, tpdb?, stashdb?}.
// The four scalar keys are legacy: kept listed so clearBrowseKeys still
// deletes them, but only the server's old-key parser and legacyBrowsePatch
// read them — every writer writes the array keys.
export const BROWSE_KEYS = [
  "type",
  "q",
  "include",
  "exclude",
  "studios",
  "studioTpdb",
  "studioStashdb",
  "performers",
  "performerMode",
  "performerTpdb",
  "performerStashdb",
  "performerStarred",
  "studioMode",
  "year",
  "yearTo",
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
  performers: BrowseEntity[],
  performerMode: PerformerMode,
  studios: BrowseEntity[],
): Record<string, string | null> {
  // A TPDB performer filmography only composes on the Scenes tab (the
  // unified pair runs the StashDB side there). Moving to All/Movies would
  // refuse the search, year range, date and sort the tab allowed — drop
  // exactly those. The studios keep their StashDB halves (that side still
  // qualifies on All); entries known to TPDB only lose their last id and
  // drop out with the studio constraint they carried.
  if (tpdbFilmographyRuns(t, performers, performerMode)) {
    const stashdbOnly = studios
      .filter((e) => e.stashdb !== undefined)
      .map((e) => ({
        ...(e.name !== undefined ? { name: e.name } : {}),
        stashdb: e.stashdb!,
      }));
    return {
      type: t === "all" ? null : t,
      q: null,
      year: null,
      yearTo: null,
      date: null,
      date_operation: null,
      sort: null,
      direction: null,
      ...(stashdbOnly.length === 0
        ? { studios: null }
        : { studios: JSON.stringify(stashdbOnly) }),
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
  // Turning starred on drops the picked performers (the server refuses the
  // pair) and cannot run on the movies tab — it drops to the combined
  // browse, the same visible clamp a tab switch applies in reverse.
  const { sort, direction } = sortPair("all", sortRaw, dirRaw);
  return {
    performerStarred: "1",
    performers: null,
    performerMode: null,
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

/** The drawer's view of the browse state a patch builds on: the current
 * tab, sort and entity lists exactly as the URL carries them. */
export type BrowseEntryState = {
  type: BrowseType;
  sortRaw: string;
  dirRaw: string;
  performerMode: PerformerMode;
  performers: BrowseEntity[]; // CURRENT entries
  studios: BrowseEntity[]; // CURRENT entries
  performerStarred: boolean;
};

/** The drawer's performer change: the entries replace the list wholesale.
 * Adding an entry always drops the starred filter — starred refuses picked
 * performers. With no side left qualifying on this tab the clamp drops to
 * the combined browse; when the TPDB filmography route runs after the
 * change, the route refuses everything else, so the same drop-set as before
 * the array keys applies (studios included — the route composes with
 * neither studio key). */
export function performersPatch(
  next: BrowseEntity[],
  state: BrowseEntryState,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    performers: next.length === 0 ? null : JSON.stringify(next),
    performerStarred: null,
  };
  // Starred was just dropped above, so qualification is judged without it —
  // the sides the patched URL will actually run.
  const sides = browseSideRuns(
    state.type,
    next,
    state.studios,
    state.performerMode,
    false,
  );
  if (!sides.tpdb && !sides.stashdb) {
    // No side qualifies on this tab (TPDB-only entries on the Scenes tab,
    // say): the grid would show an empty page naming the wrong cause —
    // drop to the combined browse, the clamp starredPatch applies too.
    const { sort, direction } = sortPair("all", state.sortRaw, state.dirRaw);
    return { ...patch, type: null, sort, direction };
  }
  if (tpdbFilmographyRuns(state.type, next, state.performerMode)) {
    return {
      ...patch,
      q: null,
      include: null,
      exclude: null,
      year: null,
      yearTo: null,
      date: null,
      date_operation: null,
      studios: null,
      studioMode: null,
      sort: null,
      direction: null,
      // `name` is the facet display label; this reset drops the studio/tag
      // constraints it names, so it never survives the filmography route.
      name: null,
    };
  }
  return patch;
}

/** The drawer's studio change: studios compose freely with every other
 * filter (both sides honor them), so the only clamp is a tab neither source
 * qualifies on. */
export function studiosPatch(
  next: BrowseEntity[],
  state: BrowseEntryState,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    studios: next.length === 0 ? null : JSON.stringify(next),
  };
  const sides = browseSideRuns(
    state.type,
    state.performers,
    next,
    state.performerMode,
    state.performerStarred,
  );
  if (!sides.tpdb && !sides.stashdb) {
    const { sort, direction } = sortPair("all", state.sortRaw, state.dirRaw);
    return { ...patch, type: null, sort, direction };
  }
  return patch;
}

/** The drawer's all/any toggle. `all` is the default and never rides the
 * URL; it never counts as a filter of its own. A switch can START the TPDB
 * filmography route: in `all` mode an entry the TPDB side does not know
 * keeps TPDB off the page, so year, q and sort are legal there — `any`
 * runs TPDB after the change and the route refuses them. The drop-set is
 * the same one performersPatch applies when a pick starts the route. A
 * switch to `all` can also stop every side (entries split across the two
 * sources know no complete set); the tab clamp then drops to the combined
 * browse like the other patch builders. */
export function performerModePatch(
  mode: PerformerMode,
  state: BrowseEntryState,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    performerMode: mode === "any" ? "any" : null,
  };
  if (tpdbFilmographyRuns(state.type, state.performers, mode)) {
    return {
      ...patch,
      q: null,
      include: null,
      exclude: null,
      year: null,
      yearTo: null,
      date: null,
      date_operation: null,
      studios: null,
      studioMode: null,
      sort: null,
      direction: null,
      // `name` is the facet display label; this reset drops the studio/tag
      // constraints it names, so it never survives the filmography route.
      name: null,
    };
  }
  const sides = browseSideRuns(
    state.type,
    state.performers,
    state.studios,
    mode,
    state.performerStarred,
  );
  if (!sides.tpdb && !sides.stashdb) {
    const { sort, direction } = sortPair("all", state.sortRaw, state.dirRaw);
    return { ...patch, type: null, sort, direction };
  }
  return patch;
}

/** The drawer's year range: `year` is the lower bound, `yearTo` the upper
 * one. Either bound may ride alone; an absent upper bound (empty box, or a
 * repeated year) deletes the key. A date window refuses the pair, the same
 * clamp the year filter applied before. */
export function yearRangePatch(
  year: string,
  yearTo: string,
): Record<string, string | null> {
  return {
    year: year || null,
    yearTo: yearTo !== "" && yearTo !== year ? yearTo : null,
    date: null,
    date_operation: null,
  };
}

// Tab, paging and the direction/date_operation/performerMode/yearTo
// carriers are not constraints of their own. Scalars truthy count, arrays
// count length (callers pass performers/studios as the parsed arrays, so
// their entries count), missing keys 0.
export function countActiveFilters(
  values: Record<string, string | boolean | readonly unknown[]>,
): number {
  let n = 0;
  for (const key of BROWSE_KEYS) {
    if (
      key === "type" ||
      key === "perPage" ||
      key === "direction" ||
      key === "date_operation" ||
      key === "performerMode" ||
      key === "yearTo"
    )
      continue;
    const v = values[key];
    if (Array.isArray(v)) n += v.length;
    else if (v) n += 1;
  }
  return n;
}
/** A provider-legal filter entry point handed from a detail page into the
 * unified browse constraints. `param` is a canonical /api/browse key;
 * `id` is the provider-native id, or the YYYY string for `year`; `tag`
 * rides for `include` and as a co-filter on the performer params;
 * `studioMode` only for StashDB studios; `counterpart` only with the
 * performer params — her id on the other provider, so browse runs both
 * sides at once. `name` is optional: a writer that knows the display label
 * puts it in the entry (and the URL's `name` facet heading), so chips label
 * themselves without a name-cache hit; code never matches on it. */
export type BrowseFilter = {
  param:
    | "studioTpdb"
    | "studioStashdb"
    | "performerTpdb"
    | "performerStashdb"
    | "year"
    | "include";
  provider: CatalogProvider;
  id: string;
  name?: string;
  tag?: CatalogTagSelection;
  studioMode?: "withChildren";
  counterpart?: { param: "performerTpdb" | "performerStashdb"; id: string };
};

/** The URL a detail entry point lands on, as a real href: the patch's set
 * keys only (a fresh browse carries nothing else), so middle-click opens
 * the same browse in a new tab that a plain click opens in place. */
export function browseFilterHref(filter: BrowseFilter): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(browseFilterPatch(filter)))
    if (v) qs.set(k, v);
  return `/?${qs}`;
}

export function browseFilterPatch(
  filter: BrowseFilter,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    // Any view may host an entry point (performer pages live on the
    // following view), so the jump always lands on the titles view and
    // drops that view's own keys (provider, per-view paging).
    ...clearBrowseKeys(),
    view: "titles",
    // The jump names no facet of its own; a writer that knows the label
    // passes it as `name` (see BrowseFilter).
    name: filter.name ?? null,
    type:
      filter.param === "year" || filter.provider === "tpdb" ? "movie" : "scene",
    provider: null,
    moviePage: null,
    scenePage: null,
    kind: null,
    id: null,
  };
  // Only the selection fields ride the URL; count-style extras a caller
  // carries on its tag objects never leak into the wire.
  const cleanTag = ({ name, tpdb, stashdb }: CatalogTagSelection) => ({
    name,
    ...(tpdb !== undefined ? { tpdb } : {}),
    ...(stashdb !== undefined ? { stashdb } : {}),
  });
  if (filter.param === "include" && filter.tag !== undefined) {
    patch.include = JSON.stringify([cleanTag(filter.tag)]);
  } else if (
    filter.param === "performerTpdb" ||
    filter.param === "performerStashdb"
  ) {
    // One performers entry carries every known id, so the counterpart
    // rides the same constraint and browse runs both sides at once; no
    // single type can, so it lands on browse All.
    const entry: BrowseEntity = {};
    if (filter.name !== undefined) entry.name = filter.name;
    if (filter.param === "performerTpdb") entry.tpdb = filter.id;
    else entry.stashdb = filter.id;
    if (filter.counterpart !== undefined) {
      if (filter.counterpart.param === "performerTpdb")
        entry.tpdb = filter.counterpart.id;
      else entry.stashdb = filter.counterpart.id;
      patch.type = null;
    }
    patch.performers = JSON.stringify([entry]);
  } else if (
    filter.param === "studioTpdb" ||
    filter.param === "studioStashdb"
  ) {
    const entry: BrowseEntity = {};
    if (filter.name !== undefined) entry.name = filter.name;
    if (filter.param === "studioTpdb") entry.tpdb = filter.id;
    else entry.stashdb = filter.id;
    patch.studios = JSON.stringify([entry]);
  } else {
    patch[filter.param] = filter.id;
  }
  if (filter.studioMode) patch.studioMode = filter.studioMode;
  if (filter.tag !== undefined && filter.param !== "include") {
    patch.include = JSON.stringify([cleanTag(filter.tag)]);
  }
  return patch;
}
