// Moved verbatim from route.ts (v0.24.1) — pure move, no logic edits.
import {
  readJson,
  fieldText,
  fieldUrl,
  fieldBool,
  fieldRole,
  fieldIds,
  optionalText,
  requireId,
  optionalBool,
  queryInt,
  parseCatalogProvider,
  parseCatalogKind,
  parseCatalogReference,
  isMediaReference,
  parseMediaReference,
  sameMedia,
  PROVIDER_UUID,
  type CatalogSearchParams,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import { createHash } from "node:crypto";
import type {
  Account,
  AdminAccount,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
  ExternalUser,
  IntegrationConfig,
  Library,
  LibraryItem,
  MediaKind,
  MediaReference,
  ProviderStatus,
  RequestListItem,
  RequestRecord,
  Role,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../../../../lib/contracts.ts";
import {
  isDeliverableMedia,
  isRemovalLevel,
  normalizeFacetName,
  UNDELIVERABLE_REASON,
} from "../../../../lib/contracts.ts";
import {
  approveRemovalRequest,
  bootstrap,
  cancelRemovalRequest,
  cancelRequest,
  countRequestsByAccount,
  createRemovalRequest,
  createRequest,
  createSession,
  decideRequest,
  declineRemovalRequest,
  followPerformer,
  getAcquisitionByReference,
  getAccount,
  getConfig,
  getContentPreferences,
  getSession,
  hasAuthoritativeAbsence,
  importAccounts,
  isInitialized,
  isObservationStale,
  listAccounts,
  listFollows,
  listFollowsByProvider,
  listRequests,
  listRemovalRequests,
  revokeSession,
  saveConfig,
  saveContentPreferences,
  linkFollows,
  unfollowPerformer,
  updateAccount,
  upsertCatalogRecord,
} from "../../../../server/storage.ts";
import {
  consumeLoginAttempt,
  guardMutation,
  readSessionToken,
  sessionCookie,
  isSecureRequest,
  verifySetupSecret,
} from "../../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../../server/http.ts";
import {
  authenticate,
  getLibraryImage,
  getLibraryItem,
  getServer,
  getUserImage,
  listLibraries,
  listLibraryItems,
  listRecentlyAddedItems,
  listUsers,
  resolvePlaybackAccess,
  validateUser,
  getJellyfinStatus,
} from "../../../../server/jellyfin.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  isProviderImageUrl,
  listCatalogTags,
  searchCatalog,
  searchCatalogTags,
  studioCounterpart,
  tagCounterpart,
  type CatalogSearchQuery,
  type CatalogSortDirection,
  type CatalogSortKey,
  type ReleaseDateOperation,
} from "../../../../server/providers.ts";
import { suggestTags } from "../../../../server/judgment.ts";
import {
  findWhisparrItem,
  getWhisparrStatus,
} from "../../../../server/whisparr.ts";
import {
  browseTitles,
  isHiddenTitle,
  parseBrowseQuery,
  searchBrowseTags,
  searchVisibleCatalog,
  type BrowsePage,
  type SourceError,
} from "../../../../server/browse.ts";
import {
  relatedPerformers,
  relatedTitles,
} from "../../../../server/related.ts";

export function isTpdbDateOperation(v: string): v is ReleaseDateOperation {
  return ["<", "<=", "=", ">", ">="].includes(v);
}

// Runtime check, never a cast: the vocabulary mirrors providers'
// CatalogSortKey so an unknown sort is the route's explicit 400.
export function isCatalogSortKey(v: string): v is CatalogSortKey {
  switch (v) {
    case "relevance":
    case "recency":
    case "duration":
    case "title":
    case "date":
    case "created":
    case "updated":
    case "trending":
    case "popularity":
      return true;
    default:
      return false;
  }
}

// Tag lists arrive repeatable (?tags=a&tags=b) or comma-separated
// (?tags=a,b). Ids stay provider-native; only shape is validated here —
// uuid-ness and provider acceptance stay the provider's explicit errors.
export function tagList(
  params: URLSearchParams,
  key: string,
): string[] | undefined {
  const ids = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (ids.length === 0) return undefined;
  if (ids.some((id) => id.length > 64)) {
    throw new AppError(400, "invalid_query", `Invalid ${key} filter id.`);
  }
  if (ids.length > 25) {
    throw new AppError(400, "invalid_query", `Too many ${key} ids.`);
  }
  return [...new Set(ids)];
}

// Sorts each provider+kind genuinely implements, mirroring resolveSort in
// providers.ts so an unsupported order is rejected here with the route's
// invalid_query error before any upstream call.
export const SORT_SUPPORT: Partial<
  Record<
    CatalogProvider,
    Partial<Record<CatalogKind, readonly CatalogSortKey[]>>
  >
> = {
  tpdb: {
    movie: ["relevance", "recency", "duration"],
    scene: ["relevance", "recency", "duration"],
  },
  stashdb: {
    scene: [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ],
  },
};

export function supportedSort(
  provider: CatalogProvider,
  kind: CatalogKind,
  sort: CatalogSortKey | undefined,
  direction: CatalogSortDirection | undefined,
): { sort?: CatalogSortKey; direction?: CatalogSortDirection } {
  if (sort === undefined) {
    if (direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        "direction requires an explicit sort.",
      );
    }
    return {};
  }
  const supported = SORT_SUPPORT[provider]?.[kind];
  if (supported === undefined || !supported.includes(sort)) {
    throw new AppError(
      400,
      "invalid_query",
      `No ${sort} order for ${provider} ${kind} search.`,
    );
  }
  return direction !== undefined ? { sort, direction } : { sort };
}

