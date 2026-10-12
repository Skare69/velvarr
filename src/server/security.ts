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

// HTTPS upgrade for the session cookie: an https reverse proxy
// (X-Forwarded-Proto), a direct https URL, or a pinned https VELVARR_ORIGIN
// all gain Secure. The pin covers proxies that do not send
// X-Forwarded-Proto, so an accidental plain-http hop to the pinned host
// never carries the token in cleartext. Plain LAN http legitimately cannot
// have it (browsers drop Secure cookies on http).
export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto === "https:" || proto === "https") return true;
  let pinned: URL | null = null;
  try {
    pinned = process.env.VELVARR_ORIGIN
      ? new URL(process.env.VELVARR_ORIGIN)
      : null;
  } catch {
    // Invalid pin: enforceOriginConfig reports it on the gated paths.
  }
  return (
    pinned?.protocol === "https:" || new URL(request.url).protocol === "https:"
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
  // form post whatever the browser's age. Header-absent passes only for
  // bodyless mutations (the app's own DELETEs): a wire-framed body without
  // a JSON content type — form posts and typeless Blob bodies alike — is
  // refused here.
  const site = request.headers.get("sec-fetch-site");
  if (site && site.trim().toLowerCase() !== "same-origin") {
    throw new AppError(
      403,
      "cross_site_request",
      "mutations must originate from this app's own origin",
    );
  }
  const contentType = request.headers.get("content-type");
  const typeOk =
    contentType?.split(";")[0]!.trim().toLowerCase() === "application/json";
  // A body is framed by Content-Length or chunked Transfer-Encoding on the
  // wire; Content-Length: 0 and absent framing mean no body.
  const hasBody =
    Number(request.headers.get("content-length") ?? "0") > 0 ||
    request.headers.get("transfer-encoding") !== null;
  if (contentType ? !typeOk : hasBody) {
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
// here — the attempt reserves its per-account slot right after the gate
// (reserveLoginAttempt), and the slot is refunded on a success or a
// non-credential error, so a successful login never burns its own account's
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

// Reserves one attempt slot in the account bucket before the attempt runs.
// The reservation lands in the same synchronous step as the gate, so every
// in-flight guess holds a slot and parallel guesses cannot all reach
// upstream at once (a charge that only landed after the upstream
// round-trip let a whole burst through). The returned refund covers the
// outcomes that were not guesses — a success, an upstream outage, a
// malformed field; a credential rejection keeps the charge. The account
// bucket is charged regardless of the global bucket's state, so a sprayer
// who fills the global cap cannot unlock unlimited guesses against known
// admitted names.
export function reserveLoginAttempt(name: string): () => void {
  const key = `account:${name.trim().toLowerCase()}`;
  consumeBucket(key, ACCOUNT_LIMIT, Date.now());
  // ponytail: a refund landing after a window rollover frees one slot in
  // the fresh window; only non-guess outcomes refund, so no guess ever
  // gets capacity back.
  return () => {
    const bucket = buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  };
}

// Charges one failed authentication against the global spray cap. The
// process-wide cap has no name dimension: the account slot was already
// paid by reserveLoginAttempt before the attempt. Charging the cap on
// every credential rejection keeps an active brute force feeding it even
// once the name's account bucket is full.
export function recordLoginFailure(): void {
  consumeBucket("global", GLOBAL_LIMIT, Date.now());
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
