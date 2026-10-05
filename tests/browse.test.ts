// Browse-service regression tests: isolated 127.0.0.1 HTTP fixtures only.
// No real network, no source-text asserts — every case drives browseTitles /
// searchVisibleCatalog / searchBrowseTags / parseBrowseQuery against a
// scripted TPDB + StashDB upstream and asserts observable pages: AND versus
// OR, include+exclude+hidden precedence, page fill past blocked candidates,
// unequal source exhaustion, provider-scoped tag identity, honest totals and
// outages, the documented scan ceiling, and per-user hidden filtering.

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  appError,
  dashed,
  hexId,
  pathOf,
  queryOf,
  sendJson,
  withFixture,
  type FixtureHandler,
} from "./fixture.ts";
import { AppError } from "../src/server/http.ts";
import { resetMetaCache, resolveSort } from "../src/server/providers.ts";
import {
  browseSortIsDirectional,
  browseSortsFor,
  SORT_CAPABILITIES,
  SORT_KEYS,
  SORT_LABELS,
} from "../src/lib/sorts.ts";
import {
  browseTitles,
  parseBrowseQuery,
  planBrowseSides,
  searchBrowseTags,
  searchVisibleCatalog,
} from "../src/server/browse.ts";
import { isHiddenTitle } from "../src/server/catalog-visibility.ts";
import type { BrowseQuery } from "../src/server/browse.ts";
import type {
  CatalogProvider,
  CatalogTagSelection,
} from "../src/lib/contracts.ts";

beforeEach(() => {
  resetMetaCache();
});

// --- identity and fixture helpers ---

const uuid = (n: number): string => dashed(hexId(n));

const TPDB_TOKEN = "tpdb-browse-token-0001";
const STASH_TOKEN = "stashdb-browse-key-0001";
const ENV_KEYS = [
  "TPDB_API_TOKEN",
  "STASHDB_API_KEY",
  "TPDB_BASE_URL",
  "STASHDB_BASE_URL",
] as const;

async function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface TagRow {
  id: number;
  uuid: string;
  name: string;
}

function tpdbRow(
  id: string,
  title: string,
  date: string,
  tags: TagRow[] = [],
): unknown {
  return {
    id,
    title,
    date,
    duration: 600,
    tags,
    performers: [],
    scenes: [],
    movies: [],
    posters: {},
    background: {},
  };
}

function stashRow(
  id: string,
  title: string,
  date: string,
  tags: { id: string; name: string }[] = [],
): unknown {
  return {
    id,
    title,
    date,
    duration: 900,
    tags,
    performers: [],
    studio: null,
    urls: [],
    images: [],
  };
}

interface TpdbPage {
  rows: unknown[];
  /** Absolute next URL or null. */
  next: string | null;
  total: number;
}

async function runBrowse(
  handler: FixtureHandler,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  await withEnv(
    { TPDB_API_TOKEN: TPDB_TOKEN, STASHDB_API_KEY: STASH_TOKEN },
    async () => {
      await withFixture(handler, async (fx) => {
        process.env.TPDB_BASE_URL = fx.origin;
        process.env.STASHDB_BASE_URL = fx.origin;
        await run(fx.origin);
      });
    },
  );
}

/** Full-duplex upstream: TPDB /tags + /movies pages, StashDB queryScenes and
 * searchTag. TPDB movies advance through `pages` on each request. */
function scriptedUpstream(options: {
  tagRows: TagRow[];
  moviePages: TpdbPage[];
  scenes: { count: number; rows: unknown[] };
  tpdbMoviesStatus?: number;
  stashStatus?: number;
  /** TPDB site-key (uuid or slug) -> numeric site id, for /sites/<key>. */
  siteIds?: Record<string, number>;
  onMovieRequest?: (page: number, qs: URLSearchParams, url: string) => void;
  onScenesRequest?: (input: Record<string, unknown>) => void;
}): FixtureHandler {
  let movieRequest = 0;
  return (req, res, body) => {
    const path = pathOf(req.url ?? "");
    if (path === "/tags") {
      sendJson(res, 200, { data: options.tagRows, links: { next: null } });
      return;
    }
    if (path.startsWith("/sites/")) {
      const id = options.siteIds?.[path.slice("/sites/".length)];
      if (id === undefined) {
        sendJson(res, 404, { message: `fixture has no ${path}` });
        return;
      }
      sendJson(res, 200, { data: { id } });
      return;
    }
    // Filmography reads the same listing shape under /performers/<id>/movies.
    if (path === "/movies" || path.endsWith("/movies")) {
      if (
        options.tpdbMoviesStatus !== undefined &&
        options.tpdbMoviesStatus !== 200
      ) {
        sendJson(res, options.tpdbMoviesStatus, { message: "upstream down" });
        return;
      }
      const scripted = options.moviePages[movieRequest];
      movieRequest += 1;
      options.onMovieRequest?.(
        movieRequest,
        queryOf(req.url ?? ""),
        req.url ?? "",
      );
      // Once the script runs out: a page that ended with a next link keeps
      // serving that same page (an upstream that genuinely continues), and
      // one that ended without a link stays exhausted. Never rows-less
      // continuation, which no real provider emits.
      const last = options.moviePages.at(-1);
      const payload =
        scripted ??
        (last?.next != null
          ? last
          : { rows: [], next: null, total: last?.total ?? 0 });
      sendJson(res, 200, {
        data: payload.rows,
        links: { next: payload.next },
        meta: { total: payload.total },
      });
      return;
    }
    if (path === "/graphql") {
      if (options.stashStatus !== undefined && options.stashStatus !== 200) {
        sendJson(res, options.stashStatus, { message: "upstream down" });
        return;
      }
      const gql = JSON.parse(body) as {
        query: string;
        variables: { f?: Record<string, unknown>; t?: string };
      };
      if (gql.query.includes("queryScenes")) {
        options.onScenesRequest?.(gql.variables.f ?? {});
        sendJson(res, 200, {
          data: {
            queryScenes: {
              count: options.scenes.count,
              scenes: options.scenes.rows,
            },
          },
        });
        return;
      }
      sendJson(res, 200, { data: { searchTag: [] } });
      return;
    }
    sendJson(res, 404, { message: `fixture has no ${path}` });
  };
}

