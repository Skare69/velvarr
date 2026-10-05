// Whisparr integration. Reads (status, resolution, adoption, observation) are
// always allowed. Writes are exclusively the delivery add path and are gated
// on config.whisparr.delivery being present, enabled, and fully specified;
// a missing or disabled delivery is an explicit blocked condition, never a
// silent no-op. Every other mutation (commands, monitoring edits, scans,
// deletes) is out of scope and never issued.

import { AppError, requestJson } from "./http.ts";
import {
  looksWindows,
  mappedPrefix,
  pathComponents,
  samePathPrefix,
} from "./pathmap.ts";
import { isDeliverableMedia, UNDELIVERABLE_REASON } from "../lib/contracts.ts";
import type {
  AcquisitionProgress,
  IntegrationConfig,
  MediaKind,
  MediaReference,
} from "../lib/contracts.ts";

export interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
}

interface StatusDto {
  version?: unknown;
  appName?: unknown;
}

interface RootFolderDto {
  id?: unknown;
  path?: unknown;
}

interface QualityProfileDto {
  id?: unknown;
  name?: unknown;
}

export async function getWhisparrStatus(
  config: IntegrationConfig,
): Promise<WhisparrStatus> {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) {
    return { configured: false };
  }
  // All three reads are plain GETs against the v3 API with the key header;
  // any upstream failure rejects so routes can report a genuine outage.
  const [status, rootFolders, profiles] = await Promise.all([
    requestJson<StatusDto>(
      whisparr.url,
      "/api/v3/system/status",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<RootFolderDto[]>(
      whisparr.url,
      "/api/v3/rootfolder",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
    requestJson<QualityProfileDto[]>(
      whisparr.url,
      "/api/v3/qualityprofile",
      whisparr.apiKey,
      { service: "whisparr" },
    ),
  ]);
  return {
    configured: true,
    version:
      typeof status?.version === "string"
        ? status.version.slice(0, 64)
        : undefined,
    appName:
      typeof status?.appName === "string"
        ? status.appName.slice(0, 64)
        : undefined,
    rootFolders: (Array.isArray(rootFolders) ? rootFolders : [])
      .filter((r) => Number.isInteger(r?.id) && typeof r?.path === "string")
      .map((r) => ({ id: r.id as number, path: r.path as string })),
    profiles: (Array.isArray(profiles) ? profiles : [])
      .filter((p) => Number.isInteger(p?.id) && typeof p?.name === "string")
      .map((p) => ({ id: p.id as number, name: p.name as string })),
  };
}

// --- shared validation ---

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical external provider identity: lowercase dashed UUID. Accepts the
 * dashed or compact hex form so stored identities compare equal either way. */
function canonicalProviderId(value: unknown): string {
  const compact =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/-/g, "")
      : "";
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new AppError(400, "invalid_id", "Invalid provider id.");
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

interface WhisparrEndpoint {
  url: string;
  apiKey: string;
}

function requireWhisparr(config: IntegrationConfig): WhisparrEndpoint {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) {
    throw new AppError(400, "not_configured", "Whisparr is not configured.");
  }
  return { url: whisparr.url, apiKey: whisparr.apiKey };
}

export interface WhisparrDeliveryTarget {
  rootFolderPath: string;
  qualityProfileId: number;
  searchOnAdd: boolean;
}

/** Delivery gate: every write path funnels through here. Absent, disabled,
 * or incompletely specified delivery is a hard blocked condition. */
function requireDelivery(config: IntegrationConfig): WhisparrDeliveryTarget {
  const delivery = config?.whisparr?.delivery;
  const root = delivery?.rootFolderPath;
  if (
    !delivery ||
    delivery.enabled !== true ||
    typeof root !== "string" ||
    root.length < 1 ||
    root.length > 1024 ||
    root !== root.trim() ||
    /[\u0000-\u001f]/.test(root) ||
    !Number.isInteger(delivery.qualityProfileId) ||
    delivery.qualityProfileId <= 0
  ) {
    throw new AppError(
      409,
      "delivery_disabled",
      "Whisparr delivery is disabled or incomplete.",
    );
  }
  return {
    rootFolderPath: delivery.rootFolderPath,
    qualityProfileId: delivery.qualityProfileId,
    searchOnAdd: delivery.searchOnAdd === true,
  };
}

/** A MediaReference this module can work with: TPDB movies and StashDB
 * scenes only, with the provider and kind in their canonical pairing. */
