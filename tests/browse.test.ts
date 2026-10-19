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
  resolveIncludeCriteria,
  scanCeilingOutcome,
  softCeilingFor,
  TAG_FILTER_ID_CAP,
} from "../src/lib/browse-includes.ts";
import {
  browseTitles,
  parseBrowseQuery,
  planBrowseSides,
  searchBrowseTags,
  searchVisibleCatalog,
} from "../src/server/browse.ts";
import { isHiddenTitle } from "../src/server/catalog-visibility.ts";
import type { BrowsePage, BrowseQuery } from "../src/server/browse.ts";
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
  /** Absent on some real TPDB rows: tpdbTags then emits a numeric-string id. */
  uuid?: string;
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
  /** HTTP status for the TPDB /tags listing (the counterpart tag lookup). */
  tpdbTagsStatus?: number;
  /** HTTP status for the StashDB queryTags listing (the counterpart tag
   * lookup; also the free-text expansion walk). */
  stashQueryTagsStatus?: number;
  /** Rows for the StashDB searchTag. The counterpart lookup left searchTag
   * for the listing walk; searchTag now answers only listCatalogTags (the
   * no-match suggestion path, which searches the empty term). The fixture
   * honours the term: only rows whose name contains it return. */
  stashTagRows?: { id: string; name: string }[];
  /** Rows for the StashDB queryTags listing (the complete tag vocabulary
   * the free-text expansion walks). */
  stashQueryTagRows?: { id: string; name: string }[];
  /** Paged TPDB /tags listing for the expansion walk: entry i answers
   * `page=i+1`; past the last entry the last repeats (an upstream that
   * genuinely continues). Term'd counterpart reads keep the single-page
   * shape. The array is read per request, so a test may mutate it between
   * walks the way a published vocabulary changes while the app stays up. */
  tpdbTagPages?: TpdbPage[];
  /** Paged StashDB queryTags listing for the expansion walk: entry i
   * answers `page=i+1`; past the last entry the last repeats. */
  stashQueryTagPages?: {
    count: number;
    rows: { id: string; name: string }[];
  }[];
  /** TPDB site-key (uuid or slug) -> numeric site id, for /sites/<key>. */
  siteIds?: Record<string, number>;
  /** Query string of each TPDB /tags read (expansion walks carry no term;
   * counterpart lookups do). */
  onTagsRequest?: (qs: URLSearchParams) => void;
  onMovieRequest?: (page: number, qs: URLSearchParams, url: string) => void;
  onScenesRequest?: (input: Record<string, unknown>) => void;
}): FixtureHandler {
  let movieRequest = 0;
  return (req, res, body) => {
    const path = pathOf(req.url ?? "");
    if (path === "/tags") {
      if (
        options.tpdbTagsStatus !== undefined &&
        options.tpdbTagsStatus !== 200
      ) {
        sendJson(res, options.tpdbTagsStatus, { message: "upstream down" });
        return;
      }
      // The search honours its term (the real provider filters by it); the
      // unterm'd listing walk that backs free-text expansion returns
      // everything.
      const qs = queryOf(req.url ?? "");
      options.onTagsRequest?.(qs);
      const q = qs.get("q");
      // The term-less listing walk serves its scripted pages; the term'd
      // counterpart read keeps the single-page shape below.
      if (!q && options.tpdbTagPages) {
        const page = Number(qs.get("page") ?? "1");
        const entry =
          options.tpdbTagPages[page - 1] ?? options.tpdbTagPages.at(-1)!;
        sendJson(res, 200, { data: entry.rows, links: { next: entry.next } });
        return;
      }
      const rows = q
        ? options.tagRows.filter((t) =>
            t.name.toLowerCase().includes(q.toLowerCase()),
          )
        : options.tagRows;
      sendJson(res, 200, { data: rows, links: { next: null } });
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
        variables: { f?: Record<string, unknown>; t?: string; p?: number };
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
      // queryTags is the complete tag listing the free-text expansion
      // walks and the counterpart lookup reads: every row, with its count
      // (the fixture vocabulary fits one page), or a scripted outage when
      // stashQueryTagsStatus says so.
      if (gql.query.includes("queryTags")) {
        if (
          options.stashQueryTagsStatus !== undefined &&
          options.stashQueryTagsStatus !== 200
        ) {
          sendJson(res, options.stashQueryTagsStatus, {
            message: "upstream down",
          });
          return;
        }
        // The listing walk serves its scripted pages; past the last entry
        // the last repeats.
        if (options.stashQueryTagPages) {
          const page = Number(gql.variables.p ?? 1);
          const entry =
            options.stashQueryTagPages[page - 1] ??
            options.stashQueryTagPages.at(-1)!;
          sendJson(res, 200, {
            data: { queryTags: { count: entry.count, tags: entry.rows } },
          });
          return;
        }
        const rows = options.stashQueryTagRows ?? [];
        sendJson(res, 200, {
          data: { queryTags: { count: rows.length, tags: rows } },
        });
        return;
      }
      // searchTag answers listCatalogTags (the no-match suggestion path,
      // which searches the empty term): every scripted row whose name
      // contains the term.
      const term =
        typeof gql.variables.t === "string"
          ? gql.variables.t.toLowerCase()
          : "";
      sendJson(res, 200, {
        data: {
          searchTag: (options.stashTagRows ?? []).filter((t) =>
            t.name.toLowerCase().includes(term),
          ),
        },
      });
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
    // A label-only include is a free-text term now, not a 400: it filters
    // locally as a substring (pinned positively below).
    [
      "include=" + encodeURIComponent('[{"name":"","tpdb":"' + uuid(1) + '"}]'),
      "invalid_preferences",
    ],
    ["date=2026-01-31", "invalid_query"], // operation missing
    ["date_operation=%3C", "invalid_query"], // date missing
    ["date=yesterday&date_operation=%3C", "invalid_query"],
    // Regex-shaped but impossible calendar dates: refused locally, never
    // shipped upstream as a provider-shaped 400/502.
    ["date=2025-02-30&date_operation=%3D", "invalid_query"],
    ["date=2025-13-01&date_operation=%3D", "invalid_query"],
    ["year=1800", "invalid_query"],
    ["year=1899", "invalid_query"],
    ["year=2101", "invalid_query"],
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
  // A label-only include is a free-text term: it parses and rides to
  // browseTitles, which applies it locally as a substring.
  assert.deepEqual(
    parseBrowseQuery(
      new URLSearchParams("include=" + encodeURIComponent('[{"name":"xyz"}]')),
    ).include,
    [{ name: "xyz", tpdb: undefined, stashdb: undefined }],
  );
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
      assert.equal(upstreamCalls, 0, "refusals must not touch either upstream");
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

// --- latency: provider sides fetch side by side ---

test("browse All asks StashDB for scenes while TPDB is still answering movies", async () => {
  const inner = scriptedUpstream({
    tagRows: [],
    moviePages: [
      { rows: [tpdbRow(uuid(1), "Movie", "2024-01-01")], next: null, total: 1 },
    ],
    scenes: { count: 1, rows: [stashRow(uuid(3), "Scene", "2024-06-01")] },
  });
  const scenesAsked = Promise.withResolvers<void>();
  await runBrowse(
    (req, res, body) => {
      const path = pathOf(req.url ?? "");
      if (path === "/graphql" && body.includes("queryScenes")) {
        scenesAsked.resolve();
      }
      if (path !== "/movies") return inner(req, res, body);
      // The movie page answers only once StashDB has been asked. A merge
      // that waits for TPDB before asking StashDB stalls here until the
      // TPDB read times out, so the page loses the movie and names an error.
      void scenesAsked.promise.then(() => inner(req, res, body));
    },
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
        page.items.map((d) => d.reference.id),
        [uuid(3), uuid(1)],
      );
      assert.deepEqual(page.errors, []);
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

// --- a broken counterpart lookup is an outage, never absence ---

test("a failed StashDB tag listing keeps the movie page but names the outage instead of an exact TPDB-only total", async () => {
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
        rows: [stashRow(uuid(3), "Unqueried", "2024-06-01")],
      },
      stashQueryTagsStatus: 500,
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
      // The scene side is dropped (never run unfiltered) and its outage is
      // named beside the movie results that did survive.
      assert.equal(sceneCalls.length, 0);
      assert.deepEqual(
        page.items.map((d) => d.reference.provider),
        ["tpdb"],
      );
      assert.equal(page.errors.length, 1);
      assert.equal(page.errors[0]!.provider, "stashdb");
      assert.equal(page.errors[0]!.code, "upstream_unavailable");
      // A wanted side is dark: the surviving side's count is not the
      // catalog total, so it must not read as exact.
      assert.equal(page.totalCountKnown, false);
    },
  );
});

test("when every wanted side's include lookup fails, browse is a 502 instead of an exact empty catalog", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      tpdbTagsStatus: 500,
      stashQueryTagsStatus: 500,
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      // Each selection anchors only the other side, so both sides need a
      // counterpart lookup and both lookups are down.
      await assert.rejects(
        browseTitles(
          {
            type: "all",
            include: [
              { name: "Only Stash", stashdb: uuid(201) },
              { name: "Only Tpdb", tpdb: uuid(101) },
            ],
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

test("every side failing after a side already delivered rows keeps the partial page", async () => {
  let movies = 0;
  const handler: FixtureHandler = (req, res) => {
    const path = pathOf(req.url ?? "");
    if (path === "/movies") {
      movies += 1;
      if (movies === 1) {
        // First page delivers a real match, then continues.
        sendJson(res, 200, {
          data: [tpdbRow(uuid(1), "First page match", "2024-02-01")],
          links: { next: "x" },
          meta: { total: 10000 },
        });
        return;
      }
      // The continuation dies: a real outage after delivered rows.
      sendJson(res, 500, { message: "upstream down" });
      return;
    }
    if (path === "/graphql") {
      sendJson(res, 500, { message: "upstream down" });
      return;
    }
    sendJson(res, 404, { message: `fixture has no ${path}` });
  };
  await runBrowse(handler, async () => {
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
    // Both sides ended in outages, but the movie side had already delivered
    // its page-1 row: the partial page survives with both errors named.
    assert.deepEqual(
      page.items.map((d) => d.reference.id),
      [uuid(1)],
    );
    assert.deepEqual(
      page.errors.map((e) => [e.provider, e.code]),
      [
        ["tpdb", "upstream_unavailable"],
        ["stashdb", "upstream_unavailable"],
      ],
    );
    assert.equal(page.totalCountKnown, false);
    assert.equal(page.hasMore, false);
  });
});

// --- include criteria decisions (pure, extracted from browse.ts) ---

/** A complete, native expansion: the only shape the native criteria accept
 * on its own. */
const ready = (ids: string[]) => ({ complete: true, dropped: false, ids });

test("resolveIncludeCriteria joins singleton expansions with anchored ids in the all-of criterion", () => {
  // The single-tag all-of rule: a singleton group is as good as an anchored
  // id (an AND match carries it), and multi-id terms keep the local
  // re-check.
  assert.deepEqual(
    resolveIncludeCriteria(
      [uuid(1)],
      [ready([uuid(9)]), ready([uuid(2), uuid(3)])],
    ),
    {
      allOf: [uuid(1), uuid(9)],
      anyOf: [],
      localTermIndexes: [1],
      freeTextNative: true,
      provablyEmpty: false,
    },
  );
  // Anchored ids alone: the all-of path with nothing free riding native.
  assert.deepEqual(
    resolveIncludeCriteria([uuid(1)], [ready([uuid(2), uuid(3)])]),
    {
      allOf: [uuid(1)],
      anyOf: [],
      localTermIndexes: [0],
      freeTextNative: false,
      provablyEmpty: false,
    },
  );
  // A singleton duplicating an anchored id travels once.
  const deduped = resolveIncludeCriteria(
    [uuid(7)],
    [ready([uuid(7)]), ready([uuid(8), uuid(9)])],
  );
  assert.deepEqual(deduped.allOf, [uuid(7)]);
  assert.deepEqual(deduped.localTermIndexes, [1]);
  assert.equal(deduped.freeTextNative, true);
});

test("resolveIncludeCriteria rides the smallest group as any-of and keeps the rest local", () => {
  // No singleton and no anchored id: the smallest multi-id group is the
  // valid any-of pre-filter, the other terms keep filtering locally.
  assert.deepEqual(
    resolveIncludeCriteria(
      [],
      [ready([uuid(1), uuid(2), uuid(3)]), ready([uuid(4), uuid(5)])],
    ),
    {
      allOf: [],
      anyOf: [uuid(4), uuid(5)],
      localTermIndexes: [0],
      freeTextNative: true,
      provablyEmpty: false,
    },
  );
  // Equal-size groups keep the first: the smallest pick is stable.
  const tie = resolveIncludeCriteria(
    [],
    [ready([uuid(1), uuid(2)]), ready([uuid(3), uuid(4)])],
  );
  assert.deepEqual(tie.anyOf, [uuid(1), uuid(2)]);
  assert.deepEqual(tie.localTermIndexes, [1]);
});

test("resolveIncludeCriteria routes a union past the native id cap to local filtering", () => {
  const atCap = resolveIncludeCriteria(
    [],
    [ready(Array.from({ length: TAG_FILTER_ID_CAP }, (_, i) => uuid(i + 1)))],
  );
  assert.equal(atCap.anyOf.length, TAG_FILTER_ID_CAP);
  assert.equal(atCap.freeTextNative, true);
  // One id more and the criterion would silently ignore its tail upstream:
  // the whole group filters locally instead.
  assert.deepEqual(
    resolveIncludeCriteria(
      [],
      [
        ready(
          Array.from({ length: TAG_FILTER_ID_CAP + 1 }, (_, i) => uuid(i + 1)),
        ),
      ],
    ),
    {
      allOf: [],
      anyOf: [],
      localTermIndexes: [0],
      freeTextNative: false,
      provablyEmpty: false,
    },
  );
  // The same overload with an anchored id: the anchored id still travels
  // the all-of criterion, the oversized term stays local.
  assert.deepEqual(
    resolveIncludeCriteria(
      [uuid(9)],
      [
        ready(
          Array.from({ length: TAG_FILTER_ID_CAP + 1 }, (_, i) => uuid(i + 1)),
        ),
      ],
    ),
    {
      allOf: [uuid(9)],
      anyOf: [],
      localTermIndexes: [0],
      freeTextNative: false,
      provablyEmpty: false,
    },
  );
  // No terms at all: nothing rides, nothing re-checks — the function is
  // total over empty input.
  assert.deepEqual(resolveIncludeCriteria([], []), {
    allOf: [],
    anyOf: [],
    localTermIndexes: [],
    freeTextNative: false,
    provablyEmpty: false,
  });
});

test("resolveIncludeCriteria keeps the whole group local when any term expands incompletely", () => {
  for (const bad of [
    { complete: false, dropped: false, ids: [uuid(2)] }, // capped listing walk
    { complete: true, dropped: true, ids: [uuid(2)] }, // uuid-less match
  ]) {
    assert.deepEqual(
      resolveIncludeCriteria([uuid(9)], [ready([uuid(1)]), bad]),
      {
        allOf: [uuid(9)],
        anyOf: [],
        localTermIndexes: [0, 1],
        freeTextNative: false,
        provablyEmpty: false,
      },
    );
  }
  // No terms at all: nothing rides and nothing re-checks.
  assert.deepEqual(resolveIncludeCriteria([uuid(9)], []), {
    allOf: [uuid(9)],
    anyOf: [],
    localTermIndexes: [],
    freeTextNative: false,
    provablyEmpty: false,
  });
});

test("resolveIncludeCriteria reads a complete empty expansion as a provably empty side", () => {
  // A complete, fresh listing walk (card 926308ec bounds the listing's
  // age) that holds no tag for the term and no uuid-less match grounds
  // the absence: no published tag contains the term, so no title can
  // carry it and the AND can never match on this side.
  assert.deepEqual(
    resolveIncludeCriteria([], [{ complete: true, dropped: false, ids: [] }]),
    {
      allOf: [],
      anyOf: [],
      localTermIndexes: [0],
      freeTextNative: false,
      provablyEmpty: true,
    },
  );
  // Anchored ids change nothing: the AND still cannot match; the anchored
  // ids still travel the inert allOf field.
  assert.deepEqual(
    resolveIncludeCriteria(
      [uuid(9)],
      [{ complete: true, dropped: false, ids: [] }],
    ),
    {
      allOf: [uuid(9)],
      anyOf: [],
      localTermIndexes: [0],
      freeTextNative: false,
      provablyEmpty: true,
    },
  );
  // One absent term among several kills the whole AND, whichever slot it
  // sits in: the other terms' expansions cannot rescue it.
  assert.equal(
    resolveIncludeCriteria(
      [],
      [{ complete: true, dropped: false, ids: [] }, ready([uuid(3)])],
    ).provablyEmpty,
    true,
  );
  assert.equal(
    resolveIncludeCriteria(
      [],
      [ready([uuid(3)]), { complete: true, dropped: false, ids: [] }],
    ).provablyEmpty,
    true,
  );
  // uuid-less matches exist, so titles could still carry the term on this
  // side: not absence — the local scan stays.
  assert.equal(
    resolveIncludeCriteria([], [{ complete: true, dropped: true, ids: [] }])
      .provablyEmpty,
    false,
  );
});

test("softCeilingFor degrades only a native free-text term that still re-checks locally", () => {
  assert.equal(
    softCeilingFor({ localInclude: [{}], freeTextNative: true }),
    true,
  );
  assert.equal(
    softCeilingFor({ localInclude: [], freeTextNative: true }),
    false,
  );
  assert.equal(
    softCeilingFor({ localInclude: [{}], freeTextNative: false }),
    false,
  );
  assert.equal(
    softCeilingFor({ localInclude: [], freeTextNative: false }),
    false,
  );
});

test("scanCeilingOutcome throws hard ceilings and degrades soft ones to scan_ceiling", () => {
  assert.deepEqual(scanCeilingOutcome(false, "tpdb"), { hard: true });
  assert.deepEqual(scanCeilingOutcome(true, "stashdb"), {
    hard: false,
    error: {
      provider: "stashdb",
      code: "scan_ceiling",
      message:
        "Reached the upstream page limit while filling this page — results are incomplete; narrow the filters.",
    },
  });
});

// --- free-text includes: expand on each provider's tags, travel native ---

test("a free-text include expands on each provider's tags and travels as a native all-of filter", async () => {
  const TPDB_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const STASH_XYZ = uuid(201);
  const movieUrls: string[] = [];
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TPDB_XYZ],
      stashQueryTagRows: [{ id: STASH_XYZ, name: "XYZ Thing" }],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Movie with", "2024-02-01", [TPDB_XYZ]),
            tpdbRow(uuid(2), "Movie without", "2024-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(3), "Scene with", "2024-06-01", [
            { id: STASH_XYZ, name: "XYZ Thing" },
          ]),
          stashRow(uuid(4), "Scene without", "2022-01-01"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The term expanded on both providers (each side's complete tag
      // listing walk); its one matching tag travels as each side's native
      // all-of criterion — a single tag a title must carry is the all-of
      // form by definition. The fixture returns every row regardless of
      // the native filter, so the untagged siblings stay: there is no
      // local substring post-filter to drop them. Recency-desc merge order.
      assert.deepEqual(
        page.items.map((d) => [d.reference.provider, d.reference.id]),
        [
          ["stashdb", uuid(3)],
          ["tpdb", uuid(1)],
          ["tpdb", uuid(2)],
          ["stashdb", uuid(4)],
        ],
      );
      // Fully native includes: the providers' own totals pass through.
      assert.equal(page.hasMore, false);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 4);
      assert.deepEqual(page.errors, []);
      // TPDB: the expanded tag rides the all-of criterion (its uuid 101
      // resolved to numeric 11) under tag_and.
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[0]!, /tag_and=1/);
      // StashDB: the expansion is the INCLUDES_ALL (all-of) criterion.
      assert.deepEqual(scenesSeen[0]!.tags, {
        value: [STASH_XYZ],
        modifier: "INCLUDES_ALL",
      });
    },
  );
});

test("a free-text term that expands on no TPDB tag drops the movie side and keeps the scene side", async () => {
  const STASH_XYZ = uuid(201);
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      // TPDB publishes no tag containing the term.
      tagRows: [],
      stashQueryTagRows: [{ id: STASH_XYZ, name: "XYZ Thing" }],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Whatever", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(3), "Scene with", "2024-06-01", [
            { id: STASH_XYZ, name: "XYZ Thing" },
          ]),
        ],
      },
      onMovieRequest: (_page, qs) => {
        moviesCalled += 1;
        movieUrls.push(qs.toString());
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Moved pin: this test held that "an empty expansion is never proof
      // the side is empty" — the movie side scanned unfiltered while its
      // local predicate dropped every row, costing up to 40 /movies reads
      // per page view. The complete freshness-bounded TPDB listing (card
      // 926308ec) grounds the absence: no published tag contains the
      // term, so the movie side is provably empty and skipped before any
      // /movies read. The scene side carries its expansion natively.
      assert.equal(moviesCalled, 0);
      assert.deepEqual(movieUrls, []);
      assert.deepEqual(
        page.items.map((d) => d.reference.provider),
        ["stashdb"],
      );
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("a 30-tag TPDB expansion filters the movie side locally instead of sending a truncated native union", async () => {
  const fillers = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i,
    uuid: uuid(1000 + i),
    name: `Filler ${i + 1}`,
  }));
  const tagWalks: (string | null)[] = [];
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: fillers,
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Tag one only", "2024-02-01", [fillers[0]!]),
            tpdbRow(uuid(2), "Tag twenty-six only", "2024-01-01", [
              fillers[25]!,
            ]),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onTagsRequest: (qs) => tagWalks.push(qs.get("q")),
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "filler" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The expansion reads the complete listing (the walk carries no
      // term), so all 30 published tags match — past the native 25-id
      // criterion cap, where the upstream would silently ignore the tail.
      // Nothing native travels: the side scans with the local substring
      // predicate and keeps the title carrying only tag #26 (the old
      // behavior sent 25 of 30 ids and claimed exact totals while that
      // title vanished).
      assert.deepEqual(tagWalks, [null]);
      assert.doesNotMatch(movieUrls[0]!, /tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Tag one only", "Tag twenty-six only"],
      );
      // Exact only because the scan truly exhausted its listing.
      assert.equal(page.total, 2);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("a union at the native id cap stays native; one past it filters locally", async () => {
  const makeFillers = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: 100 + i,
      uuid: uuid(1000 + i),
      name: `Filler ${i + 1}`,
    }));
  const run = async (count: number) => {
    // Each run scripts a fresh vocabulary: drop the process-lifetime
    // listing memo so the second walk really reads the second fixture.
    resetMetaCache();
    let movieUrl = "";
    let page: BrowsePage;
    await runBrowse(
      scriptedUpstream({
        tagRows: makeFillers(count),
        moviePages: [
          {
            rows: [
              tpdbRow(uuid(1), "Tagged", "2024-01-01", [
                { id: 100, uuid: uuid(1000), name: "Filler 1" },
              ]),
            ],
            next: null,
            total: 1,
          },
        ],
        scenes: { count: 0, rows: [] },
        onMovieRequest: (_page, qs) => {
          movieUrl = qs.toString();
        },
      }),
      async () => {
        page = await browseTitles(
          {
            type: "movie",
            include: [{ name: "filler" }],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        );
      },
    );
    return { movieUrl, page: page! };
  };
  // Exactly 25 ids: the native criterion carries the whole union — the
  // fast path passes the provider's totals through. The cap is inclusive.
  const atCap = await run(25);
  assert.match(atCap.movieUrl, /tags%5B100%5D=1|tags\[100\]=1/);
  assert.equal(atCap.page.totalCountKnown, true);
  assert.equal(atCap.page.total, 1);
  assert.deepEqual(
    atCap.page.items.map((d) => d.reference.id),
    [uuid(1)],
  );
  // 26 ids: one more than the native criterion carries, so nothing native
  // travels — a partial union would silently drop its tail.
  const over = await run(26);
  assert.doesNotMatch(over.movieUrl, /tags%5B|tags\[/);
  assert.equal(over.page.total, 1);
  assert.deepEqual(
    over.page.items.map((d) => d.reference.id),
    [uuid(1)],
  );
});

