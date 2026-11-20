// User-visible catalog composition: one Browse destination over TPDB movies
// and StashDB scenes, with personal hidden tags and tag include/exclude
// filters layered on top of provider-native search. The metadata cache in
// providers.ts stays unfiltered and shared: every per-user predicate here is
// evaluated locally AFTER provider pages arrive and keyed by nothing
// personal, so one account's hidden list can never leak into another's
// cached results.
//
// Ordering honesty: a merged page is globally ordered only when every
// qualifying stream is natively sorted by the same key (release recency or
// duration). A TPDB performer filmography has no upstream order at all, so
// any query it qualifies runs as stable concatenation and claims no order.
//
// ponytail: upstream scan ceiling is 40 provider pages per stream, and —
// since VELV-240 — 40 per provider per request: every stream of one browse
// draws from one shared pool (createScanBudget), so entity seeds x fan-out
// ids cannot multiply a request's reads past the ceiling. Hitting it
// before a page fills is a visible 422 "query_too_broad", never a fake
// empty page or fake end — narrow the filters. One exception:
// a multi-term free-text AND split between a native tag criterion and the
// local re-check degrades to a named partial page instead
// (Stream.softCeiling). A second: a side whose free-text expansion is
// provably empty (complete freshness-bounded listing, no match, no
// uuid-less rows) answers exact zero before any scan. A third: a page past
// the deepest page the ceiling can fill is refused before any read
// (refuseUnscannablePage). Raise MAX_SCAN_PAGES only when real browsing
// measurably needs it.

// Stryker disable all — the mutation window re-opens below the parse/adapters
// block and covers the pure merge/plan logic only (mergeStreams, nativeQuery,
// planBrowseSides); parse helpers and fetch adapters stay out of scope.

import { setImmediate as nextMacrotask } from "node:timers/promises";

import {
  FoldedTags,
  hiddenTitleMatcher,
  tagMatcher,
} from "./catalog-visibility.ts";

import { AppError, sourceError } from "./http.ts";
import { suggestTags, tagSuggestionsAllowed } from "./judgment.ts";
import {
  listCatalogTags,
  MAX_ROWS_PER_PAGE_FACTOR,
  resolveTpdbStudioFilter,
  searchCatalog,
  searchCatalogTags,
  tagCounterpart,
  expandCatalogTagTerm,
} from "./providers.ts";
import {
  resolveIncludeCriteria,
  scanCeilingError,
  scanCeilingOutcome,
  softCeilingFor,
  type TagExpansion,
} from "../lib/browse-includes.ts";
import type {
  CatalogSearchPage,
  CatalogSearchQuery,
  CatalogSortDirection,
  CatalogSortKey,
  ReleaseDateOperation,
} from "./providers.ts";
import {
  getConfig,
  parseIncludeSelections,
  parseTagSelections,
} from "./storage.ts";
import { isIsoDate, isUuid } from "./provider-rows.ts";
import {
  CATALOG_YEAR_MAX,
  CATALOG_YEAR_MIN,
  normalizeFacetName,
} from "../lib/contracts.ts";
import {
  MAX_BROWSE_ENTITIES,
  entriesUnknownTo,
  mergedSourceRestricted,
  planStreams,
  sourceRunsFor,
  type BrowseStreamSeed,
  type PerformerMode,
  type StreamPlan,
} from "../lib/browse-entities.ts";
import { BROWSE_MIXED_SORTS, SORT_KEYS, sortSpec } from "../lib/sorts.ts";
import type {
  BrowseEntity,
  BrowseNotice,
  BrowseTagsResponse,
  CatalogDetail,
  CatalogProvider,
  CatalogTagSelection,
  SourceError,
} from "../lib/contracts.ts";

const MAX_SCAN_PAGES = 40;

/** One pool of MAX_SCAN_PAGES upstream page reads per provider, shared by
 * every stream of one browse request (VELV-240): fan-out multiplies the
 * streams a browse opens (ids x entity seeds), so the per-stream ceiling
 * alone let one request read seeds x ids x 40 pages on the shared
 * operator keys. Takes are synchronous, so concurrent streams cannot
 * oversubscribe the pool; a stream refused a page ends soft with the
 * named scan_ceiling error (scanCeilingError) — the hard query_too_broad
 * stays a stream's own "40 broad pages" verdict, which is why the
 * per-stream check runs first in Stream.fetch and a lone stream can never
 * see the pool refuse it (its own ceiling fires at the same fetch). */
function createScanBudget(): (provider: CatalogProvider) => boolean {
  const left = new Map<CatalogProvider, number>();
  return (provider) => {
    const have = left.get(provider) ?? MAX_SCAN_PAGES;
    if (have <= 0) return false;
    left.set(provider, have - 1);
    return true;
  };
}

// --- pinned public shapes ---

export type BrowseType = "all" | "movie" | "scene";

export type BrowseQuery = {
  type: BrowseType;
  q?: string;
  /** Include terms AND together; a group element (a non-empty array) is one
   * "or" term matching when ANY member matches. */
  include: (CatalogTagSelection | CatalogTagSelection[])[];
  exclude: CatalogTagSelection[];
  /** Up to MAX_BROWSE_ENTITIES performer/studio entries; old scalar keys
   * consolidate into one entry each at parse time. */
  performers: BrowseEntity[];
  studios: BrowseEntity[];
  performerMode: PerformerMode;
  performerStarred?: true;
  studioMode: "exact" | "withChildren";
  /** Inclusive release-year window. A lone year stays exact.
   * With release-date order, a range sends one bound upstream and checks
   * both bounds locally. */
  year?: number;
  yearTo?: number;
  date?: string;
  dateOperation?: ReleaseDateOperation;
  /** Inclusive release-date upper bound (`YYYY-MM-DD`). Requires `date` + `>=`.
   * Release-date order selects the native bound. Both bounds also check locally. */
  dateTo?: string;
  sort?: CatalogSortKey;
  direction?: CatalogSortDirection;
  page: number;
  perPage: number;
};

export type BrowsePage = {
  items: CatalogDetail[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  errors: SourceError[];
  /** Why a source skipped or narrowed an entity filter: muted notes beside
   * the grid, never errors and never total-hiding. */
  notices: BrowseNotice[];
};

// --- query-string parsing (shape validation only; combination policy lives
// in browseTitles where cross-field context exists) ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** TPDB site slug: the `/sites/<slug>` token (path-safe by construction). */
const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const DATE_OPS: readonly ReleaseDateOperation[] = ["<", "<=", "=", ">", ">="];

function invalidQuery(message: string): AppError {
  return new AppError(400, "invalid_query", message);
}

function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim() as T;
  if (!allowed.includes(value)) {
    throw invalidQuery(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function parseId(params: URLSearchParams, key: string): string | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  // TPDB publishes studio identity as a uuid BESIDE a /sites/<slug> token,
  // and cross-provider studio links legitimately carry the slug. Slugged
  // values are validated to a path-safe provider token so they can never
  // smuggle URL syntax into an upstream path.
  const slugOk = key === "studioTpdb" && SITE_SLUG_RE.test(value);
  if (!UUID_RE.test(value) && !slugOk) {
    throw invalidQuery(
      key === "studioTpdb"
        ? "studioTpdb must be a provider UUID or site slug."
        : `${key} must be a provider UUID.`,
    );
  }
  return value.toLowerCase();
}

function parseJsonArray(
  params: URLSearchParams,
  key: string,
  what: string,
): unknown {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return [];
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidQuery(`${key} must be a JSON array of ${what}.`);
  }
}

/** One performer or studio entry of the multi-entity filters. At least one
 * provider id is required; a TPDB studio id may also be a site slug (same
 * rule as parseId). Trimmed name kept, ids lowercased. */
function parseEntityEntries(
  params: URLSearchParams,
  key: string,
  kind: "performer" | "studio",
): BrowseEntity[] {
  const parsed = parseJsonArray(params, key, `${kind} entries`);
  if (!Array.isArray(parsed)) {
    throw invalidQuery(`${key} must be a JSON array of ${kind} entries.`);
  }
  if (parsed.length > MAX_BROWSE_ENTITIES) {
    throw invalidQuery(`${key} holds at most ${MAX_BROWSE_ENTITIES} entries.`);
  }
  const entries: BrowseEntity[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidQuery(`${key} entries must be JSON objects.`);
    }
    const rec = raw as Record<string, unknown>;
    for (const field of Object.keys(rec)) {
      if (field !== "name" && field !== "tpdb" && field !== "stashdb") {
        throw invalidQuery(
          `${key} entries accept only name, tpdb and stashdb fields.`,
        );
      }
    }
    let name: string | undefined;
    if (rec.name !== undefined) {
      if (typeof rec.name !== "string") {
        throw invalidQuery(`${key} entry name must be a string.`);
      }
      const trimmed = rec.name.trim();
      if (trimmed.length < 1 || trimmed.length > 120) {
        throw invalidQuery(`${key} entry name must be 1..120 characters.`);
      }
      name = trimmed;
    }
    let tpdb: string | undefined;
    if (rec.tpdb !== undefined) {
      const value = typeof rec.tpdb === "string" ? rec.tpdb.trim() : "";
      // Same slug allowance as parseId: cross-provider studio links
      // legitimately carry the /sites/<slug> token.
      const slugOk = kind === "studio" && SITE_SLUG_RE.test(value);
      if (!UUID_RE.test(value) && !slugOk) {
        throw invalidQuery(
          kind === "studio"
            ? `${key} entry tpdb must be a provider UUID or site slug.`
            : `${key} entry tpdb must be a provider UUID.`,
        );
      }
      tpdb = value.toLowerCase();
    }
    let stashdb: string | undefined;
    if (rec.stashdb !== undefined) {
      const value = typeof rec.stashdb === "string" ? rec.stashdb.trim() : "";
      if (!UUID_RE.test(value)) {
        throw invalidQuery(`${key} entry stashdb must be a provider UUID.`);
      }
      stashdb = value.toLowerCase();
    }
    if (tpdb === undefined && stashdb === undefined) {
      throw invalidQuery(`${key} entry needs a TPDB or StashDB id.`);
    }
    entries.push({
      ...(name !== undefined ? { name } : {}),
      ...(tpdb !== undefined ? { tpdb } : {}),
      ...(stashdb !== undefined ? { stashdb } : {}),
    });
  }
  return entries;
}

