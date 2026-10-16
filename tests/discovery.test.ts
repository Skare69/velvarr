// Discovery cache unit tests: the documented cache-key shape, the
// read-through TTL over the SQLite-backed discover_cache, the in-flight join
// for concurrent misses, and the failure-propagation contract for a failed
// shelf build. Uses the zero-follow null shelf (no upstream contact) plus
// stubbed fetches for the releases and trending builds. No real network, no
// real credentials: every fetch is stubbed and the base URLs point at a
// discard port the stub never dials.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MORE_PREVIEWS,
  SHELF_ITEMS,
} from "../src/app/api/[...path]/routes/discover.ts";
import {
  DISCOVER_CACHE_TTL_MS,
  cachedFollowed,
  cachedReleases,
  cachedTrending,
  releasesCacheKey,
  trendingCacheKey,
} from "../src/server/discovery.ts";
import { normalizeFacetName } from "../src/lib/contracts.ts";
import { AppError } from "../src/server/http.ts";
import { resetMetaCache } from "../src/server/providers.ts";
import {
  followPerformer,
  getConfig,
  getDiscoverCache,
  importAccounts,
  listFollows,
  putDiscoverCache,
  updateAccount,
} from "../src/server/storage.ts";

const TPDB_TOKEN = "tpdb-fixture-token-0001";
const STASH_TOKEN = "stashdb-fixture-key-0001";
const DISCARD = "http://127.0.0.1:9";

/** Mirrors discovery.ts's documented fingerprint shape (api.test.ts keeps
 * the same mirror for the releases key); a mismatch fails the
 * key-addressed assertions, so a fingerprint mutation cannot hide. The
 * hiddenTags half is canonical — folded label + ids per selection, sorted
 * and deduped — mirroring fingerprint() exactly. */
function fingerprint(
  hiddenTags: unknown[],
  env: { tpdb?: string; stashdb?: string } = {},
): string {
  const stored = getConfig()?.providers;
  const tpdb =
    stored?.tpdbApiToken ??
    (env.tpdb !== undefined ? env.tpdb : process.env.TPDB_API_TOKEN);
  const stashdb =
    stored?.stashdbApiKey ??
    (env.stashdb !== undefined ? env.stashdb : process.env.STASHDB_API_KEY);
  const entries = hiddenTags.map((t) => {
    const sel = t as { name: string; tpdb?: string; stashdb?: string };
    return JSON.stringify([
      normalizeFacetName(sel.name),
      sel.tpdb ?? "",
      sel.stashdb ?? "",
    ]);
  });
  return JSON.stringify([
    [...new Set(entries)].sort(),
    typeof tpdb === "string" && tpdb.trim() !== "",
    typeof stashdb === "string" && stashdb.trim() !== "",
  ]);
}

/** The documented followed-cache key; discovery.ts computes the same key on
 * every cachedFollowed call for the account. */
function followedKey(accountId: string, fp: string): string {
  const rows = listFollows(accountId).map(
    (f) => `${f.reference.provider}:${f.reference.id}`,
  );
  return `discover:followed:${accountId}:${rows.sort().join(",")}:${fp}`;
}

const TOKEN_KEYS = [
  "TPDB_API_TOKEN",
  "STASHDB_API_KEY",
  "TPDB_BASE_URL",
  "STASHDB_BASE_URL",
] as const;

/** Sets provider tokens and base URLs for one run; absent values delete. */
function withEnv(
  values: Partial<Record<(typeof TOKEN_KEYS)[number], string | undefined>>,
  run: () => unknown,
): Promise<unknown> | unknown {
  const saved = TOKEN_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of TOKEN_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const done = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(done);
    done();
    return result;
  } catch (error) {
    done();
    throw error;
  }
}

const NO_PROVIDERS = {
  TPDB_API_TOKEN: undefined,
  STASHDB_API_KEY: undefined,
} as const;

