import { createHash } from "node:crypto";
import type {
  Account,
  ExternalUser,
  IntegrationConfig,
} from "../../../lib/contracts.ts";
import {
  getConfig,
  getSession,
  revokeSession,
} from "../../../server/storage.ts";
import { readSessionToken } from "../../../server/security.ts";
import { AppError } from "../../../server/http.ts";
import { validateUser } from "../../../server/jellyfin.ts";

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

// Successful validations are cached for 60 s so a page of N images costs one
// /Users/Me round trip, not N. The promise is stored, so concurrent requests
// of one page share a single upstream call; rejections are never cached.
// ponytail: a Jellyfin-side disable, remote-access change or token revocation
// takes effect within 60 s instead of immediately; lower the TTL or drop the
// cache if that window matters.
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_CAP = 1000;
const sessionCache = new Map<
  string,
  { at: number; user: Promise<ExternalUser> }
>();

export function resetSessionCache(): void {
  sessionCache.clear();
}

function sessionCacheKey(config: IntegrationConfig, token: string): string {
  return createHash("sha256")
    .update(`${config.jellyfin.url}\n${token}`)
    .digest("hex");
}

function cachedUser(
  config: IntegrationConfig,
  token: string,
): Promise<ExternalUser> | undefined {
  const key = sessionCacheKey(config, token);
  const entry = sessionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(key);
    return undefined;
  }
  // Re-insert to keep FIFO eviction away from live entries.
  sessionCache.delete(key);
  sessionCache.set(key, entry);
  return entry.user;
}

function rememberUser(
  config: IntegrationConfig,
  token: string,
  user: Promise<ExternalUser>,
): void {
  const key = sessionCacheKey(config, token);
  sessionCache.delete(key);
  sessionCache.set(key, { at: Date.now(), user });
  while (sessionCache.size > SESSION_CACHE_CAP) {
    // Map preserves insertion order, so the first key is the oldest.
    sessionCache.delete(sessionCache.keys().next().value!);
  }
  // Failures must never be cached: a Jellyfin 401/403 still revokes the
  // session on the very next request.
  void user.catch(() => sessionCache.delete(key));
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
    let pending = cachedUser(config, session.jellyfinToken);
    if (!pending) {
      pending = validateUser(config, session.jellyfinToken);
      rememberUser(config, session.jellyfinToken, pending);
    }
    user = await pending;
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
