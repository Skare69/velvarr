import type { Account, MediaReference } from "../lib/contracts.ts";
import { AppError } from "./http.ts";
import { getCatalogDetail } from "./providers.ts";
import {
  clearDiscoverCache,
  getMovieMerge,
  recordMovieMerge,
  removeMovieMerge,
} from "./storage.ts";

/** The merge grant rides the account: admins always may, members only with
 * the per-account "Merge duplicates" grant (same shape as prose search). */
export function canMergeDuplicates(account: Account): boolean {
  return account.role === "admin" || account.mergeDuplicates;
}

/** Store one Velvarr-wide merge link: `mergedId` resolves to `primaryId` at
 * read time from now on. TPDB must return both details before the link is
 * stored, so a forged or stale id pairs nothing; an upstream failure names
 * its source and stores nothing. Ids fold to lowercase once here, matching
 * migration 16's fold rule. */
export async function mergeMovies(
  mergedId: string,
  primaryId: string,
  accountId: string,
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
