// Catalog visibility policy shared by browse, related and discover: whether a
// title matches a tag selection (tagMatches) and whether an account's hidden
// tags hide it (isHiddenTitle). Pure move out of server/browse.ts.

import { facetTokens, normalizeFacetName } from "../lib/contracts.ts";
import type { CatalogDetail, CatalogTagSelection } from "../lib/contracts.ts";

// --- tag matching: provider UUID first, then label by mode ("exact" folded
// equality, or "family" whole-word-sequence containment for local filtration) ---

/** `"exact"`: folded-label equality — the include paths, which mirror or
 * must agree with native provider tag ids. `"family"`: the selection's
 * token sequence appears as a contiguous run of the tag's tokens, so
 * "Anal" matches "Anal Creampie"/"Rough Anal Sex" but never "Analingus",
 * and "Double Penetration" never matches "Double Anal Penetration" — the
 * hidden/exclude filtration paths. An empty (blank) selection label matches
 * nothing in either mode. */
export function tagMatches(
  detail: CatalogDetail,
  sel: CatalogTagSelection,
  mode: "exact" | "family",
): boolean {
  const nativeId =
    detail.reference.provider === "tpdb" ? sel.tpdb : sel.stashdb;
  if (nativeId !== undefined && detail.tags.some((t) => t.id === nativeId)) {
    return true;
  }
  const label = normalizeFacetName(sel.name);
  // An empty normalized label identifies nothing — never a wildcard.
  if (label === "") return false;
  if (mode === "exact") {
    return detail.tags.some((t) => normalizeFacetName(t.name) === label);
  }
  const selTokens = facetTokens(sel.name);
  if (selTokens.length === 0) return false;
  return detail.tags.some((t) => {
    const tagTokens = facetTokens(t.name);
    if (tagTokens.length < selTokens.length) return false;
    return tagTokens.some((_, i) =>
      selTokens.every((tok, j) => tagTokens[i + j] === tok),
    );
  });
}

/** True when any personal hidden tag matches by provider UUID, or by label
 * under the family rule: the selection's normalized word sequence appears
 * as a contiguous run of the tag's words ("Anal" hides "Anal Creampie",
 * never "Analingus"). Raw substring and AI inference are never applied;
 * preference is filtration, never authorization. */
export function isHiddenTitle(
  detail: CatalogDetail,
  hiddenTags: CatalogTagSelection[],
): boolean {
  return hiddenTags.some((sel) => tagMatches(detail, sel, "family"));
}
