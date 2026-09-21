// Related titles for one movie or scene: provider-published tag overlap over
// real, bounded candidates from both sources. No title guessing, no
// sexuality inference, no AI-invented entries — Jev can only reorder
// candidates code has already vetted.

import type {
  CatalogCredit,
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
  MediaReference,
} from "../lib/contracts.ts";
import { normalizeFacetName } from "../lib/contracts.ts";
import { rankRelatedTitles, type RankableTitle } from "./judgment.ts";
import { isHiddenTitle, type SourceError } from "./browse.ts";
import { AppError } from "./http.ts";
import {
  getCatalogDetail,
  searchCatalog,
  tagCounterpart,
  type CatalogSearchPage,
  type CatalogSearchQuery,
} from "./providers.ts";

/** Related rail for one title. `ranking` names the order actually applied —
 * 'jev' only when the caller explicitly requested Jev and the rerank fully
 * succeeded; `canRank` mirrors that success, so a keyless or failed rerank
 * reads as false instead of pretending. `errors` carries every provider
 * failure; a partial source failure keeps its successful candidates next to
 * the error evidence, and a total failure is a visible empty, never a fake
 * clean end. */
export type RelatedTitles = {
  items: CatalogDetail[];
  ranking: "tags" | "jev";
  canRank: boolean;
  errors: SourceError[];
};

// ponytail: a detail-page rail, not a crawl — one bounded page per candidate
// source, seeded by at most 8 of the source's own tags. Widen SEED_TAGS /
// CANDIDATE_PAGE if rails feel thin; add pages only with a real reason.
const SEED_TAGS = 8;
const CANDIDATE_PAGE = 24;
const RELATED_LIMIT = 12;

/** Provider+kind+id identity key. Callers (route, provider mapping) disagree
 * on UUID case; lowercasing makes dedupe and self-exclusion case-proof. */
const refKey = (r: { provider: string; kind: string; id: string }) =>
  `${r.provider}:${r.kind}:${r.id.toLowerCase()}`;

function toSourceError(provider: CatalogProvider, err: unknown): SourceError {
  return {
    provider,
    code: err instanceof AppError ? err.code : "upstream_error",
    message:
      err instanceof Error && err.message !== ""
        ? err.message
        : "The provider request failed.",
  };
}

/** The metadata a Jev rerank may see: titles, tag names, studio, year. */
function descriptor(d: CatalogDetail): RankableTitle {
  const year = Number((d.releaseDate ?? "").slice(0, 4));
  return {
    title: d.title,
    tags: d.tags.map((t) => t.name),
    ...(d.studio !== undefined ? { studio: d.studio.name } : {}),
    ...(Number.isInteger(year) && year > 1900 ? { year } : {}),
  };
}

export async function relatedTitles(
  reference: MediaReference,
  hiddenTags: CatalogTagSelection[],
  options: { rank?: "tags" | "jev"; typesafeApiKey?: string } = {},
): Promise<RelatedTitles> {
  // The source's own provider detail grounds everything below.
  let source: CatalogDetail | null;
  try {
    source = await getCatalogDetail(reference);
  } catch (err) {
    return {
      items: [],
      ranking: "tags",
      canRank: false,
      errors: [toSourceError(reference.provider, err)],
    };
  }
  if (source === null) {
    return {
      items: [],
      ranking: "tags",
      canRank: false,
      errors: [
        {
          provider: reference.provider,
          code: "not_found",
          message: "The source title is no longer on its provider.",
        },
      ],
    };
  }
  // Bounded, real seed tags. Without any provider-published tag there is no
  // honest relatedness — an explicit empty beats a popularity guess.
  const seedTags = source.tags.slice(0, SEED_TAGS);
  if (seedTags.length === 0) {
    return { items: [], ranking: "tags", canRank: false, errors: [] };
  }

  // Candidate discovery through each provider's native any-of tag search:
  // this OR finds the candidate pool, it is NOT a user filter — relevance
  // comes from the shared-tag ranking below. Same source searches with the
  // source's own tag ids; the counterpart source searches with the tags its
  // provider publishes under an exactly-equal normalized name (the existing
  // deterministic pairing; absent counterparts simply shrink the pool).
  const counterpartIds = (
    await Promise.all(
      seedTags.map((t) => tagCounterpart(reference.provider, t.name)),
    )
  )
    .filter((t) => t !== undefined)
    .map((t) => t.id);
  const seedIds = seedTags.map((t) => t.id);
  const queries: CatalogSearchQuery[] = [];
  if (reference.provider === "tpdb") {
    queries.push({
      provider: "tpdb",
      kind: "movie",
      tags: seedIds,
      perPage: CANDIDATE_PAGE,
    });
    if (counterpartIds.length > 0) {
      queries.push({
        provider: "stashdb",
        kind: "scene",
        tags: counterpartIds,
        perPage: CANDIDATE_PAGE,
      });
    }
  } else {
    queries.push({
      provider: "stashdb",
      kind: "scene",
      tags: seedIds,
      perPage: CANDIDATE_PAGE,
    });
    if (counterpartIds.length > 0) {
      queries.push({
        provider: "tpdb",
        kind: "movie",
        tags: counterpartIds,
        perPage: CANDIDATE_PAGE,
      });
    }
  }
  const settled = await Promise.all(
    queries.map(async (q) => {
      try {
        return { items: (await searchCatalog(q)).items, error: undefined };
      } catch (err) {
        return {
          items: [] as CatalogDetail[],
          error: toSourceError(q.provider, err),
        };
      }
    }),
  );

  // Dedup by provider+kind+id, drop the source itself, drop personally
  // hidden titles. The source detail's own provider-native `related`
  // references stay out of this list: that is a separate, unranked concept,
  // and its entries only enter here through the same tag searches.
  const errors: SourceError[] = [];
  const seen = new Set([refKey(reference)]);
  const visible: CatalogDetail[] = [];
  for (const page of settled) {
    if (page.error !== undefined) errors.push(page.error);
    for (const detail of page.items) {
      const key = refKey(detail.reference);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isHiddenTitle(detail, hiddenTags)) continue;
      visible.push(detail);
    }
  }

  // Deterministic relevance: how many of the candidate's provider-published
  // tags exactly equal a seed tag after normalization. Ties first prefer a
  // genuinely shared native performer/studio reference — same provider AND
  // same id, never a name comparison — then a stable reference order, so
  // equal-scoring rails never shuffle between loads.
  const seedNames = new Set(seedTags.map((t) => normalizeFacetName(t.name)));
  const seedRefs = new Set([
    ...source.credits.map((c) => refKey(c.reference)),
    ...(source.studio?.reference !== undefined
      ? [refKey(source.studio.reference)]
      : []),
  ]);
  const shortlist = visible
    .map((detail) => ({
      detail,
      shared: detail.tags.filter((t) =>
        seedNames.has(normalizeFacetName(t.name)),
      ).length,
      sameCompany:
        (detail.studio?.reference !== undefined &&
          seedRefs.has(refKey(detail.studio.reference))) ||
        detail.credits.some((c) => seedRefs.has(refKey(c.reference))),
    }))
    .filter((e) => e.shared > 0)
    .sort((a, b) => {
      if (a.shared !== b.shared) return b.shared - a.shared;
      if (a.sameCompany !== b.sameCompany) return a.sameCompany ? -1 : 1;
      const ka = refKey(a.detail.reference);
      const kb = refKey(b.detail.reference);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, RELATED_LIMIT)
    .map((e) => e.detail);

  // Optional, explicitly requested Jev rerank: metadata-only, bounded to the
  // shortlist, and able only to reorder it. Any failure (no key, outage,
  // malformed answer) keeps the deterministic tag order and reads as
  // canRank: false.
  let ranking: RelatedTitles["ranking"] = "tags";
  let canRank = false;
  let items = shortlist;
  if (options.rank === "jev" && shortlist.length > 1) {
    const descriptors = shortlist.map(descriptor);
    const reranked = await rankRelatedTitles(
      descriptor(source),
      descriptors,
      options.typesafeApiKey,
    );
    if (reranked !== null) {
      const back = new Map(descriptors.map((d, i) => [d, shortlist[i]!]));
      items = reranked.map((d) => back.get(d)!);
      ranking = "jev";
      canRank = true;
    }
  }
  return { items, ranking, canRank, errors };
}

