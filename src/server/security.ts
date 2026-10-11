import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionGrant } from "../lib/contracts.ts";
import { AppError, isLoopbackHost, isPrivateHost } from "./http.ts";

const COOKIE_NAME = "velvarr_session";

// Login attempt limiter: one process-global bucket plus one per account name,
// fixed five-minute windows. ponytail: in-memory only, resets on restart —
// durable counters only if abuse survives process restarts.
const WINDOW_MS = 5 * 60_000;
// Last-resort spray cap, not the primary defense: far above any household's
// legitimate login traffic, low enough to stop a username-spraying bot from
// hammering unknown names. Admitted names are exempt from this cap and
// bounded by ACCOUNT_LIMIT instead.
const GLOBAL_LIMIT = 300;
const ACCOUNT_LIMIT = 5;
const MAX_BUCKETS = 1024;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

// HTTPS upgrade for the session cookie comes from the request, not from a
// pinned origin: behind any https reverse proxy (X-Forwarded-Proto) or direct
// https URL the cookie gains Secure; plain LAN http legitimately cannot have
// it (browsers drop Secure cookies on http).
export function isSecureRequest(request: Request): boolean {
  return (
    request.headers.get("x-forwarded-proto") === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:"
  );
}

function originEnforced(): boolean {
  return !!process.env.VELVARR_ORIGIN;
}

function consumeBucket(key: string, limit: number, now: number): void {
  const current = buckets.get(key);
  if (!current || now - current.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  if (current.count >= limit) {
    throw new AppError(
      429,
      "too_many_attempts",
      "too many attempts; try again later",
    );
  }
  current.count += 1;
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }
}

function enforceOriginConfig(): URL {
  const raw = process.env.VELVARR_ORIGIN;
  if (!raw) throw new AppError(500, "bad_origin_config", "unreachable");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      500,
      "bad_origin_config",
      "VELVARR_ORIGIN is not a valid URL",
    );
  }
  // Loopback plain HTTP is always fine. The flag unlocks private/Docker
  // addresses (isPrivateHost) — never a public HTTP origin, which is what
  // README.md, scripts/setup.mjs and compose.yaml all promise.
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    if (
      !isPrivateHost(url.hostname) ||
      process.env.VELVARR_ALLOW_HTTP !== "1"
    ) {
      throw new AppError(
        500,
        "unsafe_origin",
        "plain-HTTP origins must be loopback, or private-network addresses with VELVARR_ALLOW_HTTP=1",
      );
    }
  }
  return url;
}

export function guardMutation(request: Request): void {
  // These two gates run even when VELVARR_ORIGIN is unset: SameSite=Strict
  // keeps the session cookie off cross-SITE requests, but a homelab's apps
  // share one host IP, so a sibling app is same-site and its posts arrive
  // with the victim's cookies and no CORS preflight. The browser's
  // Sec-Fetch-Site is the reliable same-origin signal; HTML forms cannot
  // send application/json, so any other content type on a mutation is a
  // form post whatever the browser's age. Header-absent passes: the
  // client's own bodyless DELETEs, and browsers without fetch metadata
  // (their form posts still fail the content-type gate).
  const site = request.headers.get("sec-fetch-site");
  if (site && site.trim().toLowerCase() !== "same-origin") {
    throw new AppError(
      403,
      "cross_site_request",
      "mutations must originate from this app's own origin",
    );
  }
  const contentType = request.headers.get("content-type");
  if (
    contentType &&
    contentType.split(";")[0]!.trim().toLowerCase() !== "application/json"
  ) {
    throw new AppError(
      403,
      "bad_content_type",
      "mutations must be posted as application/json",
    );
  }
  if (!originEnforced()) return;
  const configured = enforceOriginConfig();
  const header = request.headers.get("origin");
  if (!header) {
    throw new AppError(403, "origin_missing", "missing Origin header");
  }
  let got: URL;
  try {
    got = new URL(header);
  } catch {
    throw new AppError(403, "origin_mismatch", "origin not allowed");
  }
  if (got.origin !== configured.origin) {
    throw new AppError(
      403,
      "origin_mismatch",
      `origin not allowed: set VELVARR_ORIGIN to the address you browse (expected ${configured.origin}, got ${got.origin})`,
    );
  }
}

export function verifySetupSecret(value: unknown): void {
  const expected = process.env.VELVARR_SETUP_SECRET;
  if (
    typeof value !== "string" ||
    !expected ||
    expected.length < 32 ||
    !timingSafeEqual(
      createHash("sha256").update(value).digest(),
      createHash("sha256").update(expected).digest(),
    )
  ) {
    throw new AppError(403, "setup_secret_invalid", "setup secret is invalid");
  }
}

// Read-only gate: may this name try to authenticate now. Nothing is consumed
// here — budget is charged on failed authentications only
// (recordLoginFailure), so a successful login never burns its own account's
// budget. The spray cap binds only names without an admitted Velvarr
// account: admitted names skip it (their brute force is bounded by the
// per-account bucket), so a rotating-name sprayer can fill the global
// bucket without locking the household out of sign-in.
export function assertLoginAllowed(name: string, admitted = false): void {
  const now = Date.now();
  const global = buckets.get("global");
  if (
    !admitted &&
    global &&
    now - global.windowStart < WINDOW_MS &&
    global.count >= GLOBAL_LIMIT
  ) {
    throw new AppError(
      429,
      "too_many_attempts",
      "too many attempts; try again later",
    );
  }
  const account = buckets.get(`account:${name.trim().toLowerCase()}`);
  if (
    account &&
    now - account.windowStart < WINDOW_MS &&
    account.count >= ACCOUNT_LIMIT
  ) {
    throw new AppError(
      429,
      "too_many_attempts",
      "too many attempts; try again later",
    );
  }
}

// Test hook: the buckets are module-global, so a test that drives any cap
// would otherwise leak state into every limiter test after it.
export function resetLoginBuckets(): void {
  buckets.clear();
}

// Charges one failed authentication: the account bucket carries the
// brute-force limit, the global bucket is the last-resort spray cap. Global
// is charged first so an already-locked account's guesses still feed it.
// ponytail: with the global bucket full, an admitted name's failure throws
// on the global charge before its account bucket fills; if upstream
// round-trips during an active spray ever matter, charge admitted names
// account-first.
export function recordLoginFailure(name: string): void {
  const now = Date.now();
  consumeBucket("global", GLOBAL_LIMIT, now);
  consumeBucket(`account:${name.trim().toLowerCase()}`, ACCOUNT_LIMIT, now);
}

export function sessionCookie(grant?: SessionGrant, secure?: boolean): string {
  const suffix = secure ? "; Secure" : "";
  if (!grant) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${suffix}`;
  }
  const maxAge = Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000));
  return `${COOKIE_NAME}=${grant.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${suffix}`;
}

// Cookie parsing sits beside cookie writing so COOKIE_NAME stays the single
// owner of the literal.
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}
