// Performer match suggestions: a bounded name search on the other provider,
// each candidate scored by scorePerformerMatch. Suggestions never link
// anything; the user confirms each merge (docs/specs/performer-matches.md).

import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  PerformerMatchesResponse,
} from "../lib/contracts.ts";
import { sourceError } from "./http.ts";
import { getCatalogDetail, searchCatalog } from "./providers.ts";
import {
  MATCH_MAX_CANDIDATES,
  MATCH_MAX_SUGGESTIONS,
  MATCH_SUGGEST_MIN,
  normalizePerformerName,
  scorePerformerMatch,
} from "./performer-match.ts";

/** Searches the other provider for the performer's title and first two
 * aliases and returns the probable records with their evidence. A failed
 * search or detail read is a named error beside the other results, and a
 * capped candidate list says so in `incomplete`. */
export async function performerMatchSuggestions(
  detail: CatalogDetail,
): Promise<PerformerMatchesResponse> {
  const other: CatalogProvider =
    detail.reference.provider === "tpdb" ? "stashdb" : "tpdb";
  const otherLabel = other === "tpdb" ? "TPDB" : "StashDB";
  const response: PerformerMatchesResponse = {
    suggestions: [],
    searched: [],
    incomplete: [],
    errors: [],
  };
  const queried = new Set<string>();
  const found = new Map<string, CatalogReference>();
  // ponytail: 3 queries (title + 2 aliases), one search page each, and 10
  // candidate detail reads — a bounded name search, not a scan. A wider net
  // wants the provider's own paging plumbed through and a stored candidate
  // index, not bigger slices here.
  for (const query of [detail.title, ...detail.aliases.slice(0, 2)]) {
    const key = normalizePerformerName(query);
    if (key === "" || queried.has(key)) continue;
    queried.add(key);
    response.searched.push(query);
    try {
      const page = await searchCatalog(
        other === "tpdb"
          ? { provider: "tpdb", kind: "performer", query, perPage: 10 }
          : { provider: "stashdb", kind: "performer", query },
      );
      for (const item of page.items) {
        const ref = item.reference;
        if (
          ref.provider === detail.reference.provider &&
          ref.id === detail.reference.id
        ) {
          continue; // the performer itself, echoed back
        }
        if (!found.has(ref.id)) found.set(ref.id, ref);
      }
    } catch (err) {
      response.errors.push(sourceError(other, err));
    }
  }
  const candidates = [...found.values()];
  if (candidates.length > MATCH_MAX_CANDIDATES) {
    response.incomplete.push(
      `Compared the first ${MATCH_MAX_CANDIDATES} of ${candidates.length} ${otherLabel} search results`,
    );
  }
  for (const reference of candidates.slice(0, MATCH_MAX_CANDIDATES)) {
    let candidate: CatalogDetail | null;
    try {
      candidate = await getCatalogDetail(reference);
    } catch (err) {
      response.errors.push(sourceError(other, err));
      continue;
    }
    if (candidate === null) continue; // deleted or missing upstream
    const { score, confidence, signals, hardConflict } = scorePerformerMatch(
      detail,
      candidate,
    );
    if (hardConflict || score < MATCH_SUGGEST_MIN) continue;
    response.suggestions.push({
      reference: candidate.reference,
      title: candidate.title,
      ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
      aliases: candidate.aliases.slice(0, 5),
      score,
      confidence,
      signals,
    });
  }
  response.suggestions = response.suggestions
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.reference.id < b.reference.id
          ? -1
          : a.reference.id > b.reference.id
            ? 1
            : 0),
    )
    .slice(0, MATCH_MAX_SUGGESTIONS);
  return response;
}
