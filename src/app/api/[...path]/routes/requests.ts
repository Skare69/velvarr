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

export function mediaFromBody(body: Record<string, unknown>): MediaReference {
  const media = body.media;
  if (media === null || typeof media !== "object" || Array.isArray(media)) {
    throw new AppError(400, "invalid_field", "Invalid media reference.");
  }
  const m = media as Record<string, unknown>;
  if (
    (m.provider !== "tpdb" && m.provider !== "stashdb") ||
    (m.kind !== "movie" && m.kind !== "scene") ||
    typeof m.id !== "string" ||
    !PROVIDER_UUID.test(m.id)
  ) {
    throw new AppError(400, "invalid_field", "Invalid media reference.");
  }
  const ref: MediaReference = {
    provider: m.provider,
    kind: m.kind,
    id: m.id.toLowerCase(),
  };
  // Whisparr has no metadata source for a TPDB scene, so a request for one
  // could only ever fail in the worker. Refuse it at the click instead.
  if (!isDeliverableMedia(ref)) {
    throw new AppError(400, "invalid_reference", UNDELIVERABLE_REASON);
  }
  return ref;
}

// Creates one user's request intent from a server-validated MediaReference.
// With the autoApprove grant — or an admin role, which carries the same trust
// implicitly (Seerr parity; the owner account cannot be granted the flag in
// the UI because it is already staff) — the request is decided approved
// immediately so shared acquisition work is enqueued; otherwise it stays
// pending for a moderator. No Whisparr call happens anywhere on this path.
export async function createRequestRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const media = mediaFromBody(await readJson(request));
  const record = createRequest(ctx.account.id, media);
  if (ctx.account.autoApprove || ctx.account.role === "admin") {
    return json(
      {
        request: decideRequest(ctx.account, record.id, "approved"),
        autoApproved: true,
      },
      201,
    );
  }
  return json({ request: record }, 201);
}

/** Approved rows carry the SHARED acquisition state for their identity, so a
 * viewer can see whether the work actually went through. Staff viewers also
 * get requester names: the shape both the requests list and the discover
 * rail serve, without exposing anyone else's request history. */
export function listRequestItems(ctx: AuthContext): RequestListItem[] {
  const staff =
    ctx.account.role === "admin" || ctx.account.role === "moderator";
  // One map lookup per row instead of one account fetch per row.
  const accounts = staff ? new Map(listAccounts().map((a) => [a.id, a])) : null;
  return listRequests(ctx.account).map((r) => {
    const acc = accounts?.get(r.accountId);
    const item: RequestListItem = acc
      ? { ...r, requestedBy: acc.name, requestedById: acc.id }
      : r;
    if (item.decision !== "approved") return item;
    const a = getAcquisitionByReference(item.media);
    return {
      ...item,
      acquisition: a && {
        state: a.state,
        lastError: a.lastError,
        updatedAt: a.updatedAt,
        observationStale: isObservationStale(a),
        monitored: a.whisparrMonitored,
        progress: a.progress,
      },
    };
  });
}

export async function listRequestsRoute(ctx: AuthContext): Promise<Response> {
  return json({ requests: listRequestItems(ctx) });
}

export async function decideRequestRoute(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const decision = (await readJson(request)).decision;
  const requestId = requireId(id);
  if (decision === "approved" || decision === "declined") {
    return json({
      request: decideRequest(ctx.account, requestId, decision),
    });
  }
  if (decision === "cancelled") {
    return json({ request: cancelRequest(ctx.account, requestId) });
  }
  throw new AppError(
    400,
    "invalid_field",
    "decision must be approved, declined, or cancelled.",
  );
}

// --- follows: per-account performer follows ---

// Server-validated performer reference from a request body. Mirrors
// mediaFromBody but for the catalog-only performer kind: a movie/scene
// reference must never land in a follow list.
export const BULK_REQUEST_CAP = 100;
// A provider page, not the cap: TPDB rejects (oversized response) a
// filmography page of 100 rows. 24 is what the browse surfaces request.
export const BULK_SCAN_PAGE = 24;