test("a 30-tag StashDB expansion filters the scene side locally instead of sending a truncated native union", async () => {
  const fillers = Array.from({ length: 30 }, (_, i) => ({
    id: uuid(2000 + i),
    name: `Filler ${i + 1}`,
  }));
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      stashQueryTagRows: fillers,
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(1), "Tag one only", "2024-06-01", [fillers[0]!]),
          stashRow(uuid(2), "Tag twenty-six only", "2024-05-01", [
            fillers[25]!,
          ]),
        ],
      },
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "scene",
          include: [{ name: "filler" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Same union-over-cap rule on the StashDB side: no INCLUDES criterion
      // travels, the scene query runs unfiltered, and the local substring
      // predicate keeps both matching scenes — including the one tagged
      // only with tag #26, which a truncated 25-id union would have lost.
      assert.equal(scenesSeen[0]!.tags, undefined);
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1), uuid(2)],
      );
      assert.equal(page.total, 2);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

// --- the expansion walk: paging, the row cap, and the memo's age ---

test("the TPDB expansion walk reads past page one and a later page's tag travels native", async () => {
  const TAG_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  let tagPageReads = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      // Page 2 holds the only tag matching the term: a walk that stops
      // after page one never finds it.
      tagRows: [],
      tpdbTagPages: [
        {
          rows: [{ id: 20, uuid: uuid(200), name: "Unrelated" }],
          next: "https://tpdb.example/tags?page=2",
          total: 0,
        },
        { rows: [TAG_XYZ], next: null, total: 0 },
      ],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie Foo", "2024-02-01", [TAG_XYZ])],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onTagsRequest: (qs) => {
        if (!qs.get("q")) tagPageReads += 1;
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The walk ran to the end signal (two pages) and the page-2 tag
      // rides the native all-of criterion with exact provider totals.
      assert.equal(tagPageReads, 2);
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[0]!, /tag_and=1/);
      assert.equal(page.totalCountKnown, true);
    },
  );
});