// --- parseBrowseQuery ---

test("parseBrowseQuery round-trips pinned keys and rejects malformed input", () => {
  const parsed = parseBrowseQuery(
    new URLSearchParams(
      "type=scene&q=big&include=[]&exclude=[]&studioStashdb=" +
        uuid(9) +
        "&studioMode=withChildren&year=2020&date=2026-01-31&date_operation=%3C=" +
        "&sort=duration&direction=asc&page=3&perPage=48",
    ),
  );
  assert.deepEqual(parsed, {
    type: "scene",
    q: "big",
    include: [],
    exclude: [],
    studioStashdb: uuid(9),
    studioMode: "withChildren",
    year: 2020,
    date: "2026-01-31",
    dateOperation: "<=",
    sort: "duration",
    direction: "asc",
    page: 3,
    perPage: 48,
  });
  assert.equal(parseBrowseQuery(new URLSearchParams()).type, "all");
  assert.equal(parseBrowseQuery(new URLSearchParams()).perPage, 24);
  assert.equal(
    parseBrowseQuery(new URLSearchParams("performerStarred=1"))
      .performerStarred,
    true,
  );
  assert.equal(
    "performerStarred" in parseBrowseQuery(new URLSearchParams()),
    false,
  );
  assert.throws(
    () => parseBrowseQuery(new URLSearchParams("performerStarred=yes")),
    /performerStarred must be one of: 1/,
  );
  // TPDB site slugs are studio identity beside the uuid.
  assert.equal(
    parseBrowseQuery(new URLSearchParams("studioTpdb=evilangel")).studioTpdb,
    "evilangel",
  );

  const bad: [string, string][] = [
    ["type=everyone", "invalid_query"],
    // A path character is neither a uuid nor a site slug.
    ["studioTpdb=bad%2Fslug", "invalid_query"],
    ["include=not-json", "invalid_query"],
    ["include=%7B%22name%22%3A%22x%22%7D", "invalid_preferences"], // object, not array
    ["include=" + encodeURIComponent('[{"name":"x"}]'), "invalid_preferences"], // include needs a provider id
    [
      "include=" + encodeURIComponent('[{"name":"","tpdb":"' + uuid(1) + '"}]'),
      "invalid_preferences",
    ],
    ["date=2026-01-31", "invalid_query"], // operation missing
    ["date_operation=%3C", "invalid_query"], // date missing
    ["date=yesterday&date_operation=%3C", "invalid_query"],
    ["year=1800", "invalid_query"],
    ["page=0", "invalid_query"],
    ["perPage=101", "invalid_query"],
    ["direction=desc", "invalid_query"], // sort missing
    ["sort=freshness", "invalid_query"],
  ];
  for (const [query, code] of bad) {
    assert.throws(
      () => parseBrowseQuery(new URLSearchParams(query)),
      appError(400, code),
      query,
    );
  }
  // SORT_KEYS dedupes across providers: parseEnum joins it into the 400
  // message, so each key must appear exactly once there.
  assert.throws(
    () => parseBrowseQuery(new URLSearchParams("sort=bogus")),
    (err: unknown) => {
      if (!(err instanceof AppError) || !appError(400, "invalid_query")(err))
        return false;
      return SORT_KEYS.every(
        (key) =>
          (err.message.match(new RegExp(`\\b${key}\\b`, "g")) ?? []).length ===
          1,
      );
    },
    "sort=bogus",
  );
});

// --- combination policy: refuse, never ignore ---

test("browseTitles refuses unsupported combinations before any upstream call", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const refusals: [string, Partial<BrowseQuery>][] = [
        // The wrong-kind combos (a StashDB filter on the movie tab, a TPDB
        // filter on the scene tab) no longer refuse: they keep the filter and run no side —
        // pinned by the empty-page test below and the planBrowseSides tests.
        [
          "withChildren needs stash studio",
          { type: "all", studioMode: "withChildren" },
        ],
        [
          "withChildren is stash-only",
          {
            type: "all",
            studioMode: "withChildren",
            studioStashdb: uuid(2),
            studioTpdb: uuid(1),
          },
        ],
        [
          "filmography + sort",
          { type: "all", performerTpdb: uuid(1), sort: "recency" },
        ],
        [
          "filmography + year",
          { type: "all", performerTpdb: uuid(1), year: 2020 },
        ],
        [
          "filmography + date",
          {
            type: "all",
            performerTpdb: uuid(1),
            date: "2026-01-01",
            dateOperation: "<",
          },
        ],
        ["trending cannot mix kinds", { type: "all", sort: "trending" }],
      ];
      for (const [label, extra] of refusals) {
        await assert.rejects(
          browseTitles(
            {
              type: "all",
              include: [],
              exclude: [],
              studioMode: "exact",
              page: 1,
              perPage: 24,
              ...extra,
            } as BrowseQuery,
            [],
          ),
          appError(400, "invalid_search"),
          label,
        );
      }
    },
  );
});