function requireMediaReference(ref: MediaReference): {
  kind: MediaKind;
  id: string;
} {
  if (!ref || !isDeliverableMedia(ref)) {
    throw new AppError(400, "invalid_reference", UNDELIVERABLE_REASON);
  }
  return { kind: ref.kind, id: canonicalProviderId(ref.id) };
}

// --- upstream DTOs ---

interface MovieResourceDto {
  id?: unknown;
  /** Whisparr declares "movie" | "scene" | "studio" | "performer" on stored
   * resources; lookup results carry it too. Absent on some builds. */
  itemType?: unknown;
  title?: unknown;
  monitored?: unknown;
  hasFile?: unknown;
  movieFileId?: unknown;
  movieFile?: unknown;
  path?: unknown;
  foreignId?: unknown;
  tmdbId?: unknown;
  tpdbId?: unknown;
  stashId?: unknown;
  /** Lookup results only, when the build reveals it: the identity sits on
   * Whisparr's import-exclusion list. Absent means unknown, never false. */
  isExcluded?: unknown;
  statistics?: {
    movieFileCount?: unknown;
  } & Record<string, unknown>;
}

interface QueueRecordDto {
  movieId?: unknown;
  movie?: { id?: unknown };
  size?: unknown;
  sizeleft?: unknown;
  timeleft?: unknown;
}

interface QueuePageDto {
  records?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Queue-record numbers: Whisparr's size/sizeleft are C# decimals that may
 * serialize as JSON numbers or strings. Anything else is not a number. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Derive progress from a matched queue record. percent is null — never a
 * fake 0 — without a usable size; a fully downloaded record (sizeleft 0)
 * is 100, not null. */
function progressOf(r: QueueRecordDto): AcquisitionProgress {
  const size = asNumber(r.size);
  const sizeleft = asNumber(r.sizeleft);
  const usable =
    size !== null && size > 0 && sizeleft !== null && sizeleft >= 0;
  const percent = usable ? Math.round(((size - sizeleft) / size) * 100) : null;
  const timeleft = asString(r.timeleft)?.trim() ?? "";
  return {
    percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
    // ponytail: timeleft truncated at 32 chars — Whisparr emits "D.HH:MM:SS";
    // truncate rather than reject if upstream ever lengthens it.
    timeleft: timeleft === "" ? null : timeleft.slice(0, 32),
  };
}

/** Stored identity and kind of a Whisparr movie/scene resource, read from
 * the routing fields Whisparr itself keeps (declared ItemType cross-checked
 * against ForeignId shape, TpdbId, StashId). Cross-ids never participate: an
 * item routes to exactly one metadata source. */
function identityOf(
  dto: MovieResourceDto,
): { itemType: MediaKind; identity: string } | null {
  const tpdbId = asString(dto.tpdbId);
  const foreignId = asString(dto.foreignId)?.toLowerCase() ?? "";
  let itemType: MediaKind;
  let identity: string;
  if (tpdbId !== undefined || foreignId.startsWith("tpdbid:")) {
    itemType = "movie";
    identity = tpdbId ?? foreignId.slice("tpdbid:".length);
  } else {
    const stashId = asString(dto.stashId);
    if (stashId !== undefined) {
      itemType = "scene";
      identity = stashId;
    } else if (
      foreignId !== "" &&
      dto.tmdbId === 0 &&
      UUID_RE.test(foreignId)
    ) {
      // StashDB scenes are stored with a bare UUID ForeignId and no TmdbId.
      itemType = "scene";
      identity = foreignId;
    } else {
      return null;
    }
  }
  if (identity === "") return null;
  // A declared itemType counts only when it agrees with the routing shape.
  const declared = asString(dto.itemType)?.toLowerCase();
  if ((declared === "movie" || declared === "scene") && declared !== itemType) {
    return null;
  }
  return { itemType, identity };
}

// --- resolution (lookup) ---

interface WhisparrResolved {
  itemType: MediaKind;
  /** The exact provider UUID that was requested, verified against the
   * upstream response. Never a wrapper id. */
  identity: string;
  title: string;
  /** True only when the lookup response itself reveals an import
   * exclusion; absent means the API did not say. */
  importExcluded?: boolean;
}

function asMovieResources(dto: unknown): MovieResourceDto[] {
  if (Array.isArray(dto)) return dto as MovieResourceDto[];
  if (dto && typeof dto === "object") return [dto as MovieResourceDto];
  return [];
}

/** Path-correspondence matches for one Jellyfin item across the already
 *  fetched Whisparr resources: zero matches → [], one → [that reference],
 *  several distinct → all of them (the caller decides ambiguity policy). */
function matchesByPaths(
  dtos: MovieResourceDto[],
  whisparr: NonNullable<IntegrationConfig["whisparr"]>,
  jellyfinPaths: string[],
): MediaReference[] {
  const distinct = new Map<string, MediaReference>();
  for (const dto of dtos) {
    const routed = identityOf(dto);
    const path = asString(dto.path)?.trim() ?? "";
    if (routed === null || path === "") continue;
    const mapped = mappedPrefix(path, whisparr.pathMappings);
    const matches = jellyfinPaths.some((jp) =>
      samePathPrefix(
        mapped.comps,
        pathComponents(jp),
        mapped.fold || looksWindows(jp),
      ),
    );
    if (!matches) continue;
    const provider = routed.itemType === "movie" ? "tpdb" : "stashdb";
    const key = `${provider}:${routed.itemType}:${routed.identity.toLowerCase()}`;
    distinct.set(key, {
      provider,
      kind: routed.itemType,
      id: routed.identity,
    });
  }
  return [...distinct.values()];
}

/** Resolve a Jellyfin item's file paths to its Whisparr identity via
 * configured path mappings (path correspondence only — never title/name
 * matching). Zero matches → null (also when Whisparr is unconfigured or
 * the item has no paths); exactly one distinct identity → that
 * MediaReference; more than one distinct identity → throws
 * ambiguous_identity (the route turns it into catalogNote). */
export async function findWhisparrItemByPath(
  config: IntegrationConfig,
  jellyfinPaths: string[],
): Promise<MediaReference | null> {
  if (jellyfinPaths.length === 0) return null;
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) return null;
  const dtos = asMovieResources(
    await requestJson<unknown>(whisparr.url, "/api/v3/movie", whisparr.apiKey, {
      service: "whisparr",
    }),
  );
  const matches = matchesByPaths(dtos, whisparr, jellyfinPaths);
  if (matches.length > 1) {
    throw new AppError(
      409,
      "ambiguous_identity",
      "Multiple Whisparr items match this item's path.",
    );
  }
  return matches[0] ?? null;
}