test("the StashDB expansion walk reads past page one and a later page's tag travels native", async () => {
  const STASH_XYZ = uuid(201);
  const fillers = Array.from({ length: 100 }, (_, i) => ({
    id: uuid(2000 + i),
    name: `Unrelated ${i + 1}`,
  }));
  const tailFillers = Array.from({ length: 49 }, (_, i) => ({
    id: uuid(3000 + i),
    name: `Tail ${i + 1}`,
  }));
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      // The provider claims 150 tags over two pages; page 2 holds the only
      // tag matching the term.
      stashQueryTagPages: [
        { count: 150, rows: fillers },
        {
          count: 150,
          rows: [{ id: STASH_XYZ, name: "XYZ Thing" }, ...tailFillers],
        },
      ],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(1), "Scene Foo", "2024-06-01", [
            { id: STASH_XYZ, name: "XYZ Thing" },
          ]),
        ],
      },
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "scene",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The page-2 tag rides the native INCLUDES_ALL criterion; a walk
      // that stopped after page one would have scanned locally instead.
      assert.deepEqual(scenesSeen[0]!.tags, {
        value: [STASH_XYZ],
        modifier: "INCLUDES_ALL",
      });
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
    },
  );
});

test("a rows-less StashDB page before count keeps the expansion local", async () => {
  const STASH_XYZ = uuid(201);
  const fillers = Array.from({ length: 99 }, (_, i) => ({
    id: uuid(2000 + i),
    name: `Unrelated ${i + 1}`,
  }));
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      // The provider claims 150 tags but sends a rows-less page after the
      // first hundred: 50 published rows are missing, so the walk is
      // incomplete — the same rule as TPDB's rows-less page beside a next
      // link.
      stashQueryTagPages: [
        {
          count: 150,
          rows: [{ id: STASH_XYZ, name: "XYZ Thing" }, ...fillers],
        },
        { count: 150, rows: [] },
      ],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(1), "Scene Foo", "2024-06-01", [
            { id: STASH_XYZ, name: "XYZ Thing" },
          ]),
        ],
      },
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "scene",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Incomplete: the tag must not ride a native union under
      // claimed-exact totals — the side scans locally and keeps the scene.
      assert.equal(scenesSeen[0]!.tags, undefined);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Scene Foo"],
      );
    },
  );
});

