// The pure multi-entity browse semantics behind src/server/browse.ts's
// planBrowseSides and src/lib/browse-url.ts's client clamps: which sources a
// query's performer/studio entries qualify, whether the TPDB filmography
// route runs, and the concrete stream seeds one request pages. No IO and no
// React — the planner adds only refusals and sort wiring, the client mirrors
// refusals so the URL never forms a request the server would 400, and both
// read the same functions so the two can never drift.

import type { BrowseEntity, CatalogProvider } from "./contracts.ts";
import { BROWSE_MIXED_SORTS } from "./sorts.ts";

export type BrowseTab = "all" | "movie" | "scene";
export type PerformerMode = "all" | "any";

/** The most performer or studio entries one browse may carry. */
export const MAX_BROWSE_ENTITIES = 5;

/** True when the source knows the entry: the entry carries that provider's
 * own id. */
export function entityKnownBy(
  e: BrowseEntity,
  side: "tpdb" | "stashdb",
): boolean {
  return side === "tpdb" ? e.tpdb !== undefined : e.stashdb !== undefined;
}

/** The entries a source knows nothing about. */
export function entriesUnknownTo(
  entries: BrowseEntity[],
  side: "tpdb" | "stashdb",
): BrowseEntity[] {
  return entries.filter((e) => !entityKnownBy(e, side));
}

/** The old one-sided-clause truth table, generalized to entry lists. With
 * no entries the constraint is absent and the source qualifies; in `all`
 * mode a source must know EVERY entry; in `any` mode (and for studios,
 * which are always any-of) at least one. This is exactly the old
 * `performerStashdb === undefined || bothPerformers` shape: a source-scoped
 * entry disqualifies the other source unless that source also knows one. */
export function sourceRunsFor(
  entries: BrowseEntity[],
  side: "tpdb" | "stashdb",
  mode: PerformerMode = "any",
): boolean {
  if (entries.length === 0) return true;
  const known = entries.filter((e) => entityKnownBy(e, side)).length;
  return mode === "all" ? known === entries.length : known > 0;
}

/** Whether the TPDB filmography route runs for this tab, the performer
 * entries and the mode: TPDB must qualify (never on the Scenes tab, where
 * StashDB owns the side) and at least one entry must carry a TPDB id. */
export function tpdbFilmographyRuns(
  type: BrowseTab,
  performers: BrowseEntity[],
  performerMode: PerformerMode,
): boolean {
  return (
    performers.length > 0 &&
    type !== "scene" &&
    sourceRunsFor(performers, "tpdb", performerMode)
  );
}

/** Which sources a tab runs under the full clause set: performer and studio
 * qualification plus the starred filter (starred refuses the TPDB side —
 * it is a StashDB-scenes filter — and never touches the StashDB side). */
export function browseSideRuns(
  type: BrowseTab,
  performers: BrowseEntity[],
  studios: BrowseEntity[],
  performerMode: PerformerMode,
  performerStarred: boolean,
): { tpdb: boolean; stashdb: boolean } {
  return {
    tpdb:
      type !== "scene" &&
      !performerStarred &&
      sourceRunsFor(performers, "tpdb", performerMode) &&
      sourceRunsFor(studios, "tpdb", "any"),
    stashdb:
      type !== "movie" &&
      sourceRunsFor(performers, "stashdb", performerMode) &&
      sourceRunsFor(studios, "stashdb", "any"),
  };
}

/** One concrete upstream stream a browse request pages. `planStreams` emits
 * them in entry order; the merge concatenates unordered groups in exactly
 * this order. Fields mirror the adapter's CatalogSearchQuery carriers. */
export type BrowseStreamSeed = {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  /** TPDB filmography route for this performer id. */
  filmographyPerformer?: string;
  /** StashDB performers criterion ids (INCLUDES_ALL when performerAll). */
  performerIds?: string[];
  performerAll?: boolean;
  /** TPDB studio filter value — resolved to its numeric site_id at IO time
   * (uuid and slug resolve through /sites/{id}; numeric passes through). */
  tpdbStudio?: string;
  /** StashDB exact-mode studios criterion: every known id, one query. */
  studioIds?: string[];
  /** StashDB withChildren: one parentStudio id per stream. */
  parentStudioId?: string;
  /** Streams sharing a dedupeKey may return the same title: the merge
   * keeps only its first occurrence across the group. */
  dedupeKey?: string;
};

