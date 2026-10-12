import type { CatalogProvider, SourceError } from "./contracts.ts";

/** The pure free-text include decisions behind src/server/browse.ts's native
 * tag criteria, extracted from Stryker-disabled regions so mutation testing
 * covers them: which expansions ride the native tag criterion (all-of vs
 * any-of) and which terms stay on the local substring re-check, when a
 * locally split free-text AND degrades softly at the scan ceiling instead of
 * 422ing, and the native tag criterion's own id cap. No IO — the callers
 * keep the tag searches and counterpart lookups. */

/** The native tag criterion caps at this many ids and silently ignores the
 * tail past it, so callers must never send more (browse re-routes oversized
 * free-text unions to local filtering instead). */
export const TAG_FILTER_ID_CAP = 25;

/** One free-text term's expansion over a provider's published tag listing
 * (the shape expandCatalogTagTerm returns). `complete: false` marks a walk
 * that hit its row cap; `dropped` marks uuid-less matches (numeric-string
 * tag ids that can never ride a native criterion); an empty id list is
 * never proof a side is empty. */
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
  /** Indexes into the caller's parallel term list: the terms the visible
   * predicate must still re-check locally. */
  localTermIndexes: number[];
  /** True when at least one free-text term rides the native criterion: at
   * the scan ceiling such a stream degrades softly instead of 422ing. */
  freeTextNative: boolean;
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
      localTermIndexes: [],
      freeTextNative: false,
    };
  }
  // Every term must expand completely and natively, or the whole group
  // filters locally: an incomplete, capped or empty expansion must never
  // ride a union criterion under claimed-exact totals.
  if (!expansions.every((e) => e.complete && !e.dropped && e.ids.length > 0)) {
    return {
      allOf: [...anchoredIds],
      anyOf: [],
      localTermIndexes: expansions.map((_, i) => i),
      freeTextNative: false,
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
    return {
      allOf,
      anyOf: [],
      localTermIndexes: expansions.flatMap((e, i) =>
        e.ids.length > 1 ? [i] : [],
      ),
      freeTextNative: singletonIds.length > 0,
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
      localTermIndexes: expansions.map((_, i) => i),
      freeTextNative: false,
    };
  }
  return {
    allOf: [],
    anyOf: [...expansions[smallest]!.ids],
    localTermIndexes: expansions.flatMap((_, i) => (i !== smallest ? [i] : [])),
    freeTextNative: true,
  };
}

/** The plan shape softCeilingFor reads (structural slice of browseTitles'
 * inline plan objects). */
export type SoftCeilingPlan = {
  localInclude: readonly unknown[];
  freeTextNative: boolean;
};

/** The soft ceiling is exactly the documented contract: a multi-term
 * free-text AND split between a native tag criterion and the local
 * re-check — the native pre-filter kept the scanned pages productive, so
 * the matches found are a real partial answer. Filmography scans (no
 * native tag criterion), anchored+free mixes where every free term
 * re-checks locally, and every other local filter keep the hard 422;
 * hidden or exclude starvation on such a stream still degrades (the pages
 * were productive). */
export function softCeilingFor(plan: SoftCeilingPlan): boolean {
  return plan.localInclude.length > 0 && plan.freeTextNative;
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
  return {
    hard: false,
    error: {
      provider,
      code: "scan_ceiling",
      message:
        "Reached the upstream page limit while filling this page — results are incomplete; narrow the filters.",
    },
  };
}
