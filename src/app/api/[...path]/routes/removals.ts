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

export function assertRemovalFlag(): void {
  if (process.env.VELVARR_ENABLE_REMOVAL !== "1") {
    throw new AppError(
      403,
      "removal_disabled",
      "Removals are turned off by the operator.",
    );
  }
}

export function assertRemovalGrant(account: Account): void {
  if (account.canRemove !== true) {
    throw new AppError(
      403,
      "account_not_admitted",
      "only admitted accounts holding the removal grant may request removals",
    );
  }
}

export function assertRemovalApprover(account: Account): void {
  if (
    (account.role !== "admin" && account.role !== "moderator") ||
    account.canRemove !== true
  ) {
    throw new AppError(
      403,
      "forbidden",
      "approving removals requires an elevated role and the removal grant",
    );
  }
}

// Removal state is reported, never hidden: with the operator flag off the
// collection still answers with enabled:false so the UI can explain the
// state instead of pretending the feature does not exist.
export async function listRemovalsRoute(ctx: AuthContext): Promise<Response> {
  return json({
    removals: listRemovalRequests(ctx.account),
    enabled: process.env.VELVARR_ENABLE_REMOVAL === "1",
  });
}

// Creation accepts exactly {media, reason}. A level key is refused outright
// and no code path reads one: the level is the approver's choice by
// construction, not an ignored field.
export async function createRemovalRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  assertRemovalFlag();
  assertRemovalGrant(ctx.account);
  const body = await readJson(request);
  if (body.level !== undefined) {
    throw new AppError(
      400,
      "invalid_field",
      "The removal level is chosen at approval, not at creation.",
    );
  }
  const removal = createRemovalRequest(
    ctx.account.id,
    mediaFromBody(body),
    fieldText(body, "reason", 2000),
  );
  return json({ removal }, 201);
}

// Decision authority: approve = elevated role + removal grant + an explicit
// ladder level; decline = elevated role; cancel = the requester's own intent
// only. A level is rejected on every non-approved decision. Foreign or
// unknown requests stay a bare 404 with no existence leak.
export async function decideRemovalRoute(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const body = await readJson(request);
  const requestId = requireId(id);
  if (body.decision === "approved") {
    assertRemovalFlag();
    assertRemovalApprover(ctx.account);
    const level = body.level;
    if (typeof level !== "string" || !isRemovalLevel(level)) {
      throw new AppError(
        400,
        "invalid_level",
        "Approval requires an explicit removal level.",
      );
    }
    return json({
      removal: approveRemovalRequest(ctx.account, requestId, level),
    });
  }
  if (body.decision === "declined" || body.decision === "cancelled") {
    if (body.level !== undefined) {
      throw new AppError(
        400,
        "invalid_level",
        "A level is only accepted with an approved decision.",
      );
    }
    const removal =
      body.decision === "declined"
        ? declineRemovalRequest(ctx.account, requestId)
        : cancelRemovalRequest(ctx.account, requestId);
    return json({ removal });
  }
  throw new AppError(
    400,
    "invalid_field",
    "decision must be approved, declined, or cancelled.",
  );
}

// Best-effort library name for a matched item: the frozen Jellyfin exports
// expose no ancestors lookup by external reference, so scan this caller's
// granted libraries (one bounded page each) for the matched item id. Absent
// stays absent — never a guessed name.
// ponytail: one 60-item page per granted library; deeper libraries omit the
// name until jellyfin.ts exports an item-to-library lookup.
export async function libraryNameOf(
  config: IntegrationConfig,
  token: string,
  account: Account,
  itemId: string,
): Promise<string | undefined> {
  for (const libraryId of config.jellyfin.libraryIds) {
    if (!account.libraryIds.includes(libraryId)) continue;
    const page = await listLibraryItems(config, token, account, {
      start: 0,
      limit: 60,
      search: "",
      libraryId,
    });
    if (page.items.some((item) => item.id === itemId)) {
      const libraries = await listLibraries(config, token);
      return libraries.find((library) => library.id === libraryId)?.name;
    }
  }
  return undefined;
}

// Strictly read-only removal preview: what would disappear, named for THIS
// caller. Whisparr facts come from a stored-item read (GET only); the
// Jellyfin side runs entirely under the caller's own token, so the match and
// the deletion verdict reflect that user's real authority. No PUT, POST, or
// DELETE exists anywhere on this path.
export async function removalImpact(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const media = parseMediaReference(
    url.searchParams.get("provider") ?? "",
    url.searchParams.get("kind") ?? "",
    url.searchParams.get("id") ?? "",
  );
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  const stored = config.whisparr ? await findWhisparrItem(config, media) : null;
  const whisparr =
    stored === null
      ? { found: false }
      : {
          found: true,
          path: stored.path,
          fileCount: stored.fileCount,
          sizeOnDisk: stored.sizeOnDisk,
          monitored: stored.monitored,
        };
  const [verdict, caller] = await Promise.all([
    resolvePlaybackAccess(
      config,
      ctx.token,
      ctx.account,
      stored !== null
        ? {
            provider: media.provider,
            kind: media.kind,
            id: media.id,
            whisparrPath: stored.path,
            ...(stored.title ? { title: stored.title } : {}),
            ...(await performerHint(media)),
          }
        : {
            provider: media.provider,
            kind: media.kind,
            id: media.id,
            ...(await performerHint(media)),
          },
    ),
    // This caller's own Jellyfin policy. validateUser is the frozen per-user
    // authority surface: administrators provably hold deletion rights, so
    // everyone else is conservatively refused.
    // ponytail: Jellyfin's per-user EnableContentDeletion flag is not mapped
    // by validateUser; surface it for non-admins if the mapping ever grows it.
    validateUser(config, ctx.token),
  ]);
  const jellyfin =
    verdict.outcome === "available"
      ? {
          matched: true,
          itemName: verdict.item.name,
          libraryName: await libraryNameOf(
            config,
            ctx.token,
            ctx.account,
            verdict.item.id,
          ),
        }
      : { matched: false };
  return json({
    whisparr,
    jellyfin,
    canDeleteInJellyfin: caller.isAdministrator === true,
  });
}

// The requested record's performer name, read through the provider cache —
// the field the near-miss same-work judgment was calibrated on (a library
// title like "Sunset Blvd with Maddie Wren" is only provably the same scene
// with it). Absent on any failure: a metadata outage must not sink the
// availability verdict, which simply falls back to exact matching.
import { mediaFromBody } from "./requests.ts";
import { performerHint } from "./browse.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["removals"],
    auth: "session",
    run: async (ctx) => listRemovalsRoute(ctx),
  },
  {
    method: "GET",
    segments: ["removals", "impact"],
    auth: "session",
    run: async (ctx, request) => removalImpact(request, ctx),
  },
  {
    method: "POST",
    segments: ["removals"],
    auth: "session",
    run: async (ctx, request) => createRemovalRoute(request, ctx),
  },
  {
    method: "PATCH",
    segments: ["removals", ":id"],
    auth: "session",
    run: async (ctx, request, p) => decideRemovalRoute(request, ctx, p.id!),
  },
];
