import { createHash, timingSafeEqual } from "node:crypto";
import type { SessionGrant } from "../lib/contracts.ts";
import { AppError, isLoopbackHost } from "./http.ts";

const COOKIE_NAME = "velvarr_session";

// Login attempt limiter: one process-global bucket plus one per account name,
// fixed five-minute windows. ponytail: in-memory only, resets on restart —
// durable counters only if abuse survives process restarts.
const WINDOW_MS = 5 * 60_000;
const GLOBAL_LIMIT = 30;
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
  if (
    url.protocol !== "https:" &&
    !isLoopbackHost(url.hostname) &&
    process.env.VELVARR_ALLOW_HTTP !== "1"
  ) {
    throw new AppError(
      500,
      "unsafe_origin",
      "non-loopback HTTP origins require explicit VELVARR_ALLOW_HTTP=1",
    );
  }
  return url;
}

export function guardMutation(request: Request): void {
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

export function consumeLoginAttempt(name: string): void {
  const now = Date.now();
  consumeBucket("global", GLOBAL_LIMIT, now);
  consumeBucket(
    `account:${typeof name === "string" ? name.trim().toLowerCase() : ""}`,
    ACCOUNT_LIMIT,
    now,
  );
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
