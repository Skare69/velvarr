// Metadata provider catalog reads: TPDB (movies, scenes, performers) and
// StashDB (scenes, performers). Strictly read-only; returns validated
// CatalogDetail records and paged search results. No provider payload or
// image bytes are ever persisted — providers publish no caching/artwork
// terms, so every fetch is pass-through for one authorized request.
//
// Upstream shapes verified live 2026-09-10:
// - TPDB rows are flat objects (no JSON:API attributes wrapper). Release date
//   is `date` (YYYY-MM-DD); `created`/`last_updated` are record timestamps and
//   are never mapped to releaseDate.
// - TPDB listings report a FAKE total (capped at 10000) unless a countable
//   filter is applied (q, performer filmography); title-only filters still hit
//   the cap. `meta.links.next` is the only trustworthy continuation signal.
// - TPDB movie/scene credits embed the canonical parent performer
//   (performers[].parent, UUID id + numeric _id); filmography routes
//   /performers/{id}/{movies,scenes} accept both UUID and numeric _id.
// - TPDB 404 (including malformed ids) means not found; anything else that
//   fails is an outage with upstreamStatus set by the transport.
// - StashDB scene listing root is queryScenes(input: SceneQueryInput!) — NOT
//   findScenes. findScene/findPerformer return data null at HTTP 200 for
//   missing ids (authoritative absence); schema failures surface as 422.
// - searchPerformers(term) returns a real count but at most ~10 rows and has
//   no paging; its result set is complete-but-capped by the provider.
// - StashDB serves performer images from stashdb.org/images/<uuid>; TPDB
//   normalizes all artwork onto cdn.theporndb.net / thumb.theporndb.net.
//   Raw `image` fields on TPDB rows point at unbounded studio CDNs and are
//   deliberately never emitted or proxied.
// - Verified live 2026-09-11: TPDB /sites rows are {uuid, id (numeric),
//   name, url, description?, logo/poster/favicon on cdn.theporndb.net,
//   nested network/parent site rows}; /sites/{id} accepts uuid or numeric
//   id, but scene/movie `site_id` filters accept only the NUMERIC id (a
//   uuid 422s). /tags rows are {id (numeric), uuid, name}. Tag filters use
//   deep-object NUMERIC keys (`tags[70]=1`), not `tags[]=uuid`; the latter
//   silently returns zero movies (verified live 2026-09-21). Public identities
//   stay UUIDs; the adapter resolves their numeric filter keys.
//   Site-filtered listings report real totals; title-only q hits the 10000 cap.
// - StashDB searchStudio(term, limit) and searchTag(term, limit) return
//   flat [Studio]/[Tag] lists with no count (unpaged, provider-capped);
//   queryScenes accepts studios/tags criteria with INCLUDES/EXCLUDES plus
//   sort/direction (TRENDING and POPULARITY verified live). SceneQueryInput
//   also takes parentStudio (a plain ID string, verified live 2026-09-11 —
//   scenes under that studio's child rows; mutually exclusive with studios,
//   which is a MultiIDCriterionInput). StudioSortEnum
//   has no trending order, so studio search exposes no sort at all. StashDB
//   studio records carry explicit provider URLs, but cross-provider linking
//   stays performer-level only — studios are never merged across providers.

import { AppError, parseJson, requestBytes, requestJsonBytes } from "./http.ts";
import type { Service } from "./http.ts";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  MediaKind,
} from "../lib/contracts.ts";
import { normalizeFacetName } from "../lib/contracts.ts";

// Pure cross-provider identity policy (published links only, no name
// matching) lives in its own module; this adapter keeps the I/O around it.
import { crossProviderLink, identityLinkKey } from "./identity-links.ts";

// Row mapping (upstream row → CatalogDetail parts) is pure object-shaping in
// its own module; this adapter keeps transport, caches, query policy and the
// one stateful side channel: learning TPDB tags' numeric filter ids.
import {
  MAX,
  cleanString,
  cleanYear,
  dedupeBy,
  isIsoDate,
  isProviderImageUrl,
  isUuid,
  stashPerformerDetail,
  stashSceneDetail,
  stashStudioDetail,
  tpdbMediaDetail,
  tpdbPerformerDetail,
  tpdbStudioDetail,
  tpdbTags,
} from "./provider-rows.ts";

export { isProviderImageUrl } from "./provider-rows.ts";

// --- credentials and bases: stored admin UI credentials win, the environment
// is the fallback; read at call time so a save or clear takes effect without
// a restart. Values are never logged, echoed, or placed in URLs. ---
import { getConfig } from "./storage.ts";

// Metadata-provider cache: TPDB/StashDB reads only. Short-TTL freshness with
// stale-on-error fallback, so an upstream blip serves the last good payload
// instead of erroring a whole shelf. In-memory only, resets on restart.
// ponytail: one global TTL and a FIFO cap; per-endpoint tuning or durability
// only if real evidence demands it.
const META_CACHE_TTL_MS = 10 * 60_000;
const META_CACHE_MAX = 500;
const metaCache = new Map<string, { at: number; bytes: Uint8Array }>();
// Identical reads already in flight share one upstream request: a card's
// detail and availability lanes ask for the same record at the same moment.
const metaInFlight = new Map<string, Promise<Uint8Array>>();
const tpdbTagNumbers = new Map<string, number>();

/** Test seam: the suite reuses one fixture upstream per file; tests reset
 * between phases so cached reads never mask a scripted outage. */
export function resetMetaCache(): void {
  metaCache.clear();
  metaInFlight.clear();
  tpdbTagNumbers.clear();
  counterpartMemo.clear();
}

/** Learns the numeric filter key behind a TPDB tag uuid while rows map.
 * FIFO-capped: tag rows arrive on every listing, so the cap only bounds the
 * rare long tail of stale uuids. */
function recordTagPair(id: string, numeric: number): void {
  if (tpdbTagNumbers.size >= 10_000)
    tpdbTagNumbers.delete(tpdbTagNumbers.keys().next().value!);
  tpdbTagNumbers.set(
    `${process.env.TPDB_BASE_URL ?? ""}:${id.toLowerCase()}`,
    numeric,
  );
}

function isCacheable(service: Service, method: string, body: unknown): boolean {
  if (service !== "tpdb" && service !== "stashdb") return false;
  if (method === "GET") return true;
  // StashDB GraphQL reads arrive as POSTs; never cache a mutation. The
  // substring check can only over-reject (a read whose variables mention
  // "mutation" skips the cache), never serve stale writes.
  return (
    service === "stashdb" && !JSON.stringify(body ?? "").includes("mutation")
  );
}