export function catalogSearchParams(
  url: URL,
  params: URLSearchParams,
): CatalogSearchParams {
  const q = params.get("q");
  if (q !== null && (q.length === 0 || q.length > 200))
    throw new AppError(400, "invalid_query", "Invalid q.");
  const yearRaw = params.get("year");
  if (
    yearRaw !== null &&
    (!/^\d{4}$/.test(yearRaw) ||
      Number(yearRaw) < 1870 ||
      Number(yearRaw) > 2100)
  ) {
    throw new AppError(400, "invalid_query", "Invalid year.");
  }
  const dateRaw = params.get("date");
  if (dateRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw))
    throw new AppError(400, "invalid_query", "Invalid date.");
  const dateOperationRaw = params.get("date_operation");
  if (dateOperationRaw !== null && !isTpdbDateOperation(dateOperationRaw))
    throw new AppError(400, "invalid_query", "Invalid date_operation.");
  // Upstream `date` alone is an exact-match filter: the pair is meaningful
  // only together, so a lone half is an explicit 400, never a dropped bound.
  if ((dateRaw === null) !== (dateOperationRaw === null))
    throw new AppError(
      400,
      "invalid_query",
      "date and date_operation must be provided together.",
    );
  const performer = params.get("performer");
  if (performer !== null && (performer === "" || performer.length > 128))
    throw new AppError(400, "invalid_query", "Invalid performer.");
  const studio = params.get("studio");
  if (studio !== null && (studio === "" || studio.length > 64))
    throw new AppError(400, "invalid_query", "Invalid studio filter.");
  const sortRaw = params.get("sort");
  let sort: CatalogSortKey | undefined;
  if (sortRaw !== null) {
    if (!isCatalogSortKey(sortRaw)) {
      throw new AppError(400, "invalid_query", "Unknown sort.");
    }
    sort = sortRaw;
  }
  const directionRaw = params.get("direction");
  let direction: CatalogSortDirection | undefined;
  if (directionRaw !== null) {
    if (directionRaw !== "asc" && directionRaw !== "desc") {
      throw new AppError(
        400,
        "invalid_query",
        "direction must be asc or desc.",
      );
    }
    direction = directionRaw;
  }
  const studioModeRaw = params.get("studioMode");
  let studioMode: "exact" | "withChildren" | undefined;
  if (studioModeRaw !== null) {
    if (studioModeRaw !== "exact" && studioModeRaw !== "withChildren") {
      throw new AppError(
        400,
        "invalid_query",
        "studioMode must be exact or withChildren.",
      );
    }
    studioMode = studioModeRaw;
  }
  return {
    q,
    year: yearRaw !== null ? Number(yearRaw) : undefined,
    performer,
    studio,
    studioMode,
    date: dateRaw,
    dateOperation: dateOperationRaw,
    tags: tagList(params, "tags"),
    tagsAll: tagList(params, "tagsAll"),
    tagsExclude: tagList(params, "tagsExclude"),
    sort,
    direction,
    page: params.has("page") ? queryInt(url, "page", 1, 1, 10000) : 1,
    perPage: params.has("perPage") ? queryInt(url, "perPage", 24, 1, 100) : 24,
  };
}

