// Related-titles behavior tests: loopback TPDB/StashDB fixtures plus a
// tightly scoped TypeSafe stub at the ranking boundary only. No real
// network, no real credentials. Covers self exclusion, duplicate and
// hidden-title removal, deterministic shared-tag ordering with the
// native-reference studio tie-break, no-tag and no-source visibility,
// partial provider failure evidence, counterpart exact-name pairing, and
// the Jev boundary: keyless makes no paid call, success reorders the exact
// same candidates with one metadata-only request, and outage/malformed
// answers preserve the deterministic tag order.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { CatalogTagSelection } from "../src/lib/contracts.ts";
import { resetMetaCache } from "../src/server/providers.ts";
import {
  performerTags,
  relatedPerformers,
  relatedTitles,
} from "../src/server/related.ts";
import {
  appError,
  pathOf,
  queryOf,
  sendJson,
  startFixture,
  type Fixture,
  type FixtureHandler,
} from "./fixture.ts";

beforeEach(() => {
  resetMetaCache();
});

// --- constants ---

const TPDB_TOKEN = "tpdb-fixture-token-0001";
const STASH_TOKEN = "stashdb-fixture-key-0001";
const TS_KEY = "typesafe-fixture-key-0001";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const MOVIE_TWO = "22222222-2222-4222-8222-222222222222"; // shares both tags
const MOVIE_ONE = "33333333-3333-4333-8333-333333333333"; // shares Romance
const MOVIE_BOOST = "44444444-4444-4444-8444-444444444444"; // both + same studio
const MOVIE_HIDDEN = "55555555-5555-4555-8555-555555555555"; // shares Comedy
const MOVIE_ZERO = "66666666-6666-4666-8666-666666666666"; // shares nothing
const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const DOWN_ID = "99999999-9999-4999-8999-999999999999";
const STUDIO_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_STUDIO = "88888888-8888-4888-8888-888888888888";
const TAG_ROMANCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // TPDB numeric 101
const TAG_COMEDY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // TPDB numeric 102
const STASH_TAG_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SCENE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SCENE_UNRELATED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TAG_DOC = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";

// Performer co-appearance fixtures.
const PERF_ID = "12341234-1234-4123-8123-123412341234";
const PA = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0"; // Abra: 3 co-appearances
const PB = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1"; // Bravo: 2
const PC = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2"; // Zack: 2 (name-asc tie)
const PD = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3"; // Alpha: 1 visible
const STASH_PERF = "56565656-5656-4565-8565-565656565656";
const STASH_P2 = "67676767-6767-4676-8676-676767676767";

// The deterministic tag order: shared-tag count desc, native studio
// reference tie-break first, then stable reference order.
const TAG_ORDER = [MOVIE_BOOST, MOVIE_TWO, MOVIE_HIDDEN, SCENE_ID, MOVIE_ONE];

const movieRef = (id: string) =>
  ({ provider: "tpdb", kind: "movie", id }) as const;

const HIDE_COMEDY: CatalogTagSelection[] = [{ name: "Comedy" }];

// --- fixture payloads ---

interface FixtureTag {
  id: number;
  uuid: string;
  name: string;
}

const tpdbTag = (id: number, uuid: string, name: string): FixtureTag => ({
  id,
  uuid,
  name,
});

function movieRow(
  id: string,
  title: string,
  tags: FixtureTag[],
  siteUuid = OTHER_STUDIO,
  scenes: { id: string }[] = [],
  performers: { id: string; name: string }[] = [],
) {
  return {
    id,
    title,
    site: {
      name: siteUuid === STUDIO_ID ? "Studio One" : "Other Studio",
      uuid: siteUuid,
    },
    performers,
    tags,
    scenes,
    date: "2023-05-01",
    duration: 6000,
  };
}

const ROMANCE = tpdbTag(101, TAG_ROMANCE, "Romance");
const COMEDY = tpdbTag(102, TAG_COMEDY, "Comedy");