test("an endless TPDB listing caps the walk and never sends the capped tag native", async () => {
  const TAG_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  let tagPageReads = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      // Every page repeats: the listing never ends. 100 rows a page, so
      // the walk must stop at the 5000-row cap after 50 reads and report
      // the expansion incomplete.
      tagRows: [],
      tpdbTagPages: [
        {
          rows: [
            TAG_XYZ,
            ...Array.from({ length: 99 }, (_, i) => ({
              id: 200 + i,
              uuid: uuid(2000 + i),
              name: `Unrelated ${i + 1}`,
            })),
          ],
          next: "https://tpdb.example/tags?page=2",
          total: 0,
        },
      ],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie Foo", "2024-02-01", [TAG_XYZ])],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onTagsRequest: (qs) => {
        if (!qs.get("q")) tagPageReads += 1;
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // 50 reads = the 5000-row cap at 100 rows a page (hardcoded, like
      // the cache windows in tests/api.test.ts: swapping the cap in
      // src/server/providers.ts fails this test).
      assert.equal(tagPageReads, 50);
      // Capped: complete is false, so XYZ never rides a native criterion —
      // the side scans locally and keeps the tagged movie (the fixture's
      // movie listing truly exhausts, so its totals stay exact).
      assert.doesNotMatch(movieUrls[0]!, /tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Movie Foo"],
      );
    },
  );
});