function cachePut(key: string, bytes: Uint8Array): void {
  if (metaCache.size >= META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.delete(key);
  metaCache.set(key, { at: Date.now(), bytes });
}

// Cache-aware read for TPDB/StashDB. timeoutMs and cacheTtlMs are internal/
// test knobs; callers use the 15s default and the 10-minute metadata TTL.
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  token: string,
  options: {
    method?: string;
    body?: unknown;
    service?: Service;
    timeoutMs?: number;
    cacheTtlMs?: number;
  } = {},
): Promise<T> {
  const service = options.service ?? "jellyfin";
  const method = options.method ?? "GET";
  const ttl = options.cacheTtlMs ?? META_CACHE_TTL_MS;
  // ttl only governs fresh-hit refresh; 0 means "always revalidate", and the
  // stale-on-error fallback still applies.
  const cacheable = isCacheable(service, method, options.body);
  const key = cacheable
    ? `${service} ${method} ${baseUrl}${path} ${JSON.stringify(options.body ?? null)}`
    : "";
  const hit = cacheable ? metaCache.get(key) : undefined;
  if (hit && Date.now() - hit.at < ttl) return parseJson<T>(hit.bytes, service);
  try {
    let pending = cacheable ? metaInFlight.get(key) : undefined;
    if (pending === undefined) {
      pending = requestJsonBytes(baseUrl, path, token, {
        service,
        method,
        body: options.body,
        timeoutMs: options.timeoutMs,
      });
      if (cacheable) {
        const own = pending;
        metaInFlight.set(key, own);
        own
          .then(
            (bytes) => cachePut(key, bytes),
            () => {},
          )
          .finally(() => {
            if (metaInFlight.get(key) === own) metaInFlight.delete(key);
          });
      }
    }
    const bytes = await pending;
    return parseJson<T>(bytes, service);
  } catch (error) {
    // Only flaky infrastructure justifies stale data: an outage or timeout
    // serves the last good payload instead of erroring a shelf. Authoritative
    // answers (404, 401, malformed) always surface.
    const staleWorthy =
      error instanceof AppError &&
      (error.code === "upstream_unavailable" ||
        error.code === "upstream_timeout");
    if (hit && staleWorthy) return parseJson<T>(hit.bytes, service);
    throw error;
  }
}

function credential(provider: "tpdb" | "stashdb"): string | undefined {
  const stored = getConfig()?.providers;
  const value =
    provider === "tpdb"
      ? (stored?.tpdbApiToken ?? process.env.TPDB_API_TOKEN)
      : (stored?.stashdbApiKey ?? process.env.STASHDB_API_KEY);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function tpdbGet<T>(path: string): Promise<T> {
  const token = credential("tpdb");
  if (token === undefined) {
    throw notConfigured("tpdb");
  }
  const base =
    typeof process.env.TPDB_BASE_URL === "string" &&
    process.env.TPDB_BASE_URL.trim() !== ""
      ? process.env.TPDB_BASE_URL
      : "https://api.theporndb.net";
  return requestJson<T>(base, path, token, { service: "tpdb" });
}

function notConfigured(provider: "tpdb" | "stashdb"): AppError {
  return new AppError(
    503,
    "provider_not_configured",
    `${provider === "tpdb" ? "TPDB" : "StashDB"} credentials are not configured.`,
  );
}

async function stashQuery(
  query: string,
  variables: Record<string, unknown>,
  dataKey: string,
): Promise<unknown> {
  const token = credential("stashdb");
  if (token === undefined) {
    throw notConfigured("stashdb");
  }
  const base =
    typeof process.env.STASHDB_BASE_URL === "string" &&
    process.env.STASHDB_BASE_URL.trim() !== ""
      ? process.env.STASHDB_BASE_URL
      : "https://stashdb.org";
  const body = await requestJson<{
    data?: Record<string, unknown> | null;
    errors?: unknown;
  }>(base, "/graphql", token, {
    service: "stashdb",
    method: "POST",
    body: { query, variables },
  });
  // HTTP-level failures (401 auth, 422 schema, 5xx outage) already surfaced
  // by the transport with upstreamStatus. data:null at HTTP 200 is the
  // authoritative absence signal for find* queries.
  if (
    body === null ||
    typeof body !== "object" ||
    body.data === null ||
    body.data === undefined
  ) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable response.",
    );
  }
  const value = body.data[dataKey];
  return value === undefined ? null : value;
}

// --- artwork: provider-hosted images only, pass-through, never persisted ---

const PROXYABLE_IMAGE_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
  "image/avif": true,
  // StashDB serves several studio logos as SVG (verified live 2026-09-21).
  // Vector markup is active content, so the proxy route serves every artwork
  // response script-less, sandboxed and as an attachment.
  "image/svg+xml": true,
};

const IMAGE_BYTE_CAP = 8 * 1024 * 1024;

/** Fetch artwork bytes for a URL previously seen on a validated provider
 * record. Never sends provider credentials, never follows redirects (the
 * transport errors on 3xx), never persists anything. */
export async function fetchProviderArtwork(
  url: string,
  options: { timeoutMs?: number; sizeLimit?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const check = isProviderImageUrl(url);
  if (!check.ok) {
    throw new AppError(
      400,
      "invalid_artwork_url",
      `Rejected artwork URL: ${check.reason}.`,
    );
  }
  const u = new URL(url);
  // ponytail: requestBytes rejoins origin+pathname, dropping any query string;
  // provider artwork URLs carry none today — a future query-bearing URL fails
  // visibly at the CDN instead of silently changing what is served.
  const { bytes, contentType } = await requestBytes(u.origin, u.pathname, "", {
    service: check.service,
    timeoutMs: options.timeoutMs,
    sizeLimit: options.sizeLimit ?? IMAGE_BYTE_CAP,
  });
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (PROXYABLE_IMAGE_TYPES[mime] !== true) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Artwork content type is not an image.",
    );
  }
  return { bytes, contentType };
}

// --- public interface ---

export type ProviderVerification =
  | { provider: "tpdb" | "stashdb"; configured: false }
  | {
      provider: "tpdb" | "stashdb";
      configured: true;
      verified: true;
      account: string;
    };

/** One cheap authenticated read-only call: TPDB GET /user, StashDB `me`.
 * Not-configured is returned, never faked; outages and auth failures throw
 * AppError so callers never confuse them with an empty catalog. */
export async function getProviderStatus(
  provider: "tpdb" | "stashdb",
): Promise<ProviderVerification> {
  try {
    if (provider === "tpdb") {
      const res = await tpdbGet<{ data?: { name?: unknown } }>("/user");
      const name = cleanString(res?.data?.name, 120);
      return {
        provider,
        configured: true,
        verified: true,
        account: name ?? "unknown",
      };
    }
    const res = (await stashQuery(
      "query { me { id name roles } }",
      {},
      "me",
    )) as { name?: unknown } | null;
    if (res === null || typeof res !== "object") {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable identity response.",
      );
    }
    const name = cleanString(res.name, 120);
    return {
      provider,
      configured: true,
      verified: true,
      account: name ?? "unknown",
    };
  } catch (err) {
    // Not-configured is returned, never thrown: callers distinguish it from
    // outages and auth failures, which still surface as AppError.
    if (err instanceof AppError && err.code === "provider_not_configured") {
      return { provider, configured: false };
    }
    throw err;
  }
}

/** Normalized sort vocabulary. Only orders the providers genuinely implement
 * appear here; the page surfaces the exact upstream order that was applied. */
export type CatalogSortKey =
  | "relevance"
  | "recency"
  | "duration"
  | "title"
  | "date"
  | "created"
  | "updated"
  | "trending"
  | "popularity";