test("cache keys follow the documented discover: prefix shape", () => {
  // releases2: the suffix versioned the key when the outage-caching fix
  // changed the cached payload shape, busting every pre-existing entry.
  assert.equal(
    releasesCacheKey("2026-10-15", "fp1"),
    "discover:releases2:2026-10-15:fp1",
  );
  assert.equal(trendingCacheKey("fp2"), "discover:trending:fp2");
});

test("the fingerprint covers provider configured-ness, trimming empty tokens", async () => {
  await withEnv({ ...NO_PROVIDERS }, async () => {
    assert.equal(await cachedFollowed("acct-unconfigured", []), null);
    assert.ok(
      getDiscoverCache(followedKey("acct-unconfigured", fingerprint([], {}))),
      "unconfigured tokens give the [false,false] key",
    );
  });
  await withEnv({ TPDB_API_TOKEN: TPDB_TOKEN }, async () => {
    assert.equal(await cachedFollowed("acct-tpdb", []), null);
    assert.ok(
      getDiscoverCache(
        followedKey("acct-tpdb", fingerprint([], { tpdb: TPDB_TOKEN })),
      ),
      "a set TPDB token flips the first flag",
    );
  });
  await withEnv({ TPDB_API_TOKEN: "   " }, async () => {
    assert.equal(await cachedFollowed("acct-blank", []), null);
    assert.ok(
      getDiscoverCache(followedKey("acct-blank", fingerprint([], {}))),
      "a whitespace-only token counts as unconfigured",
    );
  });
  await withEnv({ TPDB_API_TOKEN: "" }, async () => {
    assert.equal(await cachedFollowed("acct-empty", []), null);
    assert.ok(
      getDiscoverCache(followedKey("acct-empty", fingerprint([], {}))),
      "an empty-string token counts as unconfigured",
    );
  });
  await withEnv({ STASHDB_API_KEY: STASH_TOKEN }, async () => {
    assert.equal(await cachedFollowed("acct-stash", []), null);
    assert.ok(
      getDiscoverCache(
        followedKey("acct-stash", fingerprint([], { stashdb: STASH_TOKEN })),
      ),
      "a set StashDB token flips the second flag",
    );
  });
  await withEnv({ STASHDB_API_KEY: "   " }, async () => {
    assert.equal(await cachedFollowed("acct-stash-blank", []), null);
    assert.ok(
      getDiscoverCache(followedKey("acct-stash-blank", fingerprint([], {}))),
      "a whitespace-only StashDB token counts as unconfigured",
    );
  });
});

test("the read-through cache serves fresh entries and rebuilds stale ones", async () => {
  await withEnv({ ...NO_PROVIDERS }, async () =>
    assert.equal(await cachedFollowed("acct-ttl", []), null),
  );
  const key = followedKey("acct-ttl", fingerprint([], {}));
  assert.ok(getDiscoverCache(key), "the cold build wrote the documented key");

  // A fresh entry is served without a rebuild: poison the payload and the
  // poisoned value must come back.
  putDiscoverCache(key, JSON.stringify({ served: "hit" }), Date.now());
  await withEnv({ ...NO_PROVIDERS }, async () =>
    assert.deepEqual(await cachedFollowed("acct-ttl", []), { served: "hit" }),
  );

  // An entry aged past the TTL is rebuilt from the source (a null shelf).
  putDiscoverCache(
    key,
    JSON.stringify({ served: "stale" }),
    Date.now() - DISCOVER_CACHE_TTL_MS - 1,
  );
  await withEnv({ ...NO_PROVIDERS }, async () =>
    assert.equal(await cachedFollowed("acct-ttl", []), null),
  );
});

