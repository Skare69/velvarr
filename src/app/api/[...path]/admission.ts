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

// --- per-account rate budget ---
// One household shares the TPDB/StashDB credentials: an unbounded loop of
// provider reads from one member session (or a stolen one) can drain the
// shared quota and starve discovery and search for every other account. A
// token bucket per account id, charged at dispatch on `metered` routes
// (those that read the provider APIs) before the handler runs, bounds the
// request rate; the providers' own throttles stay the only bound
// inside one request (a single filtered browse may still fan out to its scan
// ceiling). In-memory per process like every limiter here; a restart resets.
export const RATE_BURST = 60;
export const RATE_REFILL_PER_MINUTE = 30;
const RATE_BUCKETS_CAP = 256;
const rateBuckets = new Map<string, { tokens: number; at: number }>();

/** Test hook: the buckets are module-global, so a flood test would otherwise
 * leak a drained budget into every later test on the same account. */
export function resetRateBuckets(): void {
  rateBuckets.clear();
}

export function chargeRateBudget(accountId: string): void {
  const now = Date.now();
  let bucket = rateBuckets.get(accountId);
  if (bucket) {
    bucket.tokens = Math.min(
      RATE_BURST,
      // A wall-clock step backwards must not turn a full bucket negative.
      Math.max(bucket.tokens, 0) +
        ((now - bucket.at) / 60_000) * RATE_REFILL_PER_MINUTE,
    );
    bucket.at = now;
  } else {
    bucket = { tokens: RATE_BURST, at: now };
  }
  if (bucket.tokens < 1) {
    throw new AppError(
      429,
      "rate_limited",
      "Too many requests; slow down and try again shortly.",
    );
  }
  bucket.tokens -= 1;
  // Re-insert so the FIFO cap evicts idle accounts, never live ones.
  rateBuckets.delete(accountId);
  rateBuckets.set(accountId, bucket);
  while (rateBuckets.size > RATE_BUCKETS_CAP) {
    rateBuckets.delete(rateBuckets.keys().next().value!);
  }
}

// The route declaration contract: admission is part of the route type, so a
// new route cannot ship without declaring none|session|admin. `segments`
// exclude the `/api` prefix; a segment starting with `:` captures one
// path parameter. Matching is exact (method + count + literal/:param), so no
// entry can shadow another. `metered` marks routes whose handlers read the
// shared TPDB/StashDB APIs: those are the only requests the per-account
// budget bounds. Local reads (shell, requests, follows, library, artwork
// proxies, admin) stay uncharged, so a normal page load with its dozens of
// poster images can never drain the bucket.
export type RouteDef = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  segments: string[];
  auth: "open" | "session" | "admin";
  run: (
    ctx: AuthContext,
    request: Request,
    params: Record<string, string>,
  ) => Promise<Response>;
  metered?: boolean;
};