test("browseTitles keeps a source-scoped filter on the wrong typed tab: honest empty page, no upstream call", async () => {
  let upstreamCalls = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: { count: 0, rows: [] },
      onMovieRequest: () => {
        upstreamCalls += 1;
      },
      onScenesRequest: () => {
        upstreamCalls += 1;
      },
    }),
    async () => {
      // A scenes-only performer filter cannot run on the movie tab, and
      // nothing may run unfiltered in its place: no side qualifies, so the
      // page is provably empty before any upstream call.
      const page = await browseTitles(
        planQuery({ type: "movie", performerStashdb: uuid(2) }),
        [],
      );
      assert.deepEqual(page, {
        items: [],
        page: 1,
        perPage: 60,
        hasMore: false,
        total: 0,
        totalCountKnown: true,
        errors: [],
      });
      assert.equal(upstreamCalls, 0);
    },
  );
});

// --- native include, default recency merge, honest summed totals ---

test("browse All merges movies and scenes by release recency with native AND includes and exact summed totals", async () => {
  const TPDB_TAG = { id: 11, uuid: uuid(101), name: "Tag A" };
  const STASH_TAG = uuid(201);
  const moviePages: TpdbPage[] = [
    {
      rows: [tpdbRow(uuid(1), "Movie New", "2024-01-01", [TPDB_TAG])],
      next: null,
      total: 2,
    },
  ];
  // A second movie lives on page 2 upstream — totals count it even though
  // page one never carried the row (provider count, not item scan).
  const scenesSeen: Record<string, unknown>[] = [];
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TPDB_TAG],
      moviePages,
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(3), "Scene New", "2024-06-01", [
            { id: STASH_TAG, name: "Tag A" },
          ]),
          stashRow(uuid(4), "Scene Old", "2022-01-01"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "Tag A", tpdb: TPDB_TAG.uuid, stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Recency desc across both sources: 2024-06 scene, 2024-01 movie, 2022 scene.
      assert.deepEqual(
        page.items.map((d) => [d.reference.provider, d.reference.id]),
        [
          ["stashdb", uuid(3)],
          ["tpdb", uuid(1)],
          ["stashdb", uuid(4)],
        ],
      );
      // Totals are the exact provider counts of the displayed predicate: one
      // more TPDB movie exists beyond page one (2 + 2 scene counts = 4), even
      // though only 3 rows are displayed here. Nothing is invented.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, false);
      assert.deepEqual(page.errors, []);
      // Native AND-include on both sides: TPDB deep-object numeric key with
      // tag_and=1; StashDB INCLUDES_ALL.
      assert.match(movieUrls[0]!, /tag_and=1/);
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.equal(scenesSeen.length, 1);
      assert.deepEqual(scenesSeen[0]!.tags, {
        value: [STASH_TAG],
        modifier: "INCLUDES_ALL",
      });
    },
  );
});

// --- missing counterpart disqualifies the source; never unfiltered ---

test("an include without a resolvable StashDB id drops the scene source instead of running it unfiltered", async () => {
  const TPDB_TAG = { id: 11, uuid: uuid(101), name: "Unpaired" };
  const sceneCalls: number[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TPDB_TAG],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Only Movie", "2024-01-01", [TPDB_TAG])],
          next: null,
          total: 1,
        },
      ],
      scenes: {
        count: 5,
        rows: [stashRow(uuid(3), "Unfiltered?", "2024-06-01")],
      },
      onScenesRequest: () => sceneCalls.push(1),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "Unpaired", tpdb: TPDB_TAG.uuid }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // searchTag ran (counterpart lookup) but queryScenes never did.
      assert.equal(sceneCalls.length, 0);
      assert.deepEqual(
        page.items.map((d) => d.reference.provider),
        ["tpdb"],
      );
      assert.equal(page.totalCountKnown, true);
    },
  );
});

// --- include + exclude + hidden precedence, exclusions win ---

test("exclusions and hidden tags override includes on matching items", async () => {
  const TAG_A = { id: 11, uuid: uuid(101), name: "Include Me" };
  const TAG_B = { id: 12, uuid: uuid(102), name: "Exclude Me" };
  const TAG_H = { id: 13, uuid: uuid(103), name: "Hidden" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_A, TAG_B, TAG_H],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Clean", "2024-03-01", [TAG_A]),
            tpdbRow(uuid(2), "Excluded despite include", "2024-02-01", [
              TAG_A,
              TAG_B,
            ]),
            tpdbRow(uuid(3), "Hidden despite include", "2024-01-01", [
              TAG_A,
              TAG_H,
            ]),
            tpdbRow(uuid(4), "Clean two", "2023-01-01", [TAG_A]),
          ],
          next: null,
          total: 4,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: TAG_A.name, tpdb: TAG_A.uuid }],
          exclude: [{ name: TAG_B.name, tpdb: TAG_B.uuid }],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: TAG_H.name, tpdb: TAG_H.uuid }],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Clean", "Clean two"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
    },
  );
});

// --- page fill past blocked candidates ---

test("a page fills from later upstream pages when earlier candidates are blocked", async () => {
  const TAG_H = { id: 13, uuid: uuid(103), name: "Hidden" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_H],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Hidden one", "2024-02-01", [TAG_H])],
          next: "x",
          total: 3,
        },
        {
          rows: [tpdbRow(uuid(2), "Hidden two", "2024-01-01", [TAG_H])],
          next: "x",
          total: 3,
        },
        {
          rows: [tpdbRow(uuid(3), "Visible", "2023-01-01", [])],
          next: null,
          total: 3,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 1,
        },
        [{ name: TAG_H.name, tpdb: TAG_H.uuid }],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Visible"],
      );
      assert.equal(moviesCalled, 3); // scanned until the visible row appeared
      // True exhaustion reached: the exact matched count is known.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
      assert.equal(page.hasMore, false);
    },
  );
});

// --- unequal source exhaustion without skips or duplicates ---