function refuse(message: string): never {
  throw new AppError(400, "invalid_search", message);
}

/** Parses the pinned browse query string. Unknown values are explicit 400s,
 * never defaults in disguise. `date` and `date_operation` always travel as a
 * pair, mirroring the upstream contract. */
export function parseBrowseQuery(params: URLSearchParams): BrowseQuery {
  const type = parseEnum(params.get("type"), ["all", "movie", "scene"], "type");
  const studioMode = parseEnum(
    params.get("studioMode"),
    ["exact", "withChildren"],
    "studioMode",
  );
  const performerMode = parseEnum(
    params.get("performerMode"),
    ["all", "any"],
    "performerMode",
  );
  const sort = parseEnum(params.get("sort"), SORT_KEYS, "sort");
  const direction = parseEnum(
    params.get("direction"),
    ["asc", "desc"],
    "direction",
  );
  if (direction !== undefined && sort === undefined) {
    throw invalidQuery("direction requires an explicit sort.");
  }
  const date = params.get("date")?.trim() ?? "";
  const dateOperation = parseEnum(
    params.get("date_operation"),
    DATE_OPS,
    "date_operation",
  );
  if (date !== "" && !isIsoDate(date)) {
    throw invalidQuery("date must be a real calendar date (YYYY-MM-DD).");
  }
  if (date !== "" && dateOperation === undefined) {
    throw invalidQuery("date requires date_operation.");
  }
  if (dateOperation !== undefined && date === "") {
    throw invalidQuery("date_operation requires date.");
  }
  const dateTo = params.get("dateTo")?.trim() ?? "";
  if (dateTo !== "" && !isIsoDate(dateTo)) {
    throw invalidQuery("dateTo must be a real calendar date (YYYY-MM-DD).");
  }
  const parseYear = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < CATALOG_YEAR_MIN ||
      value > CATALOG_YEAR_MAX
    ) {
      throw invalidQuery(
        `${key} must be a calendar year between ${CATALOG_YEAR_MIN} and ${CATALOG_YEAR_MAX}.`,
      );
    }
    return value;
  };
  const year = parseYear("year");
  const yearTo = parseYear("yearTo");
  // A range is a pair, not two independent bounds; a date cutoff and a year
  // window are different release-time vocabularies and never combine.
  if (yearTo !== undefined && year === undefined) {
    refuse("yearTo requires a year.");
  }
  if (yearTo !== undefined && year !== undefined && yearTo < year) {
    refuse("yearTo cannot be before year.");
  }
  if (yearTo !== undefined && date !== "") {
    refuse("yearTo cannot be combined with a date filter.");
  }
  // `dateTo` completes a `date` + `>=` range; it never travels alone and
  // never mixes with the year vocabulary.
  if (dateTo !== "") {
    if (date === "") refuse("dateTo requires a date filter.");
    if (dateOperation !== ">=") {
      refuse("dateTo requires date_operation=>=.");
    }
    if (dateTo < date) refuse("dateTo cannot be before date.");
    if (year !== undefined || yearTo !== undefined) {
      refuse("dateTo cannot be combined with a year filter.");
    }
  }
  const pageRaw = params.get("page");
  const perPageRaw = params.get("perPage");
  const page = pageRaw === null || pageRaw.trim() === "" ? 1 : Number(pageRaw);
  const perPage =
    perPageRaw === null || perPageRaw.trim() === "" ? 24 : Number(perPageRaw);
  if (!Number.isInteger(page) || page < 1) {
    throw invalidQuery("page must be a positive integer.");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw invalidQuery("perPage must be an integer between 1 and 100.");
  }
  const q = params.get("q")?.trim();
  const performerStarred = parseEnum(
    params.get("performerStarred"),
    ["1"],
    "performerStarred",
  );
  // The new entry arrays and the old scalar keys never share a request:
  // two spellings of one filter would silently AND disjoint entry sets.
  const performerEntries = parseEntityEntries(
    params,
    "performers",
    "performer",
  );
  const studioEntries = parseEntityEntries(params, "studios", "studio");
  const oldPerformerTpdb = parseId(params, "performerTpdb");
  const oldPerformerStashdb = parseId(params, "performerStashdb");
  const oldStudioTpdb = parseId(params, "studioTpdb");
  const oldStudioStashdb = parseId(params, "studioStashdb");
  if (
    (oldPerformerTpdb !== undefined || oldPerformerStashdb !== undefined) &&
    performerEntries.length > 0
  ) {
    refuse(
      "performers cannot be combined with performerTpdb/performerStashdb.",
    );
  }
  if (
    (oldStudioTpdb !== undefined || oldStudioStashdb !== undefined) &&
    studioEntries.length > 0
  ) {
    refuse("studios cannot be combined with studioTpdb/studioStashdb.");
  }
  // One old key or both old keys of one kind consolidate into ONE unnamed
  // entry — the unified tile shape the old URL always carried.
  const performers =
    oldPerformerTpdb !== undefined || oldPerformerStashdb !== undefined
      ? [
          {
            ...(oldPerformerTpdb !== undefined
              ? { tpdb: oldPerformerTpdb }
              : {}),
            ...(oldPerformerStashdb !== undefined
              ? { stashdb: oldPerformerStashdb }
              : {}),
          },
        ]
      : performerEntries;
  const studios =
    oldStudioTpdb !== undefined || oldStudioStashdb !== undefined
      ? [
          {
            ...(oldStudioTpdb !== undefined ? { tpdb: oldStudioTpdb } : {}),
            ...(oldStudioStashdb !== undefined
              ? { stashdb: oldStudioStashdb }
              : {}),
          },
        ]
      : studioEntries;
  // The same provider id twice in one kind would double-count that source's
  // stream or criterion: refuse rather than dedupe behind the caller's back.
  for (const [key, entries] of [
    ["performers", performers],
    ["studios", studios],
  ] as const) {
    for (const side of ["tpdb", "stashdb"] as const) {
      const ids = entries
        .map((e) => e[side])
        .filter((id): id is string => id !== undefined);
      if (new Set(ids).size !== ids.length) {
        refuse(
          `${key} holds the same ${side === "tpdb" ? "TPDB" : "StashDB"} id twice.`,
        );
      }
    }
  }
  return {
    type: type ?? "all",
    ...(q !== undefined && q !== "" ? { q } : {}),
    // Both lists accept labels with no provider id: an include label is a
    // free-text term that expands on each side's published tags — the
    // native any-of criterion when the expansion is complete and within
    // the native id cap, the local substring re-check otherwise — and an
    // exclude label runs the local family matcher. Neither can travel as
    // an exact native tag, so neither is rejected here. An include element
    // may also be an "or" group (a JSON array of selections).
    include: parseIncludeSelections(
      parseJsonArray(params, "include", "tag selections"),
    ),
    exclude: parseTagSelections(
      parseJsonArray(params, "exclude", "tag selections"),
    ),
    performers,
    studios,
    performerMode: performerMode ?? "all",
    ...(performerStarred !== undefined
      ? { performerStarred: true as const }
      : {}),
    studioMode: studioMode ?? "exact",
    ...(year !== undefined ? { year } : {}),
    ...(yearTo !== undefined ? { yearTo } : {}),
    ...(date !== "" && dateOperation !== undefined
      ? { date, dateOperation }
      : {}),
    ...(dateTo !== "" ? { dateTo } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(direction !== undefined ? { direction } : {}),
    page,
    perPage,
  };
}

// --- stream planning ---

/** A selection with no provider id on either side: a free-text chip. An
 * include expands to every published tag whose name contains the term and
 * travels natively as an any-of criterion; an exclude runs the local
 * family matcher. One predicate for the whole pipeline — parse, native
 * resolution and the visible predicate must agree on it, or a free-text
 * include 400s or disqualifies a side again. */
function isFreeTextSelection(sel: CatalogTagSelection): boolean {
  return sel.tpdb === undefined && sel.stashdb === undefined;
}

/** One include term: a plain selection or an "or" group (a non-empty array
 * of selections matching when ANY member matches). */
type IncludeTerm = CatalogTagSelection | CatalogTagSelection[];

function includeTermMatcher(term: IncludeTerm): (tags: FoldedTags) => boolean {
  if (!Array.isArray(term)) {
    return tagMatcher(term, isFreeTextSelection(term) ? "substring" : "exact");
  }
  // An "or" group: anchored members match exact label, free-text members
  // substring — one member matching satisfies the whole term.
  const members = term.map((m) =>
    tagMatcher(m, isFreeTextSelection(m) ? "substring" : "exact"),
  );
  return (tags) => members.some((matches) => matches(tags));
}

function visiblePredicate(
  hiddenTags: CatalogTagSelection[],
  exclude: CatalogTagSelection[],
  include: IncludeTerm[],
  years: { from?: number; to?: number } | undefined,
  creditsAllOf: string[],
  dateTo?: string,
  dateFrom?: string,
): (d: CatalogDetail) => boolean {
  // Exclusions win over includes: a hidden or excluded match blocks the item
  // regardless of any include criterion. Selections fold once here, per
  // request; each item's tags fold once inside FoldedTags. A typed
  // (free-text) exclude matches by "contains" like a typed include ("anal"
  // removes "Analingus" too); a picked tag and personal hidden tags keep the
  // word-family rule ("Anal" hides "Anal Creampie", never "Analingus").
  const blocked = [
    ...hiddenTags.map((sel) => tagMatcher(sel, "family")),
    ...exclude.map((sel) =>
      tagMatcher(sel, isFreeTextSelection(sel) ? "substring" : "family"),
    ),
  ];
  const required = include.map(includeTermMatcher);
  // TPDB all-mode filmography: the route only carries the first entry's
  // performer, so the visible predicate re-checks every other entry's id
  // in the rows' credits — the "all of" AND stays honest.
  const credits = creditsAllOf.map(
    (id) => (d: CatalogDetail) =>
      d.credits.some(
        (c) => c.reference.provider === "tpdb" && c.reference.id === id,
      ),
  );
  return (d) => {
    const tags = new FoldedTags(d);
    if (blocked.some((matches) => matches(tags))) return false;
    if (!required.every((matches) => matches(tags))) return false;
    if (!credits.every((matches) => matches(d))) return false;
    if (
      years !== undefined &&
      (years.from !== undefined || years.to !== undefined)
    ) {
      // A missing release date can never prove the year window, so it
      // excludes — same rule as the old exact-year check.
      const raw = d.releaseDate?.slice(0, 4);
      if (raw === undefined) return false;
      const year = Number(raw);
      if (years.from !== undefined && year < years.from) return false;
      if (years.to !== undefined && year > years.to) return false;
    }
    if (dateTo !== undefined) {
      // ISO dates compare as strings; a missing release date can never
      // prove the window, so it excludes — same rule as the year check.
      const released = d.releaseDate?.slice(0, 10);
      if (released === undefined || released > dateTo) return false;
    }
    if (dateFrom !== undefined) {
      // ISO dates compare as strings; a missing release date can never
      // prove the window, so it excludes — same rule as the year check.
      const released = d.releaseDate?.slice(0, 10);
      if (released === undefined || released < dateFrom) return false;
    }
    return true;
  };
}

