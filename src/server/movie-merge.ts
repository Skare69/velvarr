import type { LibraryItem, MediaReference } from "../lib/contracts.ts";
import { canMergeDuplicates } from "../lib/approvals.ts";
import { AppError } from "./http.ts";
import { getCatalogDetail } from "./providers.ts";
import {
  clearDiscoverCache,
  getAccount,
  getMovieMerge,
  getSession,
  recordMovieMerge,
  removeMovieMerge,
} from "./storage.ts";

/** The merge grant rides the account: admins always may, members only with
 * the per-account "Merge duplicates" grant (same shape as prose search).
 * One definition lives in lib/approvals.ts; this re-export keeps the
 * server's importers on the shared gate. */
export { canMergeDuplicates } from "../lib/approvals.ts";

/** Store one Velvarr-wide merge link: `mergedId` resolves to `primaryId` at
 * read time from now on. TPDB must return both details before the link is
 * stored, so a forged or stale id pairs nothing; an upstream failure names
 * its source and stores nothing. The session and the grant are re-derived
 * just before the write, so a logout or revocation during the reads stops
 * it. Ids fold to lowercase once here, matching migration 16's fold rule. */
export async function mergeMovies(
  mergedId: string,
  primaryId: string,
  accountId: string,
  rawSessionToken: string,
): Promise<{ mergedId: string; primaryId: string }> {
  const merged = mergedId.toLowerCase();
  const primary = primaryId.toLowerCase();
  if (merged === primary) {
    throw new AppError(400, "self_merge", "A movie cannot merge into itself.");
  }
  const [mergedDetail, primaryDetail] = await Promise.all([
    getCatalogDetail({ provider: "tpdb", kind: "movie", id: merged }),
    getCatalogDetail({ provider: "tpdb", kind: "movie", id: primary }),
  ]);
  if (!mergedDetail || !primaryDetail) {
    throw new AppError(404, "not_found", "Record not found on TPDB.");
  }
  // The route's admission snapshot predates the body read and both upstream
  // reads; logout during them deletes the session, so the write re-derives
  // both facts: the live session first, then the live account below.
  const session = getSession(rawSessionToken);
  if (!session) {
    throw new AppError(
      401,
      "session_expired",
      "Sign in again to keep working.",
    );
  }
  // The grant can lapse while the two provider reads run: the ctx account is
  // a pre-body snapshot, so a revoked grant or a demotion during the awaits
  // must not complete a Velvarr-wide merge. Same rule as decideRequest's
  // live actor re-read.
  const current = getAccount(accountId);
  if (!current || !current.enabled || !canMergeDuplicates(current)) {
    throw new AppError(
      403,
      "forbidden",
      "Duplicate merge is not turned on for this account.",
    );
  }
  recordMovieMerge(merged, primary, accountId);
  // Cached discover rails can still show the merged-away tile; drop them so
  // the next page load reflects the merge.
  clearDiscoverCache();
  return { mergedId: merged, primaryId: primary };
}

/** Delete the one link row. No other state changes, so every stored
 * reference reads the old way again. */
export async function unmergeMovie(mergedId: string): Promise<void> {
  if (!removeMovieMerge(mergedId.toLowerCase())) {
    throw new AppError(404, "not_found", "No merge link for this record.");
  }
  clearDiscoverCache();
}

/** Read-time resolution: a merged-away TPDB movie reference swaps to its
 * primary; everything else passes through. One hop only — storage refuses a
 * primary that is itself merged away, so no chain walk is needed. */
export function resolveMovieReference(ref: MediaReference): MediaReference {
  if (ref.provider !== "tpdb" || ref.kind !== "movie") return ref;
  const link = getMovieMerge(ref.id.toLowerCase());
  if (!link) return ref;
  return { ...ref, id: link.primaryId };
}

/** Read-time collapse for library surfaces: Jellyfin can hold files under two
 * TPDB records that merged, and the page or rail would show both tiles.
 * Callers pass RAW items — no pre-resolution — because the preference below
 * reads the original catalog id, which pre-resolution would erase. Items
 * whose catalog is a TPDB movie group per resolved canonical id
 * (resolveMovieReference applied here); the first item of a group holds the
 * slot, and a later item filed under the kept record itself (its original
 * catalog id equals the group key) replaces the slot exactly once, so the
 * kept record's own file wins whichever order Jellyfin returns. Chosen items
 * leave with their catalog resolved: an alias-only group's tile still names
 * the kept record. Items without a catalog — and items cataloged to anything
 * but a TPDB movie — pass through untouched. */
export function groupMergedLibraryItems(items: LibraryItem[]): LibraryItem[] {
  const slots = new Map<string, number>();
  const replaced = new Set<string>();
  const out: LibraryItem[] = [];
  for (const item of items) {
    const catalog = item.catalog;
    if (
      catalog === undefined ||
      catalog.provider !== "tpdb" ||
      catalog.kind !== "movie"
    ) {
      out.push(item);
      continue;
    }
    const resolved = resolveMovieReference(catalog);
    const key = resolved.id.toLowerCase();
    const slot = slots.get(key);
    if (slot === undefined) {
      slots.set(key, out.length);
      out.push({ ...item, catalog: resolved });
    } else if (catalog.id.toLowerCase() === key && !replaced.has(key)) {
      replaced.add(key);
      out[slot] = { ...item, catalog: resolved };
    }
  }
  return out;
}