function jsonReply(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const EMPTY_STASH_PAGE = {
  data: { queryScenes: { count: 0, scenes: [] } },
};

test("concurrent misses share one build; a failed build rejects with the provider-named reason", async () => {
  const realFetch = globalThis.fetch;
  // Fulfilling fake: GraphQL scene queries and TPDB listings answer empty.
  let listingUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/graphql")) return jsonReply(EMPTY_STASH_PAGE);
    listingUrl = url;
    return jsonReply({ data: [], links: {}, meta: {} });
  }) as typeof fetch;
  try {
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        const today = "2026-10-15";
        const [a, b] = await Promise.all([
          cachedReleases([], today),
          cachedReleases([], today),
        ]);
        assert.equal(a.status, "fulfilled");
        assert.equal(b.status, "fulfilled");
        assert.ok(a.status === "fulfilled" && b.status === "fulfilled");
        assert.ok(
          Object.is(a.value, b.value),
          "the in-flight join serves both callers from one build",
        );
        assert.deepEqual(a.value.items, []);
        // The listing request carries the wire shape discovery.ts builds:
        // the route-constant page size and the release-date bound. The
        // movie type rides the /movies path, so no type= param appears.
        assert.ok(
          listingUrl.includes(
            `per_page=${String(SHELF_ITEMS + MORE_PREVIEWS)}`,
          ),
          `page size pins the route constants: ${listingUrl}`,
        );
        assert.ok(listingUrl.includes("date=2026-10-15"), listingUrl);
        assert.ok(
          listingUrl.includes(`date_operation=${encodeURIComponent("<=")}`),
          listingUrl,
        );
        assert.match(listingUrl, /\/movies\?/, listingUrl);
      },
    );

    // Throwing fake: every upstream contact fails. Phase A warmed the
    // in-process metaCache under the releases builds; drop it so the
    // failing build genuinely reaches the (throwing) stub.
    resetMetaCache();
    globalThis.fetch = (async () => {
      throw new Error("tpdb down");
    }) as typeof fetch;
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        const today = "2026-10-15";
        const hidden = [{ name: "Force Rebuild" }];
        const [x, y] = await Promise.all([
          cachedReleases(hidden, today),
          cachedReleases(hidden, today),
        ]);
        assert.equal(x.status, "rejected");
        assert.equal(y.status, "rejected");
        assert.ok(x.status === "rejected");
        const reason = x.reason as AppError;
        assert.ok(reason instanceof AppError);
        assert.equal(reason.status, 502);
        assert.equal(reason.code, "provider_unavailable");
        assert.match(reason.message, /^tpdb: .+; stashdb: .+$/);
        // The failed build propagates out of readThrough: an outage is
        // never written to discover_cache and never served stale.
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one hidden-tag set maps to one build across orderings and duplicates", async () => {
  const realFetch = globalThis.fetch;
  let builds = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/graphql")) return jsonReply(EMPTY_STASH_PAGE);
    builds += 1;
    return jsonReply({ data: [], links: {}, meta: {} });
  }) as typeof fetch;
  try {
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        // Each layer must start cold per call: requestJson's 10-minute
        // metaCache would otherwise serve a reordered set's rebuild without
        // a wire call and hide the very miss this test hunts.
        resetMetaCache();
        const today = "2026-10-16";
        const horror = {
          name: "Cardinality Probe Horror",
          stashdb: "00000000-0000-4000-8000-00000000000a",
        };
        const scifi = {
          name: "Cardinality Probe Sci Fi",
          tpdb: "00000000-0000-4000-8000-00000000000b",
        };
        const first = await cachedReleases([scifi, horror], today);
        assert.equal(first.status, "fulfilled");
        const afterFirst = builds;
        assert.ok(afterFirst >= 1, "a cold build reaches the provider");
        // The same set in another order is the same key: served from the
        // cache, no second provider build, no second cache row.
        resetMetaCache();
        const reordered = await cachedReleases([horror, scifi], today);
        assert.equal(reordered.status, "fulfilled");
        assert.equal(builds, afterFirst, "a reordered set must not rebuild");
        // A duplicated selection is the same set too.
        resetMetaCache();
        const duped = await cachedReleases([horror, scifi, scifi], today);
        assert.equal(duped.status, "fulfilled");
        assert.equal(
          builds,
          afterFirst,
          "a duplicated selection is the same set",
        );
        // The shared build sits at the documented key of either ordering.
        assert.ok(
          getDiscoverCache(
            releasesCacheKey(today, fingerprint([scifi, horror])),
          ),
          "the documented key holds the shared build",
        );
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the trending build returns the provider page items through the cache", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/graphql$/);
    return jsonReply(EMPTY_STASH_PAGE);
  }) as typeof fetch;
  try {
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        assert.deepEqual(await cachedTrending([]), []);
        assert.ok(
          getDiscoverCache(
            trendingCacheKey(
              fingerprint([], {
                tpdb: TPDB_TOKEN,
                stashdb: STASH_TOKEN,
              }),
            ),
          ),
          "the trending build wrote the documented key",
        );
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the trending build asks the provider for the trending scene page", async () => {
  const realFetch = globalThis.fetch;
  // The earlier trending test warmed the in-process metaCache; drop it so
  // this build genuinely reaches the stub.
  resetMetaCache();
  // The earlier trending test also wrote a fresh discover_cache row; age it
  // past the TTL so this build genuinely reaches the stub.
  putDiscoverCache(
    trendingCacheKey(
      fingerprint([], { tpdb: TPDB_TOKEN, stashdb: STASH_TOKEN }),
    ),
    "stale",
    Date.now() - DISCOVER_CACHE_TTL_MS - 1,
  );
  let body = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/graphql$/);
    body = String(init?.body);
    return jsonReply(EMPTY_STASH_PAGE);
  }) as typeof fetch;
  try {
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        assert.deepEqual(await cachedTrending([]), []);
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  // The GraphQL variables carry the search: the route-constant page size
  // and the trending sort. Pin the literal as serialized (no spaces).
  assert.ok(body.includes(`"per_page":${SHELF_ITEMS + MORE_PREVIEWS}`), body);
  assert.ok(body.includes("TRENDING"), body);
  assert.ok(body.includes('"DESC"'), body);
});