/** The native include criteria one provider side can carry: `allOf` are
 * the anchored tag ids plus every singleton term expansion (AND
 * criterion — a title satisfying the term AND must carry each of these
 * tags), `anyOf` the smallest term expansion (any-of criterion — a
 * valid pre-filter only, sent when no singleton or anchored id exists and
 * the expansion is complete and fits the native id cap). A term is a
 * plain selection or an "or" group; a group's expansion is the deduped
 * union of its members' native ids, and it follows the same rules as a
 * free-text term. `localInclude` holds the terms the visible predicate
 * must still re-check locally: the free-text and group terms (several AND
 * together, which one upstream tag criterion cannot express) and anchored
 * chips whose exact-label counterpart row is uuid-less (matched by exact
 * label, never a native criterion). `localFree` holds the expanding terms
 * part of `localInclude` (uuid-less anchored chips excluded): the soft
 * ceiling counts productive native pre-filtering, which only an expanding
 * local term beside a native criterion provides — a uuid-less chip filters
 * an unfiltered scan, so it keeps the hard ceiling. */
type ResolvedIncludes = {
  allOf: string[];
  anyOf: string[];
  localInclude: IncludeTerm[];
  localFree: IncludeTerm[];
  /** True when at least one expanding term rides the native tag criterion
   * (a singleton expansion in `allOf`, or the `anyOf` group): at the scan
   * ceiling such a stream degrades softly — its pages were productive and
   * the matches found are a real partial answer. */
  freeTextNative: boolean;
  /** The planned fan-out group: one native all-of stream per id, each
   * carrying `allOf ∪ {id}`, when anchored ids sit beside a small complete
   * free-text group — neither provider can express all-of plus any-of in
   * one query, so the group fans out instead of starving into the 422
   * ceiling. Empty on every other plan: a group above the fan-out cap,
   * one that misses the native id cap, or an incomplete expansion keeps
   * the local re-check, and with no anchored ids the any-of pre-filter
   * runs as before. */
  fanoutIds: string[];
};

/** Resolves the native include criteria for one provider side. Anchored
 * plain selections resolve as before: a selection already carrying the
 * side's UUID uses it; otherwise the counterpart id is resolved through
 * the providers' own published label pairing. A uuid-less exact-label match
 * (TPDB numeric-string id) keeps the anchored selection on the local
 * exact-label re-check — the tag exists there, so disqualifying the side
 * would claim an absence the provider never showed; only a label with no
 * tag row at all disqualifies the whole side (undefined) — it is NEVER
 * allowed to run unfiltered.
 * An "or" group is ONE term whose expansion is the deduped union of its
 * members' native ids: a member already carrying the side's UUID joins the
 * union directly (never allOf — the group is an any-of set, even at one
 * id), a free-text member expands on THIS side's published tag listing
 * (expandCatalogTagTerm), and a member carrying only the other side's id
 * resolves through the counterpart pairing — native joins the union,
 * uuid-less can only match locally and makes the whole group local. The
 * group rides the same rules as a free-text term (resolveIncludeCriteria):
 * every expansion must be complete and native — no capped walk, no
 * uuid-less rows — before anything travels; a partial criterion would
 * silently drop titles. Anything incomplete keeps the WHOLE term set on
 * the local re-check with the side's approximate totals; a complete,
 * freshness-bounded expansion that holds no tag for a term (and no
 * uuid-less match) proves the side's AND can never match, and the side is
 * skipped as exact absence (undefined) instead of scanning unfiltered
 * pages into the 422 ceiling. Of a complete term set, the most selective
 * valid pre-filter travels: every singleton joins the anchored ids in the
 * all-of criterion (an AND match must carry each of those tags), and with
 * no singleton and no anchored id the smallest set rides alone as any-of
 * while the other terms keep filtering locally. A lookup that fails
 * throws; browseTitles records the side as a failed source instead of
 * reading the outage as absence. */
export async function includeIdsForSide(
  selections: IncludeTerm[],
  side: "tpdb" | "stashdb",
  expandFree: boolean,
): Promise<ResolvedIncludes | undefined> {
  const allOf: string[] = [];
  // Anchored selections whose exact-label counterpart row is uuid-less:
  // the tag exists on this side but its id can never ride a native
  // criterion, so they join the local exact-label re-check.
  const local: CatalogTagSelection[] = [];
  // The terms that ride resolveIncludeCriteria (free-text plains and every
  // group), each with its expansion — plain free-text keeps today's shape.
  const terms: { term: IncludeTerm; expansion: TagExpansion }[] = [];
  for (const sel of selections) {
    if (Array.isArray(sel)) {
      // "or" group: build one TagExpansion from the members' native ids.
      const union: string[] = [];
      // Membership Set in lockstep with the ordered array: expansion bursts
      // push thousands of ids (the walk caps at 5000), and the old
      // Array.includes dedupe scanned the whole union on every push —
      // validation #VELV-247 timed this group shape at a 565 ms loop block
      // on a 1-vCPU sandbox; the dev box timed the same warm call at
      // ~50 ms. The Set keeps the deduped set and push order identical.
      const unionIds = new Set<string>();
      let complete = true;
      let dropped = false;
      let allNative = true;
      // Members whose label does not exist on this side: an OR group only
      // proves the side can never match when EVERY member is absent; one
      // absent member just adds nothing (TPDB "Anal" or StashDB "Anal Sex").
      let absent = 0;
      for (const member of sel) {
        const direct = side === "tpdb" ? member.tpdb : member.stashdb;
        if (direct !== undefined) {
          if (!unionIds.has(direct)) {
            unionIds.add(direct);
            union.push(direct);
          }
          continue;
        }
        if (isFreeTextSelection(member)) {
          // The filmography route rejects tag parameters, so nothing
          // expands there — the group stays entirely local.
          if (!expandFree) {
            allNative = false;
            complete = false;
            continue;
          }
          const expansion = await expandCatalogTagTerm(side, member.name);
          for (const id of expansion.ids) {
            if (!unionIds.has(id)) {
              unionIds.add(id);
              union.push(id);
            }
          }
          complete = complete && expansion.complete;
          dropped = dropped || expansion.dropped;
          continue;
        }
        // tagCounterpart searches the OTHER provider by exact normalized
        // label.
        const counterpart = await tagCounterpart(
          side === "tpdb" ? "stashdb" : "tpdb",
          member.name,
        );
        if (counterpart === undefined) {
          absent += 1;
          continue;
        }
        if (counterpart.native) {
          if (!unionIds.has(counterpart.id)) {
            unionIds.add(counterpart.id);
            union.push(counterpart.id);
          }
        } else {
          // This member can only match locally, which makes the whole
          // group local: a partial union would silently drop titles.
          allNative = false;
          complete = false;
        }
      }
      if (absent === sel.length) return undefined;
      terms.push({
        term: sel,
        expansion: { complete: complete && allNative, dropped, ids: union },
      });
      continue;
    }
    const direct = side === "tpdb" ? sel.tpdb : sel.stashdb;
    if (direct !== undefined) {
      if (!allOf.includes(direct)) allOf.push(direct);
      continue;
    }
    if (!isFreeTextSelection(sel)) {
      const counterpart = await tagCounterpart(
        side === "tpdb" ? "stashdb" : "tpdb",
        sel.name,
      );
      if (counterpart === undefined) return undefined;
      if (counterpart.native) {
        if (!allOf.includes(counterpart.id)) allOf.push(counterpart.id);
      } else {
        local.push(sel);
      }
      continue;
    }
    if (!expandFree) {
      terms.push({
        term: sel,
        expansion: { complete: false, dropped: false, ids: [] },
      });
      continue;
    }
    terms.push({
      term: sel,
      expansion: await expandCatalogTagTerm(side, sel.name),
    });
  }
  if (terms.length === 0) {
    return {
      allOf,
      anyOf: [],
      localInclude: [...local],
      localFree: [],
      freeTextNative: false,
      fanoutIds: [],
    };
  }
  if (!expandFree) {
    // Filmography side: nothing rides native tag criteria, every term
    // (plain or group) stays on the local re-check.
    const localTerms = terms.map((t) => t.term);
    return {
      allOf,
      anyOf: [],
      localInclude: [...localTerms, ...local],
      localFree: localTerms,
      freeTextNative: false,
      fanoutIds: [],
    };
  }
  // Every term expands before the decision: the tag listing behind
  // expandCatalogTagTerm is memoized, so reading every term costs no extra
  // upstream traffic. The ride-local-or-native decision itself lives in
  // resolveIncludeCriteria.
  const criteria = resolveIncludeCriteria(
    allOf,
    terms.map((t) => t.expansion),
  );
  // Grounded absence (complete fresh listing, no uuid-less match, empty
  // ids): the side is skipped — exact zero via the no-plans path when no
  // side survives — instead of a 40-page unfiltered scan ending in
  // query_too_broad. An All browse keeps the surviving side.
  if (criteria.provablyEmpty) return undefined;
  return {
    allOf: criteria.allOf,
    anyOf: criteria.anyOf,
    localInclude: [
      ...criteria.localTermIndexes.map((i) => terms[i]!.term),
      ...local,
    ],
    localFree: criteria.localTermIndexes.map((i) => terms[i]!.term),
    freeTextNative: criteria.freeTextNative,
    fanoutIds: criteria.fanoutIds,
  };
}

// --- ordered merge over provider-native streams ---

interface SortOrder {
  key: CatalogSortKey;
  direction?: CatalogSortDirection;
}