export async function bulkRequestRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const performer = performerFromBody(body);
  const kind = body.kind;
  if (kind !== "movie" && kind !== "scene") {
    throw new AppError(400, "invalid_field", "Invalid kind.");
  }
  if (performer.provider === "stashdb" && kind === "movie") {
    throw new AppError(400, "invalid_query", "StashDB has no movie records.");
  }
  // Same rule as a single request: filing a hundred requests Whisparr can
  // never resolve is the same mistake, a hundred times.
  if (!isDeliverableMedia({ provider: performer.provider, kind })) {
    throw new AppError(400, "invalid_reference", UNDELIVERABLE_REASON);
  }
  // ponytail: one sequential pass, hard-capped at BULK_REQUEST_CAP titles —
  // a prolific performer needs re-runs to continue the backlog. Re-running
  // is safe because the active-intent unique index makes every createRequest
  // idempotent: already-requested titles surface as skipped, not duplicated.
  const items: CatalogDetail[] = [];
  let capped = false;
  let scanned = 0;
  for (let page = 1; items.length < BULK_REQUEST_CAP; page += 1) {
    // TPDB's performer filter is paging-only: no other filter may travel
    // with it. StashDB composes freely but has no movie entity.
    //
    // The page size is BULK_SCAN_PAGE, not the cap: a TPDB filmography page
    // of 100 titles exceeds the provider client's response byte ceiling and
    // comes back as 502 upstream_bad_response, so the scan pages in the same
    // size the browse surfaces use.
    const result = await searchCatalog(
      performer.provider === "tpdb"
        ? {
            provider: "tpdb",
            kind,
            performer: performer.id,
            page,
            perPage: BULK_SCAN_PAGE,
          }
        : {
            provider: "stashdb",
            kind: "scene",
            performer: performer.id,
            page,
            perPage: BULK_SCAN_PAGE,
          },
    );
    scanned += result.items.length;
    items.push(...result.items);
    if (items.length >= BULK_REQUEST_CAP) {
      capped = result.hasMore || items.length > BULK_REQUEST_CAP;
      break;
    }
    if (!result.hasMore) break;
  }
  if (items.length > BULK_REQUEST_CAP) items.length = BULK_REQUEST_CAP;
  let requested = 0;
  let skipped = 0;
  let autoApproved = 0;
  const failed: { id: string; code: string }[] = [];
  for (const item of items) {
    // kind is pinned movie/scene above; the reference came from that query.
    const media: MediaReference = {
      provider: performer.provider,
      kind,
      id: item.reference.id,
    };
    try {
      const record = createRequest(ctx.account.id, media);
      requested += 1;
      if (ctx.account.autoApprove || ctx.account.role === "admin") {
        decideRequest(ctx.account, record.id, "approved");
        autoApproved += 1;
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "request_exists") {
        skipped += 1;
      } else if (err instanceof AppError) {
        failed.push({ id: media.id, code: err.code });
      } else {
        throw err;
      }
    }
  }
  return json({ requested, skipped, autoApproved, failed, scanned, capped });
}

// --- removals: guarded removal intents ---

// Boundary mirror of the storage gate so the refusal is legible at the API
// edge; storage re-checks the flag authoritatively on every mutation.
import { performerFromBody } from "./follows.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["requests"],
    auth: "session",
    run: async (ctx) => listRequestsRoute(ctx),
  },
  {
    method: "POST",
    segments: ["requests"],
    auth: "session",
    run: async (ctx, request) => createRequestRoute(request, ctx),
  },
  {
    method: "POST",
    segments: ["requests", "bulk"],
    auth: "session",
    run: async (ctx, request) => bulkRequestRoute(request, ctx),
  },
  {
    method: "PATCH",
    segments: ["requests", ":id"],
    auth: "session",
    run: async (ctx, request, p) => decideRequestRoute(request, ctx, p.id!),
  },
];
