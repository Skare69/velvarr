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
import { relatedTitles } from "../../../server/related.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

const BODY_LIMIT_BYTES = 32 * 1024;
const JELLYFIN_ID =
  /^(?:[0-9a-f]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

interface AuthContext {
  config: IntegrationConfig;
  account: Account;
  token: string;
  rawSessionToken: string;
}

// --- response + parsing helpers ---

function json(
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

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return json(
      { error: { code: err.code, message: err.message } },
      err.status,
    );
  }
  return json(
    { error: { code: "internal", message: "Internal server error." } },
    500,
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT_BYTES) {
    throw new AppError(413, "payload_too_large", "Request body exceeds 32KiB.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(
      400,
      "invalid_body",
      "Request body must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

function fieldText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

function fieldUrl(body: Record<string, unknown>, key: string): string {
  return validateBaseUrl(fieldText(body, key, 2048));
}

function fieldBool(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return body[key] as boolean;
}

function fieldRole(body: Record<string, unknown>, key: string): Role {
  const value = body[key];
  if (value !== "admin" && value !== "moderator" && value !== "requester") {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value;
}

function fieldIds(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !JELLYFIN_ID.test(id))
  ) {
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  }
  return value as string[];
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

function requireId(raw: string): string {
  if (!JELLYFIN_ID.test(raw))
    throw new AppError(400, "invalid_id", "Invalid identifier.");
  return raw;
}

function optionalBool(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new AppError(400, "invalid_field", `Invalid ${key}.`);
  return value;
}

function queryInt(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw))
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError(400, "invalid_query", `Invalid ${key}.`);
  return value;
}

// --- environment-derived status ---

function setupReady(): boolean {
  return (
    /^[0-9a-fA-F]{64}$/.test(process.env.VELVARR_SECRET_KEY ?? "") &&
    (process.env.VELVARR_SETUP_SECRET ?? "").length >= 32
  );
}

// --- session / authorization ---

async function requireSession(request: Request): Promise<AuthContext> {
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

async function requireAdmin(request: Request): Promise<AuthContext> {
  const ctx = await requireSession(request);
  if (ctx.account.role !== "admin")
    throw new AppError(403, "forbidden", "Administrator access required.");
  return ctx;
}

// --- setup ---

interface SetupFields {
  username: string;
  password: string;
  jellyfinUrl: string;
  jellyfinExternalUrl: string;
  jellyfinApiKey: string;
}

function setupFields(body: Record<string, unknown>): SetupFields {
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
async function verifySetupSelection(fields: SetupFields): Promise<{
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

async function setupInspect(request: Request): Promise<Response> {
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

async function setupCommit(request: Request): Promise<Response> {
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

async function login(request: Request): Promise<Response> {
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
  const grant = createSession(account.id, token);
  return json({ account: grant.account }, 200, {
    "set-cookie": sessionCookie(grant, isSecureRequest(request)),
  });
}

async function logout(request: Request): Promise<Response> {
  await readJson(request);
  const raw = readSessionToken(request);
  if (raw) revokeSession(raw);
  return json({ ok: true }, 200, {
    "set-cookie": sessionCookie(undefined, isSecureRequest(request)),
  });
}

// --- user routes ---

async function me(ctx: AuthContext): Promise<Response> {
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
async function updatePreferences(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  return json(saveContentPreferences(ctx.account.id, await readJson(request)));
}

// Coarse per-user signal: does a provider integration exist at all. Real
// verification (verified flag + account) lives on the admin providers route;
// here an outage must never claim a configured provider vanished, and an
// unconfigured provider must never pretend otherwise.
async function providerPresence(
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

async function libraries(ctx: AuthContext): Promise<Response> {
  const views = await listLibraries(ctx.config, ctx.token);
  const grants = new Set(ctx.account.libraryIds);
  const configured = new Set(ctx.config.jellyfin.libraryIds);
  return json({
    libraries: views.filter(
      (library) => grants.has(library.id) && configured.has(library.id),
    ),
  });
}

async function libraryPage(
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

async function libraryItem(ctx: AuthContext, id: string): Promise<Response> {
  const item = await getLibraryItem(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return json({ item });
}

async function libraryImage(ctx: AuthContext, id: string): Promise<Response> {
  const image = await getLibraryImage(
    ctx.config,
    ctx.token,
    ctx.account,
    requireId(id),
  );
  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// --- admin routes ---

function integrationsShape(config: IntegrationConfig) {
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

function providerShape(
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

async function adminUsers(ctx: AuthContext): Promise<Response> {
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

async function adminUserAvatar(
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const image = await getUserImage(ctx.config, requireId(id));
  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.contentType,
      // Tag-keyed URL: a changed avatar is a different URL, so caching is safe.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

async function adminImport(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  await readJson(request);
  const imported = importAccounts(await listUsers(ctx.config));
  return json({ accounts: imported });
}

async function adminUpdateUser(
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
function nextProviderCredentials(
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
async function nextJellyfin(
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
function parseDelivery(raw: unknown): WhisparrDelivery | undefined {
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

function parsePathMappings(raw: unknown): WhisparrPathMapping[] | undefined {
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
function nextWhisparr(
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

async function adminUpdateIntegrations(
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

async function adminWhisparr(ctx: AuthContext): Promise<Response> {
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
async function adminJellyfin(ctx: AuthContext): Promise<Response> {
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

const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCatalogProvider(raw: string | null): CatalogProvider {
  if (raw === "tpdb" || raw === "stashdb") return raw;
  throw new AppError(400, "invalid_reference", "Unknown catalog provider.");
}
// Two signatures only: the stashdb narrowing one (its call site narrows the
// provider first and needs the narrow return) and the general one.
function parseCatalogKind(
  provider: "stashdb",
  raw: string,
): "scene" | "performer" | "studio";
function parseCatalogKind(provider: CatalogProvider, raw: string): CatalogKind;
function parseCatalogKind(provider: CatalogProvider, raw: string): CatalogKind {
  if (provider === "tpdb") {
    if (
      raw === "movie" ||
      raw === "scene" ||
      raw === "performer" ||
      raw === "studio"
    ) {
      return raw;
    }
    throw new AppError(400, "invalid_reference", "Unknown catalog kind.");
  }
  if (raw === "scene" || raw === "performer" || raw === "studio") return raw;
  throw new AppError(
    400,
    "invalid_reference",
    "StashDB hosts scenes, performers, and studios only.",
  );
}

// External provider identity for catalog routes, validated before any
// upstream call. Ids are canonical provider UUIDs, never the application's
// own catalog record id.
function parseCatalogReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): CatalogReference {
  const provider = parseCatalogProvider(providerRaw);
  const kind = parseCatalogKind(provider, kindRaw);
  if (!PROVIDER_UUID.test(idRaw)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Provider catalog ids must be UUIDs.",
    );
  }
  return { provider, kind, id: idRaw.toLowerCase() };
}

// CatalogReference is requestable media only when its kind is movie/scene;
// a performer is catalog-only and must never reach createRequest,
// getAcquisitionByReference, or the availability hints. Runtime check,
// never a cast.
function isMediaReference(
  reference: CatalogReference,
): reference is MediaReference {
  return reference.kind === "movie" || reference.kind === "scene";
}

function parseMediaReference(
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): MediaReference {
  const reference = parseCatalogReference(providerRaw, kindRaw, idRaw);
  if (!isMediaReference(reference)) {
    throw new AppError(
      400,
      "invalid_reference",
      "Performers and studios are not requestable media.",
    );
  }
  return reference;
}

function sameMedia(a: MediaReference, b: MediaReference): boolean {
  return (
    a.provider === b.provider &&
    a.kind === b.kind &&
    a.id.toLowerCase() === b.id.toLowerCase()
  );
}

// Shared provider-independent scalar validation for catalog search. The
// per-provider builders below explicitly reject filter combinations their
// provider cannot express — never silently ignored downstream.
interface CatalogSearchParams {
  q: string | null;
  year: number | undefined;
  performer: string | null;
  studio: string | null;
  studioMode: "exact" | "withChildren" | undefined;
  tags: string[] | undefined;
  tagsAll: string[] | undefined;
  tagsExclude: string[] | undefined;
  /** Bounded release-date filter, upstream-native `date` + `date_operation`
   * pair. Null when absent; the pair is always provided together. */
  date: string | null;
  dateOperation: ReleaseDateOperation | null;
  sort: CatalogSortKey | undefined;
  direction: CatalogSortDirection | undefined;
  page: number;
  perPage: number;
}

// Runtime check, never a cast: the vocabulary mirrors providers'
// CatalogSortKey so an unknown sort is the route's explicit 400.
// TPDB date_operation values verified live 2026-09-11: only these operator
// strings; word forms are an upstream 422.
function isTpdbDateOperation(v: string): v is ReleaseDateOperation {
  return ["<", "<=", "=", ">", ">="].includes(v);
}

// Runtime check, never a cast: the vocabulary mirrors providers'
// CatalogSortKey so an unknown sort is the route's explicit 400.
function isCatalogSortKey(v: string): v is CatalogSortKey {
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
function tagList(params: URLSearchParams, key: string): string[] | undefined {
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
const SORT_SUPPORT: Partial<
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

function supportedSort(
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

function catalogSearchParams(
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
function catalogSearchQuery(url: URL): CatalogSearchQuery {
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
function stashdbSearchQuery(
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
function tpdbSearchQuery(
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

async function catalogSearch(
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
async function browseRoute(
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
async function browseTagsRoute(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  return json(await searchBrowseTags(q));
}

// Tag facet lookup for the catalog filter UI: the provider's own ids and
// ordering come back verbatim — nothing is merged across providers and no
// counts are invented here. An empty result with a configured TypeSafe key
// gains judged suggestions: real tags chosen among the provider's own list,
// never invented ones.
async function catalogTagsRoute(
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
async function relatedRoute(
  ctx: AuthContext,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
  url: URL,
): Promise<Response> {
  const reference = parseMediaReference(providerRaw, kindRaw, idRaw);
  const rankRaw = url.searchParams.get("rank");
  if (rankRaw !== null && rankRaw !== "tags" && rankRaw !== "jev") {
    throw new AppError(400, "invalid_query", "rank must be tags or jev.");
  }
  return json(
    await relatedTitles(
      reference,
      getContentPreferences(ctx.account.id).hiddenTags,
      {
        rank: rankRaw === "jev" ? "jev" : "tags",
        typesafeApiKey: ctx.config.providers?.typesafeApiKey,
      },
    ),
  );
}

async function catalogDetail(
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
// private/no-store, nothing persisted, and no Velvarr or provider
// credentials ever reach the image host (fetchProviderArtwork sends none).
async function catalogImage(request: Request): Promise<Response> {
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
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // Provider logos include SVG, which is active content. Nothing here is
      // trusted markup: no script, no embedding, and never a top-level
      // document — so a hostile logo has nothing to execute against.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "content-disposition": "attachment",
    },
  });
}

// Server-validated MediaReference from a request body. A browser-supplied
// resolved payload is never trusted.
function mediaFromBody(body: Record<string, unknown>): MediaReference {
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
// With the autoApprove grant the request is decided approved immediately so
// shared acquisition work is enqueued; otherwise it stays pending for a
// moderator. No Whisparr call happens anywhere on this path.
async function createRequestRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const media = mediaFromBody(await readJson(request));
  const record = createRequest(ctx.account.id, media);
  if (ctx.account.autoApprove) {
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
function listRequestItems(ctx: AuthContext): RequestListItem[] {
  const staff =
    ctx.account.role === "admin" || ctx.account.role === "moderator";
  // One map lookup per row instead of one account fetch per row.
  const names = staff
    ? new Map(listAccounts().map((a) => [a.id, a.name]))
    : null;
  return listRequests(ctx.account).map((r) => {
    const item: RequestListItem = names
      ? { ...r, requestedBy: names.get(r.accountId) }
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

async function listRequestsRoute(ctx: AuthContext): Promise<Response> {
  return json({ requests: listRequestItems(ctx) });
}

async function decideRequestRoute(
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
function performerFromBody(body: Record<string, unknown>): CatalogReference {
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

async function listFollowsRoute(ctx: AuthContext): Promise<Response> {
  return json({ follows: listFollows(ctx.account.id) });
}

/** The same performer on the other provider, taken only from the link the
 * providers themselves published (crossProviderLink never name-matches), with
 * its own snapshot read from that provider. Null when there is no link, or
 * when the lookup fails: a metadata outage must not sink the follow the user
 * asked for. */
async function performerCounterpart(reference: CatalogReference): Promise<{
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
function followImage(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" && isProviderImageUrl(raw).ok
    ? raw
    : null;
}

async function createFollowRoute(
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

async function deleteFollowRoute(
  ctx: AuthContext,
  providerRaw: string,
  idRaw: string,
): Promise<Response> {
  const reference = parseCatalogReference(providerRaw, "performer", idRaw);
  unfollowPerformer(ctx.account.id, reference.provider, reference.id);
  return new Response(null, { status: 204 });
}

// --- bulk requests: everything a performer has ---

const BULK_REQUEST_CAP = 100;
// A provider page, not the cap: TPDB rejects (oversized response) a
// filmography page of 100 rows. 24 is what the browse surfaces request.
const BULK_SCAN_PAGE = 24;

async function bulkRequestRoute(
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
      if (ctx.account.autoApprove) {
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
function assertRemovalFlag(): void {
  if (process.env.VELVARR_ENABLE_REMOVAL !== "1") {
    throw new AppError(
      403,
      "removal_disabled",
      "Removals are turned off by the operator.",
    );
  }
}

function assertRemovalGrant(account: Account): void {
  if (account.canRemove !== true) {
    throw new AppError(
      403,
      "account_not_admitted",
      "only admitted accounts holding the removal grant may request removals",
    );
  }
}

function assertRemovalApprover(account: Account): void {
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
async function listRemovalsRoute(ctx: AuthContext): Promise<Response> {
  return json({
    removals: listRemovalRequests(ctx.account),
    enabled: process.env.VELVARR_ENABLE_REMOVAL === "1",
  });
}

// Creation accepts exactly {media, reason}. A level key is refused outright
// and no code path reads one: the level is the approver's choice by
// construction, not an ignored field.
async function createRemovalRoute(
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
async function decideRemovalRoute(
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
async function libraryNameOf(
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
async function removalImpact(
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
async function performerHint(
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
async function availability(
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
async function adminProviders(ctx: AuthContext): Promise<Response> {
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
interface ShelfError {
  code: string;
  message: string;
}

// One tile of a unified Studios/Genres rail. `provider`+`id` are native to
// the snapshot side the tile came from — the grid a tile opens queries each
// side with its own id, so one rail mixes TPDB movies and StashDB scenes.
// `linked` is the counterpart on the other provider, present only when it
// genuinely resolved: a studio link the providers themselves published, or
// exact normalized-name tag equality (a label matched to a label — the one
// documented deterministic pairing, never a name guess).
interface FacetItem {
  facet: "studio" | "tag";
  provider: CatalogProvider;
  id: string;
  name: string;
  imageUrl?: string;
  /** Studio brand mark only — never the poster under another name. */
  logoUrl?: string;
  linked?: { provider: CatalogProvider; id: string };
}

interface Shelf {
  id: string;
  title: string;
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  /** Honest one-line provenance, e.g. trending is a StashDB-only signal. */
  description?: string;
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests" | "facets";
  items?: CatalogDetail[] | LibraryItem[] | RequestRecord[] | FacetItem[];
  /** Per-source partial-failure evidence; items may coexist with it. */
  errors?: SourceError[];
  error?: ShelfError;
}

interface SearchCategory {
  id: string;
  provider: "tpdb" | "stashdb";
  kind: CatalogKind;
  items: CatalogDetail[];
  error?: ShelfError;
}

// AppError codes pass through verbatim so "not configured" stays distinct
// from "unavailable" at the UI; anything unknown is a bare internal error.
function shelfError(err: unknown): ShelfError {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  return { code: "internal", message: "Internal server error." };
}

// The partial-source wire shape: the failed provider named on the error,
// its code preserved verbatim.
function sourceError(provider: "tpdb" | "stashdb", err: unknown): SourceError {
  return { provider, ...shelfError(err) };
}

const SHELF_ITEMS = 12;
const SEARCH_PER_PAGE = 6;
const FOLLOW_SHELF_PERFORMERS = 5;

// First page of each followed performer's title filmography, merged within
// ONE provider and capped at SHELF_ITEMS. Partial failure survives: pages
// that failed are dropped, and the shelf only reports an error when every
// page failed — nothing truthful to show beats a quiet empty list.
async function followedTitles(
  accountId: string,
  provider: CatalogProvider,
): Promise<CatalogDetail[]> {
  const follows = listFollowsByProvider(
    accountId,
    provider,
    FOLLOW_SHELF_PERFORMERS,
  );
  const pages = await Promise.allSettled(
    follows.map((follow) =>
      (provider === "tpdb"
        ? // TPDB's filmography route is paging-only: no sort exists there.
          searchCatalog({
            provider: "tpdb",
            kind: "movie",
            performer: follow.reference.id,
            page: 1,
            perPage: SHELF_ITEMS,
          })
        : searchCatalog({
            provider: "stashdb",
            kind: "scene",
            performer: follow.reference.id,
            sort: "date",
            direction: "desc",
            page: 1,
            perPage: SHELF_ITEMS,
          })
      ).then((page) => page.items),
    ),
  );
  const items: CatalogDetail[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (const page of pages) {
    if (page.status === "rejected") {
      failed = true;
      continue;
    }
    for (const item of page.value) {
      // Two followed performers can share a title; keep one copy.
      if (seen.has(item.reference.id)) continue;
      seen.add(item.reference.id);
      items.push(item);
    }
  }
  if (items.length === 0 && failed) {
    throw (pages.find((p) => p.status === "rejected") as PromiseRejectedResult)
      .reason;
  }
  return items.slice(0, SHELF_ITEMS);
}

// The one "From performers you follow" rail across BOTH providers. Sides
// settle independently: the surviving side's titles still render beside a
// visible partial-source warning, and the shelf errors only when both sides
// failed. Hidden tags apply here too — a fully hidden filmography leaves
// nothing to show, so the rail disappears. An account that follows nobody
// gets no rail at all.
async function followedShelf(
  accountId: string,
  hiddenTags: CatalogTagSelection[],
): Promise<Shelf | null> {
  const sides = await Promise.allSettled([
    followedTitles(accountId, "tpdb"),
    followedTitles(accountId, "stashdb"),
  ]);
  const errors: SourceError[] = [];
  const merged: CatalogDetail[] = [];
  sides.forEach((side, i) => {
    const provider = i === 0 ? ("tpdb" as const) : ("stashdb" as const);
    if (side.status === "fulfilled") {
      merged.push(
        ...side.value.filter((item) => !isHiddenTitle(item, hiddenTags)),
      );
    } else errors.push(sourceError(provider, side.reason));
  });
  if (merged.length === 0 && errors.length === 0) return null;
  const base = {
    id: "followed-titles",
    title: "From performers you follow",
    source: "velvarr" as const,
    kind: "catalog" as const,
    browse: { view: "following", params: {} },
  };
  if (merged.length === 0) {
    // Every side the account actually follows failed: the error-only shape,
    // never a quiet empty list.
    const firstFailure = sides.find(
      (side): side is PromiseRejectedResult => side.status === "rejected",
    );
    return { ...base, error: shelfError(firstFailure?.reason) };
  }
  return {
    ...base,
    items: dedupeTitles(merged).slice(0, SHELF_ITEMS),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// Provider-aware dedupe for the merged rail: a title two followed performers
// share appears once. Identity is the provider-native reference itself —
// scenes and movies are never equated across providers, and no name
// matching is ever applied.
function dedupeTitles(items: CatalogDetail[]): CatalogDetail[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key =
      `${item.reference.provider}:${item.reference.kind}:` +
      item.reference.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ShelfItems =
  CatalogDetail[] | LibraryItem[] | RequestRecord[] | FacetItem[];

function shelfOf(
  base: Omit<Shelf, "items" | "error">,
  result: PromiseSettledResult<ShelfItems>,
): Shelf {
  return result.status === "fulfilled"
    ? { ...base, items: result.value }
    : // An errored shelf carries no items at all: never an empty list that
      // could render as a quiet success.
      { ...base, error: shelfError(result.reason) };
}

// Mixed-source shelves built from a browse page: items render together with
// per-source error evidence; a page that failed BOTH sources collapses to
// the error-only shape — all-source failure stays visible, never an empty
// success. One source failing with the other merely empty keeps the honest
// errors warning.
function browseShelf(
  base: Omit<Shelf, "items" | "error" | "errors">,
  result: PromiseSettledResult<BrowsePage>,
): Shelf {
  if (result.status === "rejected")
    return { ...base, error: shelfError(result.reason) };
  const page = result.value;
  if (page.items.length === 0 && page.errors.length > 0) {
    const down = new Set(page.errors.map((error) => error.provider));
    if (down.has("tpdb") && down.has("stashdb")) {
      return {
        ...base,
        error: {
          code: page.errors[0]!.code,
          message: "Neither TPDB nor StashDB could be read.",
        },
      };
    }
  }
  return {
    ...base,
    items: page.items,
    ...(page.errors.length > 0 ? { errors: page.errors } : {}),
  };
}

// Genre facets from one provider's snapshot: unique provider-native tag ids
// in first-seen order, artwork only from an item that carries the tag. Non-
// UUID tag ids are omitted — every tile must survive the route's tag-filter
// validation as a real click-through. Artwork upgrades from later items when
// the first carrier had no image, and each facet takes a different carrier
// (ordinal % carriers) so twelve facets don't all wear the same cover.
// Studio facets resolve through the cached provider detail read so logos
// render; a failed or absent read keeps the known name/reference as a
// name-only tile — never an invented logo, and an enrich failure never sinks
// the shelf.
// ponytail: bounded recent/trending snapshot (SHELF_ITEMS unique ids, no
// popularity invented); a full directory listing only if a browse surface
// ever needs one.
function genreFacets(
  items: CatalogDetail[],
): Pick<FacetItem, "id" | "name" | "imageUrl">[] {
  const names = new Map<string, string>();
  const art = new Map<string, string[]>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!PROVIDER_UUID.test(tag.id)) continue;
      if (!names.has(tag.id)) {
        names.set(tag.id, tag.name);
        art.set(tag.id, []);
      }
      if (item.imageUrl !== undefined) art.get(tag.id)?.push(item.imageUrl);
    }
  }
  return [...names].slice(0, SHELF_ITEMS).map(([id, name], i) => {
    const carriers = art.get(id) ?? [];
    const imageUrl =
      carriers.length > 0 ? carriers[i % carriers.length] : undefined;
    return { id, name, ...(imageUrl !== undefined ? { imageUrl } : {}) };
  });
}

function studioFacets(
  provider: CatalogProvider,
  items: CatalogDetail[],
): Promise<CatalogDetail[]> {
  const known = new Map<
    string,
    { reference: CatalogReference; name: string }
  >();
  for (const item of items) {
    const studio = item.studio;
    const reference = studio?.reference;
    if (
      studio !== undefined &&
      reference !== undefined &&
      reference.provider === provider &&
      !known.has(reference.id)
    ) {
      known.set(reference.id, { reference, name: studio.name });
    }
  }
  const nameOnly = (
    reference: CatalogReference,
    name: string,
  ): CatalogDetail => ({
    reference,
    title: name,
    credits: [],
    tags: [],
    related: [],
    links: [],
    aliases: [],
  });
  return Promise.all(
    [...known.values()].slice(0, SHELF_ITEMS).map(({ reference, name }) =>
      getCatalogDetail(reference).then(
        (detail) => detail ?? nameOnly(reference, name),
        // Detail read failed: the name/reference survived the snapshot, the
        // logo did not. Degraded tile, not a shelf error.
        () => nameOnly(reference, name),
      ),
    ),
  );
}

// The two unified facet rails derive from the new-releases browse page —
// which is already hidden-tag filtered, so blocked catalog imagery can never
// reappear as facet art. A side that failed its half of the page simply
// contributes nothing (the page's own errors report the outage); both sides
// failing surfaces one error per facet shelf and no items — never a
// half-filled rail that could read as a quiet success.
function facetShelves(
  newReleases: PromiseSettledResult<BrowsePage>,
): Promise<Shelf[]> {
  let error: ShelfError | undefined;
  let items: CatalogDetail[] = [];
  if (newReleases.status === "rejected") {
    // shelfError keeps the upstream code (not configured vs outage); the
    // message names the shelf's own truth: no snapshot from either side.
    error = {
      ...shelfError(newReleases.reason),
      message: "Neither TPDB nor StashDB could be read.",
    };
  } else {
    const page = newReleases.value;
    items = page.items;
    if (items.length === 0 && page.errors.length > 0) {
      const down = new Set(page.errors.map((entry) => entry.provider));
      if (down.has("tpdb") && down.has("stashdb")) {
        error = {
          code: page.errors[0]!.code,
          message: "Neither TPDB nor StashDB could be read.",
        };
      }
    }
  }
  if (error !== undefined) {
    return Promise.resolve([
      {
        id: "studios",
        title: "Studios",
        source: "velvarr",
        kind: "facets",
        error,
      },
      {
        id: "genres",
        title: "Genres",
        source: "velvarr",
        kind: "facets",
        error,
      },
    ]);
  }
  const sources = (["tpdb", "stashdb"] as const)
    .map((provider) => ({
      provider,
      items: items.filter((item) => item.reference.provider === provider),
    }))
    .filter((source) => source.items.length > 0);
  return Promise.all([
    facetShelf("studios", sources),
    facetShelf("genres", sources),
  ]);
}

async function facetShelf(
  shelf: "studios" | "genres",
  sources: { provider: CatalogProvider; items: CatalogDetail[] }[],
): Promise<Shelf> {
  const perSource = await Promise.all(
    sources.map(async ({ provider, items }) => ({
      provider,
      tiles:
        shelf === "studios"
          ? (await studioFacets(provider, items)).map((detail): FacetItem => ({
              facet: "studio",
              provider,
              id: detail.reference.id,
              name: detail.title,
              ...(detail.logoUrl !== undefined
                ? { logoUrl: detail.logoUrl }
                : {}),
              ...(detail.imageUrl !== undefined
                ? { imageUrl: detail.imageUrl }
                : {}),
            }))
          : genreFacets(items).map((tile): FacetItem => ({
              facet: "tag",
              provider,
              ...tile,
            })),
    })),
  );
  // Alternate the providers' tiles so the cap leaves room for both sides.
  const candidates: FacetItem[] = [];
  for (let i = 0; i < SHELF_ITEMS; i++) {
    for (const { tiles } of perSource) {
      const tile = tiles[i];
      if (tile !== undefined) candidates.push(tile);
    }
  }
  const emitted = candidates.slice(0, SHELF_ITEMS);
  let items = emitted;
  if (shelf === "studios") {
    // StashDB->TPDB reads the link the studio record itself publishes (the
    // detail studioFacets just cached), so it is free to run pre-dedupe; the
    // TPDB->StashDB direction is a per-tile network query and waits until
    // identity-dedupe and the cap have picked the survivors.
    const stashTiles = emitted.filter((tile) => tile.provider === "stashdb");
    await resolveLinked(stashTiles);
    const publishedTpdb = new Set(
      stashTiles.flatMap((tile) =>
        tile.linked !== undefined ? [tile.linked.id.toLowerCase()] : [],
      ),
    );
    // Drop a TPDB tile only when a StashDB tile published that exact studio
    // as its counterpart — never by name: two same-named studios without a
    // published link stay two tiles.
    items = publishedTpdb.size
      ? emitted.filter(
          (tile) =>
            tile.provider !== "tpdb" ||
            !publishedTpdb.has(tile.id.toLowerCase()),
        )
      : emitted;
  } else {
    // Categories dedupe by exact normalized name: the first-seen tile stays
    // and the dropped side's id becomes its linked.
    const seen = new Map<string, FacetItem>();
    items = [];
    for (const tile of emitted) {
      const key = normalizeFacetName(tile.name);
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, tile);
        items.push(tile);
      } else if (prior.linked === undefined) {
        prior.linked = { provider: tile.provider, id: tile.id };
      }
    }
  }
  // Counterparts for everything the local dedupe could not pair — network
  // reads issued only for tiles that survived the cap.
  await resolveLinked(items);
  return {
    id: shelf,
    title: shelf === "studios" ? "Studios" : "Genres",
    source: "velvarr",
    kind: "facets",
    items,
  };
}

// Resolves each tile's cross-provider counterpart, settled: a rejection or
// an absent counterpart just leaves `linked` off the tile.
async function resolveLinked(tiles: FacetItem[]): Promise<void> {
  const missing = tiles.filter((tile) => tile.linked === undefined);
  const settled = await Promise.allSettled(
    missing.map((tile) =>
      tile.facet === "studio"
        ? studioCounterpart({
            provider: tile.provider,
            kind: "studio",
            id: tile.id,
          })
        : tagCounterpart(tile.provider, tile.name),
    ),
  );
  settled.forEach((result, i) => {
    const tile = missing[i];
    if (tile && result.status === "fulfilled" && result.value !== undefined) {
      tile.linked = {
        provider: result.value.provider,
        id: result.value.id,
      };
    }
  });
}

async function discover(ctx: AuthContext): Promise<Response> {
  // UTC server date: the shared "today" cutoff for the mixed New releases
  // rail and its browse-all link.
  const today = new Date().toISOString().slice(0, 10);
  // One preferences read feeds both the hidden-tag filter and the shelf
  // order; the shelves themselves assemble in registry order first.
  const { hiddenTags, discoverOrder } = getContentPreferences(ctx.account.id);
  const [newReleases, trending, recentlyAdded, requests] =
    await Promise.allSettled([
      // Built through the browse parser so the rail and its own browse link
      // are provably the same query. Native provider filters carry the date
      // bound; hidden tags apply before anything downstream is derived.
      browseTitles(
        parseBrowseQuery(
          new URLSearchParams({
            type: "all",
            sort: "recency",
            direction: "desc",
            date: today,
            date_operation: "<=",
            page: "1",
            perPage: String(SHELF_ITEMS),
          }),
        ),
        hiddenTags,
      ),
      // Trending is honestly a StashDB-only signal: TPDB publishes no
      // trend data, so nothing pretends otherwise. Single source, so a
      // failure is the shelf's own rejection.
      searchVisibleCatalog(
        {
          provider: "stashdb",
          kind: "scene",
          sort: "trending",
          direction: "desc",
          page: 1,
          perPage: SHELF_ITEMS,
        },
        hiddenTags,
      ).then((page) => page.items),
      listRecentlyAddedItems(ctx.config, ctx.token, ctx.account, SHELF_ITEMS),
      // storage is sync; defer so its failures settle like the rest. Capped
      // like every other shelf: a bulk performer request can file a hundred
      // intents at once, and a rail is not a list view. The rows carry the
      // shared acquisition state so the rail's badge tells the truth.
      Promise.resolve().then(() => listRequestItems(ctx).slice(0, SHELF_ITEMS)),
    ]);
  // Appended only when this account follows someone (or a side failed): an
  // account with no follows gets exactly the standard shelves.
  const followed = await followedShelf(ctx.account.id, hiddenTags);
  const shelves: Shelf[] = [
    browseShelf(
      {
        id: "new-releases",
        title: "New releases",
        description: "Newest TPDB movies and StashDB scenes",
        source: "velvarr",
        kind: "catalog",
        browse: {
          view: "titles",
          params: {
            type: "all",
            sort: "recency",
            direction: "desc",
            date: today,
            date_operation: "<=",
          },
        },
      },
      newReleases,
    ),
    shelfOf(
      {
        id: "trending",
        title: "Trending now",
        description: "Scene trends from StashDB",
        source: "stashdb",
        kind: "catalog",
        browse: {
          view: "titles",
          params: { type: "scene", sort: "trending", direction: "desc" },
        },
      },
      trending,
    ),
    shelfOf(
      {
        id: "jellyfin-recent",
        title: "Recently added in your libraries",
        source: "jellyfin",
        kind: "library",
        browse: { view: "library", params: {} },
      },
      recentlyAdded,
    ),
    shelfOf(
      {
        id: "velvarr-requests",
        title: "Recent requests",
        source: "velvarr",
        kind: "requests",
        browse: { view: "requests", params: {} },
      },
      requests,
    ),
    ...(await facetShelves(newReleases)),
    ...(followed === null ? [] : [followed]),
  ];
  // Per-account order over the PRESENT shelves only: a shelf the account
  // cannot fill (no follows) stays absent — never a fake rail, and the
  // saved order itself is untouched. Array#sort is stable, so any id the
  // saved order does not know (a shelf newer than this account's stored
  // order) keeps its assembled position after the ranked ones.
  const rank = new Map<string, number>(
    discoverOrder.map((id, i) => [id, i] as const),
  );
  shelves.sort(
    (a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size),
  );
  return json({ shelves });
}

function categoryOf(
  id: string,
  provider: "tpdb" | "stashdb",
  kind: CatalogKind,
  result: PromiseSettledResult<CatalogDetail[]>,
): SearchCategory {
  return result.status === "fulfilled"
    ? { id, provider, kind, items: result.value }
    : { id, provider, kind, items: [], error: shelfError(result.reason) };
}

async function globalSearch(
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
type Route =
  | { auth: "none"; run: () => Promise<Response> }
  | { auth: "session" | "admin"; run: (ctx: AuthContext) => Promise<Response> };

const openRoute = (run: () => Promise<Response>): Route => ({
  auth: "none",
  run,
});
const signedIn = (run: (ctx: AuthContext) => Promise<Response>): Route => ({
  auth: "session",
  run,
});
const staffOnly = (run: (ctx: AuthContext) => Promise<Response>): Route => ({
  auth: "admin",
  run,
});

// Pure match: one line per route, no admission and no upstream contact here.
// The open routes are the whole pre-session surface — a status probe, a health
// check, the setup handshake, and login/logout.
function routeFor(
  request: Request,
  segments: string[],
  method: string,
): Route | null {
  if (segments[0] !== "api") return null;
  const root = segments[1];
  const a = segments[2];
  const b = segments[3];
  if (method === "GET") {
    if (root === "status" && segments.length === 2)
      return openRoute(async () =>
        json({ initialized: isInitialized(), setupReady: setupReady() }),
      );
    if (root === "health" && segments.length === 2)
      return openRoute(async () => json({ ok: true }));
    if (root === "me" && segments.length === 2) return signedIn(me);
    if (root === "me" && a === "preferences" && segments.length === 3)
      return signedIn(async (ctx) =>
        json(getContentPreferences(ctx.account.id)),
      );
    if (root === "browse" && segments.length === 2)
      return signedIn((ctx) => browseRoute(request, ctx));
    if (root === "browse" && a === "tags" && segments.length === 3)
      return signedIn(() => browseTagsRoute(request));
    if (root === "libraries" && segments.length === 2)
      return signedIn(libraries);
    if (root === "library" && segments.length === 2)
      return signedIn((ctx) => libraryPage(request, ctx));
    if (root === "library" && segments.length === 3)
      return signedIn((ctx) => libraryItem(ctx, segments[2]!));
    if (root === "images" && segments.length === 3)
      return signedIn((ctx) => libraryImage(ctx, segments[2]!));
    if (root === "catalog" && a === "search" && segments.length === 3)
      return signedIn((ctx) => catalogSearch(request, ctx));
    // Related resolves before the generic detail match below it.
    if (
      root === "catalog" &&
      segments.length === 6 &&
      segments[5] === "related"
    )
      return signedIn((ctx) =>
        relatedRoute(ctx, a!, b!, segments[4]!, new URL(request.url)),
      );
    if (root === "catalog" && a === "image" && segments.length === 3)
      return signedIn(() => catalogImage(request));
    if (root === "catalog" && a === "tags" && segments.length === 3)
      return signedIn((ctx) => catalogTagsRoute(request, ctx.config));
    if (root === "catalog" && segments.length === 5)
      return signedIn((ctx) => catalogDetail(ctx, a!, b!, segments[4]!));
    if (root === "requests" && segments.length === 2)
      return signedIn(listRequestsRoute);
    if (root === "discover" && segments.length === 2) return signedIn(discover);
    if (root === "follows" && segments.length === 2)
      return signedIn(listFollowsRoute);
    if (root === "search" && segments.length === 2)
      return signedIn((ctx) => globalSearch(request, ctx));
    if (root === "availability" && segments.length === 5)
      return signedIn((ctx) => availability(ctx, a!, b!, segments[4]!));
    if (root === "removals" && segments.length === 2)
      return signedIn(listRemovalsRoute);
    if (root === "removals" && a === "impact" && segments.length === 3)
      return signedIn((ctx) => removalImpact(request, ctx));
    if (
      root === "admin" &&
      a === "users" &&
      segments[4] === "avatar" &&
      segments.length === 5
    )
      return staffOnly((ctx) => adminUserAvatar(ctx, segments[3]!));
    if (root === "admin" && a === "users" && segments.length === 3)
      return staffOnly(adminUsers);
    if (root === "admin" && a === "integrations" && segments.length === 3)
      return staffOnly(async (ctx) => json(integrationsShape(ctx.config)));
    if (root === "admin" && a === "whisparr" && segments.length === 3)
      return staffOnly(adminWhisparr);
    if (root === "admin" && a === "jellyfin" && segments.length === 3)
      return staffOnly(adminJellyfin);
    if (root === "admin" && a === "providers" && segments.length === 3)
      return staffOnly(adminProviders);
  } else if (method === "POST") {
    if (root === "setup" && a === "inspect" && segments.length === 3)
      return openRoute(() => setupInspect(request));
    if (root === "setup" && segments.length === 2)
      return openRoute(() => setupCommit(request));
    if (root === "login" && segments.length === 2)
      return openRoute(() => login(request));
    if (root === "logout" && segments.length === 2)
      return openRoute(() => logout(request));
    if (
      root === "admin" &&
      a === "users" &&
      b === "import" &&
      segments.length === 4
    )
      return staffOnly((ctx) => adminImport(request, ctx));
    if (root === "requests" && segments.length === 2)
      return signedIn((ctx) => createRequestRoute(request, ctx));
    if (root === "requests" && a === "bulk" && segments.length === 3)
      return signedIn((ctx) => bulkRequestRoute(request, ctx));
    if (root === "follows" && segments.length === 2)
      return signedIn((ctx) => createFollowRoute(request, ctx));
    if (root === "removals" && segments.length === 2)
      return signedIn((ctx) => createRemovalRoute(request, ctx));
  } else if (method === "PATCH") {
    if (root === "me" && a === "preferences" && segments.length === 3)
      return signedIn((ctx) => updatePreferences(request, ctx));
    if (root === "admin" && a === "users" && segments.length === 4)
      return staffOnly((ctx) => adminUpdateUser(request, ctx, segments[3]!));
    if (root === "requests" && segments.length === 3)
      return signedIn((ctx) => decideRequestRoute(request, ctx, segments[2]!));
    if (root === "removals" && segments.length === 3)
      return signedIn((ctx) => decideRemovalRoute(request, ctx, segments[2]!));
    if (root === "admin" && a === "integrations" && segments.length === 3)
      return staffOnly((ctx) => adminUpdateIntegrations(request, ctx));
  } else if (method === "DELETE") {
    if (root === "follows" && segments.length === 4)
      return signedIn((ctx) => deleteFollowRoute(ctx, a!, b!));
  }
  return null;
}

// Segments come from the request URL, not `context.params`: Next strips the
// static `/api` prefix from a catch-all's params, so trusting params made every
// route 404 in a real server while direct-handler tests passed.
async function dispatch(request: Request, method: string): Promise<Response> {
  try {
    const segments = new URL(request.url).pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    // The one origin-CSRF gate: runs before matching and before admission on
    // every mutation, keeping the first-failure precedence it had when each
    // handler called it, and a future mutating route cannot ship without it.
    if (method !== "GET") guardMutation(request);
    const route = routeFor(request, segments, method);
    if (!route) throw new AppError(404, "not_found", "Unknown route.");
    // Admission resolved once, here, for every route that declares it.
    if (route.auth === "none") return await route.run();
    return await route.run(
      route.auth === "admin"
        ? await requireAdmin(request)
        : await requireSession(request),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  return dispatch(request, "GET");
}

export async function POST(request: Request): Promise<Response> {
  return dispatch(request, "POST");
}

export async function PATCH(request: Request): Promise<Response> {
  return dispatch(request, "PATCH");
}

export async function DELETE(request: Request): Promise<Response> {
  return dispatch(request, "DELETE");
}