test("a capped TPDB walk keeps the hard ceiling on an endless movie source", async () => {
  const TAG_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  await runBrowse(
    scriptedUpstream({
      // Endless tag listing: the walk caps at 5000 rows, incomplete.
      tagRows: [],
      tpdbTagPages: [
        {
          rows: [
            TAG_XYZ,
            ...Array.from({ length: 99 }, (_, i) => ({
              id: 200 + i,
              uuid: uuid(2000 + i),
              name: `Unrelated ${i + 1}`,
            })),
          ],
          next: "https://tpdb.example/tags?page=2",
          total: 0,
        },
      ],
      // Endless movie pages: the local scan hits the documented ceiling. A
      // single-term local AND keeps the hard ceiling, so the named 422 is
      // the answer — never an exact-sounding partial page.
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie Foo", "2024-02-01", [TAG_XYZ])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      // Early pages still fill (the endless source yields a match on every
      // page), so the test asks a page the scan cannot reach: the merge
      // must pull past the documented 40-page ceiling, where a single-term
      // local AND keeps the hard ceiling — the named 422 is the answer,
      // never an exact-sounding partial page.
      await assert.rejects(
        browseTitles(
          {
            type: "movie",
            include: [{ name: "xyz" }],
            exclude: [],
            studioMode: "exact",
            page: 5,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
    },
  );
});

test("a capped StashDB walk keeps the hard ceiling on an endless scene source", async () => {
  const STASH_XYZ = uuid(201);
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      // Endless listing per the provider's own count: the walk caps at
      // 5000 rows, incomplete.
      stashQueryTagPages: [
        {
          count: 1_000_000,
          rows: [
            { id: STASH_XYZ, name: "XYZ Thing" },
            ...Array.from({ length: 99 }, (_, i) => ({
              id: uuid(2000 + i),
              name: `Unrelated ${i + 1}`,
            })),
          ],
        },
      ],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: {
        count: 100000,
        rows: [
          stashRow(uuid(9), "Scene Foo", "2024-06-01", [
            { id: STASH_XYZ, name: "XYZ Thing" },
          ]),
        ],
      },
    }),
    async () => {
      // Early pages still fill (the endless source yields a match on every
      // page), so the test asks a page the scan cannot reach: the hard
      // ceiling is the answer, never an exact-sounding partial page.
      await assert.rejects(
        browseTitles(
          {
            type: "scene",
            include: [{ name: "xyz" }],
            exclude: [],
            studioMode: "exact",
            page: 5,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
    },
  );
});

test("the memoized tag listing expires and the re-walk picks up newly published tags", async () => {
  const TAG_A = { id: 11, uuid: uuid(101), name: "Foo A" };
  const TAG_B = { id: 12, uuid: uuid(102), name: "Foo B" };
  // The listing the fixture serves mutates between walks, the way a
  // published vocabulary changes while the app container stays up.
  const tagPages: TpdbPage[] = [{ rows: [TAG_A], next: null, total: 0 }];
  let tagPageReads = 0;
  const movieUrls: string[] = [];
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  try {
    Date.now = () => now;
    await runBrowse(
      scriptedUpstream({
        tagRows: [],
        tpdbTagPages: tagPages,
        moviePages: [
          {
            rows: [
              tpdbRow(uuid(1), "Movie A", "2024-01-01", [TAG_A]),
              tpdbRow(uuid(2), "Movie B", "2024-02-01", [TAG_B]),
            ],
            next: null,
            total: 2,
          },
        ],
        scenes: { count: 0, rows: [] },
        onTagsRequest: (qs) => {
          if (!qs.get("q")) tagPageReads += 1;
        },
        onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      }),
      async () => {
        const query = {
          type: "movie" as const,
          include: [{ name: "foo" }],
          exclude: [],
          studioMode: "exact" as const,
          page: 1,
          perPage: 10,
        };
        // First walk: Foo A only, riding the native criterion.
        await browseTitles(query, []);
        assert.equal(tagPageReads, 1);
        assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
        assert.doesNotMatch(movieUrls[0]!, /tags%5B12%5D|tags\[12\]/);
        // Eleven minutes in: the 10-minute page cache has expired, so any
        // upstream read would show — but the listing memo (one hour) still
        // answers, and no tag page is read. The identical query may also
        // skip the movie read only while the page cache lives, so the
        // assertion counts tag pages, not movie reads.
        now += 11 * 60_000;
        await browseTitles(query, []);
        assert.equal(tagPageReads, 1);
        // Past the window the walk re-reads the listing: Foo B (now on
        // page 2) joins the native criterion instead of staying invisible
        // until the process restarts.
        tagPages.length = 0;
        tagPages.push(
          {
            rows: [TAG_A],
            next: "https://tpdb.example/tags?page=2",
            total: 0,
          },
          { rows: [TAG_B], next: null, total: 0 },
        );
        // A full day: past any sane listing window (hardcoded, like the
        // cache windows in tests/api.test.ts).
        now += 24 * 60 * 60 * 1000;
        await browseTitles(query, []);
        assert.equal(tagPageReads, 3);
        // The last movie read (the third browse; the second may have been
        // served from the 10-minute page cache without an upstream read)
        // carries BOTH tags: Foo B joined the native criterion.
        assert.match(movieUrls.at(-1)!, /tags%5B11%5D=1|tags\[11\]=1/);
        assert.match(movieUrls.at(-1)!, /tags%5B12%5D=1|tags\[12\]=1/);
      },
    );
  } finally {
    Date.now = realNow;
  }
});

test("a complete fresh listing with no match answers the side provably empty without a scan", async () => {
  // The pin this test replaces (0081f6b: "an empty expansion is never
  // proof the side is empty — the side scans into the 422 ceiling")
  // predates the freshness-bounded listing walk (card 926308ec): the
  // expansion now reads a COMPLETE listing re-walked within its TTL
  // window, so an empty id list with no uuid-less match is grounded
  // absence — no published tag contains the term, so no title can carry
  // it. The side answers exact zero before any upstream scan instead of
  // paying 40 pages per side per page view for a typo and ending in a
  // 422 that blames breadth.
  let sceneCalls = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      // The scene listing is complete: one non-matching tag, and the walk
      // stops because the rows cover the claimed count.
      stashQueryTagPages: [
        { count: 1, rows: [{ id: uuid(201), name: "Drama" }] },
      ],
      // The source keeps claiming more pages, so only a scan could ever
      // notice — and no scan happens.
      scenes: {
        count: 100000,
        rows: [stashRow(uuid(9), "Untagged", "2024-06-01")],
      },
      onScenesRequest: () => {
        sceneCalls += 1;
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "scene",
          include: [{ name: "zzqx" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.equal(sceneCalls, 0);
      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.hasMore, false);
    },
  );
});

test("an incomplete listing keeps the local scan and the hard 422 ceiling", async () => {
  // The provably-empty answer needs a COMPLETE walk: a rows-less page
  // while the count still claims more leaves the expansion incomplete,
  // the absence is not grounded, and the side scans unfiltered into the
  // documented ceiling — the honesty point 0081f6b pinned, kept.
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      // Page 1 is rows-less while count claims 5 tags: incomplete walk.
      stashQueryTagPages: [{ count: 5, rows: [] }],
      scenes: {
        count: 100000,
        rows: [stashRow(uuid(9), "Untagged", "2024-06-01")],
      },
    }),
    async () => {
      await assert.rejects(
        browseTitles(
          {
            type: "scene",
            include: [{ name: "zzqx" }],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
    },
  );
});

test("one provably empty side drops while the other side still streams", async () => {
  // All tab, term "drama": the TPDB listing is complete and holds no
  // matching tag, so the movie side is provably empty and skipped before
  // any /movies read; the StashDB side expands natively and streams.
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [], // complete empty TPDB tag vocabulary
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      stashQueryTagRows: [{ id: uuid(201), name: "Drama" }],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(5), "Drama scene", "2024-06-01", [
            { id: uuid(201), name: "Drama" },
          ]),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "drama" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(movieUrls, []);
      assert.equal(page.items.length, 1);
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
    },
  );
});

test("two free-text includes that each match one tag go native as an all-of AND", async () => {
  const TAG_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_ABC = { id: 12, uuid: uuid(102), name: "ABC Thing" };
  const movieUrls: string[] = [];
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ, TAG_ABC],
      stashQueryTagRows: [
        { id: uuid(201), name: "XYZ Special" },
        { id: uuid(202), name: "ABC Thing" },
      ],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Both tags", "2024-03-01", [TAG_XYZ, TAG_ABC]),
            tpdbRow(uuid(2), "Only xyz", "2024-02-01", [TAG_XYZ]),
            tpdbRow(uuid(3), "Untagged", "2024-01-01"),
          ],
          next: null,
          total: 3,
        },
      ],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(5), "Scene both", "2024-06-01", [
            { id: uuid(201), name: "XYZ Special" },
            { id: uuid(202), name: "ABC Thing" },
          ]),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Each term matched exactly one published tag per side, so the
      // all-of criterion IS the AND: both ids travel natively with tag_and.
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[0]!, /tags%5B12%5D=1|tags\[12\]=1/);
      assert.match(movieUrls[0]!, /tag_and=1/);
      assert.deepEqual(scenesSeen[0]!.tags, {
        value: [uuid(201), uuid(202)],
        modifier: "INCLUDES_ALL",
      });
      // Fully native: the fixture returns every row regardless of the
      // criterion, and nothing is re-checked locally. Recency-desc merge.
      assert.deepEqual(
        page.items.map((d) => [d.reference.provider, d.reference.id]),
        [
          ["stashdb", uuid(5)],
          ["tpdb", uuid(1)],
          ["tpdb", uuid(2)],
          ["tpdb", uuid(3)],
        ],
      );
      assert.equal(page.total, 4);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("a free-text include whose TPDB expansion holds a uuid-less tag filters the movie side locally instead of 400ing", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" }; // uuid-less: numeric-string id
  const LEGACY_PLUS = { id: 11, uuid: uuid(101), name: "Legacy Plus" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM, LEGACY_PLUS],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Legacy movie", "2024-01-01", [LEGACY_NUM]),
            tpdbRow(uuid(2), "Plain movie", "2023-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "legacy" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Before the uuid-less guard this threw 400 invalid_search ("TPDB tag
      // filters require TPDB tag UUIDs"). Now the term goes local: the
      // movie query carries NO tag criterion, and the visible predicate
      // keeps only the title actually tagged Legacy.
      assert.equal(movieUrls.length, 1);
      assert.doesNotMatch(movieUrls[0]!, /tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1)],
      );
      // A finite scan reports exact totals even when filtering locally.
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("a uuid-less TPDB expansion keeps the movie side local while StashDB stays native on All", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" };
  const STASH_TAG = uuid(201);
  const movieUrls: string[] = [];
  const scenesSeen: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM],
      stashQueryTagRows: [{ id: STASH_TAG, name: "Legacy" }],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Legacy movie", "2024-01-01", [LEGACY_NUM]),
            tpdbRow(uuid(2), "Plain movie", "2022-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(3), "Legacy scene", "2024-06-01", [
            { id: STASH_TAG, name: "Legacy" },
          ]),
          stashRow(uuid(4), "Plain scene", "2023-01-01"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => scenesSeen.push(input),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "legacy" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The TPDB expansion is uuid-less, so the movie side filters locally
      // (no tag criterion on the wire); the StashDB expansion is a real
      // UUID and — a single tag the title must carry — travels as the
      // native all-of INCLUDES_ALL. Recency merge.
      assert.doesNotMatch(movieUrls[0]!, /tags%5B|tags\[/);
      assert.deepEqual(scenesSeen[0]!.tags, {
        value: [STASH_TAG],
        modifier: "INCLUDES_ALL",
      });
      assert.deepEqual(
        page.items.map((d) => [d.reference.provider, d.reference.id]),
        [
          ["stashdb", uuid(3)],
          ["tpdb", uuid(1)],
          ["stashdb", uuid(4)],
        ],
      );
      // The fixture returns every row regardless of the native scene
      // filter, so the untagged scene sibling stays; the local movie
      // predicate drops the untagged movie.
      assert.equal(page.total, 3);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("a free-text term matching only uuid-less TPDB tags runs the movie side locally instead of 400ing or reading as absence", async () => {
  const VINTAGE = { id: 305, name: "Vintage" }; // uuid-less
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [VINTAGE],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Vintage movie", "2024-01-01", [VINTAGE])],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => {
        moviesCalled += 1;
        movieUrls.push(qs.toString());
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "vintage" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The term matches a published tag with no UUID: no native criterion
      // is possible, but the tag still matches details by name, so the side
      // runs locally rather than 400ing (the bug) or vanishing (absence).
      assert.equal(moviesCalled, 1);
      assert.doesNotMatch(movieUrls[0]!, /tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1)],
      );
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("an anchored include whose TPDB counterpart is uuid-less runs the movie side locally instead of 400ing or reading absence", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" }; // uuid-less TPDB row
  const STASH_TAG = uuid(201);
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM],
      stashTagRows: [{ id: STASH_TAG, name: "Legacy" }],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Legacy movie", "2024-01-01", [LEGACY_NUM]),
            tpdbRow(uuid(2), "Untagged movie", "2023-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(3), "Legacy scene", "2024-06-01", [
            { id: STASH_TAG, name: "Legacy" },
          ]),
        ],
      },
      onMovieRequest: (_page, _qs, url) => {
        moviesCalled += 1;
        movieUrls.push(url);
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "Legacy", stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The anchored StashDB id pairs with a uuid-less TPDB tag: the label
      // exists upstream, so absence is never claimed. The movie side runs
      // locally — no native tag criterion on the wire, the visible
      // predicate re-checks the exact label — while the scene side carries
      // its own anchored id natively. The pin formerly asserted the drop
      // (an exact 1, movies unread); a uuid-less row is not absence.
      assert.equal(moviesCalled, 1);
      assert.doesNotMatch(movieUrls[0]!, /tag_and|tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => [d.reference.provider, d.title]),
        [
          ["stashdb", "Legacy scene"],
          ["tpdb", "Legacy movie"],
        ],
      );
      // Both streams exhausted: the locally filtered total is exact, and
      // the untagged movie stayed dropped.
      assert.equal(page.total, 2);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("an anchored uuid-less counterpart keeps totals approximate until the local side exhausts", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" };
  const STASH_TAG = uuid(201);
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM],
      stashTagRows: [{ id: STASH_TAG, name: "Legacy" }],
      moviePages: [
        {
          rows: [
            ...Array.from({ length: 10 }, (_, i) =>
              tpdbRow(uuid(100 + i), `Legacy movie ${i + 1}`, "2024-01-01", [
                LEGACY_NUM,
              ]),
            ),
            tpdbRow(uuid(2), "Untagged movie", "2023-01-01"),
          ],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "Legacy", stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The local side filled the page before exhausting upstream: an
      // exact count would claim a completeness the scan never reached, so
      // the total stays unknown (the regression reported an exact 0).
      assert.equal(page.items.length, 10);
      assert.equal(page.hasMore, true);
      assert.equal(page.total, undefined);
      assert.equal(page.totalCountKnown, false);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("TPDB performer filmography keeps a uuid-less anchored include local instead of dropping the filmography", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" }; // uuid-less TPDB row
  const STASH_TAG = uuid(201);
  const performer = uuid(55);
  const urls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM],
      stashTagRows: [{ id: STASH_TAG, name: "Legacy" }],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Legacy movie", "2024-01-01", [LEGACY_NUM])],
          next: null,
          total: 1,
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
          include: [{ name: "Legacy", stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The filmography route rejects tag parameters, so the uuid-less
      // anchored include filters locally like any other include there — it
      // must not disqualify the only wanted side (the regression returned
      // an exact empty filmography with zero upstream reads).
      assert.match(urls[0]!, new RegExp(`/performers/${performer}/movies`));
      assert.doesNotMatch(urls[0]!, /tag_and|tags%5B|tags\[/);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Legacy movie"],
      );
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
    },
  );
});

