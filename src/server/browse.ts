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
// never a fake empty page or fake end — narrow the filters. Raise
// MAX_SCAN_PAGES only when real browsing measurably needs it.

import { AppError } from "./http.ts";
import { suggestTags } from "./judgment.ts";
import {
  listCatalogTags,
  searchCatalog,
  searchCatalogTags,
  tagCounterpart,
} from "./providers.ts";
import type {
  CatalogSearchPage,
  CatalogSearchQuery,
  CatalogSortDirection,
  CatalogSortKey,
  ReleaseDateOperation,
} from "./providers.ts";
import { getConfig, parseTagSelections } from "./storage.ts";
import { normalizeFacetName } from "../lib/contracts.ts";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogTagSelection,
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
  studioMode: "exact" | "withChildren";
  year?: number;
  date?: string;
  dateOperation?: ReleaseDateOperation;
  sort?: CatalogSortKey;
  direction?: CatalogSortDirection;
  page: number;
  perPage: number;
};

/** One source's partial failure inside an otherwise successful page. */
export type SourceError = {
  provider: CatalogProvider;
  code: string;
  message: string;
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
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OPS: readonly ReleaseDateOperation[] = ["<", "<=", "=", ">", ">="];
const SORT_KEYS: readonly CatalogSortKey[] = [
  "relevance",
  "recency",
  "duration",
  "title",
  "date",
  "created",
  "updated",
  "trending",
  "popularity",
];
/** Sorts BOTH sources express natively; everything else is per-source-only
 * and refused for mixed browse rather than silently applied to one side. */
const MIXED_SORTS: Record<string, true> = { recency: true, duration: true };

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
  if (!UUID_RE.test(value)) {
    throw invalidQuery(`${key} must be a provider UUID.`);
  }
  return value;
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
  if (date !== "" && !ISO_DATE_RE.test(date)) {
    throw invalidQuery("date must be an ISO calendar date (YYYY-MM-DD).");
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
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      throw invalidQuery("year must be a calendar year between 1900 and 2100.");
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
  return {
    type: type ?? "all",
    ...(q !== undefined && q !== "" ? { q } : {}),
    include: parseSelections(params, "include"),
    exclude: parseSelections(params, "exclude"),
    ...omitUndefined({
      studioTpdb: parseId(params, "studioTpdb"),
      studioStashdb: parseId(params, "studioStashdb"),
      performerTpdb: parseId(params, "performerTpdb"),
      performerStashdb: parseId(params, "performerStashdb"),
    }),
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

// --- tag matching: provider UUID first, then the exact normalized label ---

function tagMatches(detail: CatalogDetail, sel: CatalogTagSelection): boolean {
  const nativeId =
    detail.reference.provider === "tpdb" ? sel.tpdb : sel.stashdb;
  if (nativeId !== undefined && detail.tags.some((t) => t.id === nativeId)) {
    return true;
  }
  const label = normalizeFacetName(sel.name);
  // An empty normalized label identifies nothing — never a wildcard.
  return (
    label !== "" &&
    detail.tags.some((t) => normalizeFacetName(t.name) === label)
  );
}

/** True when any personal hidden tag matches by provider UUID or exact
 * normalized label. Substring and AI inference are never applied; preference
 * is filtration, never authorization. */
export function isHiddenTitle(
  detail: CatalogDetail,
  hiddenTags: CatalogTagSelection[],
): boolean {
  return hiddenTags.some((sel) => tagMatches(detail, sel));
}

// --- stream planning ---

function visiblePredicate(
  hiddenTags: CatalogTagSelection[],
  exclude: CatalogTagSelection[],
  include: CatalogTagSelection[],
  year: number | undefined,
): (d: CatalogDetail) => boolean {
  // Exclusions win over includes: a hidden or excluded match blocks the item
  // regardless of any include criterion.
  return (d) => {
    if (hiddenTags.some((sel) => tagMatches(d, sel))) return false;
    if (exclude.some((sel) => tagMatches(d, sel))) return false;
    if (include.length > 0 && !include.every((sel) => tagMatches(d, sel))) {
      return false;
    }
    if (year !== undefined && d.releaseDate?.slice(0, 4) !== String(year)) {
      return false;
    }
    return true;
  };
}

/** Resolves the native include-id list for one provider side. Every included
 * tag must be matchable on a qualifying source: a selection already carrying
 * the side's UUID uses it; otherwise the counterpart id is resolved through
 * the providers' own published label pairing. An unresolvable tag
 * disqualifies the whole side (undefined) — it is NEVER allowed to run
 * unfiltered. */
async function includeIdsForSide(
  selections: CatalogTagSelection[],
  side: "tpdb" | "stashdb",
): Promise<string[] | undefined> {
  const ids: string[] = [];
  for (const sel of selections) {
    const direct = side === "tpdb" ? sel.tpdb : sel.stashdb;
    if (direct !== undefined) {
      if (!ids.includes(direct)) ids.push(direct);
      continue;
    }
    // A label-only selection has no native anchor to resolve from, so this
    // side genuinely cannot match — disqualify rather than widen.
    if ((side === "tpdb" ? sel.stashdb : sel.tpdb) === undefined) {
      return undefined;
    }
    // tagCounterpart searches the OTHER provider by exact normalized label.
    const counterpart = await tagCounterpart(
      side === "tpdb" ? "stashdb" : "tpdb",
      sel.name,
    );
    if (counterpart === undefined) return undefined;
    if (!ids.includes(counterpart.id)) ids.push(counterpart.id);
  }
  return ids;
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
  ) {
    this.base = base;
    this.visible = visible;
    this.perPage = perPage;
    this.localFiltered = localFiltered;
  }

  get live(): boolean {
    return !this.exhausted && this.error === undefined;
  }

  /** True when a head is resident or more may still arrive. */
  get open(): boolean {
    return this.buffer.length > 0 || this.live;
  }

  /** One more upstream page into the buffer. Throws query_too_broad when the
   * documented ceiling is hit while upstream continuation still exists. */
  async fetch(): Promise<void> {
    if (!this.live) return;
    this.fetches += 1;
    if (this.fetches > MAX_SCAN_PAGES) {
      throw new AppError(
        422,
        "query_too_broad",
        "Browse reached its upstream page limit before filling this page; narrow the filters.",
      );
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
    // genuinely runs out (the scan ceiling throws).
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
  if (items.length === 0 && errors.length === streams.length) {
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
  // A source error means this page may be incomplete: claim continuation
  // rather than a false end. Exhaustion is the only proven stop.
  const hasMore = errors.length > 0 || !exhausted;
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
    excludeIds: string[];
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
        ? { tagsAll: plan.includeIds }
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
    ...(query.performerStashdb !== undefined
      ? { performer: query.performerStashdb }
      : {}),
    ...(query.studioStashdb !== undefined
      ? { studio: query.studioStashdb, studioMode: query.studioMode }
      : {}),
    // One upstream tag criterion: native ALL-of-includes, or — only when no
    // include is native — native excludes. Mixed include+exclude keeps the
    // includes native and re-checks every exclusion locally.
    ...(plan.includeIds.length > 0
      ? { tagsAll: plan.includeIds }
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

/** Composes the visible catalog page: native provider filters first, local
 * mandatory predicates only where a provider cannot express them, stable
 * prefix merge across sources, honest totals and failures throughout. */
export async function browseTitles(
  query: BrowseQuery,
  hiddenTags: CatalogTagSelection[],
): Promise<BrowsePage> {
  // Source-scoped constraints must never silently narrow to one kind or run
  // the other side unfiltered.
  if (query.performerStashdb !== undefined && query.type === "movie") {
    refuse(
      "A StashDB performer filter cannot apply to movies; browse All or Scenes.",
    );
  }
  if (query.studioStashdb !== undefined && query.type === "movie") {
    refuse(
      "A StashDB studio filter cannot apply to movies; browse All or Scenes.",
    );
  }
  if (query.performerTpdb !== undefined && query.type === "scene") {
    refuse(
      "A TPDB performer filmography cannot apply to scenes; browse All or Movies.",
    );
  }
  if (query.studioTpdb !== undefined && query.type === "scene") {
    refuse(
      "A TPDB studio filter cannot apply to scenes; browse All or Movies.",
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
  if (filmography) {
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
    !MIXED_SORTS[query.sort]
  ) {
    refuse(
      `"${query.sort}" order is not available on both sources; browse All supports recency and duration, or pick Movies/Scenes for the rest.`,
    );
  }

  // Global order: an explicit recency/duration request, or the default
  // release recency (newest first) — but only where every qualifying stream
  // can genuinely carry it. The filmography route cannot sort, so its
  // queries claim no order at all. Other explicit sorts reach exactly one
  // stream and pass through natively.
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

  const movieWanted =
    query.type !== "scene" &&
    query.performerStashdb === undefined &&
    query.studioStashdb === undefined;
  const sceneWanted =
    query.type !== "movie" && !filmography && query.studioTpdb === undefined;
  const [tpdbIncludes, stashIncludes] = await Promise.all([
    movieWanted
      ? includeIdsForSide(query.include, "tpdb")
      : Promise.resolve(undefined),
    sceneWanted
      ? includeIdsForSide(query.include, "stashdb")
      : Promise.resolve(undefined),
  ]);

  const plans: {
    provider: CatalogProvider;
    includeIds: string[];
    excludeIds: string[];
    localFiltered: boolean;
    localInclude: CatalogTagSelection[];
    localYear?: number;
  }[] = [];
  if (movieWanted && tpdbIncludes !== undefined) {
    plans.push({
      provider: "tpdb",
      includeIds: tpdbIncludes,
      excludeIds: [], // TPDB has no native exclude criterion
      localFiltered:
        hiddenTags.length > 0 ||
        query.exclude.length > 0 ||
        (filmography && query.include.length > 0),
      localInclude: filmography ? query.include : [],
      localYear: undefined,
    });
  }
  if (sceneWanted && stashIncludes !== undefined) {
    plans.push({
      provider: "stashdb",
      includeIds: stashIncludes,
      // One upstream tag criterion: native excludes only when no include is
      // native. Selections without a StashDB id stay local-only below.
      excludeIds:
        stashIncludes.length === 0
          ? query.exclude
              .map((sel) => sel.stashdb)
              .filter((id): id is string => id !== undefined)
          : [],
      localFiltered:
        hiddenTags.length > 0 ||
        query.exclude.length > 0 ||
        query.year !== undefined,
      localInclude: [],
      localYear: query.year,
    });
  }
  if (plans.length === 0) {
    // Reachable only when include tags resolve on no qualifying source:
    // nothing can match, provably, before any upstream call.
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
  if (single !== undefined && !single.localFiltered) {
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

  const streams = plans.map(
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
      ),
  );
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
    hasMore: !exhausted,
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
): Promise<{ tags: CatalogTagSelection[]; errors: SourceError[] }> {
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