export type StreamPlan = {
  tpdb: boolean;
  stashdb: boolean;
  filmography: boolean;
  seeds: BrowseStreamSeed[];
};

/** The stream seeds one request pages: per-provider qualification, whether
 * the TPDB filmography runs, and one seed per upstream list in entry order.
 * Multi-stream sources a merged order must refuse sorts on: TPDB with two
 * or more studio site_id lists, and StashDB withChildren with two or more
 * parent studios — both merge separate upstream lists, so only recency and
 * duration order them honestly (BROWSE_MIXED_SORTS). */
export function planStreams(
  type: BrowseTab,
  performers: BrowseEntity[],
  studios: BrowseEntity[],
  performerMode: PerformerMode,
  studioMode: "exact" | "withChildren",
  performerStarred: boolean,
): StreamPlan {
  const sides = browseSideRuns(
    type,
    performers,
    studios,
    performerMode,
    performerStarred,
  );
  const filmography = tpdbFilmographyRuns(type, performers, performerMode);
  const seeds: BrowseStreamSeed[] = [];
  if (sides.tpdb) {
    if (filmography) {
      const known = performers.filter((e) => e.tpdb !== undefined);
      if (performerMode === "all") {
        // One filmography: the first entry's route, the visible predicate
        // re-checks every other entry's id in the rows' credits.
        seeds.push({
          provider: "tpdb",
          kind: "movie",
          filmographyPerformer: known[0]!.tpdb,
        });
      } else {
        for (const e of known) {
          seeds.push({
            provider: "tpdb",
            kind: "movie",
            filmographyPerformer: e.tpdb,
            ...(known.length > 1 ? { dedupeKey: "tpdb-filmographies" } : {}),
          });
        }
      }
    } else {
      for (const e of studios) {
        if (e.tpdb !== undefined) {
          seeds.push({
            provider: "tpdb",
            kind: "movie",
            tpdbStudio: e.tpdb,
          });
        }
      }
    }
  }
  if (sides.stashdb) {
    const knownPerformers = performers.filter((e) => e.stashdb !== undefined);
    const knownStudios = studios.filter((e) => e.stashdb !== undefined);
    const seed: BrowseStreamSeed = {
      provider: "stashdb",
      kind: "scene",
    };
    let seedOut = false;
    if (performerStarred) {
      // The route layer expands starred follows into performerIds; the seed
      // only marks the criterion present.
      seed.performerIds = [];
      seed.performerAll = false;
      seedOut = true;
    } else if (knownPerformers.length > 0) {
      seed.performerIds = knownPerformers.map((e) => e.stashdb!);
      seed.performerAll = performerMode === "all";
      seedOut = true;
    }
    if (knownStudios.length > 0) {
      if (studioMode === "withChildren") {
        // One parentStudio search per studio; merged and deduped in the
        // merge. A single studio keeps the plain single-stream shape.
        for (const e of knownStudios) {
          seeds.push({
            ...seed,
            parentStudioId: e.stashdb,
            ...(knownStudios.length > 1
              ? { dedupeKey: "stashdb-parent-studios" }
              : {}),
          });
        }
        return { ...sides, filmography, seeds };
      }
      seed.studioIds = knownStudios.map((e) => e.stashdb!);
      seedOut = true;
    }
    if (seedOut) seeds.push(seed);
  }
  return { ...sides, filmography, seeds };
}

/** True when a source this query pages merges 2+ upstream lists, so only
 * recency and duration may order it. The planner refuses other sorts; the
 * client offers only these two. */
export function mergedSourceRestricted(
  plan: StreamPlan,
  sort: string | undefined,
): boolean {
  if (sort === undefined || BROWSE_MIXED_SORTS.includes(sort as never)) {
    return false;
  }
  const tpdbStudios = plan.seeds.filter((s) => s.tpdbStudio !== undefined);
  const parentStudios = plan.seeds.filter(
    (s) => s.parentStudioId !== undefined,
  );
  return tpdbStudios.length > 1 || parentStudios.length > 1;
}
