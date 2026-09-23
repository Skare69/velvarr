// Moved verbatim from route.ts (v0.24.1) — pure move, no logic edits.
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
} from "../../../lib/contracts.ts";
import {
  isDeliverableMedia,
  isRemovalLevel,
  normalizeFacetName,
  UNDELIVERABLE_REASON,
} from "../../../lib/contracts.ts";
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
} from "../../../server/storage.ts";
import {
  consumeLoginAttempt,
  guardMutation,
  readSessionToken,
  sessionCookie,
  isSecureRequest,
  verifySetupSecret,
} from "../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../server/http.ts";
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
} from "../../../server/jellyfin.ts";
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
} from "../../../server/providers.ts";
import { suggestTags } from "../../../server/judgment.ts";
import {
  findWhisparrItem,
  getWhisparrStatus,
} from "../../../server/whisparr.ts";
import {
  browseTitles,
  isHiddenTitle,
  parseBrowseQuery,
  searchBrowseTags,
  searchVisibleCatalog,
  type BrowsePage,
  type SourceError,
} from "../../../server/browse.ts";
import { relatedPerformers, relatedTitles } from "../../../server/related.ts";

export interface AuthContext {
  config: IntegrationConfig;
  account: Account;
  token: string;
  rawSessionToken: string;
}

// --- response + parsing helpers ---

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function requireSession(request: Request): Promise<AuthContext> {
  const rawSessionToken = readSessionToken(request);
  if (!rawSessionToken)
    throw new AppError(401, "unauthenticated", "Sign in required.");
  const session = getSession(rawSessionToken);
  if (!session) throw new AppError(401, "unauthenticated", "Sign in required.");
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  let user: ExternalUser;
  try {
    user = await validateUser(config, session.jellyfinToken);
  } catch (err) {
    // Proven upstream rejection invalidates the session; transient failures block without deleting state.
    if (err instanceof AppError && (err.status === 401 || err.status === 403)) {
      revokeSession(rawSessionToken);
      throw new AppError(401, "session_revoked", "Session is no longer valid.");
    }
    throw err;
  }
  if (user.id !== session.account.id) {
    revokeSession(rawSessionToken);
    throw new AppError(401, "session_revoked", "Session is no longer valid.");
  }
  if (user.isDisabled) {
    revokeSession(rawSessionToken);
    throw new AppError(403, "account_disabled", "This account is disabled.");
  }
  if (!user.enableRemoteAccess) {
    throw new AppError(
      403,
      "remote_denied",
      "Remote access is disabled for this account.",
    );
  }
  return {
    config,
    account: session.account,
    token: session.jellyfinToken,
    rawSessionToken,
  };
}

export async function requireAdmin(request: Request): Promise<AuthContext> {
  const ctx = await requireSession(request);
  if (ctx.account.role !== "admin")
    throw new AppError(403, "forbidden", "Administrator access required.");
  return ctx;
}

// The route declaration contract: admission is part of the route type, so a
// new route cannot ship without declaring none|session|admin. `segments`
// exclude the `/api` prefix; a segment starting with `:` captures one
// path parameter. Matching is exact (method + count + literal/:param), so no
// entry can shadow another.
export type RouteDef = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  segments: string[];
  auth: "open" | "session" | "admin";
  run: (
    ctx: AuthContext,
    request: Request,
    params: Record<string, string>,
  ) => Promise<Response>;
};
