import {
  readJson,
  fieldText,
  fieldUrl,
  fieldIds,
  optionalText,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import type {
  ExternalUser,
  IntegrationConfig,
  Library,
  ProviderStatus,
} from "../../../../lib/contracts.ts";
import {
  bootstrap,
  createSession,
  getAccount,
  getConfig,
  hasAccountNamed,
  getContentPreferences,
  isInitialized,
  revokeSession,
  saveContentPreferences,
  refreshAccountName,
} from "../../../../server/storage.ts";
import {
  assertLoginAllowed,
  recordLoginFailure,
  reserveLoginAttempt,
  readSessionToken,
  sessionCookie,
  isSecureRequest,
  verifySetupSecret,
} from "../../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../../server/http.ts";
import {
  authenticate,
  getServer,
  listLibraries,
  listUsers,
} from "../../../../server/jellyfin.ts";
import { getProviderStatus } from "../../../../server/providers.ts";
import { availableUpdate } from "../../../../server/update.ts";

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

// The client address as reported by the hop in front of Velvarr, for the
// failed sign-in audit line. Direct LAN callers without a proxy have none;
// the header is client-controlled until a trusted proxy overwrites it, so
// the line is evidence to correlate, not attribution.
function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}

// Login limiter wiring, shared by every route that authenticates a name:
// the gate is checked read-only before the attempt; in the same
// synchronous step the attempt reserves the per-account slot always and,
// for non-admitted names, a global spray slot. A credential rejection
// ("upstream_auth") keeps both charges; for admitted names it also charges
// the global spray cap via recordLoginFailure, and it leaves a warn audit
// line with the attempted name and the JSON-encoded reported client ip
// (never the password); a success or a non-credential error (upstream
// outage, malformed fields) refunds both slots — only real guesses consume
// budget. Callers that
// authenticate an admitted Velvarr account pass admitted=true so a
// rotating-name sprayer filling the global bucket cannot lock the
// household out; setup paths keep the cap fully (no accounts exist before
// initialization).
async function guardedAuthentication<T>(
  name: string,
  attempt: () => Promise<T>,
  admitted = false,
  ip = "unknown",
): Promise<T> {
  assertLoginAllowed(name, admitted);
  const refund = reserveLoginAttempt(name, admitted);
  try {
    const result = await attempt();
    refund();
    return result;
  } catch (e) {
    if (e instanceof AppError && e.code === "upstream_auth") {
      // JSON.stringify keeps an attacker-chosen name on one log line.
      console.warn(
        `[auth] failed sign-in attempt: account=${JSON.stringify(name)} ip=${JSON.stringify(ip)}`,
      );
      if (admitted) recordLoginFailure();
    } else refund();
    throw e;
  }
}

// The setup secret is the only credential on a not-yet-bootstrapped
// instance, so a wrong guess must cost what a wrong password costs: the
// same login limiter, keyed by the reported source address instead of an
// account name (no accounts exist before setup). The read-only gate
// answers 429 when the per-source bucket is exhausted; the reservation
// holds a per-source slot plus a global spray slot in the same synchronous
// step, so parallel guesses cannot all pass uncounted. A wrong secret
// keeps both charges; a correct one refunds them like any non-guess.
function guardedSetupSecret(request: Request, check: () => void): void {
  const ip = clientIp(request);
  assertLoginAllowed(ip, false);
  const refund = reserveLoginAttempt(ip, false);
  try {
    check();
    refund();
  } catch (e) {
    if (e instanceof AppError && e.code === "setup_secret_invalid") {
      console.warn(
        `[auth] failed setup-secret attempt: ip=${JSON.stringify(ip)}`,
      );
    } else refund();
    throw e;
  }
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
  guardedSetupSecret(request, () => verifySetupSecret(body.setupSecret));
  const fields = setupFields(body);
  const selection = await guardedAuthentication(
    fields.username,
    () => verifySetupSelection(fields),
    false,
    clientIp(request),
  );
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
  guardedSetupSecret(request, () => verifySetupSecret(body.setupSecret));
  const fields = setupFields(body);
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
  const selection = await guardedAuthentication(
    fields.username,
    () => verifySetupSelection(fields),
    false,
    clientIp(request),
  );
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
  const config = getConfig();
  if (!config)
    throw new AppError(409, "not_initialized", "Setup has not been completed.");
  const { user, token } = await guardedAuthentication(
    username,
    () => authenticate(config.jellyfin.url, username, password),
    hasAccountNamed(username),
    clientIp(request),
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
    segments: ["update"],
    auth: "open",
    run: async () => json({ update: await availableUpdate() }),
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
