import type { CatalogProvider, SourceError } from "./contracts.ts";

/** The pure free-text include decisions behind src/server/browse.ts's native
 * tag criteria, extracted from Stryker-disabled regions so mutation testing
 * covers them: which expansions ride the native tag criterion (all-of,
 * any-of, or a fan-out of one all-of stream per group id) and which terms
 * stay on the local substring re-check, when a
 * locally split free-text AND degrades softly at the scan ceiling instead of
 * 422ing, and the native tag criterion's own id cap. No IO — the callers
 * keep the tag searches and counterpart lookups. */

/** The native tag criterion caps at this many ids and silently ignores the
 * tail past it, so callers must never send more (browse re-routes oversized
 * free-text unions to local filtering instead). */
export const TAG_FILTER_ID_CAP = 25;

/** The largest free-text group that fans out beside anchored ids. A group
 * within this cap rides as one all-of stream per id (see fanoutIds); a
 * larger group is a broad facet, not an anchor, and keeps the local
 * re-check. */
export const FANOUT_GROUP_CAP = 5;

/** One free-text term's expansion over a provider's published tag listing
 * (the shape expandCatalogTagTerm returns). `complete: false` marks a walk
 * that hit its row cap; `dropped` marks uuid-less matches (numeric-string
 * tag ids that can never ride a native criterion); an empty id list from
 * an incomplete walk proves nothing, while a complete walk's empty id
 * list is grounded absence (resolveIncludeCriteria reports provablyEmpty). */
export type TagExpansion = {
  complete: boolean;
  dropped: boolean;
  ids: string[];
};

export type IncludeCriteria = {
  /** Anchored ids plus every singleton expansion: the AND criterion an
   * all-of match must satisfy completely. */
  allOf: string[];
  /** The smallest group's ids, riding alone as an any-of pre-filter — only
   * when no anchored id and no singleton exists. */
  anyOf: string[];
  /** Non-empty only when anchored or singleton ids sit beside one small
   * free-text group: the caller then opens one native all-of stream per
   * id, each carrying `allOf ∪ {id}`, instead of one starved all-of
   * stream whose pages the local re-check keeps rejecting. Every scanned
   * page carries every anchored tag plus that id, so pages stay
   * productive and the caller dedupes the streams' overlap. The group
   * itself drops out of localTermIndexes — its ids are matched by the
   * streams' criteria, not re-checked — and freeTextNative goes true so
   * the ceiling degrades softly like the any-of pre-filter case. A group
   * qualifies only with 2..FANOUT_GROUP_CAP ids whose combined criterion
   * still fits the native cap (`allOf.length + ids.length <=
   * TAG_FILTER_ID_CAP`, which silently ignores the tail past the cap). */
  fanoutIds: string[];
  /** Indexes into the caller's parallel term list: the terms the visible
   * predicate must still re-check locally. */
  localTermIndexes: number[];
  /** True when at least one free-text term rides the native criterion: at
   * the scan ceiling such a stream degrades softly instead of 422ing. */
  freeTextNative: boolean;
  /** True when some term's expansion is a complete, freshness-bounded
   * listing walk with an empty id list and no uuid-less match: no
   * published tag contains the term, so no title can carry it — the
   * side's AND can never match, and the caller answers the side as
   * provably empty (exact absence, no upstream scan). */
  provablyEmpty: boolean;
};

/** Resolves the native include criteria for one provider side from the
 * side's anchored tag ids and the expansions of its free-text terms
 * (expansions[i] belongs to term i). One upstream tag criterion is a union,
 * so the whole group rides only when EVERY term expanded completely and
 * natively — a partial union would silently drop every title the missing
 * part would have kept. Of a complete group set, the most selective valid
 * pre-filter travels: every singleton group joins the anchored ids in the
 * all-of criterion (an AND match must carry each of those tags), and with
 * no singleton and no anchored id the smallest group rides alone as any-of
 * while the other terms keep filtering locally. An oversized smallest group
 * exceeds the native id cap and filters locally instead. */