export type CatalogSortDirection = "asc" | "desc";

interface AppliedSort {
  key: CatalogSortKey;
  /** Absent only for TPDB relevance, which has no direction upstream. */
  direction?: CatalogSortDirection;
  /** The exact upstream order token that was sent. */
  upstream: string;
}

/** Resolves a requested sort for a provider+kind to the exact upstream order.
 * Throws the explicit invalid-query error for any order the provider does not
 * implement — trending and popularity are StashDB scene-only; TPDB has
 * neither. TPDB recency maps to release recency (recently_released /
 * former_released); its created/updated RECORD orders are deliberately not
 * aliased onto release recency. */
export function resolveSort(
  provider: CatalogProvider,
  kind: MediaKind,
  sort: CatalogSortKey,
  direction?: CatalogSortDirection,
): AppliedSort {
  if (kind !== "movie" && kind !== "scene") {
    throw new AppError(
      400,
      "invalid_search",
      "Sorts apply to movie and scene search only.",
    );
  }
  if (provider === "tpdb") {
    if (sort === "relevance") {
      if (direction !== undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB relevance order takes no direction.",
        );
      }
      return { key: sort, upstream: "most_relevant" };
    }
    if (sort === "recency") {
      const dir = direction ?? "desc";
      return {
        key: sort,
        direction: dir,
        upstream: dir === "desc" ? "recently_released" : "former_released",
      };
    }
    if (sort === "duration") {
      const dir = direction ?? "desc";
      return {
        key: sort,
        direction: dir,
        upstream: dir === "desc" ? "duration_desc" : "duration_asc",
      };
    }
    throw new AppError(
      400,
      "invalid_search",
      `TPDB implements no ${sort} order; only relevance, recency, and duration exist.`,
    );
  }
  if (kind !== "scene") {
    throw new AppError(
      400,
      "invalid_search",
      "StashDB has no movie entity; sorts apply to scene search only.",
    );
  }
  const stashdbSceneSorts: Record<
    | "title"
    | "date"
    | "duration"
    | "trending"
    | "popularity"
    | "created"
    | "updated",
    string
  > = {
    title: "TITLE",
    date: "DATE",
    duration: "DURATION",
    trending: "TRENDING",
    popularity: "POPULARITY",
    created: "CREATED_AT",
    updated: "UPDATED_AT",
  };
  if (sort === "relevance" || sort === "recency") {
    throw new AppError(
      400,
      "invalid_search",
      `StashDB implements no ${sort} order for scenes; relevance and recency are TPDB-only.`,
    );
  }
  const upstream = stashdbSceneSorts[sort];
  return { key: sort, direction: direction ?? "desc", upstream };
}

/** Paged search query. Filters are explicit per provider+kind; combinations
 * the upstream cannot express are rejected rather than silently ignored.
 * `performer` on tpdb movie/scene is the canonical TPDB performer UUID and
 * switches to the filmography route (paging only there); on a stashdb scene
 * it uses the performers INCLUDES criterion. `studio` filters by the
 * provider's own studio id (TPDB resolves a site UUID to its numeric
 * site_id; StashDB uses the studios INCLUDES criterion); `tags`/`tagsAll`/
 * `tagsExclude` stay provider-native tag ids. `sort`/`direction` map through
 * resolveSort to each provider's real orders — unsupported combinations
 * throw. Studio and performer searches take no filters. */
export type CatalogSearchQuery =
  | {
      provider: "tpdb";
      kind: "movie";
      query?: string;
      year?: number;
      performer?: string;
      studio?: string;
      tags?: string[];
      tagsAll?: string[];
      /** Bounded release-date filter, TPDB-native `date` + `date_operation`.
       * Only the operator strings TPDB actually accepts are exposed (<=, <, =,
       * >, >= verified live 2026-09-11; word forms are upstream 422). Rejected
       * explicitly for every other provider+kind; StashDB scenes carry their
       * own native date criterion (see the stashdb scene variant). */
      releaseDate?: {
        cutoff: string;
        operation: ReleaseDateOperation;
      };
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "scene";
      query?: string;
      year?: number;
      performer?: string;
      studio?: string;
      tags?: string[];
      tagsAll?: string[];
      releaseDate?: {
        cutoff: string;
        operation: ReleaseDateOperation;
      };
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "performer";
      query: string;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "tpdb";
      kind: "studio";
      query: string;
      page?: number;
      perPage?: number;
    }
  | {
      provider: "stashdb";
      kind: "scene";
      query?: string;
      performer?: string;
      /** Any-of performer inclusion (INCLUDES) for the starred-performers
       * browse filter: multiple ids, never combined with `performer`. */
      performers?: string[];
      studio?: string;
      /** Only real on a StashDB scene search paired with `studio`. Omitted or
       * "exact" keeps the studios INCLUDES criterion (this studio only);
       * "withChildren" issues the parentStudio criterion instead so scenes
       * living under child studios are included. Rejected for TPDB (no
       * equivalent criterion), other kinds, or a missing studio. */
      studioMode?: "exact" | "withChildren";
      /** Any-of tag inclusion (INCLUDES): kept for internal related-title
       * candidate retrieval, not user-facing AND browsing. */
      tags?: string[];
      /** All-of tag inclusion (INCLUDES_ALL, verified live 2026-09-21): the
       * native AND criterion user-facing browsing uses. Mutually exclusive
       * with `tags` and `tagsExclude` — one criterion per query. */
      tagsAll?: string[];
      tagsExclude?: string[];
      /** Bounded release-date filter on the native `date`
       * DateCriterionInput. Same shape and operator strings as TPDB;
       * StashDB exposes only EQUALS/GREATER_THAN/LESS_THAN modifiers (no
       * inclusive forms), so the inclusive day operations shift the ISO
       * cutoff by one day — exact at the provider's date granularity.
       * Unsupported modifiers are never emitted. */
      releaseDate?: {
        cutoff: string;
        operation: ReleaseDateOperation;
      };
      sort?: CatalogSortKey;
      direction?: CatalogSortDirection;
      page?: number;
      perPage?: number;
    }
  | { provider: "stashdb"; kind: "performer"; query: string }
  | { provider: "stashdb"; kind: "studio"; query: string };
/** TPDB date_operation values verified live 2026-09-11 on /movies and
 * /scenes: only these operator strings; every word form (lte, before, ...)
 * is an upstream 422. `date` without an operation is an exact-match filter,
 * so the route and this provider always emit the pair together. */
export type ReleaseDateOperation = "<" | "<=" | "=" | ">" | ">=";

const RELEASE_DATE_OPS: readonly ReleaseDateOperation[] = [
  "<",
  "<=",
  "=",
  ">",
  ">=",
];

function isReleaseDateOperation(v: unknown): v is ReleaseDateOperation {
  return (
    typeof v === "string" &&
    RELEASE_DATE_OPS.some((operation) => operation === v)
  );
}

/** Validates the bounded release-date filter: a real calendar cutoff date
 * paired with an upstream-accepted operation. Anything else is an explicit
 * 400, never a silently dropped bound. */
