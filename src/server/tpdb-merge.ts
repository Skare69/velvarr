import type { TpdbMergeResponse } from "../lib/contracts.ts";
import {
  AppError,
  readBounded,
  USER_AGENT,
  validateBaseUrl,
  validateToken,
} from "./http.ts";
import { tpdbCredential, tpdbGet, tpdbSiteUrl } from "./providers.ts";

// TPDB's public API has no merge endpoint (OpenAPI v3.24.757). Merges exist
// only as the website form `POST /movies/{slug|uuid}/merge` with
// `{ scene_id: <target numeric _id>, notes }`. The stored API token opens a
// website session (Bearer), and Laravel's CSRF check then needs the
// XSRF-TOKEN cookie echoed as a header. ponytail: undocumented website
// route; switch to an API endpoint if TPDB ever publishes one.

const TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Upstream text shown to an admin: one line, bounded. */
function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 300);
}

function sessionError(reason: string): AppError {
  return new AppError(
    502,
    "tpdb_merge_session",
    `TPDB did not accept the stored key's website session for the merge (${reason}).`,
  );
}

function rejected(reason: string): AppError {
  return new AppError(
    422,
    "tpdb_merge_rejected",
    `TPDB rejected the merge: ${clean(reason) || "no reason given"}`,
  );
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

async function text(res: Response): Promise<string> {
  return new TextDecoder().decode(await readBounded(res, PAGE_LIMIT, "tpdb"));
}

async function targetNumber(target: string): Promise<number> {
  let body: unknown;
  try {
    body = await tpdbGet<unknown>(`/movies/${target}`, true);
  } catch (error) {
    if (error instanceof AppError && error.upstreamStatus === 404) {
      throw new AppError(
        404,
        "catalog_not_found",
        "The merge target is not in the TPDB catalog.",
      );
    }
    throw error;
  }
  const data = record(record(body)?.data);
  const number = data?._id;
  if (
    typeof data?.id !== "string" ||
    data.id.toLowerCase() !== target.toLowerCase() ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new AppError(
      502,
      "upstream_bad_response",
      "TPDB returned an invalid merge target record.",
    );
  }
  return number;
}

function collectCookies(res: Response, jar: Map<string, string>): void {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0]!;
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Laravel validation body: the first field message, else `message`. */
function validationReason(body: unknown): string {
  const errors = record(record(body)?.errors);
  for (const messages of Object.values(errors ?? {})) {
    if (Array.isArray(messages) && typeof messages[0] === "string")
      return messages[0];
  }
  const message = record(body)?.message;
  return typeof message === "string" ? message : "";
}

/** The JSON object that starts at `start`, scanned with string escapes in
 * mind, or undefined when it does not parse. */
function objectAt(source: string, start: number): unknown {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The session flash in the Inertia page props of the merge redirect
 * target, in any key order. Undefined when the page carries none. */
export function flashOf(
  html: string,
): { error: string | null; success: string | null } | undefined {
  const page = html.replaceAll("&quot;", '"');
  const at = page.indexOf('"flash":{');
  if (at < 0) return undefined;
  const flash = record(objectAt(page, at + '"flash":'.length));
  if (!flash) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return { error: str(flash.error), success: str(flash.success) };
}

/** A merge whose POST left but whose result TPDB never stated. */
function unconfirmed(reason: string): AppError {
  return new AppError(502, "upstream_bad_response", reason);
}

async function submit(
  source: string,
  scene: number,
  notes: string,
  phase: { posted: boolean },
): Promise<TpdbMergeResponse> {
  const token = validateToken(tpdbCredential());
  const site = validateBaseUrl(tpdbSiteUrl());
  const formUrl = `${site}/movies/${source.toLowerCase()}/merge`;
  const base = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
  };
  const send = (url: string, init: RequestInit) =>
    fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  const jar = new Map<string, string>();
  const form = await send(formUrl, {
    headers: { ...base, Accept: "text/html" },
  });
  await discard(form);
  if (form.status === 404) {
    throw new AppError(
      404,
      "catalog_not_found",
      "This movie is not in the TPDB catalog.",
    );
  }
  if (form.status !== 200) throw sessionError(`merge form HTTP ${form.status}`);
  collectCookies(form, jar);
  const xsrf = jar.get("XSRF-TOKEN");
  if (xsrf === undefined) throw sessionError("no CSRF cookie");
  // From here on TPDB may have stored the merge even when no answer
  // arrives: a lost response is not a refusal.
  phase.posted = true;
  const post = await send(formUrl, {
    method: "POST",
    headers: {
      ...base,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ scene_id: scene, notes }),
  });
  if (post.status === 422) {
    let body: unknown;
    try {
      body = JSON.parse(await text(post));
    } catch {
      body = undefined;
    }
    throw rejected(validationReason(body));
  }
  if (post.status === 401 || post.status === 403 || post.status === 419) {
    await discard(post);
    throw sessionError(
      post.status === 419 ? "CSRF token mismatch" : `HTTP ${post.status}`,
    );
  }
  if (post.status >= 200 && post.status < 300) {
    let message: unknown;
    try {
      message = record(JSON.parse(await text(post)))?.message;
    } catch {
      message = undefined;
    }
    return { message: typeof message === "string" ? clean(message) : null };
  }
  if (post.status < 300 || post.status >= 400) {
    await discard(post);
    throw new AppError(
      502,
      "upstream_unavailable",
      `TPDB reported an unexpected error (HTTP ${post.status}).`,
    );
  }
  await discard(post);
  collectCookies(post, jar);
  const next = new URL(post.headers.get("location") ?? "/", site);
  // The form posted; only the flash on the redirect target tells success
  // from a rejection. Cookies and the key never leave TPDB's own origin,
  // so an off-origin redirect leaves the result unconfirmed.
  if (next.origin !== new URL(site).origin)
    throw unconfirmed("TPDB redirected to another site");
  if (next.pathname.includes("/login")) throw sessionError("sent to sign-in");
  const page = await send(next.href, {
    headers: { ...base, Accept: "text/html", Cookie: cookieHeader(jar) },
  });
  if (page.status !== 200) {
    await discard(page);
    throw unconfirmed(`confirmation page HTTP ${page.status}`);
  }
  const flash = flashOf(await text(page));
  if (flash?.error) throw rejected(flash.error);
  if (!flash?.success) throw unconfirmed("TPDB sent no merge confirmation");
  return { message: clean(flash.success) };
}

function failure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new AppError(
      504,
      "upstream_timeout",
      "TPDB did not respond in time.",
    );
  }
  return new AppError(
    502,
    "upstream_unavailable",
    "TPDB could not be reached.",
  );
}

/** Submits "source merges into target" on TPDB. Ids are validated UUIDs.
 * Once the form POST left, every failure except TPDB's own refusal is
 * `tpdb_merge_unknown`: the merge may exist, so the client must not offer
 * a blind resubmit. */
export async function submitTpdbMovieMerge(
  source: string,
  target: string,
  notes: string,
): Promise<TpdbMergeResponse> {
  const scene = await targetNumber(target);
  const phase = { posted: false };
  try {
    return await submit(source, scene, notes, phase);
  } catch (error) {
    const known = failure(error);
    // tpdb_merge_rejected and tpdb_merge_session are TPDB's own answer
    // that it stored nothing; anything else after the POST is uncertain.
    if (
      !phase.posted ||
      known.code === "tpdb_merge_rejected" ||
      known.code === "tpdb_merge_session"
    )
      throw known;
    throw new AppError(
      502,
      "tpdb_merge_unknown",
      `TPDB did not confirm the merge (${known.message.replace(/\.$/, "")}). It may already be submitted.`,
    );
  }
}
