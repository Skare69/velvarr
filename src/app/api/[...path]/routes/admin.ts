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

export function integrationsShape(config: IntegrationConfig) {
  return {
    jellyfin: {
      url: config.jellyfin.url,
      externalUrl: config.jellyfin.externalUrl,
      serverId: config.jellyfin.serverId,
      libraryIds: config.jellyfin.libraryIds,
      apiKeyConfigured: config.jellyfin.apiKey.length > 0,
    },
    whisparr: config.whisparr
      ? {
          url: config.whisparr.url,
          apiKeyConfigured: config.whisparr.apiKey.length > 0,
          delivery: config.whisparr.delivery ?? null,
          pathMappings: config.whisparr.pathMappings ?? [],
        }
      : null,
    providers: {
      tpdb: providerShape(config.providers?.tpdbApiToken, "TPDB_API_TOKEN"),
      stashdb: providerShape(
        config.providers?.stashdbApiKey,
        "STASHDB_API_KEY",
      ),
      typesafe: providerShape(
        config.providers?.typesafeApiKey,
        "TYPESAFE_API_KEY",
      ),
    },
  };
}

export function providerShape(
  stored: string | undefined,
  envName: string,
): { configured: boolean; source: "stored" | "environment" } {
  if (typeof stored === "string" && stored !== "") {
    return { configured: true, source: "stored" };
  }
  const env = process.env[envName];
  return {
    configured: typeof env === "string" && env !== "",
    source: "environment",
  };
}

export async function adminUsers(ctx: AuthContext): Promise<Response> {
  const [views, users] = await Promise.all([
    listLibraries(ctx.config, ctx.token),
    listUsers(ctx.config),
  ]);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  const avatarTags = new Map(
    users.filter((u) => u.imageTag).map((u) => [u.id, u.imageTag as string]),
  );
  const counts = countRequestsByAccount();
  return json({
    accounts: listAccounts().map((account): AdminAccount => {
      const tag = avatarTags.get(account.id);
      return {
        ...account,
        requestCount: counts.get(account.id) ?? 0,
        ...(tag ? { avatarTag: tag } : {}),
      };
    }),
    libraries: views.filter((library) => configured.has(library.id)),
  });
}

/** One account's Jellyfin avatar bytes: admin rows ask by id, every account
 *  asks for its own through /api/me/avatar. No upstream avatar is a 404. */
export async function userAvatar(
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const image = await getUserImage(ctx.config, requireId(id));
  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      // Admin rows use tag-keyed URLs, so a changed avatar is a new URL there;
      // the untagged /api/me/avatar can lag by this max-age.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function adminImport(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  await readJson(request);
  const imported = importAccounts(await listUsers(ctx.config));
  return json({ accounts: imported });
}

export async function adminUpdateUser(
  request: Request,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const body = await readJson(request);
  const target = getAccount(requireId(id));
  if (!target) throw new AppError(404, "not_found", "Account not found.");
  const enabled = fieldBool(body, "enabled");
  const role = fieldRole(body, "role");
  const libraryIds = fieldIds(body, "libraryIds");
  const autoApprove = optionalBool(body, "autoApprove");
  const canRemove = optionalBool(body, "canRemove");
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  if (libraryIds.some((libraryId) => !configured.has(libraryId))) {
    throw new AppError(400, "invalid_field", "Unknown library selected.");
  }
  if (target.isOwner && (!enabled || role !== "admin")) {
    throw new AppError(
      403,
      "forbidden",
      "The owner account cannot be disabled or demoted.",
    );
  }
  const account = updateAccount(target.id, {
    enabled,
    role,
    libraryIds,
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    ...(canRemove !== undefined ? { canRemove } : {}),
  });
  return json({ account });
}

/** Provider credentials: omitted key = unchanged, "" = clear (falls back to
 * the environment). Verify happens via /api/admin/providers. */
export function nextProviderCredentials(
  existing: IntegrationConfig["providers"],
  body: Record<string, unknown>,
): IntegrationConfig["providers"] {
  const tpdbApiToken = optionalText(body, "tpdbApiToken", 1024);
  const stashdbApiKey = optionalText(body, "stashdbApiKey", 512);
  const typesafeApiKey = optionalText(body, "typesafeApiKey", 512);
  if (
    tpdbApiToken === undefined &&
    stashdbApiKey === undefined &&
    typesafeApiKey === undefined
  ) {
    return existing;
  }
  const providers = {
    tpdbApiToken:
      tpdbApiToken === undefined
        ? existing?.tpdbApiToken
        : tpdbApiToken === ""
          ? undefined
          : tpdbApiToken.trim(),
    stashdbApiKey:
      stashdbApiKey === undefined
        ? existing?.stashdbApiKey
        : stashdbApiKey === ""
          ? undefined
          : stashdbApiKey.trim(),
    typesafeApiKey:
      typesafeApiKey === undefined
        ? existing?.typesafeApiKey
        : typesafeApiKey === ""
          ? undefined
          : typesafeApiKey.trim(),
  };
  if (
    providers.tpdbApiToken === undefined &&
    providers.stashdbApiKey === undefined &&
    providers.typesafeApiKey === undefined
  ) {
    return undefined;
  }
  return providers;
}

