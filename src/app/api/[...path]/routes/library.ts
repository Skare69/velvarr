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

export async function libraries(ctx: AuthContext): Promise<Response> {
  const views = await listLibraries(ctx.config, ctx.token);
  const grants = new Set(ctx.account.libraryIds);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  return json({
    libraries: views.filter(
      (library) => grants.has(library.id) && configured.has(library.id),
    ),
  });
}

export async function libraryPage(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const start = queryInt(url, "start", 0, 0, 100000);
  const limit = queryInt(url, "limit", 24, 1, 60);
  const search = url.searchParams.get("search") ?? "";
  if (search.length > 200)
    throw new AppError(400, "invalid_query", "Invalid search.");
  const grants = new Set(ctx.account.libraryIds);
  let libraryId: string | undefined;
  const requested = url.searchParams.get("libraryId");
  if (requested !== null) {
    requireId(requested);
    if (
      !grants.has(requested) ||
      !ctx.config.jellyfin.libraryIds.includes(requested)
    ) {
      throw new AppError(
        403,
        "forbidden",
        "Library is not granted to this account.",
      );
    }
    libraryId = requested;
  }
  // Empty grant list never means all libraries.
  if (grants.size === 0) return json({ items: [], total: 0, start, limit });
  const page = await listLibraryItems(ctx.config, ctx.token, ctx.account, {
    start,
    limit,
    search,
    ...(libraryId !== undefined ? { libraryId } : {}),
  });
  return json(page);
}

export async function libraryItem(
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const item = await getLibraryItem(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return json({ item });
}

/** Shared image response: strong ETag + If-None-Match revalidation so F5 is a
 * 304 instead of a full refetch, and a private max-age so ordinary navigation
 * serves from the browser cache. Artwork and library art are stable per URL;
 * a changed image revalidates through the ETag. */
export function imageResponse(
  image: { bytes: Uint8Array; contentType: string },
  request: Request,
  maxAgeSeconds: number,
): Response {
  const etag = `"${createHash("sha256").update(image.bytes).digest("base64url")}"`;
  const cache = `private, max-age=${maxAgeSeconds}`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": cache },
    });
  }
  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      etag,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function libraryImage(
  ctx: AuthContext,
  request: Request,
  id: string,
): Promise<Response> {
  const image = await getLibraryImage(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return imageResponse(image, request, 86400);
}

// --- admin routes ---

import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["libraries"],
    auth: "session",
    run: async (ctx) => libraries(ctx),
  },
  {
    method: "GET",
    segments: ["library"],
    auth: "session",
    run: async (ctx, request) => libraryPage(request, ctx),
  },
  {
    method: "GET",
    segments: ["library", ":id"],
    auth: "session",
    run: async (ctx, _request, p) => libraryItem(ctx, p.id!),
  },
  {
    method: "GET",
    segments: ["images", ":id"],
    auth: "session",
    run: async (ctx, request, p) => libraryImage(ctx, request, p.id!),
  },
];