// Builds the providers CatalogSearchQuery union from the query string. One
// builder per provider so each provider+kind pair constructs exactly its
// own valid union variant.
export function catalogSearchQuery(url: URL): CatalogSearchQuery {
  const params = url.searchParams;
  const provider = parseCatalogProvider(params.get("provider"));
  const kindRaw = params.get("kind");
  if (kindRaw === null)
    throw new AppError(400, "invalid_query", "kind is required.");
  if (provider === "stashdb") {
    // The overload types stashdb kinds as "scene" | "performer" | "studio":
    // StashDB has no movie entity, and parseCatalogKind already rejects
    // movie here with an explicit 400.
    return stashdbSearchQuery(params, parseCatalogKind(provider, kindRaw), url);
  }
  return tpdbSearchQuery(params, parseCatalogKind(provider, kindRaw), url);
}

// StashDB: unpaged performer and studio searches (query only) and scene
// search with optional query/performer/studio/tag filters; year and tagsAll
// are not supported.
export function stashdbSearchQuery(
  params: URLSearchParams,
  kind: "scene" | "performer" | "studio",
  url: URL,
): CatalogSearchQuery {
  const s = catalogSearchParams(url, params);
  if (s.tagsAll !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "tagsAll is a TPDB-only filter; StashDB scenes expose tags and tagsExclude.",
    );
  }
  if (s.tags !== undefined && s.tagsExclude !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "StashDB exposes one tag criterion per query; combine include and exclude lists client-side.",
    );
  }
  if (s.studioMode !== undefined) {
    if (kind !== "scene") {
      throw new AppError(
        400,
        "invalid_query",
        `studioMode applies only to StashDB scene search, not ${kind}.`,
      );
    }
    if (s.studio === null) {
      throw new AppError(
        400,
        "invalid_query",
        "studioMode requires a studio filter.",
      );
    }
  }
  if (kind !== "scene") {
    if (s.q === null) {
      throw new AppError(400, "invalid_query", `${kind} search requires q.`);
    }
    if (
      s.performer !== null ||
      s.studio !== null ||
      s.tags !== undefined ||
      s.tagsExclude !== undefined ||
      s.date !== null ||
      s.dateOperation !== null
    ) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search supports only a query term.`,
      );
    }
    if (s.sort !== undefined || s.direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search supports no sort.`,
      );
    }
    if (params.has("page") || params.has("perPage")) {
      throw new AppError(
        400,
        "invalid_query",
        `StashDB ${kind} search is not paged.`,
      );
    }
    return { provider: "stashdb", kind, query: s.q };
  }
  if (s.year !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "StashDB scene search does not support year.",
    );
  }
  if (s.date !== null || s.dateOperation !== null) {
    throw new AppError(
      400,
      "invalid_query",
      "date/date_operation is a TPDB-only filter; StashDB scenes filter dates through their own criterion with modifiers, which is not emulated here.",
    );
  }
  return {
    provider: "stashdb",
    kind,
    ...(s.q !== null ? { query: s.q } : {}),
    ...(s.performer !== null ? { performer: s.performer } : {}),
    ...(s.studio !== null
      ? { studio: s.studio, studioMode: s.studioMode ?? "exact" }
      : {}),
    ...(s.tags !== undefined ? { tags: s.tags } : {}),
    ...(s.tagsExclude !== undefined ? { tagsExclude: s.tagsExclude } : {}),
    ...supportedSort("stashdb", kind, s.sort, s.direction),
    page: s.page,
    perPage: s.perPage,
  };
}

