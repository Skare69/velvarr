import packageJson from "../../package.json" with { type: "json" };
import { isNewerVersion } from "../lib/update.ts";

const { version } = packageJson;

export type UpdateInfo = { version: string; url: string };

const RELEASES_URL =
  "https://api.github.com/repos/Skare69/velvarr/releases/latest";
const FRESH_MS = 60 * 60 * 1000;
const FAILED_MS = 10 * 60 * 1000;

let cache: { at: number; ok: boolean; update: UpdateInfo | null } | null = null;

/** The newest published GitHub release when it is newer than this build,
 * null when current, unreachable or shaped wrong — one wire shape for both
 * "up to date" and "cannot tell", because the chip renders absence the same
 * honest way. A successful check is trusted for an hour, a failed one
 * retries after ten minutes. */
export async function availableUpdate(): Promise<UpdateInfo | null> {
  if (cache && Date.now() - cache.at < (cache.ok ? FRESH_MS : FAILED_MS))
    return cache.update;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`github api ${res.status}`);
    const body = (await res.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string")
      throw new Error("unexpected github payload");
    const latest = body.tag_name.replace(/^v/, "");
    cache = {
      at: Date.now(),
      ok: true,
      update: isNewerVersion(latest, version)
        ? { version: latest, url: body.html_url }
        : null,
    };
  } catch {
    cache = { at: Date.now(), ok: false, update: null };
  }
  return cache.update;
}

/** Test seam: drop the module cache so a stubbed fetch is actually hit. */
export function resetUpdateCache(): void {
  cache = null;
}