function orderKeyOf(
  d: CatalogDetail,
  key: "recency" | "duration",
): string | number {
  if (key === "recency") return d.releaseDate ?? "";
  // Missing duration sorts as the shortest item: last in a descending page,
  // first in an ascending one. Deterministic, and real rows almost always
  // carry a duration.
  return d.durationSeconds ?? -1;
}

function before(
  a: CatalogDetail,
  b: CatalogDetail,
  key: "recency" | "duration",
  direction: CatalogSortDirection,
): boolean {
  const ka = orderKeyOf(a, key);
  const kb = orderKeyOf(b, key);
  if (ka !== kb) {
    const cmp =
      typeof ka === "number" && typeof kb === "number"
        ? ka - kb
        : String(ka).localeCompare(String(kb));
    return direction === "desc" ? cmp > 0 : cmp < 0;
  }
  // Deterministic tie-break: TPDB movies before StashDB scenes, then id.
  const ra =
    (a.reference.provider === "tpdb" ? 0 : 1) -
    (b.reference.provider === "tpdb" ? 0 : 1);
  if (ra !== 0) return ra < 0;
  return a.reference.id < b.reference.id;
}

/** One in-flight upstream catalog page read per provider per browse: fan-out
 * multiplies the streams a single browse opens per side, and the providers'
 * rate limits for concurrent page reads are unmeasured, so the gate bounds
 * the browse's fan-out reads at today's per-side level. The gate is created
 * per browseTitles call and gates ONLY that browse's fan-out streams — every
 * other read (non-fan-out streams of multi-seed browses, other requests,
 * other users) keeps today's parallelism and never queues behind this
 * browse. Ordered merges stay correct: the gate delays a stream's read,
 * never its merge order — the merge already waits for every live stream's
 * next row before picking a head. ponytail: measure and parallelize if
 * fan-out latency shows up. */
function createReadGate() {
  const turns = new Map<CatalogProvider, Promise<unknown>>();
  return function gateRead<T>(
    provider: CatalogProvider,
    read: () => Promise<T>,
  ): Promise<T> {
    // Queues `read` behind the provider's last queued turn. The chain is
    // `prev.then(read, read)` so a prior read's failure cannot block the
    // queue — the rejection handler runs the next read too. The stored tail
    // is the settled form of `next` (rejections swallowed), so the chain
    // never poisons a later reader; the caller's own promise still carries
    // the error.
    const prev = turns.get(provider) ?? Promise.resolve();
    const next = prev.then(read, read);
    turns.set(
      provider,
      next.catch(() => undefined),
    );
    return next;
  };
}

/** One provider stream: consecutive native pages, visibility-filtered on
 * arrival. Provider errors are captured as SourceError instead of aborting a
 * merged page; a lone failing stream surfaces through allSourcesFailed. */
class Stream {
  readonly buffer: CatalogDetail[] = [];
  exhausted = false;
  nativeHasMore = false;
  total?: number;
  totalKnown = false;
  sort?: CatalogSearchPage["sort"];
  error?: SourceError;
  /** Visible items already popped by the merge (matched-count bookkeeping). */
  consumed = 0;
  /** True when any displayed predicate is evaluated locally, which makes
   * provider-reported totals count the wrong thing. */
  readonly localFiltered: boolean;
  /** True when this stream's local filter is the local half of a free-text
   * AND whose other terms ride the native tag criterion: at the scan
   * ceiling it degrades to a named incomplete error instead of throwing,
   * because the native pre-filter kept the scanned pages productive and
   * the matches found are a real partial answer. */
  readonly softCeiling: boolean;
  /** Ends the ordered scan once a fetched page's last mapped row (provider
   * order, not yet visibility-filtered) passes the local bound of a range
   * whose far side rides native (resolveDateBound): the provider's order
   * means later pages hold only rows further past it. */
  private readonly dateStop?: (d: CatalogDetail) => boolean;
  private page = 0;
  private fetches = 0;
  private readonly base: CatalogSearchQuery;
  private readonly visible: (d: CatalogDetail) => boolean;
  private readonly perPage: number;
  /** This browse's fan-out read gate (createReadGate), set on fan-out
   * streams only: their upstream page reads queue per provider inside the
   * one browse. Undefined on every other stream — those reads run exactly
   * as before, in parallel, never behind this browse's fan-out. */
  private readonly gate?: <T>(
    provider: CatalogProvider,
    read: () => Promise<T>,
  ) => Promise<T>;
  /** This browse's per-provider page-read pool (createScanBudget), shared
   * by every stream of the request: a take that fails ends the stream
   * soft with the named scan_ceiling error. Undefined outside
   * browseTitles — searchVisibleCatalog keeps its single-stream bound. */
  private readonly budget?: (provider: CatalogProvider) => boolean;

  constructor(
    base: CatalogSearchQuery,
    visible: (d: CatalogDetail) => boolean,
    perPage: number,
    localFiltered: boolean,
    softCeiling = false,
    dateStop?: (d: CatalogDetail) => boolean,
    gate?: <T>(provider: CatalogProvider, read: () => Promise<T>) => Promise<T>,
    budget?: (provider: CatalogProvider) => boolean,
  ) {
    this.base = base;
    this.visible = visible;
    this.perPage = perPage;
    this.localFiltered = localFiltered;
    this.softCeiling = softCeiling;
    this.dateStop = dateStop;
    this.gate = gate;
    this.budget = budget;
  }

  get live(): boolean {
    return !this.exhausted && this.error === undefined;
  }

  /** True when a head is resident or more may still arrive. */
  get open(): boolean {
    return this.buffer.length > 0 || this.live;
  }

  /** One more upstream page into the buffer. Throws query_too_broad when the
   * documented per-stream ceiling is hit while upstream continuation still
   * exists — except a softCeiling stream, which degrades to a named
   * scan_ceiling error instead of throwing. The browse's per-provider page
   * pool (budget, VELV-240) ends the stream the same soft way when the
   * request's shared reads are spent — never the hard throw, which is one
   * stream's own too-broad verdict, not the browse's spent pool. */
  async fetch(): Promise<void> {
    if (!this.live) return;
    this.fetches += 1;
    if (this.fetches > MAX_SCAN_PAGES) {
      const ceiling = scanCeilingOutcome(this.softCeiling, this.base.provider);
      if (ceiling.hard) {
        const err = new AppError(
          422,
          "query_too_broad",
          "Browse reached its upstream page limit before filling this page; narrow the filters.",
        );
        // Which side burned and how far the scan got (VELV-167); the
        // caller's page facts join in browseTitles via withCeilingDetails.
        err.details = {
          provider: this.base.provider,
          upstreamPagesScanned: this.fetches - 1,
        };
        throw err;
      }
      // ponytail ceiling: a free-text AND the providers cannot express
      // natively degrades instead of 422ing — the native pre-filter kept
      // every scanned page productive, so the matches found are a real
      // partial answer and the named error says so. Widen the native
      // expression (provider combinator criteria) if this fires often.
      this.exhausted = true;
      this.error = ceiling.error;
      return;
    }
    if (this.budget !== undefined && !this.budget(this.base.provider)) {
      this.exhausted = true;
      this.error = scanCeilingError(this.base.provider);
      return;
    }
    this.page += 1;
    // A cached page resolves as a microtask chain, so a deep scan over
    // cached pages would hold the event loop for the whole walk: yield one
    // macrotask per page so other members' requests interleave.
    await nextMacrotask();
    try {
      // A fan-out stream queues its read behind its browse's per-provider
      // turn; every other stream reads directly, in parallel, as before.
      const read = () =>
        searchCatalog({
          ...this.base,
          page: this.page,
          perPage: this.perPage,
        } as CatalogSearchQuery);
      const result =
        this.gate === undefined
          ? await read()
          : await this.gate(this.base.provider, read);
      this.buffer.push(...result.items.filter(this.visible));
      this.nativeHasMore = result.hasMore;
      this.total = result.total;
      this.totalKnown = result.totalCountKnown;
      this.sort = result.sort;
      if (!result.hasMore) this.exhausted = true;
      else if (
        this.dateStop !== undefined &&
        result.items.length > 0 &&
        this.dateStop(result.items[result.items.length - 1]!)
      ) {
        // The page's last row sits past the local bound of a range whose
        // far side rides native: the release-date order guarantees later
        // pages hold only rows further past it, so the scan ends here
        // instead of walking into the ceiling. Strict comparisons keep
        // ties scanning (equal dates never prove the bound).
        this.exhausted = true;
      }
    } catch (err) {
      // The request's own input fault keeps its status: capture would bury
      // an impossible date or unsupported order (raised before any upstream
      // contact) under a 502 provider outage. Source faults stay captured —
      // the 5xx no-upstreamStatus family (upstream_timeout, upstream_
      // unavailable, upstream_bad_response) and the upstreamStatus-bearing
      // rejections (upstream_auth, upstream_not_found) are the source's
      // story, not the request's.
      if (
        err instanceof AppError &&
        err.upstreamStatus === undefined &&
        err.status < 500
      ) {
        throw err;
      }
      this.exhausted = true;
      this.error = sourceError(this.base.provider, err);
    }
  }
}

function allSourcesFailed(streams: Stream[]): never {
  // Same one-line-per-source rule as mergeStreams' errors list: several
  // streams of one source failing is one story.
  const seen = new Set<CatalogProvider>();
  const messages: string[] = [];
  for (const s of streams) {
    if (s.error === undefined || seen.has(s.error.provider)) continue;
    seen.add(s.error.provider);
    messages.push(`${s.error.provider}: ${s.error.message}`);
  }
  throw new AppError(502, "provider_unavailable", messages.join("; "));
}

/** A side whose include resolution failed before any query ran: an
 * already-failed stream, so the merge keeps the named error beside the
 * survivors, degrades the totals, and 502s when no side survives. A broken
 * counterpart lookup is an outage, never absence. */
function unresolvedStream(provider: CatalogProvider, err: unknown): Stream {
  const stream = new Stream(
    provider === "tpdb"
      ? { provider: "tpdb", kind: "movie" }
      : { provider: "stashdb", kind: "scene" },
    () => false,
    1,
    false,
  );
  stream.exhausted = true;
  stream.error = sourceError(provider, err);
  return stream;
}

// Stryker restore all
/** Refuses, before any upstream read, a page no bounded scan can fill:
 * each live stream buffers at most MAX_SCAN_PAGES pages of at most
 * MAX_ROWS_PER_PAGE_FACTOR × perPage rows, so a start at or past their sum
 * would only rescan every stream to the ceiling (cached pages reparsed on
 * every request) and still end without a row. No live stream: nothing will
 * be read, so the caller's own outcome (the all-failed 502) stands. */
