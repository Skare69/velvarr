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

const FLASH =
  /"flash":\{"error":(null|"(?:[^"\\]|\\.)*"),"success":(null|"(?:[^"\\]|\\.)*")\}/;

/** The Inertia page props carry the session flash the merge redirect set. */
function flashOf(html: string): {
  error: string | null;
  success: string | null;
} {
  const match = FLASH.exec(html.replaceAll("&quot;", '"'));
  if (!match) return { error: null, success: null };
  return {
    error: JSON.parse(match[1]!) as string | null,
    success: JSON.parse(match[2]!) as string | null,
  };
}

async function submit(
  source: string,
  scene: number,
  notes: string,
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
  if (next.pathname.includes("/login")) throw sessionError("sent to sign-in");
  // The form posted; only the flash on the redirect target tells success
  // from a rejection. Cookies never leave TPDB's own origin.
  if (next.origin !== new URL(site).origin) return { message: null };
  const page = await send(next.href, {
    headers: { ...base, Accept: "text/html", Cookie: cookieHeader(jar) },
  });
  if (page.status !== 200) {
    await discard(page);
    return { message: null };
  }
  const flash = flashOf(await text(page));
  if (flash.error !== null) throw rejected(flash.error);
  return { message: flash.success === null ? null : clean(flash.success) };
}

/** Submits "source merges into target" on TPDB. Ids are validated UUIDs. */
export async function submitTpdbMovieMerge(
  source: string,
  target: string,
  notes: string,
): Promise<TpdbMergeResponse> {
  const scene = await targetNumber(target);
  try {
    return await submit(source, scene, notes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AppError(
        504,
        "upstream_timeout",
        "TPDB did not respond in time.",
      );
    }
    throw new AppError(
      502,
      "upstream_unavailable",
      "TPDB could not be reached.",
    );
  }
}
