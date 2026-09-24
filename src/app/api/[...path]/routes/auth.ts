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
  refreshAccountName,
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

export function setupReady(): boolean {
  return (
    /^[0-9a-fA-F]{64}$/.test(process.env.VELVARR_SECRET_KEY ?? "") &&
    (process.env.VELVARR_SETUP_SECRET ?? "").length >= 32
  );
}

// --- session / authorization ---

export interface SetupFields {
  username: string;
  password: string;
  jellyfinUrl: string;
  jellyfinExternalUrl: string;
  jellyfinApiKey: string;
}

export function setupFields(body: Record<string, unknown>): SetupFields {
  return {
    username: fieldText(body, "username", 200),
    password: fieldText(body, "password", 512),
    jellyfinUrl: fieldUrl(body, "jellyfinUrl"),
    jellyfinExternalUrl: fieldUrl(body, "jellyfinExternalUrl"),
    jellyfinApiKey: fieldText(body, "jellyfinApiKey", 512),
  };
}

// Authenticates the explicitly selected user, proves the admin integration key
// enumerates the same server, and fetches real accessible libraries. Retains nothing.
export async function verifySetupSelection(fields: SetupFields): Promise<{
  user: ExternalUser;
  token: string;
  serverId: string;
  libraries: Library[];
}> {
  const server = await getServer(fields.jellyfinUrl);
  const { user, token } = await authenticate(
    fields.jellyfinUrl,
    fields.username,
    fields.password,
  );
  const candidate: IntegrationConfig = {
    jellyfin: {
      url: fields.jellyfinUrl,
      externalUrl: fields.jellyfinExternalUrl,
      apiKey: fields.jellyfinApiKey,
      serverId: server.id,
      libraryIds: [],
    },
  };
  const users = await listUsers(candidate);
  if (!users.some((entry) => entry.id === user.id)) {
    throw new AppError(
      400,
      "identity_mismatch",
      "Selected user was not found on this server.",
    );
  }
  const libraries = await listLibraries(candidate, token);
  return { user, token, serverId: server.id, libraries };
}

export async function setupInspect(request: Request): Promise<Response> {
  if (isInitialized())
    throw new AppError(
      409,
      "already_initialized",
      "Setup is already complete.",
    );
  const body = await readJson(request);
  verifySetupSecret(body.setupSecret);
  const fields = setupFields(body);
  consumeLoginAttempt(fields.username);
  const selection = await verifySetupSelection(fields);
  return json({
    user: { id: selection.user.id, name: selection.user.name },
    libraries: selection.libraries,
  });
}

export async function setupCommit(request: Request): Promise<Response> {
  if (isInitialized())
    throw new AppError(
      409,
      "already_initialized",
      "Setup is already complete.",
    );
  const body = await readJson(request);
  verifySetupSecret(body.setupSecret);
  const fields = setupFields(body);
  consumeLoginAttempt(fields.username);
  const libraryIds = fieldIds(body, "libraryIds");
  if (libraryIds.length === 0)
    throw new AppError(400, "invalid_field", "Select at least one library.");
  const whisparrUrl = optionalText(body, "whisparrUrl", 2048);
  const whisparrApiKey = optionalText(body, "whisparrApiKey", 512);
  let whisparr: { url: string; apiKey: string } | undefined;
  if (whisparrUrl !== undefined && whisparrUrl !== "") {
    if (!whisparrApiKey)
      throw new AppError(
        400,
        "invalid_field",
        "Whisparr API key is required with a Whisparr URL.",
      );
    whisparr = { url: validateBaseUrl(whisparrUrl), apiKey: whisparrApiKey };
  }
  const selection = await verifySetupSelection(fields);
  if (
    !libraryIds.every((id) =>
      selection.libraries.some((library) => library.id === id),
    )
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "Selected libraries are not accessible on this server.",
    );
  }
  const config: IntegrationConfig = {
    jellyfin: {
      url: fields.jellyfinUrl,
      externalUrl: fields.jellyfinExternalUrl,
      apiKey: fields.jellyfinApiKey,
      serverId: selection.serverId,
      libraryIds,
    },
    ...(whisparr ? { whisparr } : {}),
  };
  const grant = bootstrap(config, selection.user, selection.token);
  return json({ account: grant.account }, 200, {
    "set-cookie": sessionCookie(grant, isSecureRequest(request)),
  });
}

// --- auth routes ---