function refuseUnscannablePage(
  start: number,
  perPage: number,
  liveStreams: number,
): void {
  const deepest = liveStreams * MAX_SCAN_PAGES * MAX_ROWS_PER_PAGE_FACTOR;
  if (liveStreams > 0 && start >= deepest * perPage) {
    throw new AppError(
      422,
      "page_too_deep",
      `This page lies past the deepest page browse can scan for this query (page ${deepest}).`,
    );
  }
}

/** Consumes the ordered (or, with no shared order, stable-concatenated)
 * prefix of the given streams and slices out one visible page. */
async function mergeStreams(
  streams: Stream[],
  mergeOrder:
    | { key: "recency" | "duration"; direction: CatalogSortDirection }
    | undefined,
  start: number,
  count: number,
  notices: BrowseNotice[],
): Promise<BrowsePage> {
  refuseUnscannablePage(start, count, streams.filter((s) => s.live).length);
  const items: CatalogDetail[] = [];
  let index = 0;
  while (items.length < count) {
    // Every still-continuing stream must have its next candidate resident
    // before a head is chosen; otherwise the true winner could be hiding in
    // an unfetched page.
    // A page whose rows were all filtered out locally must not end the
    // browse: keep pulling that stream until it yields a visible row or
    // genuinely runs out (a hard scan ceiling throws; a soft one ends the
    // stream with its named scan_ceiling error).
    // Streams are independent (one per provider side), so they refill
    // together: a mixed page waits for the slowest provider, not the sum.
    await Promise.all(
      streams.map(async (s) => {
        while (s.buffer.length === 0 && s.live) await s.fetch();
      }),
    );
    const ready = streams.filter((s) => s.buffer.length > 0);
    if (ready.length === 0) break;
    // Unordered queries concatenate stably (TPDB movies first, then StashDB
    // scenes); ordered queries take the true minimum head.
    const head = mergeOrder
      ? ready.reduce((acc, s) =>
          before(
            s.buffer[0]!,
            acc.buffer[0]!,
            mergeOrder.key,
            mergeOrder.direction,
          )
            ? s
            : acc,
        )
      : ready[0]!;
    const detail = head.buffer.shift()!;
    head.consumed += 1;
    if (index >= start) items.push(detail);
    index += 1;
  }
  const failed = streams.filter((s) => s.error !== undefined);
  // Several streams of one source failing is ONE named error in the page:
  // first failure wins, the rest tell the same story.
  const errors: SourceError[] = [];
  const failedProviders = new Set<CatalogProvider>();
  for (const s of failed) {
    if (!failedProviders.has(s.error!.provider)) {
      failedProviders.add(s.error!.provider);
      errors.push(s.error!);
    }
  }
  // A 502 needs every side to have failed for real: a stream stopping on
  // its own scan ceiling is a bounded (if matchless) answer, not an outage,
  // so a ceiling beside a real outage — or beside another ceiling — stays
  // a partial page whose named errors say so. Only outages on every side
  // leave nothing answered.
  if (
    items.length === 0 &&
    failed.length === streams.length &&
    failed.every((s) => s.error!.code !== "scan_ceiling")
  ) {
    allSourcesFailed(streams); // all-source failure stays visible
  }
  const exhausted =
    streams.every((s) => s.exhausted) &&
    streams.every((s) => s.buffer.length === 0);
  let total: number | undefined;
  let totalKnown = false;
  if (errors.length === 0) {
    if (
      streams.every((s) => s.totalKnown) &&
      streams.every((s) => !s.localFiltered)
    ) {
      // Fully native queries: provider counts already count exactly the
      // displayed predicate, so the sum is exact without scrolling. No
      // cross-kind dedupe exists (movies vs scenes), so nothing is dropped.
      total = streams.reduce((sum, s) => sum + (s.total ?? 0), 0);
      totalKnown = true;
    } else if (exhausted) {
      // Locally filtered: exact only at true exhaustion of every stream.
      total = streams.reduce((sum, s) => sum + s.consumed, 0);
      totalKnown = true;
    }
  }
  // An errored stream exhausted itself on its failed fetch (Stream.fetch
  // marks it so), so once every stream is done, further pages would repeat
  // this result forever: the browse ends. The named errors above still say
  // the page may be incomplete; the client's retry refetches from page 1.
  const hasMore = !exhausted;
  return {
    items,
    page: Math.floor(start / count) + 1,
    perPage: count,
    hasMore,
    ...(totalKnown ? { total } : {}),
    totalCountKnown: totalKnown,
    errors,
    notices,
  };
}

// --- native query assembly ---

/** The far-side release-date bound of a year/date range: the one criterion
 * riding the native releaseDate slot, and where the ordered local scan may
 * stop. */
type DateBound = {
  /** The native releaseDate criterion: the far side of a range, or the
   * caller's own single-sided pair. */
  ride?: { cutoff: string; operation: ReleaseDateOperation };
  /** Present only beside a range under a release-date order: rows past
   * this local bound prove the ordered stream exhausted. */
  stop?: { bound: string; side: "lower" | "upper" };
};

/** Resolves the far side of a year/date range against the effective sort
 * (release recency desc by default; "date" is StashDB's own key). A range's
 * FAR side rides the native release-date criterion, so a newest-first
 * upstream scan never reads every newer title; the NEAR side stays local
 * (visiblePredicate) and comes back as a stop bound that ends the ordered
 * stream once a fetched page passes it. Strict comparisons in the stop keep
 * ties safe: equal dates never prove the bound, so a tie spanning pages
 * keeps scanning. A single-sided date pair keeps today's native wire
 * byte-for-byte, and a lone TPDB `year` keeps the native exact-year param. */
function resolveDateBound(
  query: BrowseQuery,
  sort: SortOrder | undefined,
  provider: CatalogProvider,
): DateBound {
  const dateOrder =
    sort !== undefined &&
    (sort.key === "recency" || (provider === "stashdb" && sort.key === "date"));
  const direction = sort?.direction ?? "desc";
  // A date+dateOperation pair always owns the releaseDate slot first
  // (today's precedence: `year` beside a single-sided `date` stays legal),
  // so date handling branches before the year window.
  if (query.date !== undefined && query.dateOperation !== undefined) {
    if (query.dateTo !== undefined && query.dateOperation === ">=") {
      if (!dateOrder) {
        // No date order: only the lower bound rides, as before.
        return { ride: { cutoff: query.date, operation: ">=" } };
      }
      return direction === "asc"
        ? {
            ride: { cutoff: query.date, operation: ">=" },
            stop: { bound: query.dateTo, side: "upper" },
          }
        : {
            ride: { cutoff: query.dateTo, operation: "<=" },
            stop: { bound: query.date, side: "lower" },
          };
    }
    // Single-sided pair: byte-for-byte today's wire, no stop.
    return { ride: { cutoff: query.date, operation: query.dateOperation } };
  }
  if (provider === "tpdb") {
    if (query.year === undefined || query.yearTo === undefined) {
      // A lone year keeps the native exact-year param, so it needs no ride.
      return {};
    }
    if (!dateOrder) {
      return { ride: { cutoff: `${query.year}-01-01`, operation: ">=" } };
    }
    return direction === "asc"
      ? {
          ride: { cutoff: `${query.year}-01-01`, operation: ">=" },
          stop: { bound: `${query.yearTo}-12-31`, side: "upper" },
        }
      : {
          ride: { cutoff: `${query.yearTo}-12-31`, operation: "<=" },
          stop: { bound: `${query.year}-01-01`, side: "lower" },
        };
  }
  if (query.year === undefined && query.yearTo === undefined) return {};
  if (!dateOrder) return {}; // no date order: nothing rides on StashDB, as before
  return direction === "asc"
    ? {
        ride: { cutoff: `${query.year}-01-01`, operation: ">=" },
        stop: { bound: `${query.yearTo ?? query.year}-12-31`, side: "upper" },
      }
    : {
        ride: {
          cutoff: `${query.yearTo ?? query.year}-12-31`,
          operation: "<=",
        },
        stop: { bound: `${query.year}-01-01`, side: "lower" },
      };
}

/** One planned stream's native query. The seed carries the provider, the
 * kind and the entity criteria; the caller adds its side's resolved include
 * criteria and the resolved TPDB studio site id. */
