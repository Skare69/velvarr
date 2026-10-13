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
// ponytail: upstream scan ceiling is 40 provider pages per stream per
// request. Hitting it before a page fills is a visible 422 "query_too_broad",
// never a fake empty page or fake end — narrow the filters. One exception:
// a multi-term free-text AND split between a native tag criterion and the
// local re-check degrades to a named partial page instead
// (Stream.softCeiling). Raise MAX_SCAN_PAGES only when real browsing
// measurably needs it.

// Stryker disable all — the mutation window re-opens below the parse/adapters
// block and covers the pure merge/plan logic only (mergeStreams, nativeQuery,
// planBrowseSides); parse helpers and fetch adapters stay out of scope.

import { isHiddenTitle, tagMatches } from "./catalog-visibility.ts";

import { AppError } from "./http.ts";
import { suggestTags } from "./judgment.ts";
import {
  listCatalogTags,
  searchCatalog,
  searchCatalogTags,
  tagCounterpart,
  expandCatalogTagTerm,
} from "./providers.ts";
import {
  resolveIncludeCriteria,
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
import { getConfig, parseTagSelections } from "./storage.ts";
import { isIsoDate, isUuid } from "./provider-rows.ts";
import {
  CATALOG_YEAR_MAX,
  CATALOG_YEAR_MIN,
  normalizeFacetName,
} from "../lib/contracts.ts";
import { BROWSE_MIXED_SORTS, SORT_KEYS, sortSpec } from "../lib/sorts.ts";
import type {
  BrowseTagsResponse,
  CatalogDetail,
  CatalogProvider,
  CatalogTagSelection,
  SourceError,
} from "../lib/contracts.ts";

const MAX_SCAN_PAGES = 40;

// --- pinned public shapes ---

export type BrowseType = "all" | "movie" | "scene";

export type BrowseQuery = {
  type: BrowseType;
  q?: string;
  include: CatalogTagSelection[];
  exclude: CatalogTagSelection[];
  studioTpdb?: string;
  studioStashdb?: string;
  performerTpdb?: string;
  performerStashdb?: string;
  performerStarred?: true;
  studioMode: "exact" | "withChildren";
  year?: number;
  date?: string;
  dateOperation?: ReleaseDateOperation;
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

function parseSelections(
  params: URLSearchParams,
  key: string,
): CatalogTagSelection[] {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidQuery(`${key} must be a JSON array of tag selections.`);
  }
  return parseTagSelections(parsed);
}

/** Optional keys stay absent rather than present-and-undefined: a caller
 * comparing queries must not see a key that was never supplied. */
function omitUndefined(
  fields: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
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
  const yearRaw = params.get("year");
  let year: number | undefined;
  if (yearRaw !== null && yearRaw.trim() !== "") {
    year = Number(yearRaw);
    if (
      !Number.isInteger(year) ||
      year < CATALOG_YEAR_MIN ||
      year > CATALOG_YEAR_MAX
    ) {
      throw invalidQuery(
        `year must be a calendar year between ${CATALOG_YEAR_MIN} and ${CATALOG_YEAR_MAX}.`,
      );
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
  return {
    type: type ?? "all",
    ...(q !== undefined && q !== "" ? { q } : {}),
    include: parseSelections(params, "include"),
    // Both lists accept labels with no provider id: an include label is a
    // free-text term that expands on each side's published tags — the
    // native any-of criterion when the expansion is complete and within
    // the native id cap, the local substring re-check otherwise — and an
    // exclude label runs the local family matcher. Neither can travel as
    // an exact native tag, so neither is rejected here.
    exclude: parseSelections(params, "exclude"),
    ...omitUndefined({
      studioTpdb: parseId(params, "studioTpdb"),
      studioStashdb: parseId(params, "studioStashdb"),
      performerTpdb: parseId(params, "performerTpdb"),
      performerStashdb: parseId(params, "performerStashdb"),
    }),
    ...(performerStarred !== undefined
      ? { performerStarred: true as const }
      : {}),
    studioMode: studioMode ?? "exact",
    ...(year !== undefined ? { year } : {}),
    ...(date !== "" && dateOperation !== undefined
      ? { date, dateOperation }
      : {}),
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

function visiblePredicate(
  hiddenTags: CatalogTagSelection[],
  exclude: CatalogTagSelection[],
  include: CatalogTagSelection[],
  year: number | undefined,
): (d: CatalogDetail) => boolean {
  // Exclusions win over includes: a hidden or excluded match blocks the item
  // regardless of any include criterion.
  return (d) => {
    if (hiddenTags.some((sel) => tagMatches(d, sel, "family"))) return false;
    if (exclude.some((sel) => tagMatches(d, sel, "family"))) return false;
    if (
      include.length > 0 &&
      !include.every((sel) =>
        tagMatches(d, sel, isFreeTextSelection(sel) ? "substring" : "exact"),
      )
    ) {
      return false;
    }
    if (year !== undefined && d.releaseDate?.slice(0, 4) !== String(year)) {
      return false;
    }
    return true;
  };
}

/** The native include criteria one provider side can carry: `allOf` are
 * the anchored tag ids plus every singleton free-text expansion (AND
 * criterion — a title satisfying the term AND must carry each of these
 * tags), `anyOf` the smallest free-text expansion (any-of criterion — a
 * valid pre-filter only, sent when no singleton or anchored id exists and
 * the expansion is complete and fits the native id cap). `localInclude`
 * holds the selections the visible predicate must still re-check locally:
 * the free-text terms (several AND together, which one upstream tag
 * criterion cannot express) and anchored chips whose exact-label
 * counterpart row is uuid-less (matched by exact label, never a native
 * criterion). `localFree` holds only the free-text part of `localInclude`
 * (uuid-less anchored chips excluded): the soft ceiling counts productive
 * native pre-filtering, which only a free-text local term beside a native
 * criterion provides — a uuid-less chip filters an unfiltered scan, so it
 * keeps the hard ceiling. */
type ResolvedIncludes = {
  allOf: string[];
  anyOf: string[];
  localInclude: CatalogTagSelection[];
  localFree: CatalogTagSelection[];
  /** True when at least one free-text term rides the native tag criterion
   * (a singleton expansion in `allOf`, or the `anyOf` group): at the scan
   * ceiling such a stream degrades softly — its pages were productive and
   * the matches found are a real partial answer. */
  freeTextNative: boolean;
};

/** Resolves the native include criteria for one provider side. Anchored
 * selections resolve as before: a selection already carrying the side's
 * UUID uses it; otherwise the counterpart id is resolved through the
 * providers' own published label pairing. A uuid-less exact-label match
 * (TPDB numeric-string id) keeps the anchored selection on the local
 * exact-label re-check — the tag exists there, so disqualifying the side
 * would claim an absence the provider never showed; only a label with no
 * tag row at all disqualifies the whole side (undefined) — it is NEVER
 * allowed to run unfiltered.
 * Free-text includes expand on THIS side's complete published tag listing
 * (expandCatalogTagTerm), anchored ids or not. Every term's expansion must
 * be complete and native — no capped walk, no uuid-less rows — before
 * anything free travels: a partial criterion would silently drop titles,
 * and an empty expansion is never proof the side is empty, so the side is
 * never skipped for one; anything incomplete keeps the WHOLE free group on
 * the local substring re-check with the side's approximate totals. Of a
 * complete group set, the most selective valid pre-filter travels: every
 * singleton group joins the anchored ids in the all-of criterion (an AND
 * match must carry each of those tags), and with no singleton and no
 * anchored id the smallest group rides alone as any-of while the other
 * terms keep filtering locally. A lookup that fails
 * throws; browseTitles records the side as a failed source instead of
 * reading the outage as absence. */
async function includeIdsForSide(
  selections: CatalogTagSelection[],
  side: "tpdb" | "stashdb",
  expandFree: boolean,
): Promise<ResolvedIncludes | undefined> {
  const allOf: string[] = [];
  const free: CatalogTagSelection[] = [];
  // Anchored selections whose exact-label counterpart row is uuid-less:
  // the tag exists on this side but its id can never ride a native
  // criterion, so they join the local exact-label re-check.
  const local: CatalogTagSelection[] = [];
  for (const sel of selections) {
    const direct = side === "tpdb" ? sel.tpdb : sel.stashdb;
    if (direct !== undefined) {
      if (!allOf.includes(direct)) allOf.push(direct);
      continue;
    }
    if (!isFreeTextSelection(sel)) {
      // tagCounterpart searches the OTHER provider by exact normalized
      // label.
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
    free.push(sel);
  }
  if (free.length === 0 || !expandFree) {
    return {
      allOf,
      anyOf: [],
      localInclude: [...free, ...local],
      localFree: free,
      freeTextNative: false,
    };
  }
  // Every term expands before the decision: the tag listing behind
  // expandCatalogTagTerm is memoized, so reading every term costs no extra
  // upstream traffic, and complete term indexes keep localInclude aligned
  // with the caller's selections. The ride-local-or-native decision
  // itself lives in resolveIncludeCriteria.
  const expansions: TagExpansion[] = [];
  for (const sel of free) {
    expansions.push(await expandCatalogTagTerm(side, sel.name));
  }
  const criteria = resolveIncludeCriteria(allOf, expansions);
  return {
    allOf: criteria.allOf,
    anyOf: criteria.anyOf,
    localInclude: [...criteria.localTermIndexes.map((i) => free[i]!), ...local],
    localFree: criteria.localTermIndexes.map((i) => free[i]!),
    freeTextNative: criteria.freeTextNative,
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
  private page = 0;
  private fetches = 0;
  private readonly base: CatalogSearchQuery;
  private readonly visible: (d: CatalogDetail) => boolean;
  private readonly perPage: number;

  constructor(
    base: CatalogSearchQuery,
    visible: (d: CatalogDetail) => boolean,
    perPage: number,
    localFiltered: boolean,
    softCeiling = false,
  ) {
    this.base = base;
    this.visible = visible;
    this.perPage = perPage;
    this.localFiltered = localFiltered;
    this.softCeiling = softCeiling;
  }

  get live(): boolean {
    return !this.exhausted && this.error === undefined;
  }

  /** True when a head is resident or more may still arrive. */
  get open(): boolean {
    return this.buffer.length > 0 || this.live;
  }

  /** One more upstream page into the buffer. Throws query_too_broad when the
   * documented ceiling is hit while upstream continuation still exists —
   * except a softCeiling stream, which degrades to a named scan_ceiling
   * error instead of throwing. */
  async fetch(): Promise<void> {
    if (!this.live) return;
    this.fetches += 1;
    if (this.fetches > MAX_SCAN_PAGES) {
      const ceiling = scanCeilingOutcome(this.softCeiling, this.base.provider);
      if (ceiling.hard) {
        throw new AppError(
          422,
          "query_too_broad",
          "Browse reached its upstream page limit before filling this page; narrow the filters.",
        );
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
    this.page += 1;
    try {
      const result = await searchCatalog({
        ...this.base,
        page: this.page,
        perPage: this.perPage,
      } as CatalogSearchQuery);
      this.buffer.push(...result.items.filter(this.visible));
      this.nativeHasMore = result.hasMore;
      this.total = result.total;
      this.totalKnown = result.totalCountKnown;
      this.sort = result.sort;
      if (!result.hasMore) this.exhausted = true;
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
      this.error = {
        provider: this.base.provider,
        code: err instanceof AppError ? err.code : "provider_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function sourceError(provider: CatalogProvider, err: unknown): SourceError {
  return {
    provider,
    code: err instanceof AppError ? err.code : "provider_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function allSourcesFailed(streams: Stream[]): never {
  const errors = streams.filter((s) => s.error !== undefined);
  throw new AppError(
    502,
    "provider_unavailable",
    errors.map((s) => `${s.error!.provider}: ${s.error!.message}`).join("; "),
  );
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
/** Consumes the ordered (or, with no shared order, stable-concatenated)
 * prefix of the given streams and slices out one visible page. */
async function mergeStreams(
  streams: Stream[],
  mergeOrder:
    | { key: "recency" | "duration"; direction: CatalogSortDirection }
    | undefined,
  start: number,
  count: number,
): Promise<BrowsePage> {
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
    for (const s of streams) {
      while (s.buffer.length === 0 && s.live) await s.fetch();
    }
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
  const errors: SourceError[] = streams
    .filter((s) => s.error !== undefined)
    .map((s) => s.error!);
  // A 502 needs every side to have failed for real: a stream stopping on
  // its own scan ceiling is a bounded (if matchless) answer, not an outage,
  // so a ceiling beside a real outage — or beside another ceiling — stays
  // a partial page whose named errors say so. Only outages on every side
  // leave nothing answered.
  if (
    items.length === 0 &&
    errors.length === streams.length &&
    errors.every((e) => e.code !== "scan_ceiling")
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
  };
}

// --- native query assembly ---

function nativeQuery(
  query: BrowseQuery,
  plan: {
    provider: CatalogProvider;
    includeIds: string[];
    /** True when includeIds are a free-text expansion: the native criterion
     * is any-of (`tags`) instead of all-of (`tagsAll`). */
    includeAny: boolean;
    excludeIds: string[];
    performerIds?: string[];
  },
  sort: SortOrder | undefined,
  filmography: boolean,
  page: number,
  perPage: number,
): CatalogSearchQuery {
  const date =
    query.date !== undefined && query.dateOperation !== undefined
      ? { cutoff: query.date, operation: query.dateOperation }
      : undefined;
  if (plan.provider === "tpdb") {
    // Filmography routes upstream-reject tag parameters, so includes stay
    // local there; every other movie query passes the AND-of-includes
    // natively.
    return {
      provider: "tpdb",
      kind: "movie",
      ...(query.q !== undefined ? { query: query.q } : {}),
      ...(query.year !== undefined ? { year: query.year } : {}),
      ...(date !== undefined ? { releaseDate: date } : {}),
      ...(query.studioTpdb !== undefined ? { studio: query.studioTpdb } : {}),
      ...(filmography ? { performer: query.performerTpdb } : {}),
      ...(plan.includeIds.length > 0 && !filmography
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
    ...(plan.performerIds !== undefined
      ? { performers: plan.performerIds }
      : query.performerStashdb !== undefined
        ? { performer: query.performerStashdb }
        : {}),
    ...(query.studioStashdb !== undefined
      ? { studio: query.studioStashdb, studioMode: query.studioMode }
      : {}),
    // One upstream tag criterion: native includes (all-of anchored or any-of
    // free-text expansion), or — only when no include is native — native
    // excludes. Mixed include+exclude keeps the includes native and
    // re-checks every exclusion locally.
    ...(plan.includeIds.length > 0
      ? plan.includeAny
        ? { tags: plan.includeIds }
        : { tagsAll: plan.includeIds }
      : plan.excludeIds.length > 0
        ? { tagsExclude: plan.excludeIds }
        : {}),
    ...(date !== undefined ? { releaseDate: date } : {}),
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

function refuse(message: string): never {
  throw new AppError(400, "invalid_search", message);
}

// --- browseTitles ---

/** The one side decision, pure: which provider streams a browse query may
 * run, which combinations are refused outright, and what ordering each side
 * can carry. No IO and no per-user state — every refusal here is provable
 * from the query alone, which makes this the directly testable face of the
 * logic that once shipped mis-wired. browseTitles consumes the plan and adds
 * only IO: include-tag resolution and per-user hidden tags. */
export type BrowsePlan = {
  sides: CatalogProvider[];
  filmography: boolean;
  nativeSort: SortOrder | undefined;
  mergeOrder:
    | { key: "recency" | "duration"; direction: CatalogSortDirection }
    | undefined;
};

export function planBrowseSides(query: BrowseQuery): BrowsePlan {
  // A source-scoped constraint on the wrong typed tab never refuses and
  // never runs the other side unfiltered: the side it cannot constrain
  // simply does not qualify, so the tab keeps the filter in the URL and
  // shows an honest empty page. A unified pair (both performer ids, both
  // studio ids) keeps the side the tab names — each side carries its own
  // constraint.
  if (
    query.performerStarred !== undefined &&
    query.performerTpdb !== undefined
  ) {
    refuse(
      "A starred-performer filter cannot be combined with a TPDB performer.",
    );
  }
  if (
    query.performerStarred !== undefined &&
    query.performerStashdb !== undefined
  ) {
    refuse(
      "A starred-performer filter cannot be combined with a StashDB performer.",
    );
  }
  if (query.studioMode === "withChildren") {
    if (query.studioStashdb === undefined) {
      refuse("studioMode withChildren requires a StashDB studio.");
    }
    if (query.studioTpdb !== undefined) {
      refuse(
        "studioMode withChildren is StashDB-only; TPDB studios have no parent criterion.",
      );
    }
  }
  const filmography = query.performerTpdb !== undefined;
  // The filmography route constrains only the TPDB side: a unified
  // performer pair on the Scenes tab runs the StashDB side alone, which
  // accepts search, year, date and sort — refuse only where TPDB runs.
  const tpdbFilmography = filmography && query.type !== "scene";
  if (tpdbFilmography) {
    // The filmography route is paging-only: query, year, date, studio and
    // every sort are upstream-rejected, so refuse them here before any
    // upstream call rather than mid-merge.
    if (query.q !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a search term.",
      );
    }
    if (query.year !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a year filter.",
      );
    }
    if (query.date !== undefined) {
      refuse(
        "A TPDB performer filmography cannot be combined with a date filter.",
      );
    }
    if (query.studioTpdb !== undefined) {
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

  // Global order: an explicit recency/duration request, or the default
  // release recency (newest first) — but only where every qualifying stream
  // can genuinely carry it. The filmography route cannot sort, so its
  // queries claim no order at all where it runs. Other explicit sorts reach
  // exactly one stream and pass through natively.
  const defaultSort: SortOrder | undefined = tpdbFilmography
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

  // One-sided clauses restrict only that side: a StashDB studio kills the
  // movie query, a TPDB studio kills the scene query. A unified studio tile
  // carries BOTH ids, and there the clauses are alternatives, not a
  // conjunction — each provider query takes its own side, the overview is
  // the union. AND-ing them could only ever return nothing. The performer
  // pair unions the same way: both ids together run both sides; a lone
  // TPDB-side clause still kills the scene side, and a lone StashDB id the
  // movie side. On a typed tab the wrong-kind clause yields no sides at
  // all: the tab keeps the filter and shows an honest empty page.
  const bothPerformers =
    query.performerTpdb !== undefined && query.performerStashdb !== undefined;
  const movieWanted =
    query.type !== "scene" &&
    (query.performerStashdb === undefined || bothPerformers) &&
    (query.studioStashdb === undefined || query.studioTpdb !== undefined) &&
    query.performerStarred === undefined;
  const sceneWanted =
    query.type !== "movie" &&
    (!filmography || bothPerformers) &&
    (query.studioTpdb === undefined || query.studioStashdb !== undefined);
  const sides: CatalogProvider[] = [];
  if (movieWanted) sides.push("tpdb");
  if (sceneWanted) sides.push("stashdb");
  // An explicit order must be one the qualifying sides genuinely carry: the
  // type=all refusal above covers only the merged vocabulary, while a typed
  // tab (or an All query filtered down to one side) sends the sort to that
  // one provider — where an unimplemented order dies upstream as
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
  return { sides, filmography, nativeSort, mergeOrder };
}
// Stryker disable all

/** Composes the visible catalog page: native provider filters first, local
 * mandatory predicates only where a provider cannot express them, stable
 * prefix merge across sources, honest totals and failures throughout. */
export async function browseTitles(
  query: BrowseQuery,
  hiddenTags: CatalogTagSelection[],
  starredPerformerIds: string[] = [],
): Promise<BrowsePage> {
  const plan = planBrowseSides(query);
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

  const plans: {
    provider: CatalogProvider;
    includeIds: string[];
    includeAny: boolean;
    freeTextNative: boolean;
    excludeIds: string[];
    localFiltered: boolean;
    localInclude: CatalogTagSelection[];
    localFree: CatalogTagSelection[];
    localYear?: number;
    performerIds?: string[];
  }[] = [];
  if (movieWanted && tpdbIncludes !== undefined) {
    // Free-text includes expand natively on this side (the filmography
    // route rejects tag parameters, so there they stay local); anchored
    // ids and singleton expansions share the one all-of criterion, so
    // anyOf only ever rides alone.
    plans.push({
      provider: "tpdb",
      includeIds:
        tpdbIncludes.allOf.length > 0 ? tpdbIncludes.allOf : tpdbIncludes.anyOf,
      includeAny:
        tpdbIncludes.allOf.length === 0 && tpdbIncludes.anyOf.length > 0,
      freeTextNative: tpdbIncludes.freeTextNative,
      excludeIds: [], // TPDB has no native exclude criterion
      localFiltered:
        hiddenTags.length > 0 ||
        query.exclude.length > 0 ||
        tpdbIncludes.localInclude.length > 0 ||
        (filmography && query.include.length > 0),
      localInclude: filmography ? query.include : tpdbIncludes.localInclude,
      localFree: filmography ? query.include : tpdbIncludes.localFree,
      localYear: undefined,
    });
  }
  if (sceneWanted && stashIncludes !== undefined) {
    const includesNative =
      stashIncludes.allOf.length > 0 || stashIncludes.anyOf.length > 0;
    plans.push({
      provider: "stashdb",
      includeIds:
        stashIncludes.allOf.length > 0
          ? stashIncludes.allOf
          : stashIncludes.anyOf,
      includeAny:
        stashIncludes.allOf.length === 0 && stashIncludes.anyOf.length > 0,
      freeTextNative: stashIncludes.freeTextNative,
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
        query.year !== undefined,
      localInclude: stashIncludes.localInclude,
      localFree: stashIncludes.localFree,
      localYear: query.year,
      performerIds:
        query.performerStarred === true ? starredPerformerIds : undefined,
    });
  }
  if (plans.length === 0) {
    if (unresolved.length > 0) {
      // Every wanted side died resolving its includes: an outage, not a
      // provably empty catalog. mergeStreams turns all-failed streams into
      // the 502 that names each provider.
      return mergeStreams(
        unresolved,
        mergeOrder,
        (query.page - 1) * query.perPage,
        query.perPage,
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
    };
  }

  // Fast path: a single fully-native stream passes straight through with the
  // provider's own totals, continuation, and error semantics — one upstream
  // request for any page depth.
  const single = plans.length === 1 ? plans[0]! : undefined;
  if (
    single !== undefined &&
    !single.localFiltered &&
    unresolved.length === 0
  ) {
    const page = await searchCatalog(
      nativeQuery(
        query,
        single,
        nativeSort,
        filmography,
        query.page,
        query.perPage,
      ),
    );
    return {
      items: page.items,
      page: page.page,
      perPage: page.perPage,
      hasMore: page.hasMore,
      ...(page.total !== undefined ? { total: page.total } : {}),
      totalCountKnown: page.totalCountKnown,
      errors: [],
    };
  }

  const streams: Stream[] = plans.map(
    (plan) =>
      new Stream(
        nativeQuery(query, plan, nativeSort, filmography, 1, query.perPage),
        visiblePredicate(
          hiddenTags,
          query.exclude,
          plan.localInclude,
          plan.localYear,
        ),
        query.perPage,
        plan.localFiltered,
        softCeilingFor({
          localInclude: plan.localFree,
          freeTextNative: plan.freeTextNative,
        }),
      ),
  );
  streams.push(...unresolved);
  return mergeStreams(
    streams,
    mergeOrder,
    (query.page - 1) * query.perPage,
    query.perPage,
  );
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
  const stream = new Stream(
    { ...query, page: 1, perPage } as CatalogSearchQuery,
    (d) => !isHiddenTitle(d, hiddenTags),
    perPage,
    true, // hidden filtering is always local
  );
  const start = (requestedPage - 1) * perPage;
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
      const key = getConfig()?.providers?.typesafeApiKey;
      if (key !== undefined && key.trim() !== "") {
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
        const suggestions = await suggestTags(q, candidates, key);
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