function cleanReleaseDate(
  v: unknown,
): { cutoff: string; operation: ReleaseDateOperation } | undefined {
  if (v === undefined) return undefined;
  const raw =
    typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : undefined;
  const cutoff = raw?.cutoff;
  const operation = raw?.operation;
  if (!isIsoDate(cutoff) || !isReleaseDateOperation(operation)) {
    throw new AppError(
      400,
      "invalid_search",
      "releaseDate requires an ISO cutoff date (YYYY-MM-DD) and an operation of <, <=, =, >, or >=.",
    );
  }
  return { cutoff, operation };
}

/** StashDB DateCriterionInput exposes no inclusive modifiers (verified live
 * 2026-09-21: EQUALS/GREATER_THAN/LESS_THAN only). The inclusive ISO-day
 * operations shift the cutoff by one day — exact at the provider's date
 * granularity — so no unsupported modifier ever reaches the wire. */
const STASH_DATE_MODIFIERS: Record<
  ReleaseDateOperation,
  { modifier: "EQUALS" | "GREATER_THAN" | "LESS_THAN"; days: number }
> = {
  "=": { modifier: "EQUALS", days: 0 },
  ">": { modifier: "GREATER_THAN", days: 0 },
  ">=": { modifier: "GREATER_THAN", days: -1 },
  "<": { modifier: "LESS_THAN", days: 0 },
  "<=": { modifier: "LESS_THAN", days: 1 },
};

function shiftIsoDate(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export interface CatalogSearchPage {
  provider: "tpdb" | "stashdb";
  kind: "movie" | "scene" | "performer" | "studio";
  page: number;
  perPage: number;
  /** Present only when the query requested a sort: the exact order the
   * provider applied, so shelves can be labeled truthfully. */
  sort?: AppliedSort;
  /** True only when the provider offers a real next page. */
  hasMore: boolean;
  /** Present only when the provider's count is genuinely real — an attested
   * zero included. TPDB's fake 10000 cap surfaces as totalCountKnown: false
   * with no total. */
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
}

const DEFAULT_PER_PAGE = 24;
const TPDB_FAKE_TOTAL = 10000;

function cleanQueryTerm(v: unknown): string | undefined {
  return cleanString(v, 200);
}

function requireTpdbPerformerId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "TPDB filmography requires a canonical TPDB performer UUID.",
    );
  }
  return v;
}

function requireStashPerformerId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB scene filters require a StashDB performer UUID.",
    );
  }
  return v;
}

function requireStashStudioId(v: unknown): string {
  if (!isUuid(v)) {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB scene studio filters require a StashDB studio UUID.",
    );
  }
  return v;
}

/** Tag filter ids stay provider-native: UUIDs on both providers, deduplicated,
 * capped. An empty array is a no-op filter, not an unsupported one. */
function cleanTagIds(
  v: unknown,
  provider: "TPDB" | "StashDB",
): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new AppError(
      400,
      "invalid_search",
      `Tag filters must be arrays of ${provider} tag UUIDs.`,
    );
  }
  const ids: string[] = [];
  for (const entry of v.slice(0, 25)) {
    const s = cleanString(entry, 64);
    if (s === undefined || !isUuid(s)) {
      throw new AppError(
        400,
        "invalid_search",
        `${provider} tag filters require ${provider} tag UUIDs.`,
      );
    }
    if (!ids.includes(s)) ids.push(s);
  }
  return ids.length > 0 ? ids : undefined;
}

/** Runtime guard for variants whose type already omits filter fields: JSON
 * callers can smuggle fields in, and an unsupported filter must never be
 * silently dropped. */
function rejectUnusedFilters(
  raw: Record<string, unknown>,
  message: string,
): void {
  for (const field of [
    "studio",
    "tags",
    "tagsAll",
    "tagsExclude",
    "sort",
    "direction",
  ]) {
    if (raw[field] !== undefined) {
      throw new AppError(400, "invalid_search", message);
    }
  }
}

/** TPDB filters scenes/movies by NUMERIC site_id (verified live 2026-09-11:
 * a uuid is rejected upstream), while site identity everywhere else is the
 * uuid beside its published /sites/<slug>. A uuid or slug resolves once
 * through /sites/{id}; a numeric string passes straight through. */
async function resolveTpdbStudioFilter(
  v: unknown,
): Promise<string | undefined> {
  const s = cleanString(v, 64);
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return s;
  if (isUuid(s) || /^[a-z0-9][a-z0-9-]{0,63}$/i.test(s)) {
    const body = await tpdbGet<{ data?: { id?: unknown } }>(`/sites/${s}`);
    const row = (body?.data ?? null) as { id?: unknown } | null;
    if (typeof row?.id === "number" && Number.isInteger(row.id)) {
      return String(row.id);
    }
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB returned an unusable site record.",
    );
  }
  throw new AppError(
    400,
    "invalid_reference",
    "TPDB studio filters require a TPDB site UUID, numeric site id, or site slug.",
  );
}

interface TpdbListBody {
  data?: unknown;
  links?: { next?: unknown };
  meta?: { total?: unknown };
}

/** TPDB publishes UUID identities but filters by numeric tag keys only. */
async function tpdbTagFilters(
  ids: string[] | undefined,
): Promise<Record<string, number>> {
  if (!ids) return {};
  const keys = ids.map(
    (id) => `${process.env.TPDB_BASE_URL ?? ""}:${id.toLowerCase()}`,
  );
  // ponytail: no single-tag lookup upstream. Cold bookmarks scan at most 50
  // cached pages; use an ID lookup if TPDB adds one. Normal clicks learn ids
  // from the catalog/tag rows already read, so they need no extra request.
  for (let page = 1; keys.some((key) => !tpdbTagNumbers.has(key)); page++) {
    if (page > 50)
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB tag lookup exceeded its page limit.",
      );
    const body = await tpdbGet<TpdbListBody>(
      `/tags${tpdbQuery({ page, per_page: 100 })}`,
    );
    if (!Array.isArray(body.data))
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable tag listing.",
      );
    tpdbTags(body.data, recordTagPair);
    if (keys.every((key) => tpdbTagNumbers.has(key))) break;
    if (!body.data.length || typeof body.links?.next !== "string")
      throw new AppError(
        400,
        "invalid_search",
        "A selected TPDB tag no longer exists.",
      );
  }
  return Object.fromEntries(
    keys.map((key) => [`tags[${tpdbTagNumbers.get(key)!}]`, 1]),
  );
}