test("unequal streams exhaust cleanly: no skips, no duplicates, honest combined totals", async () => {
  const moviePages: TpdbPage[] = [
    {
      rows: [tpdbRow(uuid(1), "Movie One", "2024-01-01")],
      next: null,
      total: 3,
    },
    { rows: [], next: null, total: 3 },
  ];
  const seen: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages,
      scenes: {
        count: 7,
        rows: Array.from({ length: 7 }, (_, i) =>
          stashRow(uuid(10 + i), `Scene ${i}`, `2024-06-0${(i % 9) + 1}`),
        ),
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      for (const detail of page.items) {
        const key = `${detail.reference.provider}:${detail.reference.id}`;
        assert.ok(!seen.includes(key), `duplicate ${key}`);
        seen.push(key);
      }
      // tpdb served 1 row (2 more exist beyond page one), stash served 7.
      assert.equal(page.items.length, 8);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 10); // 3 + 7, provider counts
      assert.equal(page.hasMore, false);

      const second = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 2,
          perPage: 10,
        },
        [],
      );
      assert.equal(second.items.length, 0);
      assert.equal(second.hasMore, false);
    },
  );
});

// --- provider-scoped tag identity ---

test("the same UUID on both providers is two distinct tags; hidden hides on each side", async () => {
  const shared = uuid(77);
  await runBrowse(
    scriptedUpstream({
      tagRows: [{ id: 11, uuid: shared, name: "Twin" }],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Movie hidden", "2024-02-01", [
              { id: 11, uuid: shared, name: "Twin" },
            ]),
            tpdbRow(uuid(2), "Movie visible", "2024-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(3), "Scene hidden", "2024-06-01", [
            { id: shared, name: "Twin" },
          ]),
          stashRow(uuid(4), "Scene visible", "2023-06-01"),
        ],
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: "Twin", tpdb: shared, stashdb: shared }],
      );
      assert.deepEqual(page.items.map((d) => d.title).sort(), [
        "Movie visible",
        "Scene visible",
      ]);
      assert.equal(page.total, 2);
    },
  );
});

// --- outages: partial, single, and total ---

test("provider outage keeps the healthy source visible and reports the failure", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 1, rows: [stashRow(uuid(3), "Survivor", "2024-06-01")] },
      tpdbMoviesStatus: 500,
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Survivor"],
      );
      assert.equal(page.errors.length, 1);
      assert.equal(page.errors[0]!.provider, "tpdb");
      assert.equal(page.totalCountKnown, false);
      // Both streams are done (the errored one exhausted itself on the
      // failed fetch): hasMore ends instead of baiting endless empty pages.
      assert.equal(page.hasMore, false);
    },
  );
});

test("a partial outage ends the browse: no page offers endless empty continuation", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 1, rows: [stashRow(uuid(3), "Survivor", "2024-06-01")] },
      tpdbMoviesStatus: 500,
    }),
    async () => {
      const first = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        first.items.map((d) => d.title),
        ["Survivor"],
      );
      assert.equal(first.hasMore, false);
      // Whatever still asks for the next page gets the named error and
      // again a proven end — never a fake continuation.
      const second = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 2,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(second.items, []);
      assert.equal(second.errors.length, 1);
      assert.equal(second.errors[0]!.provider, "tpdb");
      assert.equal(second.hasMore, false);
    },
  );
});

test("a single-source outage propagates and an all-source outage is never an empty success", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 0, rows: [] },
      tpdbMoviesStatus: 500,
      stashStatus: 503,
    }),
    async () => {
      await assert.rejects(
        browseTitles(
          {
            type: "movie",
            include: [],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        (err: unknown) => err instanceof AppError && (err.status ?? 0) >= 500,
      );
      await assert.rejects(
        browseTitles(
          {
            type: "all",
            include: [],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        appError(502, "provider_unavailable"),
      );
    },
  );
});

// --- scan ceiling ---

test("an unbounded narrow query ends in a visible ceiling error, not a fake end", async () => {
  const TAG_H = { id: 13, uuid: uuid(103), name: "Hidden" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_H],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Always hidden", "2024-01-01", [TAG_H])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
    }),
    async () => {
      await assert.rejects(
        browseTitles(
          {
            type: "movie",
            include: [],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 1,
          },
          [{ name: TAG_H.name, tpdb: TAG_H.uuid }],
        ),
        appError(422, "query_too_broad"),
      );
      // ponytail ceiling: exactly MAX_SCAN_PAGES upstream pages, no runaway.
      assert.equal(moviesCalled, 40);
    },
  );
});

// --- local year predicate on StashDB, native year on TPDB ---

test("year filters natively on TPDB and locally on StashDB", async () => {
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie 2020", "2020-03-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(3), "Scene 2020", "2020-05-05"),
          stashRow(uuid(4), "Scene 2021", "2021-05-05"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioMode: "exact",
          year: 2020,
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.match(movieUrls[0]!, /year=2020/);
      assert.deepEqual(page.items.map((d) => d.title).sort(), [
        "Movie 2020",
        "Scene 2020",
      ]);
      // StashDB year is a local predicate: totals are exact only because both
      // streams truly exhausted.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
    },
  );
});

// --- filmography: paging-only, tag predicates stay local ---