test("an anchored include whose label has no TPDB tag at all still disqualifies the movie side", async () => {
  const STASH_TAG = uuid(201);
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [{ id: 305, name: "Unrelated" }],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Unfiltered?", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: {
        count: 1,
        rows: [
          stashRow(uuid(3), "Ghost scene", "2024-06-01", [
            { id: STASH_TAG, name: "Ghost" },
          ]),
        ],
      },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "Ghost", stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // No exact-label TPDB tag exists: the side could only run unfiltered,
      // so the disqualification stands — absence with proof, never a
      // filterless stream.
      assert.equal(moviesCalled, 0);
      assert.deepEqual(
        page.items.map((d) => d.reference.provider),
        ["stashdb"],
      );
      assert.equal(page.totalCountKnown, true);
    },
  );
});

test("searchBrowseTags never returns a non-UUID tpdb id", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" };
  const LEGACY_PLUS = { id: 11, uuid: uuid(101), name: "Legacy Plus" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM, LEGACY_PLUS],
      stashTagRows: [{ id: uuid(201), name: "Legacy" }],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const picked = await searchBrowseTags("legacy");
      // The uuid-less TPDB row never rides back: "Legacy" carries only its
      // StashDB id, "Legacy Plus" its TPDB UUID. Before the guard the
      // numeric id passed through, and a stored selection built from it was
      // rejected by the storage boundary with a misleading label 400.
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const tag of picked.tags) {
        if (tag.tpdb !== undefined) assert.match(tag.tpdb, UUID_RE);
        if (tag.stashdb !== undefined) assert.match(tag.stashdb, UUID_RE);
      }
      assert.deepEqual(
        picked.tags.map((t) => [
          t.name,
          t.tpdb !== undefined,
          t.stashdb !== undefined,
        ]),
        [
          ["Legacy Plus", true, false],
          ["Legacy", false, true],
        ],
      );
      assert.deepEqual(picked.errors, []);
    },
  );
});

test("a multi-match free-text AND pre-filters natively, ANDs locally, and degrades at the scan ceiling instead of erroring", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_ABC = { id: 13, uuid: uuid(103), name: "ABC Thing" };
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_ABC],
      // abc's expansion is the singleton tag 13: it rides the all-of
      // criterion and xyz keeps the local re-check. The fixture returns
      // every row regardless of the native filter; the endless abc-only
      // rows are what a faithful upstream would return, and their missing
      // xyz tag never fills the page, so the stream runs to its ceiling.
      moviePages: [
        {
          rows: [tpdbRow(uuid(2), "Only abc", "2024-02-01", [TAG_ABC])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => {
        moviesCalled += 1;
        movieUrls.push(qs.toString());
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The smallest term's expansion is a single tag: it rides the
      // all-of criterion alone and the other term ANDs locally; the
      // ceiling degrades the browse instead of 422ing.
      assert.match(movieUrls.join("\n"), /tags%5B13%5D=1|tags\[13\]=1/);
      assert.match(movieUrls.join("\n"), /tag_and=1/);
      assert.doesNotMatch(movieUrls.join("\n"), /tags%5B11%5D=1|tags\[11\]=1/);
      assert.equal(moviesCalled, 40);
      assert.deepEqual(page.items, []);
      assert.equal(page.totalCountKnown, false);
      assert.equal(page.hasMore, false);
      assert.deepEqual(
        page.errors.map((e) => [e.provider, e.code]),
        [["tpdb", "scan_ceiling"]],
      );
    },
  );
});

test("a multi-match free-text AND returns the partial matches beside the ceiling error", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_ABC = { id: 13, uuid: uuid(103), name: "ABC Thing" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_ABC],
      moviePages: [
        {
          // First page: one full AND match amid abc-only rows.
          rows: [
            tpdbRow(uuid(1), "Both terms", "2024-03-01", [TAG_XYZ_A, TAG_ABC]),
            tpdbRow(uuid(2), "Only abc", "2024-02-01", [TAG_ABC]),
          ],
          next: "x",
          total: 10000,
        },
        {
          // The endless continuation only ever carries the abc tag (what
          // the native tag_and pre-filter would return), so the local xyz
          // AND never fills the page again.
          rows: [tpdbRow(uuid(2), "Only abc", "2024-02-01", [TAG_ABC])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The one real AND match survives beside the named incompleteness.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1)],
      );
      assert.equal(page.totalCountKnown, false);
      assert.deepEqual(
        page.errors.map((e) => e.code),
        ["scan_ceiling"],
      );
    },
  );
});