/** Jellyfin connection patch: address and key may change, server identity
 * may not. Authorization for this change is the admin session itself:
 * requireAdmin re-validates the caller upstream on every request (identity,
 * disabled, remote access) and guardMutation rejects foreign origins. No
 * password re-auth: it would re-authenticate under the shared DeviceId,
 * invalidating the caller's own Jellyfin token and logging the admin out. */
export async function nextJellyfin(
  current: IntegrationConfig["jellyfin"],
  body: Record<string, unknown>,
): Promise<IntegrationConfig["jellyfin"]> {
  const url = fieldUrl(body, "jellyfinUrl");
  const externalUrl = fieldUrl(body, "jellyfinExternalUrl");
  const supplied = optionalText(body, "jellyfinApiKey", 512);
  const apiKey =
    supplied !== undefined && supplied !== "" ? supplied : current.apiKey;
  const server = await getServer(url);
  if (server.id !== current.serverId) {
    throw new AppError(
      400,
      "server_mismatch",
      "Jellyfin server identity cannot change, only its address.",
    );
  }
  const jellyfin = {
    url,
    externalUrl,
    apiKey,
    serverId: current.serverId,
    libraryIds: current.libraryIds,
  };
  // Prove the prospective key still enumerates users as the administrator key.
  await listUsers({ jellyfin });
  return jellyfin;
}

/** Omitted key preserves what is stored; present key must be complete. */
export function parseDelivery(raw: unknown): WhisparrDelivery | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    new AppError(400, "invalid_field", "Invalid Whisparr delivery settings.");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid();
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.enabled !== "boolean" ||
    typeof d.rootFolderPath !== "string" ||
    d.rootFolderPath.length > 1024 ||
    typeof d.qualityProfileId !== "number" ||
    !Number.isInteger(d.qualityProfileId) ||
    d.qualityProfileId < 1 ||
    typeof d.searchOnAdd !== "boolean" ||
    (d.enabled && d.rootFolderPath === "")
  ) {
    throw invalid();
  }
  return {
    enabled: d.enabled,
    rootFolderPath: d.rootFolderPath,
    qualityProfileId: d.qualityProfileId,
    searchOnAdd: d.searchOnAdd,
  };
}

export function parsePathMappings(
  raw: unknown,
): WhisparrPathMapping[] | undefined {
  if (raw === undefined) return undefined;
  const invalid = () =>
    new AppError(400, "invalid_field", "Invalid Whisparr path mappings.");
  if (!Array.isArray(raw) || raw.length > 50) throw invalid();
  const mapped: WhisparrPathMapping[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid();
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.whisparrPrefix !== "string" ||
      e.whisparrPrefix === "" ||
      e.whisparrPrefix.length > 1024 ||
      typeof e.jellyfinPrefix !== "string" ||
      e.jellyfinPrefix === "" ||
      e.jellyfinPrefix.length > 1024
    ) {
      throw invalid();
    }
    mapped.push({
      whisparrPrefix: e.whisparrPrefix,
      jellyfinPrefix: e.jellyfinPrefix,
    });
  }
  return mapped;
}

/** Whisparr patch: a blank URL removes the connection, delivery settings are
 * stored only with one. Omitted keys preserve what is already configured. */
export function nextWhisparr(
  current: IntegrationConfig["whisparr"],
  body: Record<string, unknown>,
): IntegrationConfig["whisparr"] {
  let whisparr = current;
  const url = optionalText(body, "whisparrUrl", 2048);
  if (url === "") {
    if (optionalText(body, "whisparrApiKey", 512) !== undefined)
      throw new AppError(
        400,
        "invalid_field",
        "A Whisparr API key requires a Whisparr URL; clear the key to remove Whisparr.",
      );
    whisparr = undefined;
  } else if (url !== undefined) {
    const supplied = optionalText(body, "whisparrApiKey", 512);
    const apiKey =
      supplied !== undefined && supplied !== "" ? supplied : whisparr?.apiKey;
    if (!apiKey)
      throw new AppError(
        400,
        "invalid_field",
        "Whisparr API key is required with a Whisparr URL.",
      );
    whisparr = { url: validateBaseUrl(url), apiKey };
  }
  const delivery = parseDelivery(body.delivery) ?? whisparr?.delivery;
  const pathMappings =
    parsePathMappings(body.pathMappings) ?? whisparr?.pathMappings;
  if (
    (body.delivery !== undefined || body.pathMappings !== undefined) &&
    !whisparr
  ) {
    throw new AppError(
      400,
      "invalid_field",
      "Whisparr must be configured to set delivery settings.",
    );
  }
  if (!whisparr) return undefined;
  return {
    ...whisparr,
    ...(delivery ? { delivery } : {}),
    ...(pathMappings ? { pathMappings } : {}),
  };
}