test("TPDB performer filmography applies includes locally without tag parameters", async () => {
  const TAG_A = { id: 11, uuid: uuid(101), name: "Include Me" };
  const performer = uuid(55);
  const urls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_A],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Has tag", "2024-01-01", [TAG_A]),
            tpdbRow(uuid(2), "No tag", "2023-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, _qs, url) => urls.push(url),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          performerTpdb: performer,
          include: [{ name: TAG_A.name, tpdb: TAG_A.uuid }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.match(urls[0]!, new RegExp(`/performers/${performer}/movies`));
      assert.doesNotMatch(urls[0]!, /tag_and|tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Has tag"],
      );
      // Filmography claims no global order; totals are exact at exhaustion.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

// --- searchVisibleCatalog ---

test("searchVisibleCatalog filters hidden rows across page boundaries; passthrough preserves totals", async () => {
  const TAG_H = uuid(103);
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: {
        count: 3,
        rows: [
          stashRow(uuid(3), "Hidden", "2024-06-01", [
            { id: TAG_H, name: "Hidden" },
          ]),
          stashRow(uuid(4), "Visible one", "2024-05-01"),
          stashRow(uuid(5), "Visible two", "2024-04-01"),
        ],
      },
    }),
    async () => {
      const filtered = await searchVisibleCatalog(
        { provider: "stashdb", kind: "scene", page: 1, perPage: 1 },
        [{ name: "Hidden", stashdb: TAG_H }],
      );
      assert.deepEqual(
        filtered.items.map((d) => d.title),
        ["Visible one"],
      );
      assert.equal(filtered.hasMore, true); // more visible rows exist upstream
      assert.equal(filtered.totalCountKnown, false);

      const passthrough = await searchVisibleCatalog(
        { provider: "stashdb", kind: "scene", page: 1, perPage: 10 },
        [],
      );
      assert.equal(passthrough.items.length, 3);
      assert.equal(passthrough.totalCountKnown, true);
      assert.equal(passthrough.total, 3);
    },
  );
});

// --- searchBrowseTags ---

test("searchBrowseTags merges same labels across providers and reports outages", async () => {
  const SHARED_T = uuid(302);
  const SHARED_S = uuid(303);
  const handler: FixtureHandler = (req, res, body) => {
    const path = pathOf(req.url ?? "");
    if (path === "/tags") {
      const q = queryOf(req.url ?? "").get("q") ?? "";
      if (q === "shared") {
        sendJson(res, 200, {
          data: [{ id: SHARED_T, uuid: SHARED_T, name: "shared" }],
          links: { next: null },
        });
        return;
      }
      sendJson(res, 500, { message: "tpdb tags down" });
      return;
    }
    if (path === "/graphql") {
      const gql = JSON.parse(body) as {
        query: string;
        variables: { t?: string };
      };
      if (gql.query.includes("searchTag")) {
        const rows =
          gql.variables.t === "shared"
            ? [{ id: SHARED_S, name: "Shared" }] // same label, different casing
            : [
                { id: uuid(310), name: "anal" },
                { id: uuid(311), name: "stash only" },
              ];
        sendJson(res, 200, { data: { searchTag: rows } });
        return;
      }
      sendJson(res, 200, { data: { searchTag: [] } });
      return;
    }
    sendJson(res, 404, {});
  };
  await runBrowse(handler, async () => {
    // TPDB tag lookup is down for this term; StashDB answers. The failure is
    // visible and the healthy source's rows are kept.
    const partial = await searchBrowseTags("anal");
    assert.equal(partial.errors.length, 1);
    assert.equal(partial.errors[0]!.provider, "tpdb");
    assert.deepEqual(
      partial.tags.map((t) => t.name),
      ["anal", "stash only"],
    );

    // Both sources healthy: the same label under different casing merges
    // into ONE selection carrying both native ids.
    const merged = await searchBrowseTags("shared");
    assert.deepEqual(merged.errors, []);
    assert.deepEqual(merged.tags, [
      { name: "shared", tpdb: SHARED_T, stashdb: SHARED_S },
    ]);
  });
});

test("searchBrowseTags with no matches and no key returns an honest empty list", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const empty = await searchBrowseTags("zzzz");
      assert.deepEqual(empty.tags, []);
      assert.deepEqual(empty.errors, []);
      assert.rejects(searchBrowseTags("z"), appError(400, "invalid_query"));
    },
  );
});

// --- isHiddenTitle: family rule (whole-word sequence), never raw substring ---

test("isHiddenTitle matches UUID, whole label, or word family; never raw substring or blank labels", () => {
  const detail = (tags: { id: string; name: string }[]) =>
    ({
      reference: { provider: "stashdb", kind: "scene", id: uuid(9) },
      title: "t",
      tags,
      credits: [],
      related: [],
      links: [],
      aliases: [],
    }) as Parameters<typeof isHiddenTitle>[0];
  const hidden: CatalogTagSelection[] = [
    { name: "Rough", stashdb: uuid(8) },
    { name: "audlt-typo", stashdb: uuid(9) },
  ];
  assert.equal(
    isHiddenTitle(detail([{ id: uuid(8), name: "ROUGH!" }]), hidden),
    true,
  ); // uuid match wins even though the label differs
  assert.equal(
    isHiddenTitle(detail([{ id: uuid(12), name: "rough" }]), hidden),
    true,
  ); // exact normalized label
  assert.equal(
    isHiddenTitle(detail([{ id: uuid(12), name: "rough evening" }]), hidden),
    true,
  ); // family: "rough" appears as a whole word of the tag
  assert.equal(
    isHiddenTitle(detail([{ id: uuid(12), name: "roughing" }]), hidden),
    false,
  ); // raw substring never matches — the whole word must
  assert.equal(isHiddenTitle(detail([]), hidden), false);

  const family: CatalogTagSelection[] = [{ name: "Double Penetration" }];
  assert.equal(
    isHiddenTitle(
      detail([{ id: uuid(12), name: "Double Anal Penetration" }]),
      family,
    ),
    false,
  ); // multi-word selection needs its words contiguous
  assert.equal(
    isHiddenTitle(
      detail([{ id: uuid(12), name: "Rough Double Penetration" }]),
      family,
    ),
    true,
  );
  assert.equal(
    isHiddenTitle(detail([{ id: uuid(12), name: "Anal" }]), [{ name: "   " }]),
    false,
  ); // a blank selection label hides nothing
});

// --- family matching in browse: hidden/exclude catch word sequences, includes stay exact ---