test("a scan-ceiling side beside a real outage returns the partial page, not a 502", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_ABC = { id: 13, uuid: uuid(103), name: "ABC Thing" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_ABC],
      // Endless pages of abc-only rows (what the native tag_and pre-filter
      // would return): the local xyz AND never fills the page, so the TPDB
      // stream runs to its ceiling — a bounded matchless answer, not an
      // outage.
      moviePages: [
        {
          rows: [tpdbRow(uuid(2), "Only abc", "2024-02-01", [TAG_ABC])],
          next: "x",
          total: 10000,
        },
      ],
      // StashDB is dark: its include expansion (the queryTags listing
      // walk) 500s, so the scene side enters the merge as an
      // already-failed stream.
      stashStatus: 500,
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Ceiling beside outage is a partial (matchless) page with both
      // errors named, never a 502 provider_unavailable.
      assert.deepEqual(page.items, []);
      assert.equal(page.totalCountKnown, false);
      assert.equal(page.hasMore, false);
      assert.deepEqual(
        page.errors.map((e) => [e.provider, e.code]),
        [
          ["tpdb", "scan_ceiling"],
          ["stashdb", "upstream_unavailable"],
        ],
      );
    },
  );
});

test("a free-text include expands by folded substring, not family", async () => {
  const TPDB_XYZ = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TPDB_XYZ],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Inside a word", "2024-02-01", [TPDB_XYZ]),
            tpdbRow(uuid(2), "Untagged sibling", "2024-01-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      // "yz" sits inside the token "xyz": the expansion keeps the tag
      // (folded substring of the published name), where the family matcher
      // (whole-word token runs) would drop it — so the native any-of
      // criterion carries tag 11.
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "yz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      // The fixture returns every row regardless of the native filter.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1), uuid(2)],
      );
      assert.equal(page.total, 2);
      assert.equal(page.totalCountKnown, true);
    },
  );
});

test("a free-text singleton joins the anchored tag in the native all-of criterion", async () => {
  const TAG_A = { id: 11, uuid: uuid(101), name: "Tag A" };
  const TAG_XYZ = { id: 12, uuid: uuid(102), name: "XYZ Special" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_A, TAG_XYZ],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Both", "2024-03-01", [TAG_A, TAG_XYZ]),
            tpdbRow(uuid(2), "Only native", "2024-02-01", [TAG_A]),
            tpdbRow(uuid(3), "Only free", "2024-01-01", [TAG_XYZ]),
          ],
          next: null,
          total: 3,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "Tag A", tpdb: TAG_A.uuid }, { name: "xyz" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The anchored tag and the free text's one matching tag share the
      // all-of criterion, and nothing filters locally: the fixture returns
      // every row regardless of the native filter, so all three stay.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1), uuid(2), uuid(3)],
      );
      assert.equal(page.total, 3);
      assert.equal(page.totalCountKnown, true);
      // The anchored half and the singleton expansion travel natively
      // together under tag_and.
      assert.match(movieUrls[0]!, /tag_and=1/);
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[0]!, /tags%5B12%5D=1|tags\[12\]=1/);
    },
  );
});

test("a multi-match free-text AND with no singleton sends the smallest expansion as the native any-of", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_XYZ_C = { id: 13, uuid: uuid(103), name: "XYZ Other" };
  const TAG_ABC_A = { id: 14, uuid: uuid(104), name: "ABC Thing" };
  const TAG_ABC_B = { id: 15, uuid: uuid(105), name: "ABC Other" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_XYZ_C, TAG_ABC_A, TAG_ABC_B],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Both terms", "2024-03-01", [
              TAG_XYZ_A,
              TAG_ABC_A,
            ]),
            tpdbRow(uuid(2), "Only abc", "2024-02-01", [TAG_ABC_A, TAG_ABC_B]),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // No singleton group and no anchored id: the smaller expansion (abc,
      // two tags) rides the any-of criterion — a valid pre-filter, since an
      // AND match must match it too — and xyz keeps the local re-check.
      assert.match(movieUrls[0]!, /tags%5B14%5D=1|tags\[14\]=1/);
      assert.match(movieUrls[0]!, /tags%5B15%5D=1|tags\[15\]=1/);
      assert.doesNotMatch(movieUrls[0]!, /tag_and=1/);
      assert.doesNotMatch(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      // The AND still holds: the abc-only row drops on the local xyz
      // re-check; the row carrying both terms' tags stays.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1)],
      );
      // Exact only at true exhaustion, because a term re-checks locally.
      assert.equal(page.total, 1);
      assert.equal(page.totalCountKnown, true);
      assert.deepEqual(page.errors, []);
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

// --- local tag filters see every tag, not only the first 50 kept for display ---