const sourceDetail = () =>
  movieRow(
    SOURCE_ID,
    "Source Title",
    [ROMANCE, COMEDY],
    STUDIO_ID,
    // Direct source `related` reference: unrelated tags, so it must stay out
    // of the ranked rail even though the provider suggests it.
    [{ id: SCENE_UNRELATED }],
  );

const defaultListing = () => [
  // The OR search plausibly returns the source itself.
  movieRow(SOURCE_ID, "Source Title", [ROMANCE, COMEDY], STUDIO_ID),
  movieRow(MOVIE_TWO, "Two Shared", [ROMANCE, COMEDY]),
  // Duplicate of MOVIE_TWO: exactly one may survive.
  movieRow(MOVIE_TWO, "Two Shared", [ROMANCE, COMEDY]),
  movieRow(MOVIE_ONE, "One Shared", [ROMANCE]),
  movieRow(MOVIE_BOOST, "Same Studio", [ROMANCE, COMEDY], STUDIO_ID),
  movieRow(MOVIE_HIDDEN, "Hidden One", [ROMANCE, COMEDY]),
  movieRow(MOVIE_ZERO, "Nothing Shared", [
    tpdbTag(999, TAG_DOC, "Documentary"),
  ]),
];

const stashSceneRow = () => ({
  id: SCENE_ID,
  title: "Scene One",
  date: "2024-02-02",
  duration: 300,
  details: null,
  code: null,
  urls: [],
  images: [],
  studio: { id: OTHER_STUDIO, name: "Stash Studio" },
  tags: [{ id: STASH_TAG_ID, name: "Romance" }],
  performers: [],
});

// Mutable per-test slots; reset together with the metadata cache.
let sourceBody: unknown = sourceDetail();
let listing: unknown[] = defaultListing();
let searchTagReply: unknown = {
  searchTag: [{ id: STASH_TAG_ID, name: "romance" }],
};
let scenesReply: unknown = {
  queryScenes: { count: 1, scenes: [stashSceneRow()] },
};
let filmography: unknown[] = [];
let filmographyLinks: unknown = {};
let filmographyCalls = 0;
let filmographyFailAfter = 0;

beforeEach(() => {
  sourceBody = sourceDetail();
  listing = defaultListing();
  searchTagReply = { searchTag: [{ id: STASH_TAG_ID, name: "romance" }] };
  scenesReply = { queryScenes: { count: 1, scenes: [stashSceneRow()] } };
  filmography = [];
  filmographyLinks = {};
  filmographyCalls = 0;
  filmographyFailAfter = 0;
});

const handler: FixtureHandler = (req, res, body) => {
  const path = pathOf(req.url ?? "");
  if (req.method === "GET" && path === `/movies/${SOURCE_ID}`) {
    return sendJson(res, 200, { data: sourceBody });
  }
  if (req.method === "GET" && path === "/movies") {
    return sendJson(res, 200, { data: listing, links: {}, meta: {} });
  }
  if (req.method === "GET" && path === "/tags") {
    return sendJson(res, 200, { data: [ROMANCE, COMEDY], links: {}, meta: {} });
  }
  if (req.method === "GET" && path === `/movies/${MISSING_ID}`) {
    return sendJson(res, 404, { error: "absent" });
  }
  if (req.method === "GET" && path === `/movies/${DOWN_ID}`) {
    return sendJson(res, 500, { error: "down" });
  }
  if (req.method === "GET" && path === `/performers/${PERF_ID}/movies`) {
    filmographyCalls += 1;
    if (filmographyFailAfter > 0 && filmographyCalls > filmographyFailAfter) {
      return sendJson(res, 500, { error: "down" });
    }
    return sendJson(res, 200, {
      data: filmography,
      links: filmographyLinks,
      meta: {},
    });
  }
  if (req.method === "GET" && path === `/performers/${DOWN_ID}/movies`) {
    return sendJson(res, 500, { error: "down" });
  }
  if (req.method === "POST" && path === "/graphql") {
    const parsed: { query?: string } = JSON.parse(body);
    if ((parsed.query ?? "").includes("searchTag")) {
      return sendJson(res, 200, { data: searchTagReply });
    }
    return sendJson(res, 200, { data: scenesReply });
  }
  sendJson(res, 500, { error: "fixture miss" });
};