function parseTpdbPage(
  kind: "movie" | "scene" | "performer" | "studio",
  body: TpdbListBody,
  map: (row: unknown) => CatalogDetail | undefined,
  page: number,
  perPage: number,
): CatalogSearchPage {
  if (!Array.isArray(body.data)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB returned an unusable listing.",
    );
  }
  const items = dedupeBy(
    body.data
      .slice(0, perPage * 2)
      .map(map)
      .filter((d): d is CatalogDetail => d !== undefined),
    (d) => `${d.reference.kind}:${d.reference.id}`,
  );
  // rows > 0 AND a provider-issued next link: TPDB clamps beyond-end pages
  // and emits no next link there, so this terminates even under fake totals.
  const hasMore = items.length > 0 && typeof body.links?.next === "string";
  const rawTotal = body.meta?.total;
  // TPDB reports min(real, 10000): anything below the cap is the provider's
  // attestation, an attested zero included; exactly 10000 stays unproven.
  const totalReal =
    typeof rawTotal === "number" &&
    Number.isInteger(rawTotal) &&
    rawTotal >= 0 &&
    rawTotal < TPDB_FAKE_TOTAL &&
    // A zero total beside rows the provider actually sent contradicts
    // itself, whether or not those rows survive mapping.
    (rawTotal > 0 || body.data.length === 0);
  return {
    provider: "tpdb",
    kind,
    page,
    perPage,
    hasMore,
    ...(totalReal ? { total: rawTotal } : {}),
    totalCountKnown: totalReal,
    items,
  };
}

function tpdbQuery(base: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}

/** Paged catalog search. Never merges results across providers; every item is
 * source-labeled via its CatalogReference. */