test("a hidden single-word tag removes child-labelled titles while a longer unrelated word survives", async () => {
  const CHILD = { id: 12, uuid: uuid(102), name: "Anal Creampie" };
  const LONGER = { id: 13, uuid: uuid(103), name: "Analingus" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [CHILD, LONGER],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Child Label", "2024-03-01", [CHILD]),
            tpdbRow(uuid(2), "Longer Word", "2024-02-01", [LONGER]),
            tpdbRow(uuid(3), "Clean", "2024-01-01"),
          ],
          next: null,
          total: 3,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: "Anal", tpdb: uuid(101) }], // uuid matches nothing: label decides
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Longer Word", "Clean"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
    },
  );
});

test("family excludes need contiguous words; provider UUID still wins over labels", async () => {
  const DP = { id: 12, uuid: uuid(102), name: "Double Penetration" };
  const DAP = { id: 13, uuid: uuid(103), name: "Double Anal Penetration" };
  const MISLABEL = { id: 14, uuid: uuid(104), name: "Completely Different" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [DP, DAP, MISLABEL],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Excluded Contiguous", "2024-03-01", [DP]),
            tpdbRow(uuid(2), "Survives Non Contiguous", "2024-02-01", [DAP]),
            tpdbRow(uuid(3), "Hidden By Uuid", "2024-01-01", [MISLABEL]),
          ],
          next: null,
          total: 3,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [{ name: "Double Penetration", tpdb: uuid(102) }],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: "Personal Hidden", tpdb: uuid(104) }],
      );
      // "Double Anal Penetration" breaks the contiguous word run; the
      // mislabelled tag still matches its provider UUID.
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Survives Non Contiguous"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

test("a free-text exclude carries no provider id and still hides by label family", async () => {
  const PARENT = { id: 11, uuid: uuid(101), name: "Anal" };
  const OTHER = { id: 12, uuid: uuid(102), name: "Analingus" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [PARENT, OTHER],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Parent Tagged", "2024-02-01", [PARENT]),
            tpdbRow(uuid(2), "Letter Overlap", "2024-01-01", [OTHER]),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [{ name: "Anal" }],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The provider is never asked for a tag id it was never given; the
      // local family matcher does the whole exclusion.
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Letter Overlap"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

test("a TPDB studio slug resolves through /sites to its numeric site_id", async () => {
  const siteIds: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Studio Movie", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      siteIds: { evilangel: 70 },
      onMovieRequest: (_page, qs) => {
        siteIds.push(qs.get("site_id") ?? "MISSING");
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [],
          studioTpdb: "evilangel",
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Studio Movie"],
      );
    },
  );
  // TPDB filters by the numeric id only; the slug never travels upstream.
  assert.deepEqual(siteIds, ["70"]);
});

test("a studio filter on both sides means OR: each source keeps its own clause", async () => {
  const stashStudios: unknown[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Studio Movie", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: {
        count: 1,
        rows: [stashRow(uuid(2), "Studio Scene", "2024-02-02")],
      },
      siteIds: { [uuid(3)]: 70 },
      onScenesRequest: (input) =>
        stashStudios.push(
          (input.studios as { value: string[] } | undefined)?.value,
        ),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [],
          exclude: [],
          studioTpdb: uuid(3),
          studioStashdb: uuid(4),
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The union: the TPDB movie and the StashDB scene both survive — a
      // conjunction of the two clauses could only ever return nothing.
      assert.deepEqual(page.items.map((d) => d.title).sort(), [
        "Studio Movie",
        "Studio Scene",
      ]);
    },
  );
  // The StashDB query carried only the StashDB studio, never the TPDB id.
  assert.deepEqual(stashStudios, [[uuid(4)]]);
});

test("filmography local includes stay exact: a parent label never returns child-only rows", async () => {
  const PARENT = { id: 11, uuid: uuid(101), name: "Anal" };
  const CHILD = { id: 12, uuid: uuid(102), name: "Rough Anal Sex" };
  const performer = uuid(55);
  await runBrowse(
    scriptedUpstream({
      tagRows: [PARENT, CHILD],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Parent Tagged", "2024-02-01", [PARENT]),
            tpdbRow(uuid(2), "Child Only", "2024-01-01", [CHILD]),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          performerTpdb: performer,
          include: [{ name: PARENT.name, tpdb: PARENT.uuid }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Parent Tagged"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

test("native includes stay exact: the parent travels as its provider id, child rows never qualify", async () => {
  const PARENT = { id: 11, uuid: uuid(101), name: "Anal" };
  const CHILD = { id: 12, uuid: uuid(102), name: "Rough Anal Sex" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [PARENT, CHILD],
      // An exact provider answers tag_and=<parent id> with only
      // parent-tagged rows; the child-only movie exists upstream but never
      // qualifies.
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Parent Tagged", "2024-01-01", [PARENT])],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, _qs, url) => movieUrls.push(url),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: PARENT.name, tpdb: PARENT.uuid }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Exactness is the native id criterion itself: tag_and over the
      // parent's tag id, never a widened label predicate, and the child
      // tag's id is never sent.
      assert.match(movieUrls[0]!, /tag_and=1/);
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.doesNotMatch(movieUrls[0]!, /tags%5B12%5D=1|tags\[12\]=1/);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Parent Tagged"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

// --- the side decision, directly: every refusal and every side outcome is
// provable from the query alone, so these need no upstream fixture at all ---

function planQuery(overrides: Partial<BrowseQuery> = {}): BrowseQuery {
  return {
    type: "all",
    include: [],
    exclude: [],
    studioMode: "exact",
    page: 1,
    perPage: 60,
    ...overrides,
  };
}

// Contract move: a source-scoped filter on the wrong typed tab no longer
// refuses (400) — the tab keeps the filter in the URL and shows an honest
// empty page, and a unified pair keeps running the side the tab names.
test("planBrowseSides keeps source-scoped filters on the wrong kind: no side qualifies; unions keep the side that can", () => {
  for (const [field, type] of [
    ["performerStashdb", "movie"],
    ["studioStashdb", "movie"],
    ["performerTpdb", "scene"],
    ["studioTpdb", "scene"],
    ["performerStarred", "movie"],
  ] as const) {
    const sides = planBrowseSides(
      planQuery({
        type,
        // ponytail: computed key needs the cast — the loop covers exactly
        // the five source-scoped fields above.
        [field]: field === "performerStarred" ? true : uuid(1),
      } as Partial<BrowseQuery>),
    ).sides;
    assert.deepEqual(sides, [], `${field} on ${type} runs no side`);
  }
  // The performer union (both ids) runs the one side the tab names, with
  // its own constraint: Movies shows her TPDB filmography, Scenes her
  // StashDB side.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "movie",
        performerTpdb: uuid(1),
        performerStashdb: uuid(6),
      }),
    ).sides,
    ["tpdb"],
  );
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "scene",
        performerTpdb: uuid(1),
        performerStashdb: uuid(6),
      }),
    ).sides,
    ["stashdb"],
  );
  // The unified studio tile behaves the same way.
  assert.deepEqual(
    planBrowseSides(
      planQuery({ type: "movie", studioTpdb: uuid(1), studioStashdb: uuid(2) }),
    ).sides,
    ["tpdb"],
  );
  assert.deepEqual(
    planBrowseSides(
      planQuery({ type: "scene", studioTpdb: uuid(1), studioStashdb: uuid(2) }),
    ).sides,
    ["stashdb"],
  );
});

test("planBrowseSides refuses withChildren without a StashDB studio and with a TPDB studio", () => {
  assert.throws(
    () => planBrowseSides(planQuery({ studioMode: "withChildren" })),
    /requires a StashDB studio/,
  );
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          studioMode: "withChildren",
          studioStashdb: uuid(2),
          studioTpdb: uuid(3),
        }),
      ),
    /StashDB-only/,
  );
});