async function withFx(run: (fx: Fixture) => Promise<void>): Promise<void> {
  const fx = await startFixture(handler);
  const restore = setEnv({
    TPDB_API_TOKEN: TPDB_TOKEN,
    STASHDB_API_KEY: STASH_TOKEN,
    TPDB_BASE_URL: fx.origin,
    STASHDB_BASE_URL: fx.origin,
  });
  try {
    await run(fx);
  } finally {
    restore();
    await fx.close();
  }
}

const ENV_KEYS = [
  "TPDB_API_TOKEN",
  "STASHDB_API_KEY",
  "TPDB_BASE_URL",
  "STASHDB_BASE_URL",
  "TYPESAFE_API_KEY",
] as const;

function setEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): () => void {
  const saved = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );
  for (const k of ENV_KEYS) {
    const v = values[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Intercepts every non-loopback fetch (the TypeSafe boundary only); loopback
 * provider traffic is forwarded to the fixture. Records each request body. */
function stubTypeSafe(respond: () => Response, calls: string[]): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1:")) {
      return realFetch(input, init);
    }
    calls.push(String(init?.body ?? ""));
    return respond();
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

const scoreAnswer = (score: number) => ({ type: "score", score });

const ids = (items: { reference: { id: string } }[]) =>
  items.map((d) => d.reference.id);

// --- tags ranking ---

test("ranks by shared tags deterministically; self, duplicates, zero-shared, hidden, and direct related references stay out", async () => {
  await withFx(async (fx) => {
    const result = await relatedTitles(movieRef(SOURCE_ID), []);
    assert.deepEqual(ids(result.items), TAG_ORDER);
    assert.equal(result.ranking, "tags");
    assert.equal(result.canRank, false);
    assert.deepEqual(result.errors, []);

    // Native OR candidate discovery: both seed tags any-of, one bounded
    // page, never the user-facing AND filter.
    const listingReq = fx.log.find((r) => pathOf(r.url) === "/movies");
    assert.ok(listingReq);
    const q = queryOf(listingReq.url);
    assert.equal(q.get("tags[101]"), "1");
    assert.equal(q.get("tags[102]"), "1");
    assert.equal(q.get("tag_and"), null);
    assert.equal(q.get("per_page"), "24");

    // Counterpart tag search uses the exact-normalized pair.
    const stashReq = fx.log.find(
      (r) => pathOf(r.url) === "/graphql" && r.body.includes("queryScenes"),
    );
    assert.ok(stashReq);
    const payload: {
      variables: { f: { tags: { value: string[]; modifier: string } } };
    } = JSON.parse(stashReq.body);
    assert.deepEqual(payload.variables.f.tags, {
      value: [STASH_TAG_ID],
      modifier: "INCLUDES",
    });
  });
});

test("a hidden tag removes exactly the titles carrying it", async () => {
  await withFx(async () => {
    const result = await relatedTitles(movieRef(SOURCE_ID), HIDE_COMEDY);
    assert.deepEqual(ids(result.items), [SCENE_ID, MOVIE_ONE]);
    assert.deepEqual(result.errors, []);
  });
});

test("counterpart tags pair only on exact normalized equality; without a pair the stash search is skipped without an error", async () => {
  await withFx(async (fx) => {
    searchTagReply = {
      searchTag: [{ id: STASH_TAG_ID, name: "Unrelated Label" }],
    };
    const result = await relatedTitles(movieRef(SOURCE_ID), []);
    assert.deepEqual(ids(result.items), [
      MOVIE_BOOST,
      MOVIE_TWO,
      MOVIE_HIDDEN,
      MOVIE_ONE,
    ]);
    assert.ok(
      !fx.log.some(
        (r) => pathOf(r.url) === "/graphql" && r.body.includes("queryScenes"),
      ),
    );
    assert.deepEqual(result.errors, []);
  });
});

// --- visibility of failures and empties ---

test("a source without provider tags is an explicit empty with no candidate searches", async () => {
  await withFx(async (fx) => {
    sourceBody = movieRow(SOURCE_ID, "Untagged", [], STUDIO_ID);
    const result = await relatedTitles(movieRef(SOURCE_ID), []);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.canRank, false);
    assert.ok(fx.log.every((r) => pathOf(r.url) !== "/movies"));
    assert.ok(fx.log.every((r) => pathOf(r.url) !== "/graphql"));
  });
});