export async function searchCatalog(
  query: CatalogSearchQuery,
): Promise<CatalogSearchPage> {
  // StashDB performer and studio searches are the genuinely unpaged shapes:
  // searchPerformers/searchStudio take no page arguments and cap rows. They
  // are dispatched before the paging defaults so every remaining query
  // variant genuinely accepts page/perPage.
  const raw = query as Record<string, unknown>;
  // studioMode is real only on a StashDB scene search paired with a studio
  // filter. Every other carrier — TPDB (no parentStudio criterion), other
  // kinds, or a missing studio — is rejected before any upstream request;
  // parent inclusion is never emulated by widening another provider's query.
  if (raw.studioMode !== undefined) {
    if (query.provider !== "stashdb" || query.kind !== "scene") {
      throw new AppError(
        400,
        "invalid_search",
        "studioMode is only supported on StashDB scene searches.",
      );
    }
    if (query.studio === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "studioMode requires a studio filter.",
      );
    }
  }
  // One metadata source per item type: Whisparr pairs movies with TPDB and
  // scenes with StashDB, so a surface that lists TPDB scenes can only lead
  // to a request that must fail. Refuse the listing here, before any
  // upstream request is issued.
  if (query.provider === "tpdb" && query.kind === "scene") {
    throw new AppError(
      400,
      "invalid_search",
      "Scenes are listed from StashDB only — TPDB scenes cannot be acquired.",
    );
  }
  // releaseDate is native on TPDB movie searches (`date` + `date_operation`)
  // and StashDB scene searches (`date` DateCriterionInput). Every other
  // carrier is rejected before any upstream request — a bound is never
  // silently dropped, and modifiers the upstream lacks are never emitted.
  if (raw.releaseDate !== undefined) {
    const supported =
      (query.provider === "tpdb" && query.kind === "movie") ||
      (query.provider === "stashdb" && query.kind === "scene");
    if (!supported) {
      throw new AppError(
        400,
        "invalid_search",
        "releaseDate is only supported on TPDB movie and StashDB scene searches.",
      );
    }
  }
  if (query.provider === "stashdb" && query.kind === "performer") {
    rejectUnusedFilters(
      raw,
      "StashDB performer search supports only a query term.",
    );
    const q = cleanQueryTerm(query.query);
    if (q === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "StashDB performer search requires a query term.",
      );
    }
    const res = (await stashQuery(
      "query($t: String!) { searchPerformers(term: $t) { count performers { id name deleted images { url } } } }",
      { t: q },
      "searchPerformers",
    )) as { count?: unknown; performers?: unknown } | null;
    if (res === null || typeof res !== "object") {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable performer search.",
      );
    }
    const items = dedupeBy(
      (Array.isArray(res.performers) ? res.performers : [])
        .slice(0, 50)
        .map(stashPerformerDetail)
        .filter((d): d is CatalogDetail => d !== undefined),
      (d) => d.reference.id,
    );
    const rawCount: unknown = res.count;
    const totalReal =
      typeof rawCount === "number" &&
      Number.isInteger(rawCount) &&
      rawCount >= 0;
    return {
      provider: "stashdb",
      kind: "performer",
      page: 1,
      perPage: items.length,
      // ponytail: searchPerformers exposes no paging — the provider caps the
      // result at ~10 rows; when count exceeds items, the remainder is
      // genuinely unreachable through this API.
      hasMore: false,
      ...(totalReal ? { total: rawCount } : {}),
      totalCountKnown: totalReal,
      items,
    };
  }

  if (query.provider === "stashdb" && query.kind === "studio") {
    rejectUnusedFilters(
      raw,
      "StashDB studio search supports only a query term.",
    );
    const q = cleanQueryTerm(query.query);
    if (q === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "StashDB studio search requires a query term.",
      );
    }
    const res = await stashQuery(
      "query($t: String!) { searchStudio(term: $t, limit: 25) { id name deleted parent { id name } images { url } urls { url type } } }",
      { t: q },
      "searchStudio",
    );
    if (!Array.isArray(res)) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable studio search.",
      );
    }
    const items = dedupeBy(
      res
        .slice(0, 50)
        .map(stashStudioDetail)
        .filter((d): d is CatalogDetail => d !== undefined),
      (d) => d.reference.id,
    );
    return {
      provider: "stashdb",
      kind: "studio",
      page: 1,
      perPage: items.length,
      // ponytail: searchStudio exposes neither paging nor a count — the
      // provider caps the result (limit above); anything beyond it is
      // genuinely unreachable through this API.
      hasMore: false,
      totalCountKnown: false,
      items,
    };
  }

  const page =
    typeof query.page === "number" &&
    Number.isInteger(query.page) &&
    query.page >= 1
      ? query.page
      : 1;
  const perPage =
    typeof query.perPage === "number" &&
    Number.isInteger(query.perPage) &&
    query.perPage >= 1 &&
    query.perPage <= 100
      ? query.perPage
      : DEFAULT_PER_PAGE;

  if (query.provider === "tpdb") {
    if (query.kind === "performer") {
      rejectUnusedFilters(
        raw,
        "TPDB performer search supports only query, page, and perPage.",
      );
      const q = cleanQueryTerm(query.query);
      if (q === undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB performer search requires a query term.",
        );
      }
      const body = await tpdbGet<TpdbListBody>(
        `/performers${tpdbQuery({ q, page, per_page: perPage })}`,
      );
      return parseTpdbPage(
        "performer",
        body,
        tpdbPerformerDetail,
        page,
        perPage,
      );
    }
    if (query.kind === "studio") {
      rejectUnusedFilters(
        raw,
        "TPDB studio search supports only query, page, and perPage.",
      );
      const q = cleanQueryTerm(query.query);
      if (q === undefined) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB studio search requires a query term.",
        );
      }
      const body = await tpdbGet<TpdbListBody>(
        `/sites${tpdbQuery({ q, page, per_page: perPage })}`,
      );
      return parseTpdbPage("studio", body, tpdbStudioDetail, page, perPage);
    }
    if (query.performer !== undefined) {
      // Filmography traversal via the canonical performer. The route supports
      // paging only; query/year filters are rejected, not ignored.
      if (
        cleanQueryTerm(query.query) !== undefined ||
        cleanYear(query.year) !== undefined ||
        query.releaseDate !== undefined
      ) {
        throw new AppError(
          400,
          "invalid_search",
          "TPDB filmography paging cannot be combined with query, year, release-date, studio, tag, or sort filters.",
        );
      }
      rejectUnusedFilters(
        raw,
        "TPDB filmography paging cannot be combined with studio, tag, or sort filters.",
      );
      const id = requireTpdbPerformerId(query.performer);
      const body = await tpdbGet<TpdbListBody>(
        `/performers/${id}/${query.kind}s${tpdbQuery({ page, per_page: perPage })}`,
      );
      return parseTpdbPage(
        query.kind,
        body,
        (row) => tpdbMediaDetail(query.kind, row, recordTagPair),
        page,
        perPage,
      );
    }
    if (query.direction !== undefined && query.sort === undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "direction requires an explicit sort.",
      );
    }
    const sort =
      query.sort !== undefined
        ? resolveSort("tpdb", query.kind, query.sort, query.direction)
        : undefined;
    const includeTags = cleanTagIds(query.tags, "TPDB");
    const allTags = cleanTagIds(query.tagsAll, "TPDB");
    if (includeTags !== undefined && allTags !== undefined) {
      throw new AppError(
        400,
        "invalid_search",
        "Choose either tags (any-of) or tagsAll (all-of); TPDB exposes one tag criterion per query.",
      );
    }
    const studioFilter = await resolveTpdbStudioFilter(query.studio);
    const releaseDate = cleanReleaseDate(query.releaseDate);
    const path = tpdbQuery({
      q: cleanQueryTerm(query.query),
      year: cleanYear(query.year),
      date: releaseDate?.cutoff,
      date_operation: releaseDate?.operation,
      ...(await tpdbTagFilters(includeTags ?? allTags)),
      site_id: studioFilter,
      tag_and: allTags !== undefined ? 1 : undefined,
      orderBy: sort?.upstream,
      page,
      per_page: perPage,
    });
    const body = await tpdbGet<TpdbListBody>(
      query.kind === "movie" ? `/movies${path}` : `/scenes${path}`,
    );
    const result = parseTpdbPage(
      query.kind,
      body,
      (row) => tpdbMediaDetail(query.kind, row, recordTagPair),
      page,
      perPage,
    );
    return sort !== undefined ? { ...result, sort } : result;
  }

  const input: Record<string, unknown> = { page, per_page: perPage };
  const q = cleanQueryTerm(query.query);
  if (q !== undefined) input.text = q;
  if (query.performer !== undefined) {
    input.performers = {
      value: [requireStashPerformerId(query.performer)],
      modifier: "INCLUDES",
    };
  } else if (query.performers !== undefined) {
    // Any-of (INCLUDES): the starred-performers browse filter.
    input.performers = {
      value: query.performers.map(requireStashPerformerId),
      modifier: "INCLUDES",
    };
  }
  if (query.studio !== undefined) {
    // Verified live 2026-09-11: SceneQueryInput.studios is a MultiIDCriterionInput
    // (INCLUDES = this studio only), while parentStudio is a plain ID string —
    // scenes under that studio's child rows. The two are mutually exclusive.
    const studioId = requireStashStudioId(query.studio);
    if (query.studioMode === "withChildren") {
      input.parentStudio = studioId;
    } else {
      input.studios = { value: [studioId], modifier: "INCLUDES" };
    }
  }
  const includeTags = cleanTagIds(query.tags, "StashDB");
  const allTags = cleanTagIds(query.tagsAll, "StashDB");
  const excludeTags = cleanTagIds(query.tagsExclude, "StashDB");
  if (
    [includeTags, allTags, excludeTags].filter((t) => t !== undefined).length >
    1
  ) {
    throw new AppError(
      400,
      "invalid_search",
      "StashDB exposes one tag criterion per query; choose tags (any-of), tagsAll (all-of), or tagsExclude.",
    );
  }
  if (allTags !== undefined) {
    // Native AND inclusion — the user-facing browse criterion.
    input.tags = { value: allTags, modifier: "INCLUDES_ALL" };
  } else if (includeTags !== undefined) {
    // Any-of OR inclusion: internal related-title candidate retrieval only,
    // never presented to users as an AND match.
    input.tags = { value: includeTags, modifier: "INCLUDES" };
  }
  if (excludeTags !== undefined) {
    input.tags = { value: excludeTags, modifier: "EXCLUDES" };
  }
  const releaseDate = cleanReleaseDate(query.releaseDate);
  if (releaseDate !== undefined) {
    const mapped = STASH_DATE_MODIFIERS[releaseDate.operation];
    input.date = {
      value: shiftIsoDate(releaseDate.cutoff, mapped.days),
      modifier: mapped.modifier,
    };
  }
  let sort: AppliedSort | undefined;
  if (query.sort !== undefined) {
    sort = resolveSort("stashdb", "scene", query.sort, query.direction);
    input.sort = sort.upstream;
    input.direction = sort.direction === "asc" ? "ASC" : "DESC";
  } else if (query.direction !== undefined) {
    throw new AppError(
      400,
      "invalid_search",
      "direction requires an explicit sort.",
    );
  }
  const res = (await stashQuery(
    "query($f: SceneQueryInput!) { queryScenes(input: $f) { count scenes { id title code details date duration images { url } urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted images { url } } } } } }",
    { f: input },
    "queryScenes",
  )) as { count?: unknown; scenes?: unknown } | null;
  if (res === null || typeof res !== "object" || !Array.isArray(res.scenes)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable scene listing.",
    );
  }
  const items = dedupeBy(
    res.scenes
      .slice(0, perPage * 2)
      .map((row) => stashSceneDetail(row, recordTagPair))
      .filter((d): d is CatalogDetail => d !== undefined),
    (d) => d.reference.id,
  );
  const rawCount: unknown = res.count;
  // StashDB counts are always real, zero included: an attested 0 is a known
  // empty result, never an unknown total.
  const totalReal =
    typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0;
  const result: CatalogSearchPage = {
    provider: "stashdb",
    kind: "scene",
    page,
    perPage,
    // StashDB counts are always real, so page*perPage < count is a true
    // continuation signal.
    hasMore: items.length > 0 && totalReal && page * perPage < rawCount,
    ...(totalReal ? { total: rawCount } : {}),
    totalCountKnown: totalReal,
    items,
  };
  return sort !== undefined ? { ...result, sort } : result;
}

/** Full provider detail for one catalog entity. Returns null only for an
 * authoritative provider-side absence (TPDB 404, StashDB data null); outages
 * and auth failures throw AppError with upstreamStatus set. */