test("planBrowseSides refuses every filmography combination that upstream rejects", () => {
  const filmography = {
    performerTpdb: uuid(4),
    type: "all" as const,
  };
  for (const extra of [
    { q: "term" },
    { year: 2024 },
    { date: "2024-02-03" },
    { studioTpdb: uuid(5) },
    { sort: "title" as const },
  ]) {
    assert.throws(
      () => planBrowseSides(planQuery({ ...filmography, ...extra })),
      /TPDB performer filmography/,
      `${JSON.stringify(extra)} must refuse`,
    );
  }
});

test("planBrowseSides refuses non-mixed sorts on All", () => {
  assert.throws(
    () => planBrowseSides(planQuery({ type: "all", sort: "title" })),
    /not available on both sources/,
  );
});

test("planBrowseSides keeps search and sort on the Scenes tab of a unified performer pair", () => {
  // Search no longer refuses, and the default recency order applies.
  const searched = planBrowseSides(
    planQuery({
      type: "scene",
      performerTpdb: uuid(4),
      performerStashdb: uuid(6),
      q: "term",
    }),
  );
  assert.deepEqual(searched.sides, ["stashdb"]);
  assert.deepEqual(searched.nativeSort, { key: "recency", direction: "desc" });
  assert.deepEqual(searched.mergeOrder, { key: "recency", direction: "desc" });
  // An explicit sort passes through to the one StashDB stream instead of 400.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "scene",
        performerTpdb: uuid(4),
        performerStashdb: uuid(6),
        sort: "title",
      }),
    ).nativeSort,
    { key: "title" },
  );
});

test("planBrowseSides picks sides: one-sided clauses kill only their own side", () => {
  assert.deepEqual(planBrowseSides(planQuery()).sides, ["tpdb", "stashdb"]);
  assert.deepEqual(planBrowseSides(planQuery({ type: "movie" })).sides, [
    "tpdb",
  ]);
  assert.deepEqual(planBrowseSides(planQuery({ type: "scene" })).sides, [
    "stashdb",
  ]);
  // A StashDB filter (performer or studio) kills the movie side: the user
  // asked for StashDB scenes. A TPDB studio likewise kills the scene side.
  assert.deepEqual(
    planBrowseSides(planQuery({ performerStashdb: uuid(6) })).sides,
    ["stashdb"],
  );
  assert.deepEqual(
    planBrowseSides(planQuery({ studioStashdb: uuid(7) })).sides,
    ["stashdb"],
  );
  // A unified studio tile carries both ids: the clauses are alternatives,
  // not a conjunction, so both sides run.
  assert.deepEqual(
    planBrowseSides(planQuery({ studioStashdb: uuid(7), studioTpdb: uuid(8) }))
      .sides,
    ["tpdb", "stashdb"],
  );
  // The performer pair unions by the same alternative-clauses rule as the
  // unified studio tile: both ids together run both sides.
  assert.deepEqual(
    planBrowseSides(
      planQuery({ performerTpdb: uuid(1), performerStashdb: uuid(6) }),
    ).sides,
    ["tpdb", "stashdb"],
  );
});

test("planBrowseSides derives order: filmography claims none, defaults are release recency", () => {
  const def = planBrowseSides(planQuery());
  assert.deepEqual(def.nativeSort, { key: "recency", direction: "desc" });
  assert.deepEqual(def.mergeOrder, { key: "recency", direction: "desc" });

  const film = planBrowseSides(
    planQuery({ performerTpdb: uuid(4), type: "movie" }),
  );
  assert.equal(film.filmography, true);
  assert.equal(film.nativeSort, undefined);
  assert.equal(film.mergeOrder, undefined);

  // The performer union keeps the filmography route's no-sort claim.
  const union = planBrowseSides(
    planQuery({ performerTpdb: uuid(4), performerStashdb: uuid(6) }),
  );
  assert.equal(union.filmography, true);
  assert.equal(union.nativeSort, undefined);
  assert.equal(union.mergeOrder, undefined);

  const explicit = planBrowseSides(
    planQuery({ type: "movie", sort: "duration", direction: "asc" }),
  );
  assert.deepEqual(explicit.nativeSort, { key: "duration", direction: "asc" });
  assert.deepEqual(explicit.mergeOrder, { key: "duration", direction: "asc" });

  // A single-side explicit sort that the provider owns passes natively and
  // claims no merge order.
  const native = planBrowseSides(planQuery({ type: "movie", sort: "title" }));
  assert.deepEqual(native.nativeSort, { key: "title" });
  assert.equal(native.mergeOrder, undefined);
});