test("a missing source is a visible not_found, never an empty success", async () => {
  await withFx(async () => {
    const result = await relatedTitles(
      { provider: "tpdb", kind: "movie", id: MISSING_ID },
      [],
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.provider, "tpdb");
    assert.equal(result.errors[0]!.code, "not_found");
  });
});

test("a source outage is visible as an upstream error", async () => {
  await withFx(async () => {
    const result = await relatedTitles(
      { provider: "tpdb", kind: "movie", id: DOWN_ID },
      [],
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.provider, "tpdb");
    assert.equal(result.errors[0]!.code, "upstream_unavailable");
  });
});

test("a failed counterpart source keeps its error next to the surviving candidates", async () => {
  await withFx(async () => {
    scenesReply = { data: null };
    const result = await relatedTitles(movieRef(SOURCE_ID), []);
    assert.deepEqual(ids(result.items), [
      MOVIE_BOOST,
      MOVIE_TWO,
      MOVIE_HIDDEN,
      MOVIE_ONE,
    ]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.provider, "stashdb");
    assert.equal(result.errors[0]!.code, "upstream_bad_response");
  });
});

// --- Jev boundary ---

test("rank=jev without a key makes no paid call and keeps the tag order", async () => {
  await withFx(async () => {
    delete process.env.TYPESAFE_API_KEY;
    const calls: string[] = [];
    const restore = stubTypeSafe(() => {
      throw new Error("no call may happen without a key");
    }, calls);
    try {
      const result = await relatedTitles(movieRef(SOURCE_ID), [], {
        rank: "jev",
      });
      assert.deepEqual(ids(result.items), TAG_ORDER);
      assert.equal(result.ranking, "tags");
      assert.equal(result.canRank, false);
      assert.deepEqual(calls, []);
    } finally {
      restore();
    }
  });
});

