// Seerr-style shared upstream cache for the provider-derived discover
// shelves. Timers are scheduling only — all durable state lives in SQLite:
// the warm loop and every request-path read go through the same read-through
// helper over discover_cache, so a crash or restart loses at most freshness,
// never the answers. Per-user views (Jellyfin recent, requests, shelf order)
// stay live and never touch this module.
//
// The hiddenTags fingerprint is canonical (folded label + ids, sorted and
// deduped), so one tag set maps to one key however the account orders it.
// The warm job only covers the shared (empty hiddenTags) releases + trending
// entries; per-account followed entries are read-through only and go cold
// after the 1h prune or the 500-row cap.

import {
  browseTitles,
  parseBrowseQuery,
  searchVisibleCatalog,
  type BrowsePage,
} from "./browse.ts";
import { AppError } from "./http.ts";
import {
  getConfig,
  getDiscoverCache,
  listFollows,
  pruneDiscoverCache,
  putDiscoverCache,
} from "./storage.ts";
import {
  normalizeFacetName,
  type CatalogDetail,
  type CatalogTagSelection,
  type Shelf,
} from "../lib/contracts.ts";
// Exception to "no runtime imports from route modules": followedShelf lives
// in routes/discover.ts today; importing it mirrors how routes import server
// modules. If the shelf builders ever move to src/server, drop this comment.
import {
  followedShelf,
  MORE_PREVIEWS,
  SHELF_ITEMS,
} from "../app/api/[...path]/routes/discover.ts";

export const DISCOVER_CACHE_TTL_MS = 5 * 60_000;

// Stryker disable next-line ArithmeticOperator -- consumed only by the warm loop below.
const PRUNE_MAX_AGE_MS = 60 * 60_000;

// In-process join: concurrent misses for one key share a single build.
const inFlight = new Map<string, Promise<unknown>>();

function fingerprint(hiddenTags: CatalogTagSelection[]): string {
  // Covers hiddenTags plus provider configured-ness, mirroring providers.ts
  // credential(): stored value first (?? — an empty stored string means
  // unconfigured, it never falls through to env), env fallback. A mismatch
  // could never serve wrong data (a not-configured build throws and is
  // never cached), but an exact mirror keeps the keys stable.
  const stored = getConfig()?.providers;
  const tpdb = stored?.tpdbApiToken ?? process.env.TPDB_API_TOKEN;
  const stashdb = stored?.stashdbApiKey ?? process.env.STASHDB_API_KEY;
  const configuredTpdb = typeof tpdb === "string" && tpdb.trim() !== "";
  const configuredStashdb =
    typeof stashdb === "string" && stashdb.trim() !== "";
  // Canonical: one tag set is one key. Each selection folds to its
  // normalized label plus provider ids — the same pairing tagMatches and
  // mergeTagCounts use — and the set is sorted and deduped, so reordering
  // or re-saving the same tags reuses the cached build instead of forcing
  // a new shared-quota provider run and a new discover_cache row.
  const entries = hiddenTags.map((t) =>
    JSON.stringify([normalizeFacetName(t.name), t.tpdb ?? "", t.stashdb ?? ""]),
  );
  return JSON.stringify([
    [...new Set(entries)].sort(),
    configuredTpdb,
    configuredStashdb,
  ]);
}

export function releasesCacheKey(today: string, fp: string): string {
  // v2: rows written before the throw-through fix cached the settled
  // {status, ...} wrapper this module no longer reads; the bump keeps a
  // deploy from misparsing them (they age out via the 1h prune).
  return `discover:releases2:${today}:${fp}`;
}

export function trendingCacheKey(fp: string): string {
  return `discover:trending:${fp}`;
}

function followedCacheKey(
  accountId: string,
  followsFp: string,
  fp: string,
): string {
  return `discover:followed:${accountId}:${followsFp}:${fp}`;
}

function followsFingerprint(accountId: string): string {
  const rows = listFollows(accountId).map(
    (f) => `${f.reference.provider}:${f.reference.id}`,
  );
  return rows.sort().join(",");
}