test("planBrowseSides routes the starred-performer filter: stashdb scenes only, empty page on movies, refuse performer combos", () => {
  const starred = planBrowseSides(planQuery({ performerStarred: true }));
  assert.deepEqual(starred.sides, ["stashdb"]);
  assert.equal(starred.filmography, false);
  assert.deepEqual(
    planBrowseSides(
      planQuery({ performerStarred: true, studioStashdb: uuid(7) }),
    ).sides,
    ["stashdb"],
  );
  // Movies can never match a scenes-only starred filter: the tab keeps the
  // chip in the URL and runs no side (honest empty page).
  assert.deepEqual(
    planBrowseSides(planQuery({ performerStarred: true, type: "movie" })).sides,
    [],
  );
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({ performerStarred: true, performerTpdb: uuid(1) }),
      ),
    /A starred-performer filter cannot be combined with a TPDB performer\./,
  );
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({ performerStarred: true, performerStashdb: uuid(6) }),
      ),
    /A starred-performer filter cannot be combined with a StashDB performer\./,
  );
});

test("browseTitles with starred and no StashDB-side follows returns an honest empty page before any upstream call", async () => {
  const page = await browseTitles(planQuery({ performerStarred: true }), []);
  assert.deepEqual(page, {
    items: [],
    page: 1,
    perPage: 60,
    hasMore: false,
    total: 0,
    totalCountKnown: true,
    errors: [],
  });
});

// --- the offered sorts and the accepted sorts are one table (lib/sorts.ts) ---

test("planBrowseSides and resolveSort accept every sort the client offers", () => {
  for (const type of ["all", "movie", "scene"] as const) {
    for (const key of browseSortsFor(type)) {
      for (const direction of browseSortIsDirectional(type, key)
        ? (["asc", "desc"] as const)
        : ([undefined] as const)) {
        // The client's wire form: type rides only on typed tabs, direction
        // only on sorts that take one.
        const params = new URLSearchParams({ sort: key });
        if (type !== "all") params.set("type", type);
        if (direction !== undefined) params.set("direction", direction);
        const plan = planBrowseSides(parseBrowseQuery(params));
        if (type === "all") {
          assert.deepEqual(plan.mergeOrder, {
            key: key as "recency" | "duration",
            direction: direction ?? "desc",
          });
        } else {
          const [provider, kind] =
            type === "movie"
              ? (["tpdb", "movie"] as const)
              : (["stashdb", "scene"] as const);
          assert.equal(resolveSort(provider, kind, key, direction).key, key);
        }
      }
    }
  }
});

test("the drifted offers stay dead: no date on All, no direction on relevance", () => {
  // Browse All once offered "Release date" (StashDB-only) and 400ed the
  // merge; the offer now equals the server's mixed set exactly.
  assert.deepEqual([...browseSortsFor("all")], ["recency", "duration"]);
  assert.throws(() =>
    planBrowseSides(parseBrowseQuery(new URLSearchParams("sort=date"))),
  );
  // Movies once offered "Best match" with a direction always attached and
  // 400ed on the single-stream fast path.
  assert.equal(browseSortIsDirectional("movie", "relevance"), false);
  assert.throws(() => resolveSort("tpdb", "movie", "relevance", "desc"));
  // A mixed All sort takes a direction on both sources — recency via
  // StashDB's date order — so the toggle shows and asc is reachable there.
  assert.equal(browseSortIsDirectional("all", "recency"), true);
  assert.equal(browseSortIsDirectional("all", "duration"), true);
});

test("every sort-table row is observable: membership, direction rule, offers", () => {
  // The offers per tab are exactly the table rows, in table order.
  assert.deepEqual(
    [...browseSortsFor("movie")],
    ["relevance", "recency", "duration"],
  );
  assert.deepEqual(
    [...browseSortsFor("scene")],
    [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ],
  );
  // Every sort key has a label (the select and the chip); the wording is
  // display copy, not a contract.
  assert.deepEqual([...Object.keys(SORT_LABELS)].sort(), [...SORT_KEYS].sort());
  assert.ok(
    Object.values(SORT_LABELS).every((label) => label.length > 0),
    "every sort key needs a non-empty label",
  );
  // Every table row: resolveSort accepts exactly the table membership and
  // honors the directional flag; the client's direction rule matches the
  // flag on the typed tab that runs the side.
  for (const [provider, kinds] of Object.entries(SORT_CAPABILITIES)) {
    for (const [kind, specs] of Object.entries(kinds)) {
      for (const spec of specs ?? []) {
        const applied = resolveSort(
          provider as CatalogProvider,
          kind as "movie" | "scene",
          spec.key,
          spec.directional ? "asc" : undefined,
        );
        assert.equal(applied.key, spec.key);
        assert.equal(applied.direction, spec.directional ? "asc" : undefined);
        const tab = provider === "tpdb" ? "movie" : "scene";
        assert.equal(browseSortIsDirectional(tab, spec.key), spec.directional);
      }
    }
  }
  // A key the tab's side does not carry reads as non-directional: a stale
  // relevance on the Scenes tab clamps its direction off, never crashes.
  assert.equal(browseSortIsDirectional("scene", "relevance"), false);
});