test("a successful jev rerank reorders the exact same candidates in one metadata-only request", async () => {
  await withFx(async () => {
    process.env.TYPESAFE_API_KEY = TS_KEY;
    // Tags order is [BOOST, TWO, HIDDEN, SCENE, ONE] = c0..c4; the model's
    // scores lift TWO and ONE above the rest, HIDDEN stays mid, BOOST sinks.
    const answers = {
      c0: scoreAnswer(0),
      c1: scoreAnswer(1.9),
      c2: scoreAnswer(0.2),
      c3: scoreAnswer(0.9),
      c4: scoreAnswer(1.9),
    };
    const calls: string[] = [];
    const restore = stubTypeSafe(
      () =>
        new Response(JSON.stringify({ answers }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      calls,
    );
    try {
      const result = await relatedTitles(movieRef(SOURCE_ID), [], {
        rank: "jev",
        typesafeApiKey: TS_KEY,
      });
      assert.equal(result.ranking, "jev");
      assert.equal(result.canRank, true);
      assert.deepEqual(ids(result.items), [
        MOVIE_TWO,
        MOVIE_ONE,
        SCENE_ID,
        MOVIE_HIDDEN,
        MOVIE_BOOST,
      ]);
      // No IDs added or dropped by the rerank.
      assert.deepEqual([...ids(result.items)].sort(), [...TAG_ORDER].sort());

      // Exactly one request; one narrow Score question per candidate; the
      // state carries catalog metadata only — never references, urls, or
      // account data.
      assert.equal(calls.length, 1);
      const payload: {
        state: {
          source: Record<string, unknown>;
          candidates: Record<string, unknown>[];
        };
        questions: Record<string, { type: string }>;
      } = JSON.parse(calls[0]!);
      assert.deepEqual(Object.keys(payload.questions).sort(), [
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
      ]);
      assert.ok(
        Object.values(payload.questions).every((q) => q.type === "score"),
      );
      const shape = (o: Record<string, unknown>) =>
        Object.keys(o).sort().join(",");
      assert.equal(shape(payload.state.source), "studio,tags,title,year");
      for (const c of payload.state.candidates) {
        assert.equal(shape(c), "studio,tags,title,year");
      }
      assert.deepEqual(
        payload.state.candidates.map((c) => c["title"]),
        ["Same Studio", "Two Shared", "Hidden One", "Scene One", "One Shared"],
      );
    } finally {
      restore();
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});

test("outage, incomplete, and out-of-range jev answers all preserve the deterministic candidates", async () => {
  await withFx(async () => {
    process.env.TYPESAFE_API_KEY = TS_KEY;
    const attempts: (() => Response)[] = [
      () => {
        throw new Error("typesafe down");
      },
      // Incomplete: c2 never answered.
      () =>
        new Response(
          JSON.stringify({
            answers: { c0: scoreAnswer(2), c1: scoreAnswer(1) },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // Out of range, and a malformed (non-numeric) answer.
      () =>
        new Response(
          JSON.stringify({
            answers: {
              c0: scoreAnswer(7),
              c1: scoreAnswer(1),
              c2: scoreAnswer(1),
              c3: scoreAnswer(1),
              c4: scoreAnswer(1),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      () =>
        new Response(
          JSON.stringify({
            answers: {
              c0: scoreAnswer(1),
              c1: scoreAnswer(1),
              c2: scoreAnswer(1),
              c3: scoreAnswer(1),
              c4: { type: "score", score: "high" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    for (const respond of attempts) {
      const calls: string[] = [];
      const restore = stubTypeSafe(respond, calls);
      try {
        const result = await relatedTitles(movieRef(SOURCE_ID), [], {
          rank: "jev",
          typesafeApiKey: TS_KEY,
        });
        assert.deepEqual(ids(result.items), TAG_ORDER);
        assert.equal(result.ranking, "tags");
        assert.equal(result.canRank, false);
      } finally {
        restore();
      }
    }
    delete process.env.TYPESAFE_API_KEY;
  });
});

// --- related performers (co-appearance evidence) ---

const performerRef = (provider: "tpdb" | "stashdb", id: string) =>
  ({ provider, kind: "performer", id }) as const;

test("related performers rank by co-appearance count, name asc on ties, self dropped", async () => {
  await withFx(async (fx) => {
    const self = { id: PERF_ID, name: "Source Self" };
    filmography = [
      movieRow(
        SOURCE_ID,
        "Film One",
        [],
        OTHER_STUDIO,
        [],
        [self, { id: PA, name: "Abra" }],
      ),
      movieRow(
        MOVIE_TWO,
        "Film Two",
        [],
        OTHER_STUDIO,
        [],
        [self, { id: PA, name: "Abra" }, { id: PB, name: "Bravo" }],
      ),
      movieRow(
        MOVIE_ONE,
        "Film Three",
        [],
        OTHER_STUDIO,
        [],
        [{ id: PA, name: "Abra" }, { id: PC, name: "Zack" }, self],
      ),
      movieRow(
        MOVIE_BOOST,
        "Film Four",
        [],
        OTHER_STUDIO,
        [],
        [
          { id: PB, name: "Bravo" },
          { id: PC, name: "Zack" },
          { id: PD, name: "Alpha" },
        ],
      ),
      // Hidden film below is excluded from counting in the second call.
      movieRow(
        MOVIE_HIDDEN,
        "Hidden Film",
        [ROMANCE],
        OTHER_STUDIO,
        [],
        [{ id: PD, name: "Alpha" }, self],
      ),
    ];
    const result = await relatedPerformers(performerRef("tpdb", PERF_ID), []);
    assert.deepEqual(result.errors, []);
    // Abra rides three films; Alpha, Bravo and Zack ride two each (Alpha's
    // second is the film hidden only in the filtered call below), so the
    // tie falls to name order.
    assert.deepEqual(
      result.items.map((d) => [d.reference.id, d.title]),
      [
        [PA, "Abra"],
        [PD, "Alpha"],
        [PB, "Bravo"],
        [PC, "Zack"],
      ],
    );
    assert.ok(
      result.items.every(
        (d) =>
          d.reference.provider === "tpdb" && d.reference.kind === "performer",
      ),
    );

    // Titles hidden from the account never feed the count.
    const filtered = await relatedPerformers(performerRef("tpdb", PERF_ID), [
      { name: "Romance" },
    ]);
    // Alpha keeps one visible film and drops to last: the hidden title's
    // co-appearance never counted.
    assert.deepEqual(
      filtered.items.map((d) => d.reference.id),
      [PA, PB, PC, PD],
    );

    // Own-provider evidence only: no cross-provider requests.
    assert.ok(fx.log.every((r) => pathOf(r.url) !== "/graphql"));
  });
});

test("related performers use the provider-native filmography path with its performer filter", async () => {
  await withFx(async (fx) => {
    scenesReply = {
      queryScenes: {
        count: 1,
        scenes: [
          {
            ...stashSceneRow(),
            performers: [
              {
                as: null,
                performer: { id: STASH_PERF, name: "Stash Self", images: [] },
              },
              {
                as: null,
                performer: { id: STASH_P2, name: "Stash Partner", images: [] },
              },
            ],
          },
        ],
      },
    };
    const result = await relatedPerformers(
      performerRef("stashdb", STASH_PERF),
      [],
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.items.map((d) => d.reference),
      [{ provider: "stashdb", kind: "performer", id: STASH_P2 }],
    );
    assert.equal(result.items[0]!.title, "Stash Partner");
    const stashReq = fx.log.find(
      (r) => pathOf(r.url) === "/graphql" && r.body.includes("queryScenes"),
    );
    assert.ok(stashReq);
    const payload: {
      variables: { f: { performers: { value: string[]; modifier: string } } };
    } = JSON.parse(stashReq.body);
    assert.deepEqual(payload.variables.f.performers, {
      value: [STASH_PERF],
      modifier: "INCLUDES",
    });
  });
});

test("a filmography outage is a visible error, never an empty success", async () => {
  await withFx(async () => {
    const result = await relatedPerformers(performerRef("tpdb", DOWN_ID), []);
    assert.deepEqual(result.items, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.provider, "tpdb");
    assert.equal(result.errors[0]!.code, "upstream_unavailable");
  });
});

test("related performers refuse non-performer references", async () => {
  await withFx(async () => {
    await assert.rejects(
      relatedPerformers({ provider: "tpdb", kind: "movie", id: SOURCE_ID }, []),
      appError(400, "invalid_reference"),
    );
  });
});

// --- performer tags overview ---

test("performer tags count tags across visible filmography only", async () => {
  await withFx(async () => {
    filmography = [
      movieRow(SOURCE_ID, "Film One", [
        ROMANCE,
        tpdbTag(999, TAG_DOC, "Documentary"),
      ]),
      movieRow(MOVIE_TWO, "Film Two", [ROMANCE]),
      movieRow(MOVIE_HIDDEN, "Hidden Film", [COMEDY]),
    ];
    const result = await performerTags(
      performerRef("tpdb", PERF_ID),
      HIDE_COMEDY,
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.capped, false);
    // The hidden film's Comedy never counts; order is count desc, name asc.
    assert.deepEqual(result.tags, [
      { name: "Romance", count: 2 },
      { name: "Documentary", count: 1 },
    ]);
    assert.equal(result.scanned, 2);
  });
});

test("performer tags stop at the page ceiling and say so", async () => {
  await withFx(async () => {
    filmography = [movieRow(SOURCE_ID, "Film One", [ROMANCE])];
    filmographyLinks = { next: "/performers/x/movies?page=2" };
    const result = await performerTags(performerRef("tpdb", PERF_ID), []);
    // Three ceiling pages of the same single row: counted three times, and
    // capped reports the scan stopped at the ceiling, not at exhaustion.
    assert.deepEqual(result.tags, [{ name: "Romance", count: 3 }]);
    assert.equal(result.scanned, 3);
    assert.equal(result.capped, true);
  });
});

test("performer tags count stashdb scenes and pair equal normalized labels", async () => {
  await withFx(async (fx) => {
    scenesReply = {
      queryScenes: {
        count: 2,
        scenes: [
          stashSceneRow(),
          {
            ...stashSceneRow(),
            id: SCENE_UNRELATED,
            tags: [
              { id: TAG_DOC, name: "romance" },
              { id: TAG_COMEDY, name: "Documentary" },
            ],
          },
        ],
      },
    };
    const result = await performerTags(performerRef("stashdb", STASH_PERF), []);
    assert.deepEqual(result.errors, []);
    // "Romance" and "romance" are one label; the first-seen spelling wins.
    assert.deepEqual(result.tags, [
      { name: "Romance", count: 2 },
      { name: "Documentary", count: 1 },
    ]);
    assert.equal(result.scanned, 2);
    // The stashdb scene search carries the native performer filter.
    const stashReq = fx.log.find(
      (r) => pathOf(r.url) === "/graphql" && r.body.includes("queryScenes"),
    );
    assert.ok(stashReq);
    const payload: {
      variables: { f: { performers: { value: string[]; modifier: string } } };
    } = JSON.parse(stashReq.body);
    assert.deepEqual(payload.variables.f.performers, {
      value: [STASH_PERF],
      modifier: "INCLUDES",
    });
  });
});

test("performer tags keep partial pages next to the named error", async () => {
  await withFx(async () => {
    filmography = [movieRow(SOURCE_ID, "Film One", [ROMANCE])];
    filmographyLinks = { next: "/performers/x/movies?page=2" };
    filmographyFailAfter = 1; // page 2 fails
    const result = await performerTags(performerRef("tpdb", PERF_ID), []);
    // Page one's evidence survives next to the error; a half-scanned
    // overview never reads as complete or as a clean empty.
    assert.deepEqual(result.tags, [{ name: "Romance", count: 1 }]);
    assert.equal(result.scanned, 1);
    assert.equal(result.capped, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.provider, "tpdb");
    assert.equal(result.errors[0]!.code, "upstream_unavailable");
  });
});

test("a full performer-tags outage is a visible error, never an empty success", async () => {
  await withFx(async () => {
    const result = await performerTags(performerRef("tpdb", DOWN_ID), []);
    assert.deepEqual(result.tags, []);
    assert.equal(result.scanned, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.code, "upstream_unavailable");
  });
});

test("performer tags refuse non-performer references", async () => {
  await withFx(async () => {
    await assert.rejects(
      performerTags({ provider: "tpdb", kind: "movie", id: SOURCE_ID }, []),
      appError(400, "invalid_reference"),
    );
  });
});