// --- movie-list cache for list enrichment ---

// ponytail: in-memory, 30 s TTL, 4-server FIFO cap; a persisted index only
// if one fetch per window still hurts.
const MOVIE_LIST_TTL_MS = 30_000;
const MOVIE_LIST_CACHE_MAX = 4;
// Keyed by Whisparr base URL. Entries hold the in-flight promise: the
// prefetch that overlaps the Jellyfin read and the enrichment that follows
// it share one fetch instead of two.
const movieListCache = new Map<
  string,
  { at: number; dtos: Promise<MovieResourceDto[]> }
>();

/** Test seam: tests that script a changed movie list reset between phases so
 * a cached read never masks the scripted change. */
export function resetWhisparrMovieListCache(): void {
  movieListCache.clear();
}

function cachedMovieList(
  whisparr: NonNullable<IntegrationConfig["whisparr"]>,
): Promise<MovieResourceDto[]> {
  const hit = movieListCache.get(whisparr.url);
  if (hit !== undefined && Date.now() - hit.at < MOVIE_LIST_TTL_MS) {
    return hit.dtos;
  }
  const at = Date.now();
  const dtos = requestJson<unknown>(
    whisparr.url,
    "/api/v3/movie",
    whisparr.apiKey,
    { service: "whisparr" },
  ).then(asMovieResources);
  movieListCache.delete(whisparr.url);
  movieListCache.set(whisparr.url, { at, dtos });
  if (movieListCache.size > MOVIE_LIST_CACHE_MAX) {
    const oldest = movieListCache.keys().next().value;
    if (oldest !== undefined) movieListCache.delete(oldest);
  }
  // A rejected fetch removes only its own entry — a concurrent replacement
  // stays — and is never served to a later lookup. The handler also keeps
  // the rejection handled for callers that never await this promise.
  void dtos.catch(() => {
    const current = movieListCache.get(whisparr.url);
    if (current !== undefined && current.dtos === dtos) {
      movieListCache.delete(whisparr.url);
    }
  });
  return dtos;
}

/** Warm the movie-list cache without awaiting it. Library pages and the
 * Discover shelf call this before their Jellyfin fetch, so the /api/v3/movie
 * read overlaps Jellyfin instead of trailing it; a slow or down Whisparr is
 * bounded by the enrichment ceiling in jellyfin.ts, never by this call. */