test("a hidden tag past position 50 hides the title; a local free-text AND still sees tags past the rendered 50", async () => {
  const LAST = { id: 55, uuid: uuid(55), name: "Last Tag" }; // position 56: past the rendered 50
  const LEGACY_NUM = { id: 305, name: "Legacy" }; // uuid-less: forces the AND local
  const manyTags = [
    ...Array.from({ length: 54 }, (_, i) => ({
      id: 1000 + i,
      uuid: uuid(1000 + i),
      name: `Filler ${i + 1}`,
    })),
    LEGACY_NUM,
    LAST,
  ];
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: manyTags,
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Hidden by a late tag", "2024-01-01", manyTags),
            tpdbRow(uuid(2), "Found by a late tag", "2023-01-01", manyTags),
          ],
          next: null,
          total: 2,
        },
        // The free-text AND filters locally (a uuid-less expansion keeps it
        // off the native criterion), so this browse really scans: script
        // its page too.
        {
          rows: [
            tpdbRow(uuid(1), "Hidden by a late tag", "2024-01-01", manyTags),
            tpdbRow(uuid(2), "Found by a late tag", "2023-01-01", manyTags),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const hidden = await browseTitles(
        {
          type: "movie",
          include: [],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: LAST.name, tpdb: LAST.uuid }],
      );
      assert.deepEqual(
        hidden.items.map((d) => d.title),
        [],
      );
      assert.equal(hidden.total, 0);

      // The local AND's upstream request is byte-identical to the hidden
      // browse's (no native criterion rides either), so drop the read
      // cache: this browse's fetch must reach the fixture to be observed.
      resetMetaCache();
      const found = await browseTitles(
        {
          type: "movie",
          include: [{ name: "legacy" }, { name: "last tag" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The uuid-less Legacy expansion keeps the whole AND local: no tag
      // criterion rides, and the substring re-check must see BOTH names on
      // the row's tags — at positions 55 and 56, past the rendered 50 — or
      // every title drops.
      assert.doesNotMatch(movieUrls[1]!, /tags%5B|tags\[/);
      assert.deepEqual(
        found.items.map((d) => d.title),
        ["Hidden by a late tag", "Found by a late tag"],
      );
      // A finite local scan reports exact totals.
      assert.equal(found.total, 2);
      assert.equal(found.totalCountKnown, true);
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

test("a filmography free-text include keeps the hard ceiling error", async () => {
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          // Endless filmography pages, none carrying a tag with the term:
          // with no native tag criterion the scan can stay matchless
          // forever, so it must 422 instead of degrading.
          rows: [tpdbRow(uuid(9), "No rare tag", "2024-01-01")],
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
            performerTpdb: uuid(55),
            include: [{ name: "rare" }],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
      assert.equal(moviesCalled, 40);
    },
  );
});

test("an anchored tag beside a matchless free-text term answers provably empty", async () => {
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR],
      moviePages: [
        {
          // Every row carries the anchored tag, but the complete listing
          // holds no tag containing the free term.
          rows: [tpdbRow(uuid(9), "Anchor only", "2024-01-01", [TAG_ANCHOR])],
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
      // Moved pin: this test held the hard 422 here — the free term
      // filtered locally beside the native anchor and the stream ran to
      // its 40-page ceiling. The complete freshness-bounded listing now
      // proves the AND can never match: no published TPDB tag contains
      // "nevermatches", so the side answers exact zero before any scan.
      const page = await browseTitles(
        {
          type: "movie",
          include: [
            { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
            { name: "nevermatches" },
          ],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.equal(moviesCalled, 0);
      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.hasMore, false);
    },
  );
});

test("an anchored tag beside a multi-match free-text term keeps the hard ceiling error", async () => {
  // The ceiling contract the test above moved: when the free term DOES
  // match published tags — several, so it re-checks locally beside the
  // native anchor — absence is not provable, and the endless source
  // meets the documented 40-page ceiling.
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_XYZ_A = { id: 16, uuid: uuid(106), name: "XYZ Alpha" };
  const TAG_XYZ_B = { id: 17, uuid: uuid(107), name: "XYZ Beta" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR, TAG_XYZ_A, TAG_XYZ_B],
      moviePages: [
        {
          rows: [tpdbRow(uuid(9), "Anchor only", "2024-01-01", [TAG_ANCHOR])],
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
            include: [
              { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
              { name: "xyz" },
            ],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
      assert.equal(moviesCalled, 40);
    },
  );
});

test("a uuid-less anchored tag beside a native free-text term keeps the hard ceiling error", async () => {
  const LEGACY_NUM = { id: 305, name: "Legacy" }; // uuid-less: anchors locally
  const PREMIUM = { id: 11, uuid: uuid(101), name: "Premium" };
  const STASH_TAG = uuid(201);
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [LEGACY_NUM, PREMIUM],
      stashTagRows: [{ id: STASH_TAG, name: "Legacy" }],
      moviePages: [
        {
          // Every row carries the native Premium tag but never the
          // uuid-less Legacy label: the singleton free term keeps the
          // pages flowing on the wire while the local anchored chip
          // filters everything, so the stream runs to its ceiling.
          rows: [tpdbRow(uuid(9), "Premium only", "2024-01-01", [PREMIUM])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, _qs, url) => {
        moviesCalled += 1;
        movieUrls.push(url);
      },
    }),
    async () => {
      await assert.rejects(
        browseTitles(
          {
            type: "movie",
            include: [
              { name: "Legacy", stashdb: STASH_TAG },
              { name: "Premium" },
            ],
            exclude: [],
            studioMode: "exact",
            page: 1,
            perPage: 10,
          },
          [],
        ),
        appError(422, "query_too_broad"),
      );
      // ponytail ceiling: exactly MAX_SCAN_PAGES upstream pages, no runaway.
      assert.equal(moviesCalled, 40);
      // The singleton free term rode the native criterion; only the
      // uuid-less chip filtered locally.
      assert.match(movieUrls[0]!, /tags%5B/);
    },
  );
});

test("a free-text AND starved by hidden tags still degrades at the ceiling", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_ABC = { id: 13, uuid: uuid(103), name: "ABC Thing" };
  const TAG_HIDDEN = { id: 14, uuid: uuid(104), name: "Hidden" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_ABC],
      moviePages: [
        {
          // Rows the native abc all-of still returns (the fixture ignores the
          // native filter) and the local xyz re-check keeps: the account's
          // hidden tag then filters them all, so the visible yield starves and
          // this stays the soft degrade with its named error.
          rows: [
            tpdbRow(uuid(2), "Hidden xyz", "2024-02-01", [
              TAG_XYZ_A,
              TAG_HIDDEN,
            ]),
          ],
          next: "x",
          total: 10000,
        },
      ],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          page: 1,
          perPage: 10,
        },
        [{ name: TAG_HIDDEN.name, tpdb: TAG_HIDDEN.uuid }],
      );
      assert.deepEqual(page.items, []);
      assert.equal(page.hasMore, false);
      assert.deepEqual(
        page.errors.map((e) => [e.provider, e.code]),
        [["tpdb", "scan_ceiling"]],
      );
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

test("searchVisibleCatalog keeps paging when the exhausted stream leaves a visible surplus", async () => {
  const TAG_H = uuid(104);
  // 30 scenes over two 24-row upstream pages, one hidden on page 1: the last
  // page lifts the visible buffer to 29, past start(0)+perPage(24).
  const pageOne = Array.from({ length: 24 }, (_, i) =>
    stashRow(
      uuid(200 + i),
      `Scene ${i + 1}`,
      "2024-06-01",
      i === 0 ? [{ id: TAG_H, name: "Hidden" }] : [],
    ),
  );
  const pageTwo = Array.from({ length: 6 }, (_, i) =>
    stashRow(uuid(300 + i), `Tail ${i + 1}`, "2024-05-01"),
  );
  const scenes: { count: number; rows: unknown[] } = {
    count: 30,
    rows: pageOne,
  };
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [{ rows: [], next: null, total: 0 }],
      scenes,
      onScenesRequest: (input) => {
        // One Stream per catalog page: every call refetches from upstream
        // page 1, so the fixture keys rows on the upstream page number.
        scenes.rows = input.page === 2 ? pageTwo : pageOne;
      },
    }),
    async () => {
      const first = await searchVisibleCatalog(
        { provider: "stashdb", kind: "scene", page: 1, perPage: 24 },
        [{ name: "Hidden", stashdb: TAG_H }],
      );
      assert.equal(first.items.length, 24);
      assert.equal(first.items.at(-1)?.title, "Tail 1"); // filled from surplus
      assert.equal(first.hasMore, true); // 5 visible rows remain past page 1
      assert.equal(first.total, 29);
      assert.equal(first.totalCountKnown, true);

      const second = await searchVisibleCatalog(
        { provider: "stashdb", kind: "scene", page: 2, perPage: 24 },
        [{ name: "Hidden", stashdb: TAG_H }],
      );
      assert.deepEqual(
        second.items.map((d) => d.title),
        ["Tail 2", "Tail 3", "Tail 4", "Tail 5", "Tail 6"],
      );
      assert.equal(second.hasMore, false);
      assert.equal(second.total, 29);
      assert.equal(second.totalCountKnown, true);
    },
  );
});

// --- searchBrowseTags ---

test("searchBrowseTags merges same labels across providers and reports outages", async () => {
  const SHARED_T = uuid(302);
  const SHARED_S = uuid(303);
  let tpdbTagsDown = true;
  const stashRows = [
    { id: uuid(310), name: "anal" },
    { id: uuid(311), name: "stash only" },
    { id: SHARED_S, name: "Shared" }, // same label as TPDB's, different casing
  ];
  const handler: FixtureHandler = (req, res, body) => {
    const path = pathOf(req.url ?? "");
    if (path === "/tags") {
      if (tpdbTagsDown) {
        sendJson(res, 500, { message: "tpdb tags down" });
        return;
      }
      sendJson(res, 200, {
        data: [{ id: SHARED_T, uuid: SHARED_T, name: "shared" }],
        links: { next: null },
      });
      return;
    }
    if (path === "/graphql") {
      const gql = JSON.parse(body) as { query?: string };
      if (gql.query?.includes("queryTags")) {
        sendJson(res, 200, {
          data: { queryTags: { count: stashRows.length, tags: stashRows } },
        });
        return;
      }
      sendJson(res, 200, { data: { searchTag: [] } });
      return;
    }
    sendJson(res, 404, {});
  };
  await runBrowse(handler, async () => {
    // The TPDB listing is down; StashDB answers. The failure is visible and
    // the healthy source's folded-substring matches are kept (the local
    // filter replaced the provider's term-honoured search).
    const partial = await searchBrowseTags("anal");
    assert.equal(partial.errors.length, 1);
    assert.equal(partial.errors[0]!.provider, "tpdb");
    assert.deepEqual(
      partial.tags.map((t) => t.name),
      ["anal"],
    );

    // Both sources healthy: the same label under different casing merges
    // into ONE selection carrying both native ids.
    tpdbTagsDown = false;
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

test("planBrowseSides refuses orders the qualifying side cannot carry", () => {
  // Movies runs TPDB only: a StashDB-native order dies upstream as
  // invalid_search, which a locally filtered stream buried as a 502.
  assert.throws(
    () => planBrowseSides(planQuery({ type: "movie", sort: "trending" })),
    appError(400, "invalid_search"),
    "trending on Movies",
  );
  // The mirror: relevance is TPDB-only.
  assert.throws(
    () => planBrowseSides(planQuery({ type: "scene", sort: "relevance" })),
    appError(400, "invalid_search"),
    "relevance on Scenes",
  );
  // TPDB relevance takes no upstream direction.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({ type: "movie", sort: "relevance", direction: "asc" }),
      ),
    /takes no direction/,
    "relevance with direction",
  );
  // The recency vocabulary still maps onto the StashDB DATE order, so an
  // All query filtered down to the StashDB side alone keeps its order.
  assert.deepEqual(
    planBrowseSides(planQuery({ studioStashdb: uuid(2), sort: "recency" }))
      .sides,
    ["stashdb"],
    "recency survives on a StashDB-only All plan",
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
  // claims no merge order. Contract move (fix(browse)): a sort the side
  // lacks — title on TPDB movies — now refuses at plan time instead of
  // dying upstream, where a hidden-tag stream buried it as a 502.
  const native = planBrowseSides(
    planQuery({ type: "movie", sort: "relevance" }),
  );
  assert.deepEqual(native.nativeSort, { key: "relevance" });
  assert.equal(native.mergeOrder, undefined);
  assert.throws(
    () => planBrowseSides(planQuery({ type: "movie", sort: "title" })),
    /not available on TPDB movies\./,
  );
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