export async function login(request: Request): Promise<Response> {
  const body = await readJson(request);
  const username = fieldText(body, "username", 200);
  const password = fieldText(body, "password", 512);
  consumeLoginAttempt(username);
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  const { user, token } = await authenticate(
    config.jellyfin.url,
    username,
    password,
  );
  const account = getAccount(user.id);
  if (!account)
    throw new AppError(
      403,
      "not_admitted",
      "This account has not been admitted to Velvarr.",
    );
  if (!account.enabled)
    throw new AppError(403, "account_disabled", "This account is disabled.");
  if (user.isDisabled)
    throw new AppError(403, "account_disabled", "This account is disabled.");
  if (!user.enableRemoteAccess) {
    throw new AppError(
      403,
      "remote_denied",
      "Remote access is disabled for this account.",
    );
  }
  // Jellyfin owns the display name: before the session reads the row, land
  // any upstream rename so menus show the current name, not a stale one.
  if (typeof user.name === "string" && user.name !== account.name)
    refreshAccountName(account.id, user.name);
  const grant = createSession(account.id, token);
  return json({ account: grant.account }, 200, {
    "set-cookie": sessionCookie(grant, isSecureRequest(request)),
  });
}

export async function logout(request: Request): Promise<Response> {
  await readJson(request);
  const raw = readSessionToken(request);
  if (raw) revokeSession(raw);
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookie(undefined, isSecureRequest(request)),
  });
}

// --- user routes ---

export async function me(ctx: AuthContext): Promise<Response> {
  const [tpdb, stashdb] = await Promise.all([
    providerPresence("tpdb"),
    providerPresence("stashdb"),
  ]);
  return json({
    account: ctx.account,
    providers: { tpdb, stashdb } satisfies ProviderStatus,
  });
}

// --- personal content preferences ---

// Session-only by construction: the route reads ctx.account.id, so a caller
// can only ever touch its own hidden tags and discover shelf order. PATCH
// never accepts an account id
// — storage validates the whole body and rejects unknown top-level fields,
// and a malformed payload changes nothing (atomic).
export async function updatePreferences(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  return json(saveContentPreferences(ctx.account.id, await readJson(request)));
}

// Coarse per-user signal: does a provider integration exist at all. Real
// verification (verified flag + account) lives on the admin providers route;
// here an outage must never claim a configured provider vanished, and an
// unconfigured provider must never pretend otherwise.
export async function providerPresence(
  provider: "tpdb" | "stashdb",
): Promise<ProviderStatus["tpdb"]> {
  try {
    return (await getProviderStatus(provider)).configured
      ? "not_verified"
      : "not_configured";
  } catch {
    return "not_verified";
  }
}

import { userAvatar } from "./admin.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["status"],
    auth: "open",
    run: async () =>
      json({ initialized: isInitialized(), setupReady: setupReady() }),
  },
  {
    method: "GET",
    segments: ["health"],
    auth: "open",
    run: async () => json({ ok: true }),
  },
  {
    method: "GET",
    segments: ["me"],
    auth: "session",
    run: async (ctx) => me(ctx),
  },
  {
    method: "GET",
    segments: ["users", ":id", "avatar"],
    auth: "session",
    // Staff already see requester names, so they get the matching avatar;
    // requester-role accounts can only ever read their own — no enumeration.
    run: async (ctx, _request, p) => {
      const id = p.id!;
      if (id !== ctx.account.id && ctx.account.role === "requester")
        throw new AppError(404, "user_not_found", "user not found");
      return userAvatar(ctx, id);
    },
  },
  {
    method: "GET",
    segments: ["me", "avatar"],
    auth: "session",
    // The id comes from the session, never the URL: an account can only ever
    // read its own avatar. ponytail: untagged URL, so a changed Jellyfin
    // avatar can take the hour's max-age to show; carry the tag on /api/me
    // if that ever matters.
    run: async (ctx) => userAvatar(ctx, ctx.account.id),
  },
  {
    method: "GET",
    segments: ["me", "preferences"],
    auth: "session",
    run: async (ctx) => json(getContentPreferences(ctx.account.id)),
  },
  {
    method: "POST",
    segments: ["setup", "inspect"],
    auth: "open",
    run: async (_ctx, request) => setupInspect(request),
  },
  {
    method: "POST",
    segments: ["setup"],
    auth: "open",
    run: async (_ctx, request) => setupCommit(request),
  },
  {
    method: "POST",
    segments: ["login"],
    auth: "open",
    run: async (_ctx, request) => login(request),
  },
  {
    method: "POST",
    segments: ["logout"],
    auth: "open",
    run: async (_ctx, request) => logout(request),
  },
  {
    method: "PATCH",
    segments: ["me", "preferences"],
    auth: "session",
    run: async (ctx, request) => updatePreferences(request, ctx),
  },
];