export function resolveIncludeCriteria(
  anchoredIds: string[],
  expansions: TagExpansion[],
): IncludeCriteria {
  if (expansions.length === 0) {
    return {
      allOf: [...anchoredIds],
      anyOf: [],
      fanoutIds: [],
      localTermIndexes: [],
      freeTextNative: false,
      provablyEmpty: false,
    };
  }
  // A complete, freshness-bounded listing walk (card 926308ec bounds the
  // listing's age) that holds no tag for a term — and no uuid-less match —
  // grounds the absence: no published tag contains the term, so no title
  // can carry it and the AND can never match on this side. The caller
  // answers the side as exact zero instead of scanning unfiltered pages
  // into the query_too_broad ceiling. An incomplete walk, or one whose
  // matches are uuid-less, proves nothing and keeps the local scan.
  if (expansions.some((e) => e.complete && !e.dropped && e.ids.length === 0)) {
    return {
      allOf: [...anchoredIds],
      anyOf: [],
      fanoutIds: [],
      localTermIndexes: expansions.map((_, i) => i),
      freeTextNative: false,
      provablyEmpty: true,
    };
  }
  // Every term must expand completely and natively, or the whole group
  // filters locally: an incomplete, capped or empty expansion must never
  // ride a union criterion under claimed-exact totals.
  if (!expansions.every((e) => e.complete && !e.dropped && e.ids.length > 0)) {
    return {
      allOf: [...anchoredIds],
      anyOf: [],
      fanoutIds: [],
      localTermIndexes: expansions.map((_, i) => i),
      freeTextNative: false,
      provablyEmpty: false,
    };
  }
  // Every title satisfying the AND carries a tag from EVERY group, so a
  // singleton group is as good as an anchored id: the all-of criterion IS
  // their AND, and anchored ids and singleton ids travel it together.
  const singletonIds = expansions.flatMap((e) =>
    e.ids.length === 1 ? e.ids : [],
  );
  if (singletonIds.length > 0 || anchoredIds.length > 0) {
    const allOf = [...anchoredIds];
    for (const id of singletonIds) if (!allOf.includes(id)) allOf.push(id);
    // A multi-id group beside the anchored ids used to re-check locally and
    // starve the all-of stream into the 422 ceiling: the provider returns
    // every anchored title, few of them also match every typed term. The
    // smallest group that fits fans out instead (see fanoutIds): one
    // all-of stream per id, allOf ∪ {id}. A group qualifies only within
    // FANOUT_GROUP_CAP and only when the combined criterion still fits the
    // native cap; ties keep the first group in input order; no qualifier
    // keeps today's local re-check for every group.
    let fanout = -1;
    for (let i = 0; i < expansions.length; i++) {
      const ids = expansions[i]!.ids;
      if (
        ids.length < 2 ||
        ids.length > FANOUT_GROUP_CAP ||
        allOf.length + ids.length > TAG_FILTER_ID_CAP
      ) {
        continue;
      }
      if (fanout === -1 || ids.length < expansions[fanout]!.ids.length) {
        fanout = i;
      }
    }
    const fanoutIds = fanout === -1 ? [] : [...expansions[fanout]!.ids];
    return {
      allOf,
      anyOf: [],
      fanoutIds,
      localTermIndexes: expansions.flatMap((e, i) =>
        e.ids.length > 1 && i !== fanout ? [i] : [],
      ),
      freeTextNative: singletonIds.length > 0 || fanoutIds.length > 0,
      provablyEmpty: false,
    };
  }
  // No anchored id and no singleton group: the smallest group is a valid
  // any-of pre-filter (an AND match must match it too) and strictly
  // tighter than the union of every expansion, which admitted titles
  // matching any ONE term and starved the local AND into the scan ceiling.
  let smallest = 0;
  for (let i = 1; i < expansions.length; i++) {
    if (expansions[i]!.ids.length < expansions[smallest]!.ids.length) {
      smallest = i;
    }
  }
  // The native tag criterion caps at TAG_FILTER_ID_CAP ids and silently
  // ignores the tail past it: a larger group filters locally instead.
  // Reached only with no anchored ids (the branch above took those), so
  // allOf stays empty here.
  if (expansions[smallest]!.ids.length > TAG_FILTER_ID_CAP) {
    return {
      allOf: [],
      anyOf: [],
      fanoutIds: [],
      localTermIndexes: expansions.map((_, i) => i),
      freeTextNative: false,
      provablyEmpty: false,
    };
  }
  return {
    allOf: [],
    anyOf: [...expansions[smallest]!.ids],
    fanoutIds: [],
    localTermIndexes: expansions.flatMap((_, i) => (i !== smallest ? [i] : [])),
    freeTextNative: true,
    provablyEmpty: false,
  };
}

/** The plan shape softCeilingFor reads (structural slice of browseTitles'
 * inline plan objects). `localInclude` carries only the free-text terms
 * that re-check locally: uuid-less anchored chips and every other local
 * filter keep the hard 422, so they never enter it. */
export type SoftCeilingPlan = {
  localInclude: readonly unknown[];
  freeTextNative: boolean;
  /** True when the stream fans out one all-of criterion per fanout id: the
   * pages were productive like the any-of pre-filter case, so the ceiling
   * degrades softly even when no term re-checks locally. */
  fanoutNative?: boolean;
};

/** The soft ceiling is exactly the documented contract: a multi-term
 * free-text AND split between a native tag criterion and the local
 * re-check — the native pre-filter kept the scanned pages productive, so
 * the matches found are a real partial answer. Filmography scans (no
 * native tag criterion), anchored+free mixes where every free term
 * re-checks locally, uuid-less anchored chips beside a native criterion,
 * and every other local filter keep the hard 422; hidden or exclude
 * starvation on such a stream still degrades (the pages were
 * productive). A fan-out stream (fanoutNative) degrades like the any-of
 * pre-filter case, even when no term re-checks locally. */
export function softCeilingFor(plan: SoftCeilingPlan): boolean {
  return (
    (plan.localInclude.length > 0 && plan.freeTextNative) ||
    plan.fanoutNative === true
  );
}

/** The named partial a scan ceiling ends a stream with: a stream's own
 * per-stream ceiling under a soft flag (scanCeilingOutcome), or the
 * browse's spent per-provider request pool (createScanBudget in
 * server/browse.ts). */
export function scanCeilingError(provider: CatalogProvider): SourceError {
  return {
    provider,
    code: "scan_ceiling",
    message:
      "Reached the upstream page limit while filling this page — results are incomplete; narrow the filters.",
  };
}

/** The outcome when a stream hits the scan-page ceiling with upstream
 * continuation left: a hard ceiling throws query_too_broad (the caller
 * raises it), a soft one degrades to the named scan_ceiling partial
 * answer. */
export function scanCeilingOutcome(
  softCeiling: boolean,
  provider: CatalogProvider,
): { hard: true } | { hard: false; error: SourceError } {
  if (!softCeiling) return { hard: true };
  return { hard: false, error: scanCeilingError(provider) };
}