// TPDB hosts movies, scenes, performers, and studios (sites); performer and
// studio searches require q and take no other filters. studioMode is a
// StashDB-only criterion; TPDB has no parent-studio equivalent to emulate.
export function tpdbSearchQuery(
  params: URLSearchParams,
  kind: CatalogKind,
  url: URL,
): CatalogSearchQuery {
  const s = catalogSearchParams(url, params);
  if (s.studioMode !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "studioMode is a StashDB-only filter; TPDB has no parent-studio criterion.",
    );
  }
  if (s.tagsExclude !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "tagsExclude is a StashDB-only filter; TPDB exposes tags and tagsAll.",
    );
  }
  if (s.tags !== undefined && s.tagsAll !== undefined) {
    throw new AppError(
      400,
      "invalid_query",
      "Choose either tags (any-of) or tagsAll (all-of); TPDB exposes one tag criterion per query.",
    );
  }
  if (kind === "performer" || kind === "studio") {
    if (s.q === null) {
      throw new AppError(400, "invalid_query", `${kind} search requires q.`);
    }
    if (
      s.performer !== null ||
      s.year !== undefined ||
      s.studio !== null ||
      s.tags !== undefined ||
      s.tagsAll !== undefined ||
      s.date !== null ||
      s.dateOperation !== null
    ) {
      throw new AppError(
        400,
        "invalid_query",
        `TPDB ${kind} search supports only query, page, and perPage.`,
      );
    }
    if (s.sort !== undefined || s.direction !== undefined) {
      throw new AppError(
        400,
        "invalid_query",
        `TPDB ${kind} search supports no sort.`,
      );
    }
    return {
      provider: "tpdb",
      kind,
      query: s.q,
      page: s.page,
      perPage: s.perPage,
    };
  }
  const filters = {
    ...(s.q !== null ? { query: s.q } : {}),
    ...(s.year !== undefined ? { year: s.year } : {}),
    ...(s.date !== null && s.dateOperation !== null
      ? { releaseDate: { cutoff: s.date, operation: s.dateOperation } }
      : {}),
    ...(s.performer !== null ? { performer: s.performer } : {}),
    ...(s.studio !== null ? { studio: s.studio } : {}),
    ...(s.tags !== undefined ? { tags: s.tags } : {}),
    ...(s.tagsAll !== undefined ? { tagsAll: s.tagsAll } : {}),
    ...supportedSort("tpdb", kind, s.sort, s.direction),
  };
  // Each kind gets exactly its own union variant; the wide literal that used
  // to sit here is what broke when CatalogKind gained "studio".
  if (kind === "movie") {
    return {
      provider: "tpdb",
      kind,
      ...filters,
      page: s.page,
      perPage: s.perPage,
    };
  }
  return {
    provider: "tpdb",
    kind,
    ...filters,
    page: s.page,
    perPage: s.perPage,
  };
}

export async function catalogSearch(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const query = catalogSearchQuery(new URL(request.url));
  // Media results honor the caller's hidden tags through the shared browse
  // filter; performer and studio searches stay raw — a hidden tag removes
  // titles from discovery, never the people and studios themselves.
  // Pass-through page: total/totalCountKnown report exactly what the
  // provider attests (a capped TPDB total surfaces as totalCountKnown:
  // false), and an outage propagates as an error, never an empty page.
  return json(
    query.kind === "movie" || query.kind === "scene"
      ? await searchVisibleCatalog(
          query,
          getContentPreferences(ctx.account.id).hiddenTags,
        )
      : await searchCatalog(query),
  );
}

// The one user-visible catalog surface. The caller's hidden tags ride every
// query, and hiddenTagCount lets the UI show the personal filter state
// without a second request. Preference is a filter, not authorization.
export async function browseRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const hiddenTags = getContentPreferences(ctx.account.id).hiddenTags;
  const page = await browseTitles(
    parseBrowseQuery(new URL(request.url).searchParams),
    hiddenTags,
  );
  return json({ ...page, hiddenTagCount: hiddenTags.length });
}

// Tag facet lookup for the browse filter UI: provider-published tags with
// per-source errors, never invented ones.
export async function browseTagsRoute(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  return json(await searchBrowseTags(q));
}

// Tag facet lookup for the catalog filter UI: the provider's own ids and
// ordering come back verbatim — nothing is merged across providers and no
// counts are invented here. An empty result with a configured TypeSafe key
// gains judged suggestions: real tags chosen among the provider's own list,
// never invented ones.
export async function catalogTagsRoute(
  request: Request,
  config: IntegrationConfig,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const provider = parseCatalogProvider(params.get("provider"));
  const q = (params.get("q") ?? "").trim();
  if (q.length < 2) {
    throw new AppError(
      400,
      "invalid_query",
      "Enter at least 2 characters to search.",
    );
  }
  const tags = await searchCatalogTags(provider, q);
  if (tags.length > 0) return json({ tags });
  const key = config.providers?.typesafeApiKey;
  if (key === undefined || key.trim() === "") return json({ tags });
  const suggestions = await suggestTags(
    q,
    await listCatalogTags(provider),
    key,
  );
  return json({
    tags,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  });
}

