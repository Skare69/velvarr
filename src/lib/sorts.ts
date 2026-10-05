// The one sort-capability table: which provider implements which order for
// which kind, whether the order takes a direction, and which sorts a merged
// browse can carry. The route's supported-sort check (supportedSort), the
// browse parser's vocabulary (SORT_KEYS), resolveSort's membership and the
// client's offered options (browseSortsFor) all derive from this file —
// adding or retiring a sort is a one-file edit here.

import type { CatalogKind, CatalogProvider } from "./contracts.ts";

/** Normalized sort vocabulary. Only orders the providers genuinely
 * implement appear here; the page surfaces the exact upstream order that
 * was applied. */
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

export interface SortSpec {
  readonly key: SortKey;
  /** false = the upstream order takes no direction (today only TPDB
   * relevance); the client hides the direction toggle and sends none. */
  readonly directional: boolean;
}

export const SORT_CAPABILITIES: Readonly<
  Record<CatalogProvider, Partial<Record<CatalogKind, readonly SortSpec[]>>>
> = {
  tpdb: {
    movie: [
      { key: "relevance", directional: false },
      { key: "recency", directional: true },
      { key: "duration", directional: true },
    ],
    scene: [
      { key: "relevance", directional: false },
      { key: "recency", directional: true },
      { key: "duration", directional: true },
    ],
  },
  stashdb: {
    scene: [
      { key: "title", directional: true },
      { key: "date", directional: true },
      { key: "duration", directional: true },
      { key: "trending", directional: true },
      { key: "popularity", directional: true },
      { key: "created", directional: true },
      { key: "updated", directional: true },
    ],
  },
};

/** The spec for a provider+kind+key, or undefined when that provider does
 * not implement the order there. */
export function sortSpec(
  provider: CatalogProvider,
  kind: CatalogKind,
  sort: SortKey,
): SortSpec | undefined {
  return SORT_CAPABILITIES[provider]?.[kind]?.find((s) => s.key === sort);
}

/** Every key some provider implements — the parse vocabulary. Only feeds
 * .includes() checks, so a duplicate key would be inert, never a behavior. */
export const SORT_KEYS: readonly SortKey[] = Object.values(
  SORT_CAPABILITIES,
).flatMap((kinds) =>
  Object.values(kinds).flatMap((specs) => (specs ?? []).map((s) => s.key)),
);

/** Sorts BOTH browse sources carry on a merged All page (StashDB's `date` is
 * the release-recency order under its own key — the merge maps recency onto
 * it, see nativeQuery). Everything else is per-source and refused for All
 * rather than silently applied to one side. */
export const BROWSE_MIXED_SORTS: readonly SortKey[] = ["recency", "duration"];

/** Which provider+kind each typed browse tab runs: Movies is TPDB movie
 * search, Scenes is StashDB scene search. (All merges both; its offers are
 * BROWSE_MIXED_SORTS and need no side lookup.) */
const BROWSE_SIDES: Record<
  "movie" | "scene",
  readonly [CatalogProvider, CatalogKind]
> = {
  movie: ["tpdb", "movie"],
  scene: ["stashdb", "scene"],
};

/** The sort options the client offers per browse tab: the tab's own source
 * on typed tabs, the merge-capable set on All. Unsupported options are
 * never offered. */
export function browseSortsFor(
  type: "all" | "movie" | "scene",
): readonly SortKey[] {
  if (type === "all") return BROWSE_MIXED_SORTS;
  const [provider, kind] = BROWSE_SIDES[type];
  return (SORT_CAPABILITIES[provider]?.[kind] ?? []).map((spec) => spec.key);
}

/** Whether an offered sort takes a direction: on a typed tab the tab's own
 * source decides; a mixed All sort takes one on both sources (StashDB's
 * `date` asc/desc carries the recency order, see BROWSE_MIXED_SORTS). The
 * client shows the direction toggle and sends a direction only then. */
export function browseSortIsDirectional(
  type: "all" | "movie" | "scene",
  sort: SortKey,
): boolean {
  if (type === "all") return BROWSE_MIXED_SORTS.includes(sort);
  const [provider, kind] = BROWSE_SIDES[type];
  return sortSpec(provider, kind, sort)?.directional === true;
}

/** Client-facing labels; trending/popularity are labeled as StashDB's own
 * ordering — recency is never called trending. */
export const SORT_LABELS: Record<SortKey, string> = {
  relevance: "Best match",
  recency: "Release recency",
  duration: "Duration",
  title: "Title",
  date: "Release date",
  trending: "Trending (StashDB ordering)",
  popularity: "Popularity (StashDB ordering)",
  created: "Recently added (StashDB)",
  updated: "Last updated (StashDB)",
};