export function prefetchWhisparrMovieList(config: IntegrationConfig): void {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) return;
  void cachedMovieList(whisparr);
}

/** One Whisparr sweep for a whole list of Jellyfin items: a single
 * /api/v3/movie fetch (cached per URL, see cachedMovieList) resolves every
 * entry's identity via path correspondence. Unconfigured Whisparr or no
 * usable paths → empty map without any upstream call. An entry with zero or
 * several distinct matches is simply absent — the caller keeps its own
 * label, and a single ambiguous entry never sinks the batch. Upstream
 * failures propagate. */
export async function resolveIdentitiesByPath(
  config: IntegrationConfig,
  entries: { id: string; paths: string[] }[],
): Promise<Map<string, MediaReference>> {
  const whisparr = config?.whisparr;
  if (!whisparr?.url || !whisparr.apiKey) return new Map();
  const usable = entries.filter((e) => e.paths.length > 0);
  if (usable.length === 0) return new Map();
  const dtos = await cachedMovieList(whisparr);
  const resolved = new Map<string, MediaReference>();
  for (const entry of usable) {
    const matches = matchesByPaths(dtos, whisparr, entry.paths);
    if (matches.length === 1) resolved.set(entry.id, matches[0]!);
  }
  return resolved;
}

/** Prove the upstream returned exactly the requested kind and identity.
 * A mismatch is a hard error, never a best-effort guess. */
function assertResolved(
  dtos: MovieResourceDto[],
  kind: MediaKind,
  id: string,
): MovieResourceDto {
  const matches = dtos.filter((dto) => {
    const routed = identityOf(dto);
    return (
      routed !== null &&
      routed.itemType === kind &&
      routed.identity.toLowerCase() === id
    );
  });
  if (matches.length !== 1) {
    throw new AppError(
      502,
      "identity_mismatch",
      "Whisparr did not resolve the requested identity.",
    );
  }
  return matches[0]!;
}

/** Resolve a MediaReference to a Whisparr-resolvable item without mutating
 * anything. TPDB movies use the typed tpdbId lookup; StashDB scenes use the
 * term lookup with the stash: prefix. The scene-wrapper lookup path is not
 * used, so wrapper ids can never leak in as stored item ids. */
export async function resolveWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrResolved> {
  const whisparr = requireWhisparr(config);
  const { kind, id } = requireMediaReference(ref);
  const dto =
    kind === "movie"
      ? await requestJson<unknown>(
          whisparr.url,
          `/api/v3/movie/lookup/tpdb?tpdbId=${encodeURIComponent(id)}`,
          whisparr.apiKey,
          { service: "whisparr" },
        )
      : await requestJson<unknown>(
          whisparr.url,
          `/api/v3/movie/lookup?term=${encodeURIComponent(`stash:${id}`)}`,
          whisparr.apiKey,
          { service: "whisparr" },
        );
  const match = assertResolved(asMovieResources(dto), kind, id);
  const title = asString(match.title)?.trim();
  if (!title) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr resolved the identity without a usable title.",
    );
  }
  return {
    itemType: kind,
    identity: id,
    title,
    ...(match.isExcluded === true ? { importExcluded: true } : {}),
  };
}

// --- stored payload construction ---

/** Server-owned POST /api/v3/movie body. Nothing is spread from lookup
 * responses; routing fields carry exactly one metadata source. */
interface WhisparrMoviePayload {
  title: string;
  foreignId: string;
  tmdbId: 0;
  tpdbId?: string;
  rootFolderPath: string;
  qualityProfileId: number;
  monitored: true;
  addOptions: { searchForMovie: boolean; addMethod: "Manual" };
}

/** Build the validated add payload. `title` must come from a verified lookup,
 * never from browser input. TPDB movies route via ForeignId prefix plus
 * TpdbId (TmdbId 0); StashDB scenes carry a bare UUID ForeignId with no
 * TpdbId, so GetMetadata falls through to GetSceneInfo(ForeignId). */