function nativeQuery(
  query: BrowseQuery,
  plan: {
    seed: BrowseStreamSeed;
    includeIds: string[];
    /** True when includeIds are a free-text or group expansion: the native
     * criterion is any-of (`tags`) instead of all-of (`tagsAll`). */
    includeAny: boolean;
    excludeIds: string[];
    /** Numeric TPDB site id resolved from the seed's studio entry. */
    resolvedStudio?: string;
    performerIds?: string[];
    performerAll?: boolean;
  },
  sort: SortOrder | undefined,
  page: number,
  perPage: number,
): CatalogSearchQuery {
  const seed = plan.seed;
  const ride = resolveDateBound(query, sort, seed.provider).ride;
  if (seed.provider === "tpdb") {
    if (seed.filmographyPerformer !== undefined) {
      // Filmography route: paging-only. Query, year, date, studio, tags and
      // sort are all refused before planning, so the performer id is the
      // whole native query; includes stay in the visible predicate.
      return {
        provider: "tpdb",
        kind: "movie",
        performer: seed.filmographyPerformer,
        page,
        perPage,
      };
    }
    // Every other movie query passes the AND-of-includes natively. A year
    // range's FAR side rides the native date pair (resolveDateBound): TPDB
    // `year` alone is an exact one-year filter, so the range must ride
    // dates, and under a release-date order the ordered scan then stops at
    // the range's near edge instead of reading every newer title into the
    // ceiling. A single year (no yearTo) keeps the native exact-year
    // filter, exactly as before.
    return {
      provider: "tpdb",
      kind: "movie",
      ...(query.q !== undefined ? { query: query.q } : {}),
      ...(query.year !== undefined && query.yearTo === undefined
        ? { year: query.year }
        : {}),
      ...(ride !== undefined ? { releaseDate: ride } : {}),
      ...(plan.resolvedStudio !== undefined
        ? { studio: plan.resolvedStudio }
        : {}),
      ...(plan.includeIds.length > 0
        ? plan.includeAny
          ? { tags: plan.includeIds }
          : { tagsAll: plan.includeIds }
        : {}),
      ...(sort !== undefined
        ? {
            sort: sort.key,
            ...(sort.direction !== undefined
              ? { direction: sort.direction }
              : {}),
          }
        : {}),
      page,
      perPage,
    };
  }
  return {
    provider: "stashdb",
    kind: "scene",
    ...(query.q !== undefined ? { query: query.q } : {}),
    // performers INCLUDES (any-of) or INCLUDES_ALL (the "all of" browse
    // mode); starred follows arrive pre-expanded as performerIds.
    ...(plan.performerIds !== undefined
      ? {
          performers: plan.performerIds,
          ...(plan.performerAll === true ? { performerAll: true } : {}),
        }
      : {}),
    // Exact studios: every known id in ONE INCLUDES criterion, so disjoint
    // site lists keep exact summed totals. withChildren: one parentStudio
    // search per studio seed.
    ...(seed.studioIds !== undefined ? { studios: seed.studioIds } : {}),
    ...(seed.parentStudioId !== undefined
      ? { studio: seed.parentStudioId, studioMode: "withChildren" as const }
      : {}),
    // One upstream tag criterion: native includes (all-of anchored or any-of
    // expansion), or — only when no include is native — native excludes.
    // Mixed include+exclude keeps the includes native and re-checks every
    // exclusion locally.
    ...(plan.includeIds.length > 0
      ? plan.includeAny
        ? { tags: plan.includeIds }
        : { tagsAll: plan.includeIds }
      : plan.excludeIds.length > 0
        ? { tagsExclude: plan.excludeIds }
        : {}),
    ...(ride !== undefined ? { releaseDate: ride } : {}),
    ...(sort !== undefined
      ? {
          // "recency" is the browse vocabulary for release recency;
          // StashDB's release-date order is DATE.
          sort: sort.key === "recency" ? ("date" as const) : sort.key,
          ...(sort.direction !== undefined
            ? { direction: sort.direction }
            : {}),
        }
      : {}),
    page,
    perPage,
  };
}

// --- browseTitles ---

/** The one side decision, pure: which provider streams a browse query may
 * run, which combinations are refused outright, and what ordering each side
 * can carry. No IO and no per-user state — every refusal here is provable
 * from the query alone, which makes this the directly testable face of the
 * logic that once shipped mis-wired. planStreams is the only side/stream
 * authority (its BrowseStreamSeed[] rides the plan verbatim); browseTitles
 * consumes the plan and adds only IO: include-tag resolution, TPDB studio
 * site-id resolution and per-user hidden tags. */
export type BrowsePlan = {
  sides: CatalogProvider[];
  filmography: boolean;
  nativeSort: SortOrder | undefined;
  mergeOrder:
    | { key: "recency" | "duration"; direction: CatalogSortDirection }
    | undefined;
  /** One seed per upstream list, in entry order. A qualifying side whose
   * filter set produced no seed (no performer, no studio) runs one plain
   * search stream — browse is a catalog surface before it is a filter. */
  seeds: BrowseStreamSeed[];
};

export function planBrowseSides(query: BrowseQuery): BrowsePlan {
  // A starred-performer filter is a StashDB-scenes follow filter: it cannot
  // share a request with picked performers.
  if (query.performerStarred !== undefined && query.performers.length > 0) {
    refuse(
      "A starred-performer filter cannot be combined with picked performers.",
    );
  }
  if (query.studioMode === "withChildren") {
    if (!query.studios.some((e) => e.stashdb !== undefined)) {
      refuse("studioMode withChildren requires a StashDB studio.");
    }
    if (query.studios.some((e) => e.tpdb !== undefined)) {
      refuse(
        "studioMode withChildren is StashDB-only; TPDB studios have no parent criterion.",
      );
    }
  }
  const streamPlan: StreamPlan = planStreams(
    query.type,
    query.performers,
    query.studios,
    query.performerMode,
    query.studioMode,
    query.performerStarred === true,
  );
  const filmography = streamPlan.filmography;
  if (filmography) {
    // The filmography route constrains only the TPDB side (planStreams
    // never turns it on for the Scenes tab): a unified performer entry on
    // the Scenes tab runs the StashDB side alone, which accepts search,
    // year, date and sort — refuse only where TPDB runs. The route is
    // paging-only: query, year, date, studio and every sort are
    // upstream-rejected, so refuse them here before any upstream call
    // rather than mid-merge.
    if (query.q !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a search term.",
      );
    }
    if (query.year !== undefined || query.yearTo !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a year filter.",
      );
    }
    if (query.date !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a date filter.",
      );
    }
    if (query.studios.some((e) => e.tpdb !== undefined)) {
      refuse(
        "A TPDB performer filmography cannot be combined with a studio filter.",
      );
    }
    if (query.sort !== undefined) {
      refuse(
        "A TPDB performer filmography has no upstream order; drop the sort or the performer filter.",
      );
    }
  }
  if (
    query.type === "all" &&
    query.sort !== undefined &&
    !BROWSE_MIXED_SORTS.includes(query.sort)
  ) {
    refuse(
      `"${query.sort}" order is not available on both sources; browse All supports recency and duration, or pick Movies/Scenes for the rest.`,
    );
  }
  // A source merging 2+ upstream lists (several TPDB studio site_ids, or
  // several StashDB parent studios) accepts only the mixed vocabulary: any
  // other order would claim a global order a stable concatenation cannot
  // keep.
  if (mergedSourceRestricted(streamPlan, query.sort)) {
    refuse(
      `"${query.sort}" order cannot merge several upstream lists from one source; a merged source supports only recency and duration.`,
    );
  }

  // Global order: an explicit recency/duration request, or the default
  // release recency (newest first) — but only where every qualifying stream
  // can genuinely carry it. The filmography route cannot sort, so its
  // queries claim no order at all where it runs. Other explicit sorts reach
  // exactly one stream and pass through natively.
  const defaultSort: SortOrder | undefined = filmography
    ? undefined
    : { key: "recency", direction: "desc" };
  const explicitSort: SortOrder | undefined =
    query.sort !== undefined
      ? {
          key: query.sort,
          ...(query.direction !== undefined
            ? { direction: query.direction }
            : {}),
        }
      : undefined;
  const nativeSort = explicitSort ?? defaultSort;
  const mergeOrder =
    nativeSort !== undefined &&
    (nativeSort.key === "recency" || nativeSort.key === "duration")
      ? {
          key: nativeSort.key,
          direction: nativeSort.direction ?? "desc",
        }
      : undefined;

  const sides: CatalogProvider[] = [];
  if (streamPlan.tpdb) sides.push("tpdb");
  if (streamPlan.stashdb) sides.push("stashdb");
  // An explicit order must be one the qualifying sides genuinely carry: the
  // refusals above cover only the merged vocabulary, while a typed tab (or
  // an All query filtered down to one side) sends the sort to that one
  // provider — where an unimplemented order dies upstream as
  // invalid_search, which a locally filtered stream would bury as a 502.
  if (query.sort !== undefined) {
    for (const provider of sides) {
      // Native key and kind: recency is the browse vocabulary for StashDB's
      // DATE order (see nativeQuery), and each side runs exactly one kind.
      const nativeSortKey =
        provider === "stashdb" && query.sort === "recency"
          ? ("date" as const)
          : query.sort;
      const spec = sortSpec(
        provider,
        provider === "tpdb" ? "movie" : "scene",
        nativeSortKey,
      );
      if (spec === undefined) {
        refuse(
          `"${query.sort}" order is not available on ${
            provider === "tpdb" ? "TPDB movies" : "StashDB scenes"
          }.`,
        );
      }
      if (query.direction !== undefined && spec.directional !== true) {
        refuse(`"${query.sort}" order takes no direction.`);
      }
    }
  }
  // A side with no seed runs one plain search stream; seeded sides keep
  // their entry order exactly as planStreams emitted it.
  const seeded = new Set(streamPlan.seeds.map((s) => s.provider));
  for (const provider of ["tpdb", "stashdb"] as const) {
    if (sides.includes(provider) && !seeded.has(provider)) {
      streamPlan.seeds.push({
        provider,
        kind: provider === "tpdb" ? "movie" : "scene",
      });
    }
  }
  return {
    sides,
    filmography,
    nativeSort,
    mergeOrder,
    seeds: streamPlan.seeds,
  };
}
// Stryker disable all

/** Why a source skipped or narrowed an entity filter, computed from the
 * parsed query and the side qualification only — no IO, never an error: a
 * muted note beside the grid. Only the tab's own sources are judged;
 * performerStarred produces no notices (it carries no entries; the client
 * explains starred elsewhere). Entries ride as the request sent them. */
function buildNotices(query: BrowseQuery, plan: BrowsePlan): BrowseNotice[] {
  const sources: CatalogProvider[] =
    query.type === "all"
      ? ["tpdb", "stashdb"]
      : query.type === "movie"
        ? ["tpdb"]
        : ["stashdb"];
  const notices: BrowseNotice[] = [];
  for (const provider of sources) {
    const specs: {
      kind: "performer" | "studio";
      entries: BrowseEntity[];
      mode: PerformerMode;
    }[] = [
      {
        kind: "performer",
        entries: query.performers,
        mode: query.performerMode,
      },
      { kind: "studio", entries: query.studios, mode: "any" },
    ];
    for (const { kind, entries, mode } of specs) {
      if (entries.length === 0) continue;
      const unknown = entriesUnknownTo(entries, provider);
      if (!sourceRunsFor(entries, provider, mode)) {
        notices.push({
          provider,
          kind,
          code: "not_searched",
          entries: unknown,
        });
      } else if (plan.sides.includes(provider) && unknown.length > 0) {
        notices.push({
          provider,
          kind,
          code: "not_included",
          entries: unknown,
        });
      }
    }
  }
  return notices;
}

/** Composes the visible catalog page: native provider filters first, local
 * mandatory predicates only where a provider cannot express them, stable
 * prefix merge across sources, honest totals and failures throughout. */