async function readThrough<T>(
  key: string,
  build: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const pass = (async () => {
    const hit = getDiscoverCache(key);
    if (
      hit !== undefined &&
      Date.now() - hit.fetchedAt < DISCOVER_CACHE_TTL_MS
    ) {
      return JSON.parse(hit.payload) as T;
    }
    // A failed build propagates: never written, never served stale.
    const value = await build();
    putDiscoverCache(key, JSON.stringify(value), Date.now());
    return value;
  })();
  inFlight.set(key, pass);
  try {
    return await pass;
  } finally {
    inFlight.delete(key);
  }
}

export async function cachedReleases(
  hiddenTags: CatalogTagSelection[],
  today: string,
): Promise<PromiseSettledResult<BrowsePage>> {
  // The build may throw: a failure propagates out of readThrough, so an
  // outage is never written to discover_cache and never served stale —
  // same contract as cachedTrending/cachedFollowed. Only the caller sees
  // the settled shape.
  try {
    return {
      status: "fulfilled",
      value: await readThrough<BrowsePage>(
        releasesCacheKey(today, fingerprint(hiddenTags)),
        () =>
          browseTitles(
            parseBrowseQuery(
              new URLSearchParams({
                type: "all",
                sort: "recency",
                direction: "desc",
                date: today,
                date_operation: "<=",
                page: "1",
                perPage: String(SHELF_ITEMS + MORE_PREVIEWS),
              }),
            ),
            hiddenTags,
          ),
      ),
    };
  } catch (e) {
    return { status: "rejected", reason: e };
  }
}

export async function cachedTrending(
  hiddenTags: CatalogTagSelection[],
): Promise<CatalogDetail[]> {
  return readThrough<CatalogDetail[]>(
    trendingCacheKey(fingerprint(hiddenTags)),
    () =>
      searchVisibleCatalog(
        {
          provider: "stashdb",
          kind: "scene",
          sort: "trending",
          direction: "desc",
          page: 1,
          perPage: SHELF_ITEMS + MORE_PREVIEWS,
        },
        hiddenTags,
      ).then((page) => page.items),
  );
}

export async function cachedFollowed(
  accountId: string,
  hiddenTags: CatalogTagSelection[],
): Promise<Shelf | null> {
  return readThrough<Shelf | null>(
    followedCacheKey(
      accountId,
      followsFingerprint(accountId),
      fingerprint(hiddenTags),
    ),
    () => followedShelf(accountId, hiddenTags),
  );
}

// Stryker disable all -- scheduling and logging glue whose building blocks
// (cachedReleases/cachedTrending/prune) are tested directly.
export function startDiscoveryLoop(): void {
  const g = globalThis as typeof globalThis & {
    __velvarrDiscoveryLoopStarted?: boolean;
  };
  if (g.__velvarrDiscoveryLoopStarted) return;
  g.__velvarrDiscoveryLoopStarted = true;
  let passInFlight = false;
  const pass = async (): Promise<string> => {
    if (passInFlight) return "skipped (pass in flight)";
    passInFlight = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      let releases = "ok";
      let trending = "ok";
      try {
        const settledReleases = await cachedReleases([], today);
        if (settledReleases.status === "rejected") {
          releases =
            settledReleases.reason instanceof AppError
              ? settledReleases.reason.code
              : String(settledReleases.reason);
        }
      } catch (e) {
        releases = e instanceof Error ? e.message : String(e);
      }
      try {
        await cachedTrending([]);
      } catch (e) {
        trending = e instanceof Error ? e.message : String(e);
      }
      const pruned = pruneDiscoverCache(PRUNE_MAX_AGE_MS);
      return `releases ${releases}/trending ${trending}/pruned ${pruned}`;
    } finally {
      passInFlight = false;
    }
  };
  // ponytail: fixed 5min cadence, no shutdown wiring — a killed mid-pass
  // leaves at most a missing refresh; the interval dies with process.exit.
  const run = () => {
    void pass()
      .then((line) => console.log(`[velvarr] discovery warm: ${line}`))
      .catch((e) => {
        // pass() never rejects by construction; this guards the interval.
        console.error(
          `[velvarr] discovery warm failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  };
  run();
  // unref mirrors the acquisition loop: scheduling must never hold the
  // process open (a test that starts the loop would otherwise never exit;
  // in production the HTTP listener holds the process regardless).
  const timer = setInterval(run, DISCOVER_CACHE_TTL_MS);
  timer.unref?.();
}
// Stryker restore all