test("the followed cache key folds the account's follows into the key", async () => {
  // An admitted account with two follow rows: the key must carry the rows'
  // provider:id pairs, not collapse to the zero-follow shape.
  importAccounts([
    {
      id: "acct-follow",
      name: "Follower",
      isDisabled: false,
      enableRemoteAccess: false,
      enableMediaPlayback: false,
      isAdministrator: false,
    },
  ]);
  updateAccount("acct-follow", {
    enabled: true,
    role: "requester",
    libraryIds: [],
  });
  followPerformer(
    "acct-follow",
    {
      provider: "tpdb",
      kind: "performer",
      id: "00000000-0000-4000-8000-000000000000",
    },
    "Performer Zero",
    null,
  );
  // A second row whose id sorts after the first: storage returns
  // newest-first, so inserting the larger id last leaves the SQL order
  // reversed against lexicographic order — exactly the disorder the key's
  // defensive sort exists to normalize. (Small id last yields rows that are
  // already sorted, and a dropped sort then survives.)
  followPerformer(
    "acct-follow",
    {
      provider: "tpdb",
      kind: "performer",
      id: "12341234-1234-4123-8123-123412341234",
    },
    "Performer One",
    null,
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/graphql")) return jsonReply(EMPTY_STASH_PAGE);
    return jsonReply({ data: [], links: {}, meta: {} });
  }) as typeof fetch;
  try {
    await withEnv(
      {
        TPDB_API_TOKEN: TPDB_TOKEN,
        STASHDB_API_KEY: STASH_TOKEN,
        TPDB_BASE_URL: DISCARD,
        STASHDB_BASE_URL: DISCARD,
      },
      async () => {
        // An empty filmography answers a null shelf and still writes the
        // key this account's follow row hashes into.
        assert.equal(await cachedFollowed("acct-follow", []), null);
        assert.ok(
          getDiscoverCache(
            followedKey(
              "acct-follow",
              fingerprint([], {
                tpdb: TPDB_TOKEN,
                stashdb: STASH_TOKEN,
              }),
            ),
          ),
          "the follow row's provider:id pair is part of the key",
        );
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