/** "Often appears with" rail for one performer: co-appearance counts over a
 * bounded slice of the performer's own filmography on their own provider.
 * Published co-credits are the evidence — never name or attribute guessing.
 * No cross-provider merge (the existing crossProviderLink chip covers the
 * counterpart) and no Jev in this pass. */
export type RelatedPerformers = {
  items: CatalogDetail[];
  errors: SourceError[];
};

// ponytail: one filmography page per rail (50 rows); partners beyond it are
// genuinely unreachable from this slice — widen with real paging only if a
// rail looks thin. Both providers' listing rows already carry credited
// performers' published name and image, so no bounded detail-read fallback
// exists here; add one (with its own page cap) if a listing shape ever
// drops credits.
const FILMOGRAPHY_SLICE = 50;

export async function relatedPerformers(
  reference: CatalogReference,
  hiddenTags: CatalogTagSelection[],
): Promise<RelatedPerformers> {
  if (reference.kind !== "performer") {
    throw new AppError(
      400,
      "invalid_reference",
      "Related performers need a performer reference.",
    );
  }
  // The performer's own filmography, their own provider: TPDB movie
  // filmography, StashDB scene credits.
  const query: CatalogSearchQuery =
    reference.provider === "tpdb"
      ? {
          provider: "tpdb",
          kind: "movie",
          performer: reference.id,
          page: 1,
          perPage: FILMOGRAPHY_SLICE,
        }
      : {
          provider: "stashdb",
          kind: "scene",
          performer: reference.id,
          page: 1,
          perPage: FILMOGRAPHY_SLICE,
        };
  let page: CatalogSearchPage;
  try {
    page = await searchCatalog(query);
  } catch (err) {
    return { items: [], errors: [toSourceError(reference.provider, err)] };
  }
  // Count co-appearances over visible titles only; the performer themself
  // and duplicate credit rows never count twice on one title. ponytail: a
  // requested alias id whose credits carry the canonical id would keep a
  // same-person credit counted — add canonical self resolution via one
  // detail read only if a real provider case shows up.
  const selfKey = refKey(reference);
  const counts = new Map<string, { credit: CatalogCredit; count: number }>();
  for (const row of page.items) {
    if (isHiddenTitle(row, hiddenTags)) continue;
    for (const credit of row.credits) {
      const key = refKey(credit.reference);
      if (key === selfKey) continue;
      const seen = counts.get(key);
      if (seen !== undefined) {
        seen.count += 1;
      } else {
        counts.set(key, { credit, count: 1 });
      }
    }
  }
  const items = [...counts.values()]
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.credit.name !== b.credit.name) {
        return a.credit.name < b.credit.name ? -1 : 1;
      }
      const ka = refKey(a.credit.reference);
      const kb = refKey(b.credit.reference);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, RELATED_LIMIT)
    .map(({ credit }) => ({
      reference: credit.reference,
      title: credit.name,
      ...(credit.imageUrl !== undefined ? { imageUrl: credit.imageUrl } : {}),
      credits: [],
      tags: [],
      related: [],
      links: [],
      aliases: [],
    }));
  return { items, errors: [] };
}