export function buildMoviePayload(
  ref: MediaReference,
  title: string,
  delivery: WhisparrDeliveryTarget,
): WhisparrMoviePayload {
  const { kind, id } = requireMediaReference(ref);
  const cleanTitle =
    typeof title === "string" ? title.trim().slice(0, 300) : "";
  if (!cleanTitle) {
    throw new AppError(400, "invalid_title", "A title is required to add.");
  }
  return {
    title: cleanTitle,
    foreignId: kind === "movie" ? `tpdbId:${id}` : id,
    tmdbId: 0,
    ...(kind === "movie" ? { tpdbId: id } : {}),
    rootFolderPath: delivery.rootFolderPath,
    qualityProfileId: delivery.qualityProfileId,
    monitored: true,
    addOptions: {
      searchForMovie: delivery.searchOnAdd,
      addMethod: "Manual",
    },
  };
}

// --- adoption and reconciliation ---

export interface WhisparrItem {
  /** Stored Whisparr item id. Only ever taken from a stored resource, never
   * from a lookup wrapper. */
  whisparrId: number;
  itemType: MediaKind;
  identity: string;
  title?: string;
  monitored: boolean;
  /** Stored library path; Jellyfin matching maps this through pathMappings. */
  path: string;
  hasFile: boolean;
}

function mapStoredItem(dto: MovieResourceDto): WhisparrItem {
  const routed = identityOf(dto);
  const id = dto.id;
  const path = asString(dto.path);
  if (
    routed === null ||
    !Number.isInteger(id) ||
    (id as number) <= 0 ||
    !path
  ) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr returned an unusable stored item.",
    );
  }
  const imported =
    dto.hasFile === true ||
    (typeof dto.movieFileId === "number" && dto.movieFileId > 0) ||
    dto.movieFile != null ||
    (typeof dto.statistics?.movieFileCount === "number" &&
      dto.statistics.movieFileCount > 0);
  return {
    whisparrId: id as number,
    itemType: routed.itemType,
    identity: canonicalProviderId(routed.identity),
    title: asString(dto.title)?.trim(),
    monitored: dto.monitored === true,
    path,
    hasFile: imported,
  };
}

/** Exact-identity stored-resource lookup: GET /api/v3/movie?tpdbId=|stashId=.
 * Returns the stored item, or null when the identity is provably absent.
 * Conflicting matches are a hard error. */
export async function findWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrItem | null> {
  const whisparr = requireWhisparr(config);
  const { kind, id } = requireMediaReference(ref);
  const field = kind === "movie" ? "tpdbId" : "stashId";
  const rows = await requestJson<unknown>(
    whisparr.url,
    `/api/v3/movie?${field}=${encodeURIComponent(id)}`,
    whisparr.apiKey,
    { service: "whisparr" },
  );
  if (!Array.isArray(rows)) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "Whisparr returned an unexpected stored-item listing.",
    );
  }
  const matches = (rows as MovieResourceDto[]).filter((dto) => {
    const routed = identityOf(dto);
    return (
      routed !== null &&
      routed.itemType === kind &&
      routed.identity.toLowerCase() === id
    );
  });
  if (matches.length > 1) {
    throw new AppError(
      502,
      "identity_mismatch",
      "Whisparr returned conflicting items for the requested identity.",
    );
  }
  const [match] = matches;
  return match === undefined ? null : mapStoredItem(match);
}

// --- observation ---

export type WhisparrObservation =
  | {
      found: true;
      /** monitoring: tracked, nothing grabbed/imported yet — not a failure.
       * downloading: tracked and present in the Whisparr queue.
       * imported: a file is on disk (hasFile/movieFileId/movieFile/
       * statistics). Never derived from isAvailable or the release-status
       * enum: both were observed unrelated to download state. */
      state: "monitoring" | "downloading" | "imported";
      item: WhisparrItem;
      /** Present only while downloading; absent otherwise. */
      progress?: AcquisitionProgress;
    }
  | { found: false };

/** Map a stored item to a persistable observation. Downloading is only
 * claimed when the item appears in the queue; a failed or unrecognized queue
 * read falls back to monitoring rather than inventing a failure. Upstream
 * outages on the identity read itself propagate as AppError so the workflow
 * records a failed check without touching recorded state. */