export async function getCatalogDetail(
  reference: CatalogReference,
): Promise<CatalogDetail | null> {
  const provider = reference?.provider;
  const kind = reference?.kind;
  const id = reference?.id;
  if (provider !== "tpdb" && provider !== "stashdb") {
    throw new AppError(400, "invalid_reference", "Unknown catalog provider.");
  }
  if (!isUuid(id)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  }
  if (provider === "stashdb" && kind === "movie") {
    throw new AppError(
      400,
      "invalid_reference",
      "StashDB has no movie entity; movies are TPDB-only.",
    );
  }

  if (provider === "tpdb") {
    const path =
      kind === "movie"
        ? `/movies/${id}`
        : kind === "scene"
          ? `/scenes/${id}`
          : kind === "studio"
            ? `/sites/${id}`
            : `/performers/${id}`;
    let body: { data?: unknown };
    try {
      body = await tpdbGet<{ data?: unknown }>(path);
    } catch (err) {
      if (err instanceof AppError && err.upstreamStatus === 404) return null;
      throw err;
    }
    const detail =
      kind === "performer"
        ? tpdbPerformerDetail(body?.data)
        : kind === "movie"
          ? tpdbMediaDetail("movie", body?.data, recordTagPair)
          : kind === "scene"
            ? tpdbMediaDetail("scene", body?.data, recordTagPair)
            : tpdbStudioDetail(body?.data);
    // A record whose id differs from the requested one is unusable for this
    // reference even when individually well-formed.
    if (detail === undefined || detail.reference.id !== id) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable record.",
      );
    }
    return detail;
  }

  if (kind === "scene") {
    const row = await stashQuery(
      "query($id: ID!) { findScene(id: $id) { id title code details date duration images { url } urls { url type } studio { id name } tags { id name } performers { as performer { id name deleted aliases images { url } urls { url type } } } } }",
      { id },
      "findScene",
    );
    if (row === null) return null;
    const detail = stashSceneDetail(row, recordTagPair);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable scene record.",
      );
    }
    return detail;
  }
  if (kind === "performer") {
    const row = await stashQuery(
      "query($id: ID!) { findPerformer(id: $id) { id name deleted aliases urls { url type } images { url } gender birthdate { date accuracy } ethnicity country eye_color hair_color height cup_size band_size waist_size hip_size breast_type career_start_year career_end_year tattoos { location description } piercings { location description } } }",
      { id },
      "findPerformer",
    );
    if (row === null) return null;
    if ((row as { deleted?: unknown }).deleted === true) {
      return null; // deleted performers are authoritatively gone
    }
    const detail = stashPerformerDetail(row);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable performer record.",
      );
    }
    return detail;
  }
  if (kind === "studio") {
    const row = await stashQuery(
      "query($id: ID!) { findStudio(id: $id) { id name deleted urls { url type } images { url } parent { id name } child_studios { id } } }",
      { id },
      "findStudio",
    );
    if (
      typeof row === "object" &&
      row !== null &&
      "deleted" in row &&
      row.deleted === true
    ) {
      return null; // deleted studios are authoritatively gone
    }
    if (row === null) return null;
    const detail = stashStudioDetail(row);
    if (detail === undefined) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "StashDB returned an unusable studio record.",
      );
    }
    return detail;
  }
  throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
}

/** Tag lookup for filter pickers: provider-native {id, name} pairs for a
 * search term. TPDB /tags and StashDB searchTag; ids are never mapped across
 * providers. First page/limit only — enough to build a filter list. */
export async function searchCatalogTags(
  provider: CatalogProvider,
  term: string,
): Promise<{ id: string; name: string }[]> {
  const q = cleanQueryTerm(term);
  if (q === undefined) {
    throw new AppError(
      400,
      "invalid_search",
      "Tag lookup requires a search term.",
    );
  }
  if (provider === "tpdb") {
    const body = await tpdbGet<TpdbListBody>(
      `/tags${tpdbQuery({ q, per_page: MAX.tags })}`,
    );
    if (!Array.isArray(body?.data)) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable tag listing.",
      );
    }
    return tpdbTags(body.data);
  }
  const res = await stashQuery(
    "query($t: String!) { searchTag(term: $t, limit: 50) { id name } }",
    { t: q },
    "searchTag",
  );
  if (!Array.isArray(res)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable tag search.",
    );
  }
  const out: { id: string; name: string }[] = [];
  for (const row of res.slice(0, MAX.tags)) {
    if (row === null || typeof row !== "object") continue;
    const name = "name" in row ? cleanString(row.name, 120) : undefined;
    if ("id" in row && isUuid(row.id) && name !== undefined) {
      out.push({ id: row.id, name });
    }
  }
  return dedupeBy(out, (t) => t.id);
}

/** The provider's first tag page, no term — the candidate list the tag
 * suggestion judgment selects from. TPDB lists tags without a term;
 * StashDB's searchTag refuses an empty term on some key tiers, and that
 * upstream refusal propagates: suggestions degrade to absent, never to
 * fabricated ones. */
export async function listCatalogTags(
  provider: CatalogProvider,
): Promise<{ id: string; name: string }[]> {
  if (provider === "tpdb") {
    const body = await tpdbGet<TpdbListBody>(
      `/tags${tpdbQuery({ per_page: MAX.tags })}`,
    );
    if (!Array.isArray(body?.data)) {
      throw new AppError(
        502,
        "upstream_bad_response",
        "TPDB returned an unusable tag listing.",
      );
    }
    return tpdbTags(body.data);
  }
  const res = await stashQuery(
    'query { searchTag(term: "", limit: 50) { id name } }',
    {},
    "searchTag",
  );
  if (!Array.isArray(res)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "StashDB returned an unusable tag listing.",
    );
  }
  const out: { id: string; name: string }[] = [];
  for (const row of res.slice(0, MAX.tags)) {
    if (row === null || typeof row !== "object") continue;
    const name = "name" in row ? cleanString(row.name, 120) : undefined;
    if ("id" in row && isUuid(row.id) && name !== undefined) {
      out.push({ id: row.id, name });
    }
  }
  return dedupeBy(out, (t) => t.id);
}

/** Process-lifetime memo of computed performer auto-links, keyed by
 * provider:kind:id. Each miss costs a name search plus per-candidate detail
 * reads for a verdict that only changes when a provider republishes links,
 * so every reference is computed once per process. Cleared by
 * resetMetaCache so tests start cold. */
const counterpartMemo = new Map<
  string,
  { linked?: CatalogReference; unlinkedReason?: string } | null
>();

/** The other provider's performer record for one performer detail. The
 * explicit cross-provider URL on the record wins outright; otherwise a name
 * search on the other provider only *nominates* candidates — a candidate
 * merges only when its own record shares an identity-scoped third-party
 * profile link (identityLinkKey) with this one. Names never merge anything;
 * exactly one sharing candidate links, zero extends the explicit reason
 * honestly, and two or more is ambiguous and refused, never guessed.
 * Outage, not-configured, or bad payload returns the explicit reason
 * unchanged; this never throws. */
