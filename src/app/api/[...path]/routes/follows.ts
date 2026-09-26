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
  mergePerformerFollows,
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
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  isProviderImageUrl,
  linkedPerformerCounterpart,
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
  return performerField(body, "performer");
}

/** One keyed performer reference off a JSON body; the key names the field so
 * a multi-ref body (merge) reports which side was malformed. */
export function performerField(
  body: Record<string, unknown>,
  key: string,
): CatalogReference {
  const performer = body[key];
  if (
    performer === null ||
    typeof performer !== "object" ||
    Array.isArray(performer)
  ) {
    throw new AppError(400, "invalid_field", `Invalid ${key} reference.`);
  }
  const p = performer as Record<string, unknown>;
  if (
    typeof p.provider !== "string" ||
    typeof p.kind !== "string" ||
    typeof p.id !== "string"
  ) {
    throw new AppError(400, "invalid_field", `Invalid ${key} reference.`);
  }
  try {
    const reference = parseCatalogReference(p.provider, p.kind, p.id);
    if (reference.kind !== "performer") {
      throw new AppError(400, "invalid_field", `Invalid ${key} reference.`);
    }
    return reference;
  } catch (e) {
    // A malformed ref in a JSON body is one invalid_field error, whichever
    // check catches it; parseCatalogReference names it invalid_reference.
    if (e instanceof AppError && e.code === "invalid_reference") {
      throw new AppError(400, "invalid_field", `Invalid ${key} reference.`);
    }
    throw e;
  }
}

export async function listFollowsRoute(ctx: AuthContext): Promise<Response> {
  return json({ follows: listFollows(ctx.account.id) });
}

/** The same performer on the other provider, taken only from links the
 * providers themselves published (never name-matched): an explicit
 * cross-provider URL first, then a shared third-party profile link
 * (identity URL match). The counterpart's own snapshot is read from that
 * provider. Null when no link resolves, or when the lookup fails: a
 * metadata outage must not sink the follow the user asked for. */
export async function performerCounterpart(
  reference: CatalogReference,
): Promise<{
  reference: CatalogReference;
  name: string;
  imageUrl: string | null;
} | null> {
  try {
    const detail = await getCatalogDetail(reference);
    const linked = detail
      ? (await linkedPerformerCounterpart(detail)).linked
      : undefined;
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

/** Merges two already-followed entries the user asserts are the same person
 * and the providers never linked. Both sides must already be followed and on
 * different providers; the survivor (`performer`) row names the counterpart,
 * exactly as a provider-published pair would. */
export async function mergeFollowsRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  const performer = performerField(body, "performer");
  const counterpart = performerField(body, "counterpart");
  if (performer.provider === counterpart.provider) {
    throw new AppError(
      400,
      "invalid_field",
      "a merge pairs a TPDB entry with a StashDB entry",
    );
  }
  // Same-provider and malformed refs are refused above, before storage runs.
  const follow = mergePerformerFollows(ctx.account.id, performer, counterpart);
  return json({ follow }, 200);
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
    method: "POST",
    segments: ["follows", "merge"],
    auth: "session",
    run: async (ctx, request) => mergeFollowsRoute(request, ctx),
  },
  {
    method: "DELETE",
    segments: ["follows", ":provider", ":id"],
    auth: "session",
    run: async (ctx, _request, p) => deleteFollowRoute(ctx, p.provider!, p.id!),
  },
];