export async function observeWhisparrItem(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrObservation> {
  const item = await findWhisparrItem(config, ref);
  if (item === null) return { found: false };
  if (item.hasFile) return { found: true, state: "imported", item };
  const whisparr = requireWhisparr(config);
  let records: QueueRecordDto[] = [];
  try {
    const queue = await requestJson<QueuePageDto>(
      whisparr.url,
      "/api/v3/queue?page=1&pageSize=200",
      whisparr.apiKey,
      { service: "whisparr" },
    );
    if (Array.isArray(queue?.records))
      records = queue.records as QueueRecordDto[];
  } catch {
    records = [];
  }
  // First queue page only (pageSize=200): a known ceiling — a record that
  // scrolled past it reads as monitoring until the next recheck.
  const matched = records.find(
    (r) =>
      r.movieId === item.whisparrId ||
      (r.movie && r.movie.id) === item.whisparrId,
  );
  if (matched) {
    return {
      found: true,
      state: "downloading",
      item,
      progress: progressOf(matched),
    };
  }
  return { found: true, state: "monitoring", item };
}

// --- delivery ---

export type WhisparrDeliveryResult =
  | { outcome: "adopted"; item: WhisparrItem }
  | { outcome: "accepted"; item: WhisparrItem }
  | { outcome: "failed"; reason: string }
  | { outcome: "uncertain"; reason: string };

async function resolveAfterSubmission(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrItem | null | "unknown"> {
  try {
    return await findWhisparrItem(config, ref);
  } catch (err) {
    // A proven 404 is authoritative absence; anything else leaves the
    // submission outcome unknown.
    if (err instanceof AppError && err.upstreamStatus === 404) return null;
    return "unknown";
  }
}

/** Deliver a media reference to Whisparr. Adoption first: an existing exact
 * identity is adopted, never re-added. Adds are the module's only writes and
 * require an enabled, fully specified delivery. After any nontrivial
 * submission outcome the decision is made by an exact-identity re-read, not
 * by guessing from status codes. */
export async function deliverToWhisparr(
  config: IntegrationConfig,
  ref: MediaReference,
): Promise<WhisparrDeliveryResult> {
  const whisparr = requireWhisparr(config);
  const { id } = requireMediaReference(ref);
  // Explicit blocked condition — throws AppError delivery_disabled.
  const delivery = requireDelivery(config);

  const existing = await findWhisparrItem(config, ref);
  if (existing !== null) return { outcome: "adopted", item: existing };

  // Verify the identity is upstream-resolvable and take the title from the
  // verified lookup only.
  const resolved = await resolveWhisparrItem(config, ref);
  if (resolved.importExcluded === true) {
    // The lookup itself revealed the exclusion — a doomed add is skipped so
    // the blocked delivery explains itself instead of surfacing a generic
    // upstream rejection.
    return {
      outcome: "failed",
      reason: "Whisparr reports this identity as import-excluded.",
    };
  }
  const payload = buildMoviePayload(ref, resolved.title, delivery);

  let created: unknown;
  try {
    created = await requestJson<unknown>(
      whisparr.url,
      "/api/v3/movie",
      whisparr.apiKey,
      { service: "whisparr", method: "POST", body: payload },
    );
  } catch (err) {
    const proven = err instanceof AppError ? err.upstreamStatus : undefined;
    if (proven !== undefined && proven >= 400 && proven < 500) {
      // Proven client-side rejection: never inferred as already-exists.
      // A positive exact-identity re-read is proof of adoption; a proven 404
      // is proof of absence.
      const again = await resolveAfterSubmission(config, ref);
      return again !== null && again !== "unknown"
        ? { outcome: "adopted", item: again }
        : { outcome: "failed", reason: "Whisparr rejected the add." };
    }
    // Timeout / 5xx / network: submission outcome unknown — re-resolve.
    const again = await resolveAfterSubmission(config, ref);
    if (again !== "unknown" && again !== null) {
      return { outcome: "accepted", item: again };
    }
    if (again === null) {
      return { outcome: "failed", reason: "Whisparr did not accept the add." };
    }
    return {
      outcome: "uncertain",
      reason: "Whisparr did not confirm the add outcome.",
    };
  }

  // 2xx: accept only a well-formed stored echo carrying the exact identity;
  // anything else falls back to the exact-identity re-read.
  const dto = created as MovieResourceDto;
  const routed = dto && typeof dto === "object" ? identityOf(dto) : null;
  const echoedId = dto?.id;
  if (
    routed !== null &&
    routed.itemType === ref.kind &&
    canonicalProviderId(routed.identity) === id &&
    Number.isInteger(echoedId) &&
    (echoedId as number) > 0
  ) {
    return { outcome: "accepted", item: mapStoredItem(dto) };
  }
  const again = await resolveAfterSubmission(config, ref);
  if (again !== "unknown" && again !== null) {
    return { outcome: "accepted", item: again };
  }
  return {
    outcome: "uncertain",
    reason: "Whisparr accepted the add but did not confirm the stored item.",
  };
}