export async function browseTitles(
  query: BrowseQuery,
  hiddenTags: CatalogTagSelection[],
  starredPerformerIds: string[] = [],
): Promise<BrowsePage> {
  const plan = planBrowseSides(query);
  const notices = buildNotices(query, plan);
  if (query.performerStarred === true && starredPerformerIds.length === 0) {
    // Starred but the account follows no StashDB-side performer: nothing can
    // match, provably, before any upstream call.
    return {
      items: [],
      page: query.page,
      perPage: query.perPage,
      hasMore: false,
      total: 0,
      totalCountKnown: true,
      errors: [],
      notices: [],
    };
  }
  const filmography = plan.filmography;
  const nativeSort = plan.nativeSort;
  const mergeOrder = plan.mergeOrder;
  const movieWanted = plan.sides.includes("tpdb");
  const sceneWanted = plan.sides.includes("stashdb");
  // A side whose include resolution fails enters the merge as an
  // already-failed stream: its plan is dropped (never run unfiltered) but
  // the outage stays named, and a browse whose every wanted side dies this
  // way is a 502 — never an exact empty catalog.
  const unresolved: Stream[] = [];
  const resolveIncludes = (
    wanted: boolean,
    side: "tpdb" | "stashdb",
  ): Promise<ResolvedIncludes | undefined> => {
    if (!wanted) return Promise.resolve(undefined);
    // The filmography route rejects tag parameters, so TPDB never expands
    // free text there; every other side can carry the any-of criterion.
    const expandFree = !(side === "tpdb" && filmography);
    return includeIdsForSide(query.include, side, expandFree).catch(
      (err: unknown) => {
        unresolved.push(unresolvedStream(side, err));
        return undefined;
      },
    );
  };
  const [tpdbIncludes, stashIncludes] = await Promise.all([
    resolveIncludes(movieWanted, "tpdb"),
    resolveIncludes(sceneWanted, "stashdb"),
  ]);

  // One plan per stream seed, in entry order; seeds of one side share that
  // side's resolved include criteria. Anchored plain ids and singleton
  // expansions share the one all-of criterion, so anyOf only ever rides
  // alone.
  type SeedPlan = {
    seed: BrowseStreamSeed;
    includeIds: string[];
    includeAny: boolean;
    freeTextNative: boolean;
    /** The side's planned fan-out group (ResolvedIncludes.fanoutIds): when
     * non-empty, this seedPlan opens one all-of stream per id instead of
     * its single stream. */
    fanoutIds: string[];
    excludeIds: string[];
    localFiltered: boolean;
    localInclude: IncludeTerm[];
    localFree: IncludeTerm[];
    localYearRange?: { from?: number; to?: number };
    creditsAllOf: string[];
    resolvedStudio?: string;
    performerIds?: string[];
    performerAll?: boolean;
  };
  const seedPlans: SeedPlan[] = [];
  const seenSiteIds = new Set<string>();
  for (const seed of plan.seeds) {
    if (seed.provider === "tpdb") {
      if (tpdbIncludes === undefined) continue; // provable absence, or unresolved above
      if (seed.filmographyPerformer !== undefined) {
        // ponytail route limit: TPDB's filmography carries ONE performer, so
        // "all of" rides the first entry's id and every other entry's id
        // re-checks in the rows' credits — and the totals degrade, because
        // the upstream list is not AND-ed. ponytail ceiling: the rows map
        // at most MAX.credits (50) performers, so a movie whose 51st or
        // later credit is one of the required performers drops without
        // notice — an empty result here is honest absence at the cap, never
        // a wrong one. Widen only if TPDB ships a multi-performer criterion
        // or raises the mapped-credit cap.
        const creditsAllOf =
          query.performerMode === "all"
            ? query.performers
                .filter((e) => e.tpdb !== undefined)
                .map((e) => e.tpdb!)
                .slice(1)
            : [];
        seedPlans.push({
          seed,
          includeIds: [],
          includeAny: false,
          freeTextNative: false,
          fanoutIds: [],
          excludeIds: [],
          localFiltered:
            hiddenTags.length > 0 ||
            query.exclude.length > 0 ||
            query.include.length > 0 ||
            creditsAllOf.length > 0,
          localInclude: query.include,
          localFree: query.include,
          creditsAllOf,
        });
        continue;
      }
      if (seed.tpdbStudio !== undefined) {
        // The numeric site id resolves first, sequentially in seed order; a
        // later entry resolving to the same site_id is dropped — one stream
        // per distinct list, or the summed totals would double-count.
        let siteId: string | undefined;
        try {
          siteId = await resolveTpdbStudioFilter(seed.tpdbStudio);
        } catch (err) {
          unresolved.push(unresolvedStream("tpdb", err));
          continue;
        }
        // Unreachable in practice: parse guarantees a non-empty studio value.
        if (siteId === undefined || seenSiteIds.has(siteId)) continue;
        seenSiteIds.add(siteId);
        seedPlans.push({
          seed,
          includeIds:
            tpdbIncludes.allOf.length > 0
              ? tpdbIncludes.allOf
              : tpdbIncludes.anyOf,
          includeAny:
            tpdbIncludes.allOf.length === 0 && tpdbIncludes.anyOf.length > 0,
          freeTextNative: tpdbIncludes.freeTextNative,
          fanoutIds: tpdbIncludes.fanoutIds,
          excludeIds: [], // TPDB has no native exclude criterion
          localFiltered:
            hiddenTags.length > 0 ||
            query.exclude.length > 0 ||
            tpdbIncludes.localInclude.length > 0 ||
            query.yearTo !== undefined ||
            query.dateTo !== undefined,
          localInclude: tpdbIncludes.localInclude,
          localFree: tpdbIncludes.localFree,
          // Under a release-date order the range's far side rides native
          // (resolveDateBound); both ends still check locally here.
          localYearRange:
            query.yearTo !== undefined
              ? { from: query.year, to: query.yearTo }
              : undefined,
          creditsAllOf: [],
          resolvedStudio: siteId,
        });
        continue;
      }
      // Plain movie search seed (no entity narrowed this side).
      seedPlans.push({
        seed,
        includeIds:
          tpdbIncludes.allOf.length > 0
            ? tpdbIncludes.allOf
            : tpdbIncludes.anyOf,
        includeAny:
          tpdbIncludes.allOf.length === 0 && tpdbIncludes.anyOf.length > 0,
        freeTextNative: tpdbIncludes.freeTextNative,
        fanoutIds: tpdbIncludes.fanoutIds,
        excludeIds: [], // TPDB has no native exclude criterion
        localFiltered:
          hiddenTags.length > 0 ||
          query.exclude.length > 0 ||
          tpdbIncludes.localInclude.length > 0 ||
          query.yearTo !== undefined ||
          query.dateTo !== undefined,
        localInclude: tpdbIncludes.localInclude,
        localFree: tpdbIncludes.localFree,
        // Under a release-date order the range's far side rides native
        // (resolveDateBound); both ends still check locally here.
        localYearRange:
          query.yearTo !== undefined
            ? { from: query.year, to: query.yearTo }
            : undefined,
        creditsAllOf: [],
      });
      continue;
    }
    if (stashIncludes === undefined) continue; // provable absence, or unresolved above
    const includesNative =
      stashIncludes.allOf.length > 0 || stashIncludes.anyOf.length > 0;
    seedPlans.push({
      seed,
      includeIds:
        stashIncludes.allOf.length > 0
          ? stashIncludes.allOf
          : stashIncludes.anyOf,
      includeAny:
        stashIncludes.allOf.length === 0 && stashIncludes.anyOf.length > 0,
      freeTextNative: stashIncludes.freeTextNative,
      fanoutIds: stashIncludes.fanoutIds,
      // One upstream tag criterion: native excludes only when no include is
      // native. Selections without a StashDB id stay local-only below.
      excludeIds: includesNative
        ? []
        : query.exclude
            .map((sel) => sel.stashdb)
            .filter((id): id is string => id !== undefined),
      localFiltered:
        hiddenTags.length > 0 ||
        query.exclude.length > 0 ||
        stashIncludes.localInclude.length > 0 ||
        query.year !== undefined ||
        query.yearTo !== undefined ||
        query.dateTo !== undefined,
      localInclude: stashIncludes.localInclude,
      localFree: stashIncludes.localFree,
      // Under a release-date order the range's far side rides native
      // (resolveDateBound); the year window still checks locally here, and
      // `yearTo` defaults the upper end so `year` alone stays an exact-year
      // filter, as before.
      localYearRange:
        query.year !== undefined || query.yearTo !== undefined
          ? { from: query.year, to: query.yearTo ?? query.year }
          : undefined,
      creditsAllOf: [],
      performerIds:
        query.performerStarred === true
          ? starredPerformerIds
          : seed.performerIds,
      performerAll: seed.performerAll === true,
    });
  }
  if (seedPlans.length === 0) {
    if (unresolved.length > 0) {
      // Every wanted side died resolving its includes: an outage, not a
      // provably empty catalog. mergeStreams turns all-failed streams into
      // the 502 that names each provider.
      return mergeStreams(
        unresolved,
        mergeOrder,
        (query.page - 1) * query.perPage,
        query.perPage,
        notices,
      );
    }
    // Reachable when the query provably matches nothing before any upstream
    // call: conflicting one-sided clauses, a source-scoped filter on a tab
    // of the other kind (no sides survive it), or include tags that resolve
    // on no qualifying source.
    return {
      items: [],
      page: query.page,
      perPage: query.perPage,
      hasMore: false,
      total: 0,
      totalCountKnown: true,
      errors: [],
      notices,
    };
  }

  // Fast path: a single fully-native stream passes straight through with the
  // provider's own totals, continuation, and error semantics — one upstream
  // request for any page depth. A fan-out plan is several streams with a
  // shared dedupe set, so it never takes this path even when no term
  // re-checks locally.
  const single =
    seedPlans.length === 1 && seedPlans[0]!.fanoutIds.length === 0
      ? seedPlans[0]!
      : undefined;
  if (
    single !== undefined &&
    !single.localFiltered &&
    unresolved.length === 0
  ) {
    const page = await searchCatalog(
      nativeQuery(query, single, nativeSort, query.page, query.perPage),
    );
    return {
      items: page.items,
      page: page.page,
      perPage: page.perPage,
      hasMore: page.hasMore,
      ...(page.total !== undefined ? { total: page.total } : {}),
      totalCountKnown: page.totalCountKnown,
      errors: [],
      notices,
    };
  }

  const streams: Stream[] = [];
  const dedupeSets = new Map<string, Set<string>>();
  // One gate per browse: it serializes only this browse's fan-out streams,
  // per provider, so a fan-out's worst-case upstream reads stay at today's
  // one-in-flight-per-side level without touching any other browse or read.
  const gateRead = createReadGate();
  // One page pool per provider per browse (VELV-240): every stream of this
  // request draws from it, so the product of entity seeds and fan-out ids
  // cannot multiply the request's upstream reads past MAX_SCAN_PAGES.
  const budgetRead = createScanBudget();
  for (const [seedIndex, seedPlan] of seedPlans.entries()) {
    const dateBound = resolveDateBound(
      query,
      nativeSort,
      seedPlan.seed.provider,
    );
    // Tie-safe: strict comparisons mean equal dates never prove the bound,
    // so a tie spanning pages keeps scanning instead of stopping early.
    let dateStop: ((d: CatalogDetail) => boolean) | undefined;
    if (dateBound.stop !== undefined) {
      const stop = dateBound.stop;
      dateStop = (d: CatalogDetail) => {
        const released = d.releaseDate?.slice(0, 10);
        if (released === undefined) return false;
        return stop.side === "lower"
          ? released < stop.bound
          : released > stop.bound;
      };
    }
    const base = visiblePredicate(
      hiddenTags,
      query.exclude,
      seedPlan.localInclude,
      seedPlan.localYearRange,
      seedPlan.creditsAllOf,
      query.dateTo,
      query.dateTo !== undefined ? query.date : undefined,
    );
    let visible = base;
    let localFiltered = seedPlan.localFiltered;
    if (
      seedPlan.fanoutIds.length > 0 ||
      seedPlan.seed.dedupeKey !== undefined
    ) {
      // Streams sharing one dedupe set may surface the same title (fan-out
      // streams of one seedPlan, overlapping filmographies, parent/child
      // studios): the merge keeps only its first occurrence across the
      // group. The set records only rows the base predicate passed, so an
      // excluded row never poisons its twin's verdict; totals degrade to
      // exhaustion-exact because the native lists overlap. A seedPlan
      // without its own dedupeKey gets a synthetic one, so all of its
      // fan-out streams share exactly one set.
      const dedupeKey =
        seedPlan.seed.dedupeKey ??
        `fanout:${seedPlan.seed.provider}:${seedIndex}`;
      let set = dedupeSets.get(dedupeKey);
      if (set === undefined) {
        set = new Set();
        dedupeSets.set(dedupeKey, set);
      }
      visible = (d) => {
        const dedupeId = `${d.reference.provider}:${d.reference.id}`;
        if (set.has(dedupeId)) return false;
        if (!base(d)) return false;
        set.add(dedupeId);
        return true;
      };
      localFiltered = true;
    }
    if (seedPlan.fanoutIds.length > 0) {
      // Fan-out: one native stream per id g of the planned free-text
      // group, each carrying allOf ∪ {id} (includeAny stays false —
      // includeIds is allOf there), replacing the single stream at this
      // seedPlan's position; seed order and group id order stay intact.
      // The streams share the dedupe set above, so a title carrying two
      // ids of the group arrives in two streams and shows once.
      const fanoutPlan = {
        localInclude: seedPlan.localFree,
        freeTextNative: seedPlan.freeTextNative,
        // Soft ceiling: every scanned page of a fan-out stream carries
        // allOf ∧ g, so the pages stay productive even when no term
        // re-checks locally — a ceiling hit is a named partial answer,
        // never the hard 422.
        fanoutNative: true,
      };
      for (const fanoutId of seedPlan.fanoutIds) {
        streams.push(
          new Stream(
            nativeQuery(
              query,
              { ...seedPlan, includeIds: [...seedPlan.includeIds, fanoutId] },
              nativeSort,
              1,
              query.perPage,
            ),
            visible,
            query.perPage,
            localFiltered,
            softCeilingFor(fanoutPlan),
            dateStop,
            gateRead,
            budgetRead,
          ),
        );
      }
      continue;
    }
    streams.push(
      new Stream(
        nativeQuery(query, seedPlan, nativeSort, 1, query.perPage),
        visible,
        query.perPage,
        localFiltered,
        softCeilingFor({
          localInclude: seedPlan.localFree,
          freeTextNative: seedPlan.freeTextNative,
        }),
        dateStop,
        undefined,
        budgetRead,
      ),
    );
  }
  streams.push(...unresolved);
  try {
    return await mergeStreams(
      streams,
      mergeOrder,
      (query.page - 1) * query.perPage,
      query.perPage,
      notices,
    );
  } catch (e) {
    throw withCeilingDetails(e, query);
  }
}