// Related titles for one media reference, loaded separately from the detail
// so it never delays playback/request actions. Same reference validation as
// detail (media only, provider UUID), plus an explicit rank choice; the
// caller's hidden tags and the TypeSafe key ride along.
export async function relatedRoute(
  ctx: AuthContext,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
  url: URL,
): Promise<Response> {
  const rankRaw = url.searchParams.get("rank");
  if (rankRaw !== null && rankRaw !== "tags" && rankRaw !== "jev") {
    throw new AppError(400, "invalid_query", "rank must be tags or jev.");
  }
  const hiddenTags = getContentPreferences(ctx.account.id).hiddenTags;
  // A performer's rail is co-appearance over her filmography; movie/scene
  // rails are similar-titles. The performer branch must not pass through
  // parseMediaReference, whose requestability refusal reads as a lookup
  // failure on the page.
  if (kindRaw === "performer") {
    return json(
      await relatedPerformers(
        parseCatalogReference(providerRaw, kindRaw, idRaw),
        hiddenTags,
      ),
    );
  }
  return json(
    await relatedTitles(
      parseMediaReference(providerRaw, kindRaw, idRaw),
      hiddenTags,
      {
        rank: rankRaw === "jev" ? "jev" : "tags",
        typesafeApiKey: ctx.config.providers?.typesafeApiKey,
      },
    ),
  );
}

export async function catalogDetail(
  ctx: AuthContext,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): Promise<Response> {
  const reference = parseCatalogReference(providerRaw, kindRaw, idRaw);
  const detail = await getCatalogDetail(reference);
  if (!detail) {
    throw new AppError(
      404,
      "catalog_not_found",
      "This item is not in the provider catalog.",
    );
  }
  const record = upsertCatalogRecord(detail);
  const media: MediaReference | null = isMediaReference(reference)
    ? reference
    : null;
  // Only the caller's own intent and the shared (user-anonymous) acquisition
  // state; never another user's request history.
  const mine = media
    ? (listRequests(ctx.account).find(
        (r) =>
          r.accountId === ctx.account.id &&
          sameMedia(r.media, media) &&
          // Terminal decisions (cancelled, declined) never block a fresh
          // request: they hide the button only if counted here. History
          // stays on the Requests page.
          (r.decision === "pending" || r.decision === "approved"),
      ) ?? null)
    : null;
  const acquisition = media ? getAcquisitionByReference(media) : null;
  return json({
    detail,
    link: crossProviderLink(detail),
    catalogRecord: record,
    myRequest: mine && {
      id: mine.id,
      decision: mine.decision,
      createdAt: mine.createdAt,
      decidedAt: mine.decidedAt,
    },
    acquisition: acquisition && {
      state: acquisition.state,
      lastError: acquisition.lastError,
      updatedAt: acquisition.updatedAt,
      observationStale: isObservationStale(acquisition),
      monitored: acquisition.whisparrMonitored,
      progress: acquisition.progress,
    },
  });
}

// Artwork proxy: provider-hosted URLs only, byte-capped pass-through,
// cacheable per URL (ETag + private max-age, revalidated on F5), nothing
// persisted, and no Velvarr or provider credentials ever reach the image
// host (fetchProviderArtwork sends none).
export async function catalogImage(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url");
  if (target === null || target === "") {
    throw new AppError(400, "invalid_query", "url is required.");
  }
  const check = isProviderImageUrl(target);
  if (!check.ok) {
    throw new AppError(
      400,
      "invalid_artwork_url",
      `Rejected artwork URL: ${check.reason}.`,
    );
  }
  const { bytes, contentType } = await fetchProviderArtwork(target);
  const response = imageResponse({ bytes, contentType }, request, 604800);
  if (response.status === 304) return response;
  // Provider logos include SVG, which is active content. Nothing here is
  // trusted markup: no script, no embedding, and never a top-level
  // document — so a hostile logo has nothing to execute against.
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  response.headers.set("content-disposition", "attachment");
  return response;
}

// Server-validated MediaReference from a request body. A browser-supplied
// resolved payload is never trusted.
import { imageResponse } from "./library.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["catalog", "search"],
    auth: "session",
    run: async (ctx, request) => catalogSearch(request, ctx),
  },
  {
    method: "GET",
    segments: ["catalog", "image"],
    auth: "session",
    run: async (_ctx, request) => catalogImage(request),
  },
  {
    method: "GET",
    segments: ["catalog", "tags"],
    auth: "session",
    run: async (ctx, request) => catalogTagsRoute(request, ctx.config),
  },
  {
    method: "GET",
    segments: ["catalog", ":provider", ":kind", ":id", "related"],
    auth: "session",
    run: async (ctx, request, p) =>
      relatedRoute(ctx, p.provider!, p.kind!, p.id!, new URL(request.url)),
  },
  {
    method: "GET",
    segments: ["catalog", ":provider", ":kind", ":id"],
    auth: "session",
    run: async (ctx, _request, p) =>
      catalogDetail(ctx, p.provider!, p.kind!, p.id!),
  },
];
