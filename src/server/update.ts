import packageJson from "../../package.json" with { type: "json" };
import { isNewerVersion } from "../lib/update.ts";
import type { UpdateInfo } from "../lib/contracts.ts";

const { version } = packageJson;

const RELEASES_URL =
  "https://api.github.com/repos/Skare69/velvarr/releases/latest";
const FRESH_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;

let cache: { at: number; update: UpdateInfo | null } | null = null;
let failUntil = 0;
let inflight: Promise<UpdateInfo | null> | null = null;

/** `retry-after` (delta-seconds or HTTP-date) and `x-ratelimit-reset` (epoch
 * seconds) on a 403/429, as milliseconds from now; 0 when absent or already
 * past. Only a header that parses to a finite millisecond count is used —
 * a NaN hint would poison the Math below and switch the backoff off — and
 * the result is clamped to FRESH_MS so a bogus or hostile header cannot
 * keep the check silent longer than a success cache would. */
function backoffHint(res: Response, now: number): number {
  let hint = 0;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsedMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - now;
    if (Number.isFinite(parsedMs)) hint = parsedMs;
  }
  const resetEpochS = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetEpochS) && resetEpochS > 0)
    hint = Math.max(hint, resetEpochS * 1000 - now);
  return Math.min(Math.max(hint, 0), FRESH_MS);
}

/** Arm the failure window and answer with the last successful check (null
 * on a cold start — never a fabricated no-update, VELV-125). Arming only
 * happens when a fetch actually ran, so this one warning line is the one
 * log per failure window; calls inside the window never reach github and
 * never log (VELV-135). */
function degrade(reason: string, hintMs: number): UpdateInfo | null {
  const waitMs = Math.min(Math.max(FAILURE_BACKOFF_MS, hintMs), FRESH_MS);
  failUntil = Date.now() + waitMs;
  console.warn(
    `[update] github check failed (${reason}); retrying in ${Math.round(waitMs / 1000)}s`,
  );
  return cache?.update ?? null;
}

/** The newest published GitHub release when it is newer than this build,
 * null when current or when no successful check has happened yet — one wire
 * shape for both "up to date" and "cannot tell", because the chip renders
 * absence the same honest way. A successful check is trusted for an hour.
 * A failed check arms a short backoff instead of a no-update window
 * (VELV-125): the route is open and every page load calls it, so during an
 * outage or rate limit each call would otherwise cost one outbound github
 * request (VELV-135). The window is 60 s by default, longer when a 403/429
 * carries retry-after or x-ratelimit-reset, never more than an hour. Inside
 * the window github is not asked and the last successful answer stays up;
 * with no prior success the answer is null, and the chip renders nothing
 * until the retry succeeds. Parallel callers share the in-flight check
 * instead of each starting their own github call. VELVARR_UPDATE_CHECK=0
 * skips the call entirely — no request leaves the server, and the chip
 * renders nothing. */
export async function availableUpdate(): Promise<UpdateInfo | null> {
  if (process.env.VELVARR_UPDATE_CHECK === "0") return null;
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS) return cache.update;
  if (now < failUntil) return cache?.update ?? null;
  // The route needs no auth, so a burst on a cold or expired cache must
  // fan out to one fetch — same shape as the client's updatePromise ??=.
  inflight ??= checkRelease().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function checkRelease(): Promise<UpdateInfo | null> {
  let res: Response;
  try {
    res = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    return degrade(err instanceof Error ? err.message : String(err), 0);
  }
  if (!res.ok) {
    return degrade(
      `github api ${res.status}`,
      res.status === 403 || res.status === 429
        ? backoffHint(res, Date.now())
        : 0,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    tag_name?: unknown;
    html_url?: unknown;
  } | null;
  if (
    !body ||
    typeof body.tag_name !== "string" ||
    typeof body.html_url !== "string" ||
    // html_url becomes the chip href; only this repo's release pages pass.
    !body.html_url.startsWith("https://github.com/Skare69/velvarr/releases/")
  )
    return degrade("unexpected github payload", 0);
  const latest = body.tag_name.replace(/^v/, "");
  cache = {
    at: Date.now(),
    update: isNewerVersion(latest, version)
      ? { version: latest, url: body.html_url }
      : null,
  };
  failUntil = 0;
  return cache.update;
}

/** Test seam: drop the module cache so a stubbed fetch is actually hit. */
export function resetUpdateCache(): void {
  cache = null;
  failUntil = 0;
  inflight = null;
}
