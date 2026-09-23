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

export async function performerHint(
  media: MediaReference,
): Promise<{ performer: string } | Record<string, never>> {
  try {
    const detail = await getCatalogDetail(media);
    const credit = detail?.credits.find(
      (c) => c.reference.kind === "performer",
    );
    return credit ? { performer: credit.name } : {};
  } catch {
    return {};
  }
}

// Per-user playback verdict for one external identity. Runs under THIS
// caller's Jellyfin token; hints are the validated reference plus the
// shared acquisition's persisted Whisparr facts when present. This is a
// read route: no Whisparr call ever happens here.
export async function availability(
  ctx: AuthContext,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): Promise<Response> {
  const media = parseMediaReference(providerRaw, kindRaw, idRaw);
  const acquisition = getAcquisitionByReference(media);
  const verdict = await resolvePlaybackAccess(
    ctx.config,
    ctx.token,
    ctx.account,
    {
      provider: media.provider,
      kind: media.kind,
      id: media.id,
      ...(acquisition?.whisparrPath
        ? { whisparrPath: acquisition.whisparrPath }
        : {}),
      ...(acquisition?.whisparrTitle
        ? { title: acquisition.whisparrTitle }
        : {}),
      ...(await performerHint(media)),
    },
  );
  // Scan lag (hazard 9): Whisparr has imported the item but Jellyfin's fresh
  // check under this caller's token found no authorized match — the library
  // simply has not caught up. A proven Whisparr absence demotes back to
  // missing; outages stay unavailable and per-user denials stay denied
  // because they never reach this branch.
  if (
    verdict.outcome === "missing" &&
    acquisition !== null &&
    acquisition.state === "imported" &&
    !hasAuthoritativeAbsence(acquisition)
  ) {
    return json({
      outcome: "awaiting_scan",
      reason: "Imported on Whisparr; the media server has not matched it yet.",
      observationStale: isObservationStale(acquisition),
    });
  }
  return json(verdict);
}

// Real provider verification for the admin UI: configured:false stays
// honest, and an outage or auth failure throws rather than masquerading as
// an empty or unverified catalog.
export interface SearchCategory {
  id: string;
  provider: "tpdb" | "stashdb";
  kind: CatalogKind;
  items: CatalogDetail[];
  error?: ShelfError;
}

// AppError codes pass through verbatim so "not configured" stays distinct
// from "unavailable" at the UI; anything unknown is a bare internal error.
export function categoryOf(
  id: string,
  provider: "tpdb" | "stashdb",
  kind: CatalogKind,
  result: PromiseSettledResult<CatalogDetail[]>,
): SearchCategory {
  return result.status === "fulfilled"
    ? { id, provider, kind, items: result.value }
    : { id, provider, kind, items: [], error: shelfError(result.reason) };
}

export async function globalSearch(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").trim();
  if (term.length < 2) {
    throw new AppError(
      400,
      "invalid_query",
      "Enter at least 2 characters to search.",
    );
  }
  // Media categories honor the caller's hidden tags; performer and studio
  // categories stay raw — hidden tags remove titles, never entities.
  const hiddenTags = getContentPreferences(ctx.account.id).hiddenTags;
  const [
    tpdbMovies,
    stashdbScenes,
    tpdbPerformers,
    stashdbPerformers,
    tpdbStudios,
    stashdbStudios,
  ] = await Promise.allSettled([
    searchVisibleCatalog(
      {
        provider: "tpdb",
        kind: "movie",
        query: term,
        page: 1,
        perPage: SEARCH_PER_PAGE,
      },
      hiddenTags,
    ).then((page) => page.items),
    searchVisibleCatalog(
      {
        provider: "stashdb",
        kind: "scene",
        query: term,
        page: 1,
        perPage: SEARCH_PER_PAGE,
      },
      hiddenTags,
    ).then((page) => page.items),
    searchCatalog({
      provider: "tpdb",
      kind: "performer",
      query: term,
      page: 1,
      perPage: SEARCH_PER_PAGE,
    }).then((page) => page.items),
    searchCatalog({
      provider: "stashdb",
      kind: "performer",
      query: term,
    }).then((page) => page.items),
    searchCatalog({
      provider: "tpdb",
      kind: "studio",
      query: term,
      page: 1,
      perPage: SEARCH_PER_PAGE,
    }).then((page) => page.items),
    searchCatalog({
      provider: "stashdb",
      kind: "studio",
      query: term,
    }).then((page) => page.items),
  ]);
  // Six source-labeled categories, never merged across providers. Each is
  // the provider's own search order — no global ranking is computed here.
  return json({
    query: term,
    categories: [
      categoryOf("tpdb-movies", "tpdb", "movie", tpdbMovies),
      categoryOf("stashdb-scenes", "stashdb", "scene", stashdbScenes),
      categoryOf("tpdb-performers", "tpdb", "performer", tpdbPerformers),
      categoryOf(
        "stashdb-performers",
        "stashdb",
        "performer",
        stashdbPerformers,
      ),
      categoryOf("tpdb-studios", "tpdb", "studio", tpdbStudios),
      categoryOf("stashdb-studios", "stashdb", "studio", stashdbStudios),
    ],
  });
}

/** A matched route: what to run, and the admission it needs. The auth level
 * is part of the shape, so a new branch cannot ship without declaring one;
 * the previous table enforced "remember requireSession here" by discipline. */
import { shelfError, SEARCH_PER_PAGE, type ShelfError } from "./discover.ts";
import { browseRoute, browseTagsRoute } from "./catalog.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["browse"],
    auth: "session",
    run: async (ctx, request) => browseRoute(request, ctx),
  },
  {
    method: "GET",
    segments: ["browse", "tags"],
    auth: "session",
    run: async (_ctx, request) => browseTagsRoute(request),
  },
  {
    method: "GET",
    segments: ["availability", ":provider", ":kind", ":id"],
    auth: "session",
    run: async (ctx, _request, p) =>
      availability(ctx, p.provider!, p.kind!, p.id!),
  },
  {
    method: "GET",
    segments: ["search"],
    auth: "session",
    run: async (ctx, request) => globalSearch(request, ctx),
  },
];