export async function linkedPerformerCounterpart(
  detail: CatalogDetail,
): Promise<{
  linked?: CatalogReference;
  unlinkedReason?: string;
}> {
  if (detail.reference.kind !== "performer") return crossProviderLink(detail);
  const explicit = crossProviderLink(detail);
  if (explicit.linked !== undefined) return explicit; // a direct pointer outranks link equality
  const memoKey = `${detail.reference.provider}:${detail.reference.kind}:${detail.reference.id}`;
  const memoed = counterpartMemo.get(memoKey);
  // null memo = no auto link: fall back to the explicit verdict.
  if (memoed !== undefined) return memoed ?? explicit;
  try {
    const mine = new Set(
      detail.links
        .map((l) => identityLinkKey(l.url))
        .filter((k): k is string => k !== undefined),
    );
    // With no identity-scoped link of our own, no candidate can ever share
    // one — skip the search and let the explicit reason stand.
    if (mine.size === 0) return explicit;
    const other: CatalogProvider =
      detail.reference.provider === "tpdb" ? "stashdb" : "tpdb";
    const otherName = other === "stashdb" ? "StashDB" : "TPDB";
    const search = await searchCatalog(
      other === "tpdb"
        ? {
            provider: "tpdb",
            kind: "performer",
            query: detail.title,
            perPage: 10,
          }
        : { provider: "stashdb", kind: "performer", query: detail.title },
    );
    // ponytail: 10-candidate cap — the first name-search page only nominates;
    // a wider net wants the provider's own paging plumbed through, not a
    // bigger slice here.
    const matches: CatalogDetail[] = [];
    for (const item of search.items.slice(0, 10)) {
      if (
        item.reference.provider === detail.reference.provider &&
        item.reference.id === detail.reference.id
      ) {
        continue; // the searched record itself, echoed back
      }
      // null covers deleted rows and missing ids: authoritatively gone.
      const candidate = await getCatalogDetail(item.reference);
      if (candidate === null) continue;
      if (
        candidate.links.some((l) => {
          const key = identityLinkKey(l.url);
          return key !== undefined && mine.has(key);
        })
      ) {
        matches.push(candidate);
      }
    }
    const result: { linked?: CatalogReference; unlinkedReason?: string } =
      matches.length === 1
        ? { linked: matches[0]!.reference }
        : matches.length === 0
          ? {
              unlinkedReason: `${explicit.unlinkedReason}; no shared profile link with any searched ${otherName} performer either`,
            }
          : {
              unlinkedReason: `${explicit.unlinkedReason}; ${matches.length} searched ${otherName} performers share profile links with this record — ambiguous, refusing to guess`,
            };
    counterpartMemo.set(memoKey, result);
    return result;
  } catch {
    // Outage/not-configured/bad payload: the explicit reason stands, and the
    // failure is not memoized so a later call can retry.
    return explicit;
  }
}

/** The other provider's studio row for one studio reference, resolved only
 * through provider-published cross-provider URLs — never name similarity.
 * StashDB → TPDB is a pure URL read off the cached studio detail. TPDB →
 * StashDB has no published reverse pointer (TPDB site rows carry no external
 * ids), so the raw site row's own uuid/short_name build candidate
 * `theporndb.net` URLs and StashDB's exact-URL studio search arbitrates: a
 * candidate wins only when exactly one studio's own `urls` contain it. The
 * live `sites/blacked` case matches two studios, so ambiguity is refused,
 * never guessed. Absence, ambiguity, outage, malformed payload — always
 * undefined; this never throws. */
export async function studioCounterpart(
  reference: CatalogReference,
): Promise<CatalogReference | undefined> {
  if (reference?.kind !== "studio") return undefined;
  try {
    if (reference.provider === "stashdb") {
      const detail = await getCatalogDetail(reference);
      return detail === null ? undefined : crossProviderLink(detail).linked;
    }
    // uuid and slug are the only id shapes the TPDB /sites/ path accepts;
    // anything else is a forged reference, not a lookup failure.
    if (!/^[0-9a-z][0-9a-z-]{0,63}$/i.test(reference.id)) return undefined;
    const body = await tpdbGet<{ data?: unknown }>(`/sites/${reference.id}`);
    const row = body?.data;
    if (row === null || typeof row !== "object") return undefined;
    const r = row as Record<string, unknown>;
    // tpdbStudioDetail keeps neither uuid-in-isolation nor short_name, and
    // one cached transport read serves both candidate URLs.
    const uuid = isUuid(r.uuid) ? r.uuid.toLowerCase() : undefined;
    const shortName = cleanString(r.short_name, 64);
    const candidates: string[] = [];
    if (uuid !== undefined) {
      candidates.push(`https://theporndb.net/studios/${uuid}`);
    }
    if (shortName !== undefined) {
      candidates.push(`https://theporndb.net/sites/${shortName.toLowerCase()}`);
    }
    for (const url of candidates) {
      const want = url.replace(/\/+$/, "").toLowerCase();
      const res = (await stashQuery(
        "query($url: String!) { queryStudios(input: { url: $url, page: 1, per_page: 5 }) { studios { id name urls { url } } } }",
        { url },
        "queryStudios",
      )) as { studios?: unknown } | null;
      const studios = Array.isArray(res?.studios) ? res.studios : [];
      const hits = studios.filter((s) => {
        if (s === null || typeof s !== "object") return false;
        if (!isUuid(s.id) || !Array.isArray(s.urls)) return false;
        return s.urls.some((u: unknown) => {
          if (u === null || typeof u !== "object" || !("url" in u)) {
            return false;
          }
          const link = u.url;
          return (
            typeof link === "string" &&
            link.replace(/\/+$/, "").toLowerCase() === want
          );
        });
      });
      const id = hits.length === 1 ? hits[0]?.id : undefined;
      if (isUuid(id)) {
        return { provider: "stashdb", kind: "studio", id: id.toLowerCase() };
      }
      // Zero hits or ambiguous hits: try the next candidate URL, never guess.
    }
    return undefined;
  } catch {
    return undefined; // outage/not-configured/bad payload degrade to absent
  }
}

/** A tag reference: provider plus native id, no `kind`. Tags are labels, not
 * entities — CatalogKind is for entities, and widening it would claim a
 * cross-provider identity a label does not have. */
export type TagReference = { provider: CatalogProvider; id: string };

/** The other provider's tag with an exactly-equal normalized name. Exact
 * name equality (after normalizeFacetName) is honest for tags because a tag
 * IS its name — a label with no deeper entity to be wrong about; it is the
 * one documented deterministic pairing that needs no published URL. It is
 * deliberately NOT used for studios or performers: those are entities whose
 * identity comes only from provider-published URLs, and equal names there
 * would be a guess. Absence or any upstream failure → undefined. */
export async function tagCounterpart(
  from: CatalogProvider,
  name: string,
): Promise<TagReference | undefined> {
  const target = normalizeFacetName(name);
  if (target === "") return undefined; // an empty label identifies nothing
  const other: CatalogProvider = from === "tpdb" ? "stashdb" : "tpdb";
  try {
    const rows = await searchCatalogTags(other, name);
    const row = rows.find((r) => normalizeFacetName(r.name) === target);
    return row === undefined ? undefined : { provider: other, id: row.id };
  } catch {
    return undefined; // a failed counterpart lookup degrades to absent
  }
}

/** Tag-label normalization lives in lib/contracts.ts (shared with storage
 * and UI); exact normalized-name equality pairs tags deterministically (a
 * tag is a label; its identity is the name) and is never applied to studios
 * or performers, which are entities paired only through provider-published
 * URLs. */