/** The scan-ceiling error carries the request's own facts beside the
 * stream's (provider, pages scanned): the page, the page size, and the
 * filters in play, so the message's "narrow the filters" names the exact
 * query (VELV-167). Any other error passes through untouched. */
function withCeilingDetails(e: unknown, query: BrowseQuery): unknown {
  if (e instanceof AppError && e.code === "query_too_broad") {
    e.details = {
      ...(e.details ?? {}),
      requestedPage: query.page,
      perPage: query.perPage,
      include: query.include,
    };
  }
  return e;
}

// --- provider-specific media search with hidden filtering ---

/** Hidden-tag filtering for the provider-specific media search callers.
 * Provider outages propagate (those callers already surface errors); a page
 * is only ever reported full when enough visible rows truly exist upstream.
 * Totals stay pass-through when nothing is hidden; with hidden filtering the
 * count is exact only at true exhaustion. */
export async function searchVisibleCatalog(
  query: CatalogSearchQuery,
  hiddenTags: CatalogTagSelection[],
): Promise<CatalogSearchPage> {
  if (
    hiddenTags.length === 0 ||
    (query.kind !== "movie" && query.kind !== "scene")
  ) {
    return searchCatalog(query);
  }
  const requestedPage = query.page ?? 1;
  const perPage = query.perPage ?? 24;
  const hidden = hiddenTitleMatcher(hiddenTags);
  const stream = new Stream(
    { ...query, page: 1, perPage } as CatalogSearchQuery,
    (d) => !hidden(d),
    perPage,
    true, // hidden filtering is always local
  );
  const start = (requestedPage - 1) * perPage;
  refuseUnscannablePage(start, perPage, 1);
  // `live` (not `open`): a stream holding buffered rows but no continuation
  // must end the fill, otherwise this spins on a no-op fetch.
  while (stream.buffer.length < start + perPage && stream.live) {
    await stream.fetch();
    if (stream.error !== undefined) {
      throw new AppError(502, stream.error.code, stream.error.message);
    }
  }
  const exhausted = !stream.live;
  return {
    provider: query.provider,
    kind: query.kind,
    page: requestedPage,
    perPage,
    ...(stream.sort !== undefined ? { sort: stream.sort } : {}),
    // Exhausted but holding rows past this page: the surplus is still
    // pageable (mergeStreams requires the same empty-buffer proof).
    hasMore: !exhausted || stream.buffer.length > start + perPage,
    ...(exhausted
      ? { total: stream.buffer.length, totalCountKnown: true }
      : { totalCountKnown: false }),
    items: stream.buffer.slice(start, start + perPage),
  };
}

// --- unified tag picker search ---

/** Both providers searched in parallel; selections group by the existing
 * exact normalized label rule, carrying each provider's native id. Missing
 * sources and partial failures come back as errors — never silently dropped.
 * When no provider matches and a TypeSafe key exists, the existing judged
 * suggestion path proposes real provider tags (never invented ones). */
export async function searchBrowseTags(
  term: string,
): Promise<BrowseTagsResponse> {
  const q = term.trim();
  if (q.length < 2) {
    throw new AppError(
      400,
      "invalid_query",
      "Enter at least 2 characters to search.",
    );
  }
  if (q.length > 200) throw new AppError(400, "invalid_query", "Invalid q.");
  const providers: CatalogProvider[] = ["tpdb", "stashdb"];
  const settled = await Promise.allSettled(
    providers.map((p) => searchCatalogTags(p, q)),
  );
  const errors: SourceError[] = [];
  const tags: CatalogTagSelection[] = [];
  const byLabel = new Map<string, CatalogTagSelection>();
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const provider = providers[i]!;
    if (result.status === "rejected") {
      errors.push(sourceError(provider, result.reason));
      continue;
    }
    for (const row of result.value) {
      // A uuid-less TPDB id would fail the stored-selection boundary with
      // a misleading 400 and can never ride a native filter: the row never
      // rides back (the typed term stays offered as free text).
      if (provider === "tpdb" && !isUuid(row.id)) continue;
      const label = normalizeFacetName(row.name);
      if (label === "") continue;
      const existing = byLabel.get(label);
      if (existing === undefined) {
        const selection: CatalogTagSelection = { name: row.name };
        if (provider === "tpdb") selection.tpdb = row.id;
        else selection.stashdb = row.id;
        byLabel.set(label, selection);
        tags.push(selection);
      } else if (provider === "tpdb" && existing.tpdb === undefined) {
        existing.tpdb = row.id;
      } else if (provider === "stashdb" && existing.stashdb === undefined) {
        existing.stashdb = row.id;
      }
    }
  }
  if (tags.length === 0 && errors.length < providers.length) {
    try {
      const settings = getConfig()?.providers;
      if (tagSuggestionsAllowed(settings)) {
        const candidates: {
          id: string;
          name: string;
          provider: CatalogProvider;
        }[] = [];
        for (let i = 0; i < settled.length; i++) {
          if (settled[i]!.status !== "fulfilled") continue;
          for (const row of await listCatalogTags(providers[i]!)) {
            // Same boundary as the search rows: uuid-less TPDB tag ids
            // would fail the stored-selection validation downstream.
            if (providers[i] === "tpdb" && !isUuid(row.id)) continue;
            candidates.push({
              id: row.id,
              name: row.name,
              provider: providers[i]!,
            });
          }
        }
        const suggestions = await suggestTags(q, candidates, settings);
        for (const suggestion of suggestions) {
          const candidate = candidates.find((c) => c.id === suggestion.id);
          if (candidate === undefined) continue;
          const selection: CatalogTagSelection = { name: candidate.name };
          if (candidate.provider === "tpdb") selection.tpdb = candidate.id;
          else selection.stashdb = candidate.id;
          if (
            !tags.some(
              (t) =>
                normalizeFacetName(t.name) ===
                normalizeFacetName(candidate.name),
            )
          ) {
            tags.push(selection);
          }
        }
      }
    } catch {
      // Suggestions degrade to absent; never fabricated.
    }
  }
  return { tags, errors };
}
