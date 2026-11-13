// Catalog visibility policy shared by browse, related and discover: whether a
// title matches a tag selection (tagMatcher) and whether an account's hidden
// tags hide it (hiddenTitleMatcher). Pure move out of server/browse.ts.
//
// Cost model: a browse scan filters up to MAX_SCAN_PAGES pages per stream,
// so each selection folds once per request (tagMatcher) and each title's
// tags fold once per title (FoldedTags), never once per title x selection.

import { facetTokens, normalizeFacetName } from "../lib/contracts.ts";
import type { CatalogDetail, CatalogTagSelection } from "../lib/contracts.ts";

/** One title's tag names, folded at most once per form on first use: the
 * exact/substring modes read `labels`, the family mode reads `tokens`. */
export class FoldedTags {
  readonly detail: CatalogDetail;
  #labels?: string[];
  #tokens?: string[][];

  constructor(detail: CatalogDetail) {
    this.detail = detail;
  }

  get labels(): string[] {
    return (this.#labels ??= this.detail.tags.map((t) =>
      normalizeFacetName(t.name),
    ));
  }

  get tokens(): string[][] {
    return (this.#tokens ??= this.detail.tags.map((t) => facetTokens(t.name)));
  }
}

// --- tag matching: provider UUID first, then label by mode ("exact" folded
// equality, or "family" whole-word-sequence containment for local filtration) ---

/** Folds `sel` once and returns its matcher over one title's folded tags.
 * `"exact"`: folded-label equality — the include paths, which mirror or
 * must agree with native provider tag ids. `"substring"`: the folded term
 * appears anywhere in a tag's folded name — free-text include chips, whose
 * native any-of expansion only pre-filters, so the visible predicate
 * re-checks every term locally after pages arrive. `"family"`: the selection's
 * token sequence appears as a contiguous run of the tag's tokens, so
 * "Anal" matches "Anal Creampie"/"Rough Anal Sex" but never "Analingus",
 * and "Double Penetration" never matches "Double Anal Penetration" — the
 * hidden/exclude filtration paths. An empty (blank) selection label matches
 * nothing in either mode. */
export function tagMatcher(
  sel: CatalogTagSelection,
  mode: "exact" | "family" | "substring",
): (tags: FoldedTags) => boolean {
  const native = ({ detail }: FoldedTags): boolean => {
    const id = detail.reference.provider === "tpdb" ? sel.tpdb : sel.stashdb;
    return id !== undefined && detail.tags.some((t) => t.id === id);
  };
  const label = normalizeFacetName(sel.name);
  // An empty normalized label identifies nothing — never a wildcard. A
  // non-empty label has at least one token: both fold the same way.
  if (label === "") return native;
  if (mode === "exact") {
    return (tags) => native(tags) || tags.labels.includes(label);
  }
  if (mode === "substring") {
    return (tags) =>
      native(tags) || tags.labels.some((name) => name.includes(label));
  }
  const selTokens = facetTokens(sel.name);
  return (tags) =>
    native(tags) ||
    tags.tokens.some(
      (tagTokens) =>
        tagTokens.length >= selTokens.length &&
        tagTokens.some((_, i) =>
          selTokens.every((tok, j) => tagTokens[i + j] === tok),
        ),
    );
}

/** Builds the hidden-tag test once per request: true when any personal
 * hidden tag matches by provider UUID, or by label under the family rule:
 * the selection's normalized word sequence appears as a contiguous run of
 * the tag's words ("Anal" hides "Anal Creampie", never "Analingus"). Raw
 * substring and AI inference are never applied; preference is filtration,
 * never authorization. */
export function hiddenTitleMatcher(
  hiddenTags: CatalogTagSelection[],
): (detail: CatalogDetail) => boolean {
  const matchers = hiddenTags.map((sel) => tagMatcher(sel, "family"));
  return (detail) => {
    const tags = new FoldedTags(detail);
    return matchers.some((matches) => matches(tags));
  };
}
