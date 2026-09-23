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

export function performerFromBody(
  body: Record<string, unknown>,
): CatalogReference {
  const performer = body.performer;
  if (
    performer === null ||
    typeof performer !== "object" ||
    Array.isArray(performer)
  ) {
    throw new AppError(400, "invalid_field", "Invalid performer reference.");
  }
  const p = performer as Record<string, unknown>;
  if (
    typeof p.provider !== "string" ||
    typeof p.kind !== "string" ||
    typeof p.id !== "string"
  ) {
    throw new AppError(400, "invalid_field", "Invalid performer reference.");
  }
  const reference = parseCatalogReference(p.provider, p.kind, p.id);
  if (reference.kind !== "performer") {
    throw new AppError(400, "invalid_field", "Invalid performer reference.");
  }
  return reference;
}

export async function listFollowsRoute(ctx: AuthContext): Promise<Response> {
  return json({ follows: listFollows(ctx.account.id) });
}

/** The same performer on the other provider, taken only from the link the
 * providers themselves published (crossProviderLink never name-matches), with
 * its own snapshot read from that provider. Null when there is no link, or
 * when the lookup fails: a metadata outage must not sink the follow the user
 * asked for. */
export async function performerCounterpart(
  reference: CatalogReference,
): Promise<{
  reference: CatalogReference;
  name: string;
  imageUrl: string | null;
} | null> {
  try {
    const detail = await getCatalogDetail(reference);
    const linked = detail ? crossProviderLink(detail).linked : undefined;
    if (!linked) return null;
    const counterpart = await getCatalogDetail(linked);
    if (!counterpart) return null;
    return {
      reference: linked,
      name: counterpart.title,
      imageUrl: followImage(counterpart.imageUrl),
    };
  } catch {
    return null;
  }
}

/** An image URL that fails the provider-artwork check degrades to null
 * rather than sinking the whole follow: the snapshot is cosmetic. */
export function followImage(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" && isProviderImageUrl(raw).ok
    ? raw
    : null;
}

export async function createFollowRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const reference = performerFromBody(body);
  // A performer is one person on both metadata sources, so one Follow press
  // follows both: the pair then answers as one identity everywhere.
  const counterpart = await performerCounterpart(reference);
  const follow = followPerformer(
    ctx.account.id,
    reference,
    fieldText(body, "name", 200),
    followImage(body.imageUrl),
    counterpart?.reference ?? null,
  );
  if (counterpart) {
    try {
      // The counterpart row exists so the per-provider follow shelves read
      // both metadata sources; only the row above names the pair, and the
      // list folds this one away.
      followPerformer(
        ctx.account.id,
        counterpart.reference,
        counterpart.name,
        counterpart.imageUrl,
      );
    } catch (e) {
      // Already followed on its own: nothing to insert, only the pair to
      // record. Any other failure leaves the asked-for follow standing.
      if (e instanceof AppError && e.status === 409) {
        linkFollows(ctx.account.id, reference, counterpart.reference);
      }
    }
  }
  return json({ follow }, 201);
}

export async function deleteFollowRoute(
  ctx: AuthContext,
  providerRaw: string,
  idRaw: string,
): Promise<Response> {
  const reference = parseCatalogReference(providerRaw, "performer", idRaw);
  unfollowPerformer(ctx.account.id, reference.provider, reference.id);
  return new Response(null, { status: 204 });
}

// --- bulk requests: everything a performer has ---

import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["follows"],
    auth: "session",
    run: async (ctx) => listFollowsRoute(ctx),
  },
  {
    method: "POST",
    segments: ["follows"],
    auth: "session",
    run: async (ctx, request) => createFollowRoute(request, ctx),
  },
  {
    method: "DELETE",
    segments: ["follows", ":provider", ":id"],
    auth: "session",
    run: async (ctx, _request, p) => deleteFollowRoute(ctx, p.provider!, p.id!),
  },
];