export async function adminUpdateIntegrations(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const body = await readJson(request);
  // Provider-only saves never touch Jellyfin/Whisparr: the provider card
  // sends just its fields, and re-validating the Jellyfin connection would
  // make provider keys uneditable whenever Jellyfin is briefly down.
  const bodyKeys = Object.keys(body);
  if (
    bodyKeys.length > 0 &&
    bodyKeys.every(
      (k) =>
        k === "tpdbApiToken" || k === "stashdbApiKey" || k === "typesafeApiKey",
    )
  ) {
    const providers = nextProviderCredentials(ctx.config.providers, body);
    const patched: IntegrationConfig = {
      jellyfin: ctx.config.jellyfin,
      ...(ctx.config.whisparr ? { whisparr: ctx.config.whisparr } : {}),
      ...(providers ? { providers } : {}),
    };
    saveConfig(patched);
    return json(integrationsShape(patched));
  }
  const jellyfin = await nextJellyfin(ctx.config.jellyfin, body);
  const whisparr = nextWhisparr(ctx.config.whisparr, body);
  const providers = nextProviderCredentials(ctx.config.providers, body);
  const config: IntegrationConfig = {
    jellyfin,
    ...(whisparr ? { whisparr } : {}),
    ...(providers ? { providers } : {}),
  };
  saveConfig(config);
  return json(integrationsShape(config));
}

export async function adminWhisparr(ctx: AuthContext): Promise<Response> {
  try {
    return json(await getWhisparrStatus(ctx.config));
  } catch (err) {
    // Upstream rejection or outage is status information, never a dead
    // Velvarr session: an HTTP 401 here would fire the client's global
    // sign-out and bounce the admin off the settings page in a loop.
    if (err instanceof AppError && err.status >= 400) {
      return json({
        configured: true,
        error: { code: err.code, message: err.message },
      });
    }
    throw err;
  }
}
export async function adminJellyfin(ctx: AuthContext): Promise<Response> {
  try {
    return json(await getJellyfinStatus(ctx.config));
  } catch (err) {
    // Same as the Whisparr probe: upstream rejection is status information,
    // not a dead Velvarr session.
    if (err instanceof AppError && err.status >= 400) {
      return json({
        configured: true,
        error: { code: err.code, message: err.message },
      });
    }
    throw err;
  }
}

// --- catalog, requests, availability ---

export async function adminProviders(ctx: AuthContext): Promise<Response> {
  const [tpdb, stashdb] = await Promise.all([
    getProviderStatus("tpdb"),
    getProviderStatus("stashdb"),
  ]);
  return json({ providers: [tpdb, stashdb] });
}

// --- discover shelves + global search ---

// Wire shapes for the phase-3 UI. Response contracts only; contracts.ts stays
// domain records. Every shelf/category fails independently: one provider
// outage or storage error fills its own error field and never fails the page.
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["admin", "users"],
    auth: "admin",
    run: async (ctx) => adminUsers(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "users", ":id", "avatar"],
    auth: "admin",
    run: async (ctx, _request, p) => userAvatar(ctx, p.id!),
  },
  {
    method: "GET",
    segments: ["admin", "integrations"],
    auth: "admin",
    run: async (ctx) => json(integrationsShape(ctx.config)),
  },
  {
    method: "GET",
    segments: ["admin", "whisparr"],
    auth: "admin",
    run: async (ctx) => adminWhisparr(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "jellyfin"],
    auth: "admin",
    run: async (ctx) => adminJellyfin(ctx),
  },
  {
    method: "GET",
    segments: ["admin", "providers"],
    auth: "admin",
    run: async (ctx) => adminProviders(ctx),
  },
  {
    method: "POST",
    segments: ["admin", "users", "import"],
    auth: "admin",
    run: async (ctx, request) => adminImport(request, ctx),
  },
  {
    method: "PATCH",
    segments: ["admin", "users", ":id"],
    auth: "admin",
    run: async (ctx, request, p) => adminUpdateUser(request, ctx, p.id!),
  },
  {
    method: "PATCH",
    segments: ["admin", "integrations"],
    auth: "admin",
    run: async (ctx, request) => adminUpdateIntegrations(request, ctx),
  },
];
