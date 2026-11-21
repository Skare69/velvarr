// Browse-service regression tests: isolated 127.0.0.1 HTTP fixtures only.
// No real network, no source-text asserts — every case drives browseTitles /
// searchVisibleCatalog / searchBrowseTags / parseBrowseQuery against a
// scripted TPDB + StashDB upstream and asserts observable pages: AND versus
// OR, include+exclude+hidden precedence, page fill past blocked candidates,
// unequal source exhaustion, provider-scoped tag identity, honest totals and
// outages, the documented scan ceiling, and per-user hidden filtering.

import assert from "node:assert/strict";
import { mock, test, beforeEach } from "node:test";

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
import { parseIncludeSelections } from "../src/server/storage.ts";
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
  browseSideRuns,
  MAX_BROWSE_ENTITIES,
  mergedSourceRestricted,
  planStreams,
  sourceRunsFor,
  tpdbFilmographyRuns,
} from "../src/lib/browse-entities.ts";
import {
  browseTitles,
  includeIdsForSide,
  parseBrowseQuery,
  planBrowseSides,
  searchBrowseTags,
  searchVisibleCatalog,
} from "../src/server/browse.ts";
import {
  FoldedTags,
  hiddenTitleMatcher,
  tagMatcher,
} from "../src/server/catalog-visibility.ts";
import fc from "fast-check";
import type { BrowsePage, BrowseQuery } from "../src/server/browse.ts";
import type {
  BrowseEntity,
  CatalogDetail,
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

/** A performer credit as TPDB embeds it in a movie row: tpdbCredits maps
 * `id` (a UUID) + `name` into the detail's credits, which the all-mode
 * filmography re-check reads. */
interface CreditRow {
  id: string;
  name: string;
}

function tpdbRow(
  id: string,
  title: string,
  date: string,
  tags: TagRow[] = [],
  performers: CreditRow[] = [],
): unknown {
  return {
    id,
    title,
    date,
    duration: 600,
    tags,
    performers,
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
  // Contract move (VELV-166): the scalar studio key parses into ONE
  // unnamed entry in the studios array; performerMode defaults to all.
  assert.deepEqual(parsed, {
    type: "scene",
    q: "big",
    include: [],
    exclude: [],
    performers: [],
    studios: [{ stashdb: uuid(9) }],
    performerMode: "all",
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
  assert.deepEqual(
    parseBrowseQuery(new URLSearchParams("studioTpdb=evilangel")).studios,
    [{ tpdb: "evilangel" }],
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
        // Contract move (VELV-166): one unified studio entry carrying both
        // ids replaces the old scalar pair.
        [
          "withChildren is stash-only",
          {
            type: "all",
            studioMode: "withChildren",
            studios: [{ stashdb: uuid(2), tpdb: uuid(1) }],
          },
        ],
        // Contract move (VELV-166): a picked performer rides the performers
        // array; the filmography refusals are unchanged.
        [
          "filmography + sort",
          { type: "all", performers: [{ tpdb: uuid(1) }], sort: "recency" },
        ],
        [
          "filmography + year",
          { type: "all", performers: [{ tpdb: uuid(1) }], year: 2020 },
        ],
        [
          "filmography + date",
          {
            type: "all",
            performers: [{ tpdb: uuid(1) }],
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
              performers: [],
              studios: [],
              performerMode: "all",
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
      // page is provably empty before any upstream call. Contract move
      // (VELV-166): the empty page now names the skipped source in a
      // notice — a muted note, never an error.
      const page = await browseTitles(
        planQuery({ type: "movie", performers: [{ stashdb: uuid(2) }] }),
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
        notices: [
          {
            provider: "tpdb",
            kind: "performer",
            code: "not_searched",
            entries: [{ stashdb: uuid(2) }],
          },
        ],
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
        performers: [],
        studios: [],
        performerMode: "all",
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
  // id (an AND match carries it). A complete multi-id group beside an
  // anchored id (or a singleton) no longer re-checks locally: it fans out
  // into one native all-of stream per id (VELV-204), so its term leaves
  // the local re-check and freeTextNative follows the fan-out.
  // Moved pin: the multi-id group planned localTermIndexes [1]; it now
  // plans the fan-out group instead.
  assert.deepEqual(
    resolveIncludeCriteria(
      [uuid(1)],
      [ready([uuid(9)]), ready([uuid(2), uuid(3)])],
    ),
    {
      allOf: [uuid(1), uuid(9)],
      anyOf: [],
      fanoutIds: [uuid(2), uuid(3)],
      localTermIndexes: [],
      freeTextNative: true,
      provablyEmpty: false,
    },
  );
  // Moved pin: without a singleton the multi group re-checked locally and
  // freeTextNative stayed false; the anchored+group mix now fans out, and
  // a non-empty fan-out group alone keeps the soft ceiling.
  assert.deepEqual(
    resolveIncludeCriteria([uuid(1)], [ready([uuid(2), uuid(3)])]),
    {
      allOf: [uuid(1)],
      anyOf: [],
      fanoutIds: [uuid(2), uuid(3)],
      localTermIndexes: [],
      freeTextNative: true,
      provablyEmpty: false,
    },
  );
  // A singleton duplicating an anchored id travels once.
  const deduped = resolveIncludeCriteria(
    [uuid(7)],
    [ready([uuid(7)]), ready([uuid(8), uuid(9)])],
  );
  assert.deepEqual(deduped.allOf, [uuid(7)]);
  // Moved pin: the {8,9} group used to re-check locally (localTermIndexes
  // [1]); it now rides the fan-out streams (allOf ∪ {8}, allOf ∪ {9}), so
  // it leaves the local re-check entirely.
  assert.deepEqual(deduped.localTermIndexes, []);
  assert.equal(deduped.freeTextNative, true);
  assert.deepEqual(deduped.fanoutIds, [uuid(8), uuid(9)]);
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
      fanoutIds: [],
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
  assert.deepEqual(atCap.fanoutIds, []);
  // One id more and the criterion would silently ignore its tail upstream:
  // the whole group filters locally instead. A 26-id group also exceeds the
  // fan-out cap (FANOUT_GROUP_CAP = 5), so it never fans out either way.
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
      fanoutIds: [],
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
      fanoutIds: [],
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
    fanoutIds: [],
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
        fanoutIds: [],
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
    fanoutIds: [],
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
      fanoutIds: [],
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
      fanoutIds: [],
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

test("softCeilingFor degrades a native free-text re-check and a fan-out stream", () => {
  // Moved pin: the name said "only a native free-text term that still
  // re-checks locally" — a fan-out stream now degrades too (fanoutNative),
  // even when no term re-checks locally.
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
  // A fan-out stream degrades: its pages were productive all-of reads even
  // when no term re-checks locally, so the matches found are a real
  // partial answer.
  assert.equal(
    softCeilingFor({
      localInclude: [],
      freeTextNative: false,
      fanoutNative: true,
    }),
    true,
  );
  assert.equal(
    softCeilingFor({
      localInclude: [{}],
      freeTextNative: false,
      fanoutNative: true,
    }),
    true,
  );
});

test("resolveIncludeCriteria fans out the smallest fitting group beside anchored ids", () => {
  // Beside an anchored id, a complete 2..FANOUT_GROUP_CAP group fans out:
  // one native all-of stream per id. A group above the fan-out cap (7 > 5)
  // stays local; the pick takes the fewest ids, ties first in input order.
  const fanned = resolveIncludeCriteria(
    [uuid(9)],
    [
      ready([uuid(1), uuid(2), uuid(3)]),
      ready([uuid(4), uuid(5), uuid(6), uuid(7), uuid(8), uuid(10), uuid(11)]),
    ],
  );
  assert.deepEqual(fanned.fanoutIds, [uuid(1), uuid(2), uuid(3)]);
  assert.deepEqual(fanned.localTermIndexes, [1]);
  assert.equal(fanned.freeTextNative, true);
  // Native-cap fit guard: 24 anchored ids + a 2-id group is 26 ids, past
  // TAG_FILTER_ID_CAP (25) — the native criterion would silently ignore
  // its tail, so nothing fans out and both groups keep the local
  // re-check; no singleton exists, so nothing rides free-text native.
  const noFit = resolveIncludeCriteria(
    Array.from({ length: 24 }, (_, i) => uuid(30 + i)),
    [ready([uuid(1), uuid(2)]), ready([uuid(3), uuid(4), uuid(5)])],
  );
  assert.deepEqual(noFit.fanoutIds, []);
  assert.deepEqual(noFit.localTermIndexes, [0, 1]);
  assert.equal(noFit.freeTextNative, false);
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all" as const,
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
          performers: [],
          studios: [],
          performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          include: [{ name: "Legacy", stashdb: STASH_TAG }],
          exclude: [],
          studioMode: "exact",
          // Contract move (VELV-166): the scalar performer key became an
          // entry in the performers array.
          performers: [{ tpdb: performer }],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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

test("a singleton free-text term beside a multi-match term fans out and degrades at the scan ceiling instead of erroring", async () => {
  const TAG_XYZ_A = { id: 11, uuid: uuid(101), name: "XYZ Special" };
  const TAG_XYZ_B = { id: 12, uuid: uuid(102), name: "XYZ Thing" };
  const TAG_ABC = { id: 13, uuid: uuid(103), name: "ABC Thing" };
  let moviesCalled = 0;
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_XYZ_A, TAG_XYZ_B, TAG_ABC],
      // abc's expansion is the singleton tag 13: it joins the all-of
      // criterion and the xyz pair fans out beside it — one native
      // all-of stream per xyz id. The fixture returns every row
      // regardless of the native filter, so the abc-only row reaches
      // both streams; the shared dedupe set surfaces it once, and with
      // no local re-check left both streams refill until the ceiling.
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
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Moved pin: abc rode the all-of criterion alone and xyz kept the
      // local re-check, so one stream starved to the ceiling (40 reads,
      // empty page). xyz now fans out beside the abc anchor: both
      // streams carry abc plus one xyz id, degrade softly at the
      // ceiling, and the fixture's only row still surfaces — deduped to
      // one entry.
      assert.match(movieUrls.join("\n"), /tags%5B13%5D=1|tags\[13\]=1/);
      assert.match(movieUrls.join("\n"), /tag_and=1/);
      assert.match(movieUrls.join("\n"), /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls.join("\n"), /tags%5B12%5D=1|tags\[12\]=1/);
      // Moved pin (VELV-240): the request's per-provider page pool caps the
      // whole browse at MAX_SCAN_PAGES (40) reads, so the fan-out's two
      // streams share one 40-read budget instead of doubling it.
      assert.equal(moviesCalled, 40);
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(2)],
      );
      assert.equal(page.totalCountKnown, false);
      assert.equal(page.hasMore, false);
      assert.deepEqual(
        page.errors.map((e) => [e.provider, e.code]),
        [["tpdb", "scan_ceiling"]],
      );
    },
  );
});

test("fan-out streams share 40 reads per provider, not 40 reads across providers", async () => {
  const tags = [
    { id: 11, uuid: uuid(101), name: "XYZ Special" },
    { id: 12, uuid: uuid(102), name: "XYZ Thing" },
    { id: 13, uuid: uuid(103), name: "ABC Thing" },
  ];
  const sceneTags = tags.map((tag) => ({ id: tag.uuid, name: tag.name }));
  let movieReads = 0;
  let sceneReads = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: tags,
      stashQueryTagRows: sceneTags,
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Movie", "2024-02-01", tags)],
          next: "x",
          total: 10000,
        },
      ],
      scenes: {
        count: 10000,
        rows: [stashRow(uuid(1), "Scene", "2024-01-01", sceneTags)],
      },
      onMovieRequest: () => {
        movieReads += 1;
      },
      onScenesRequest: () => {
        sceneReads += 1;
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "all",
          include: [{ name: "xyz" }, { name: "abc" }],
          exclude: [],
          studioMode: "exact",
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.equal(movieReads, 40);
      assert.equal(sceneReads, 40);
      assert.deepEqual(
        page.items.map((item) => [item.reference.provider, item.reference.id]),
        [
          ["tpdb", uuid(1)],
          ["stashdb", uuid(1)],
        ],
      );
      assert.deepEqual(
        page.errors.map((error) => [error.provider, error.code]).sort(),
        [
          ["stashdb", "scan_ceiling"],
          ["tpdb", "scan_ceiling"],
        ],
      );
      assert.equal(page.totalCountKnown, false);
      assert.equal(page.hasMore, false);
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
          // The endless continuation only ever carries the abc tag.
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
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Moved pin: with xyz re-checking locally only the full AND match
      // survived ([uuid(1)]). xyz now fans out beside the abc anchor, so
      // no term re-checks locally and the fixture's abc-only row — which
      // the fixture returns regardless of the native tag filter —
      // surfaces too, once, via the shared dedupe set. Both fan-out
      // streams then run to the soft ceiling: the matches found are a
      // real partial answer beside the named incompleteness.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1), uuid(2)],
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
      // Endless pages of abc-only rows: the xyz pair fans out beside the
      // abc anchor, no term re-checks locally, and both fan-out streams
      // refill until their ceiling — a bounded answer, not an outage.
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
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Moved pin: the page was empty while the local xyz re-check kept
      // every row out; the fan-out removed that re-check, so the
      // fixture's abc-only row surfaces once (deduped across the two
      // streams). Ceiling beside outage stays a partial page with both
      // errors named, never a 502 provider_unavailable.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(2)],
      );
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
          performers: [],
          studios: [],
          performerMode: "all",
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

test("a free-text exclude removes every title with a tag that contains the term", async () => {
  // Typed "anal" in Must not have: contains, like a typed include — it
  // removes "Analingus" and "Anal Fisting" alike. (Picked tags and
  // personal hidden tags keep the word-family rule, pinned elsewhere.)
  const ANALINGUS = { id: 11, uuid: uuid(101), name: "Analingus" };
  const FISTING = { id: 12, uuid: uuid(102), name: "Anal Fisting" };
  const SOLO = { id: 13, uuid: uuid(103), name: "Solo" };
  await runBrowse(
    scriptedUpstream({
      tagRows: [ANALINGUS, FISTING, SOLO],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Inside a word", "2024-03-01", [ANALINGUS]),
            tpdbRow(uuid(2), "First word", "2024-02-01", [FISTING]),
            tpdbRow(uuid(3), "Unrelated", "2024-01-01", [SOLO]),
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
          exclude: [{ name: "anal" }],
          studioMode: "exact",
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(3)],
      );
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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

// --- the or-group union at walk scale: VELV-241 perf regression ---

// 25 one-letter terms are the route's group cap (MAX_HIDDEN_TAGS) and the
// listing walk caps at 5000 rows, so this is the worst union a legal group
// can build: the deduped set holds all 5000 ids. The union build must keep
// the same deduped set and push order after the Set rewrite (VELV-241:
// validation #VELV-247 timed the Array.includes dedupe at 565 ms per warm
// side on a 1-vCPU sandbox; the dev box timed the same call at ~50 ms).
const UNION_LETTERS = "abcdefghijklmnopqrstuvwxy".split("");

function unionListingPages(buildName: (i: number) => string): TpdbPage[] {
  const rows = Array.from({ length: 5000 }, (_, i) => ({
    id: i + 1,
    uuid: uuid(i),
    name: buildName(i),
  }));
  // Page 50 ends with next: null, so the walk completes at exactly the
  // 5000-row cap instead of degrading to an incomplete listing.
  return Array.from({ length: 50 }, (_, p) => ({
    rows: rows.slice(p * 100, p * 100 + 100),
    next: p === 49 ? null : `next-${p}`,
    total: 5000,
  }));
}

test("an or-group of 25 one-letter terms over a 5000-row listing keeps the deduped union ids and routes past the native cap locally", async () => {
  // Every row matches exactly one letter, so the union holds all 5000 ids:
  // past TAG_FILTER_ID_CAP, the whole group filters locally.
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: { count: 0, rows: [] },
      tpdbTagPages: unionListingPages((i) => `${UNION_LETTERS[i % 25]}${i}`),
    }),
    async () => {
      const group = UNION_LETTERS.map((name) => ({ name }));
      const resolved = await includeIdsForSide([group], "tpdb", true);
      assert.deepEqual(resolved, {
        allOf: [],
        anyOf: [],
        localInclude: [group],
        localFree: [group],
        freeTextNative: false,
        fanoutIds: [],
      });
    },
  );
  resetMetaCache();
  // Overlapping rows: "ab0" matches both "a" and "b", so the union dedupe
  // skips repeats; the 25 distinct ids sit at TAG_FILTER_ID_CAP and ride the
  // native any-of. The pinned order is the union's first-seen order: a's
  // rows (0, 24), then each later letter's one new row (1..23).
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: { count: 0, rows: [] },
      tpdbTagPages: unionListingPages((i) =>
        i < 25
          ? `${UNION_LETTERS[i]}${UNION_LETTERS[(i + 1) % 25]}${i}`
          : `z${i}`,
      ),
    }),
    async () => {
      const group = UNION_LETTERS.map((name) => ({ name }));
      const resolved = await includeIdsForSide([group], "tpdb", true);
      assert.ok(resolved !== undefined);
      assert.deepEqual(resolved.anyOf, [
        uuid(0),
        uuid(24),
        ...Array.from({ length: 23 }, (_, k) => uuid(k + 1)),
      ]);
      assert.deepEqual(resolved, {
        allOf: [],
        anyOf: [
          uuid(0),
          uuid(24),
          ...Array.from({ length: 23 }, (_, k) => uuid(k + 1)),
        ],
        localInclude: [],
        localFree: [],
        freeTextNative: true,
        fanoutIds: [],
      });
    },
  );
});

test("an or-group dedupes direct, expanded, and counterpart ids in first-seen order", async () => {
  const tags = [
    { id: 11, uuid: uuid(101), name: "Alpha" },
    { id: 12, uuid: uuid(102), name: "Beta" },
    { id: 13, uuid: uuid(103), name: "Gamma" },
  ];
  await runBrowse(
    scriptedUpstream({
      tagRows: tags,
      moviePages: [],
      scenes: { count: 0, rows: [] },
    }),
    async () => {
      const resolved = await includeIdsForSide(
        [
          [
            { name: "Alpha", tpdb: uuid(101) },
            { name: "alpha" },
            { name: "beta" },
            { name: "Beta", tpdb: uuid(102) },
            { name: "Beta", stashdb: uuid(202) },
            { name: "Gamma", stashdb: uuid(203) },
            { name: "Gamma", tpdb: uuid(103) },
            { name: "Gamma", stashdb: uuid(203) },
          ],
        ],
        "tpdb",
        true,
      );
      assert.ok(resolved !== undefined);
      assert.deepEqual(resolved.anyOf, [uuid(101), uuid(102), uuid(103)]);
      assert.deepEqual(resolved.localInclude, []);
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
            performers: [],
            studios: [],
            performerMode: "all",
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
      let err: unknown;
      try {
        await browseTitles(
          {
            type: "movie",
            include: [{ name: "rare" }],
            exclude: [],
            studioMode: "exact",
            performers: [{ tpdb: uuid(55) }],
            studios: [],
            performerMode: "all",
            page: 1,
            perPage: 10,
          },
          [],
        );
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof AppError, "the ceiling throws AppError");
      assert.equal(err.code, "query_too_broad");
      // The payload names the query that must shrink (VELV-167): the side
      // that burned, how far it scanned, and the caller's own page facts.
      assert.deepEqual(err.details, {
        provider: "tpdb",
        upstreamPagesScanned: 40,
        requestedPage: 1,
        perPage: 10,
        include: [{ name: "rare" }],
      });
      assert.equal(moviesCalled, 40);
    },
  );
});

// The deepest scannable page: a stream buffers at most MAX_SCAN_PAGES (40)
// pages of at most 2 × perPage rows, so with perPage 1 one live stream can
// fill pages up to 80 and two can fill pages up to 160. Past that, a scan
// could only walk every stream to the ceiling (reparsing cached pages on
// every request) and still end rowless: the page is refused before any read.
const TAG_DEEP = { id: 16, uuid: uuid(106), name: "Deep Hidden" };

function deepQuery(type: BrowseQuery["type"], page: number): BrowseQuery {
  return {
    type,
    include: [],
    exclude: [],
    performers: [],
    studios: [],
    performerMode: "all",
    studioMode: "exact",
    page,
    perPage: 1,
  };
}

test("a browse page past the deepest scannable page is refused before any upstream read", async () => {
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_DEEP],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Always hidden", "2024-01-01", [TAG_DEEP])],
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
      const hidden = [{ name: TAG_DEEP.name, tpdb: TAG_DEEP.uuid }];
      await assert.rejects(
        browseTitles(deepQuery("movie", 81), hidden),
        appError(422, "page_too_deep"),
      );
      assert.equal(moviesCalled, 0);
      // The last page a scan could still fill keeps scanning to the ceiling.
      await assert.rejects(
        browseTitles(deepQuery("movie", 80), hidden),
        appError(422, "query_too_broad"),
      );
      assert.equal(moviesCalled, 40);
    },
  );
});

test("a page past the scannable depth reparses no cached provider page", async () => {
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_DEEP],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Always hidden", "2024-01-01", [TAG_DEEP])],
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
      const hidden = [{ name: TAG_DEEP.name, tpdb: TAG_DEEP.uuid }];
      // Warm the metadata cache with all 40 pages the ceiling allows.
      await assert.rejects(
        browseTitles(deepQuery("movie", 80), hidden),
        appError(422, "query_too_broad"),
      );
      assert.equal(moviesCalled, 40);
      const parse = mock.method(JSON, "parse");
      try {
        // A warm rescan reparses every cached page: the counter sees them.
        await assert.rejects(
          browseTitles(deepQuery("movie", 80), hidden),
          appError(422, "query_too_broad"),
        );
        assert.equal(parse.mock.callCount(), 40);
        parse.mock.resetCalls();
        await assert.rejects(
          browseTitles(deepQuery("movie", 81), hidden),
          appError(422, "page_too_deep"),
        );
        assert.equal(parse.mock.callCount(), 0);
      } finally {
        parse.mock.restore();
      }
      assert.equal(moviesCalled, 40);
    },
  );
});

test("the scannable depth counts every live stream of a mixed browse", async () => {
  let moviesCalled = 0;
  let scenesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_DEEP],
      moviePages: [
        {
          rows: [tpdbRow(uuid(1), "Always hidden", "2024-01-01", [TAG_DEEP])],
          next: "x",
          total: 10000,
        },
      ],
      scenes: {
        count: 10000,
        rows: [stashRow(uuid(2), "A scene", "2024-01-01")],
      },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
      onScenesRequest: () => {
        scenesCalled += 1;
      },
    }),
    async () => {
      const hidden = [{ name: TAG_DEEP.name, tpdb: TAG_DEEP.uuid }];
      await assert.rejects(
        browseTitles(deepQuery("all", 161), hidden),
        appError(422, "page_too_deep"),
      );
      assert.deepEqual([moviesCalled, scenesCalled], [0, 0]);
      // Page 81 is past one stream's depth but within two: it still scans.
      await assert.rejects(
        browseTitles(deepQuery("all", 81), hidden),
        appError(422, "query_too_broad"),
      );
      assert.equal(moviesCalled, 40);
    },
  );
});

test("a hidden-filtered catalog search past the deepest scannable page is refused before any upstream read", async () => {
  let scenesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: {
        count: 10000,
        rows: [
          stashRow(uuid(3), "Always hidden", "2024-01-01", [
            { id: TAG_DEEP.uuid, name: TAG_DEEP.name },
          ]),
        ],
      },
      onScenesRequest: () => {
        scenesCalled += 1;
      },
    }),
    async () => {
      const hidden = [{ name: TAG_DEEP.name, stashdb: TAG_DEEP.uuid }];
      await assert.rejects(
        searchVisibleCatalog(
          { provider: "stashdb", kind: "scene", page: 81, perPage: 1 },
          hidden,
        ),
        appError(422, "page_too_deep"),
      );
      assert.equal(scenesCalled, 0);
      await assert.rejects(
        searchVisibleCatalog(
          { provider: "stashdb", kind: "scene", page: 80, perPage: 1 },
          hidden,
        ),
        appError(422, "query_too_broad"),
      );
      assert.equal(scenesCalled, 40);
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
          performers: [],
          studios: [],
          performerMode: "all",
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

test("an anchored tag beside a multi-match free-text term fans out into all-of streams instead of starving", async () => {
  // Moved pin: this test held the hard 422 here — the multi-match term
  // re-checked locally beside the native anchor and the one stream starved
  // into the 40-page scan ceiling. The side now fans out: one native
  // all-of stream per matched tag id, so both streams exhaust in one page
  // each and a title carrying two of the matched ids surfaces once.
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_XYZ_A = { id: 16, uuid: uuid(106), name: "XYZ Alpha" };
  const TAG_XYZ_B = { id: 17, uuid: uuid(107), name: "XYZ Beta" };
  const BOTH_ROW = tpdbRow(uuid(3), "Both xyz tags", "2025-06-01", [
    TAG_ANCHOR,
    TAG_XYZ_A,
    TAG_XYZ_B,
  ]);
  let moviesCalled = 0;
  const movieQs: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR, TAG_XYZ_A, TAG_XYZ_B],
      // Request order = fan-out stream order: stream A carries
      // [ANCHOR, XYZ Alpha], stream B [ANCHOR, XYZ Beta]. Both pages also
      // return the title tagged with BOTH matched ids: the shared dedupe
      // set must surface it exactly once.
      moviePages: [
        {
          rows: [
            BOTH_ROW,
            tpdbRow(uuid(1), "Anchor alpha", "2025-05-01", [
              TAG_ANCHOR,
              TAG_XYZ_A,
            ]),
          ],
          next: null,
          total: 2,
        },
        {
          rows: [
            BOTH_ROW,
            tpdbRow(uuid(2), "Anchor beta", "2025-04-01", [
              TAG_ANCHOR,
              TAG_XYZ_B,
            ]),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => {
        moviesCalled += 1;
        movieQs.push(qs.toString());
      },
    }),
    async () => {
      const page = await browseTitles(
        {
          type: "movie",
          include: [
            { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
            { name: "xyz" },
          ],
          exclude: [],
          studioMode: "exact",
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(
        [...page.items.map((d) => d.reference.id)].sort(),
        [uuid(1), uuid(2), uuid(3)].sort(),
      );
      assert.equal(
        page.items.filter((d) => d.reference.id === uuid(3)).length,
        1,
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.hasMore, false);
      assert.equal(moviesCalled, 2);
      // Stream A's read carries the anchored id and the first matched id;
      // stream B's carries the anchored id and the second.
      assert.match(movieQs[0]!, /tag_and=1/);
      assert.match(movieQs[0]!, /tags%5B15%5D=1/);
      assert.match(movieQs[0]!, /tags%5B16%5D=1/);
      assert.doesNotMatch(movieQs[0]!, /tags%5B17%5D=1/);
      assert.match(movieQs[1]!, /tag_and=1/);
      assert.match(movieQs[1]!, /tags%5B15%5D=1/);
      assert.match(movieQs[1]!, /tags%5B17%5D=1/);
      assert.doesNotMatch(movieQs[1]!, /tags%5B16%5D=1/);
    },
  );
});

test("an anchored chip beside two multi-match free terms fills the page by fanning out instead of 422ing", async () => {
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_YOUNG = { id: 11, uuid: uuid(111), name: "Young" };
  const TAG_YOUNG_W = { id: 12, uuid: uuid(112), name: "Young Woman" };
  const TAG_OLD = { id: 13, uuid: uuid(113), name: "Old" };
  const TAG_OLD_M = { id: 14, uuid: uuid(114), name: "Old Man" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR, TAG_YOUNG, TAG_YOUNG_W, TAG_OLD, TAG_OLD_M],
      // "young" and "old" both expand to two published tags; the size tie
      // keeps the first group, so "young" fans out (stream 1 carries
      // [ANCHOR, Young], stream 2 [ANCHOR, Young Woman]) and the old
      // group re-checks locally.
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(1), "Young and old", "2025-06-01", [
              TAG_ANCHOR,
              TAG_YOUNG,
              TAG_OLD,
              TAG_OLD_M,
            ]),
            // Carries the young half only: the local old re-check drops it.
            tpdbRow(uuid(2), "Young only", "2025-05-01", [
              TAG_ANCHOR,
              TAG_YOUNG,
            ]),
          ],
          next: null,
          total: 2,
        },
        {
          rows: [
            tpdbRow(uuid(3), "Young woman and old", "2024-06-01", [
              TAG_ANCHOR,
              TAG_YOUNG_W,
              TAG_OLD,
            ]),
          ],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
    }),
    async () => {
      // Before the fan-out both free terms re-checked locally beside the
      // native anchor; on an endless non-matching listing that shape
      // starved into the 422 (the moved pin above). Here the young group
      // fans out into productive native streams, and the guard is the
      // call count: an uncapped fan-out or an extra read breaks this pin.
      const page = await browseTitles(
        {
          type: "movie",
          include: [
            { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
            { name: "young" },
            { name: "old" },
          ],
          exclude: [],
          studioMode: "exact",
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // Both kept rows surface in stream order (stream 1's row is newer),
      // and the totals are exhaustion-exact.
      assert.deepEqual(
        page.items.map((d) => d.reference.id),
        [uuid(1), uuid(3)],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
      assert.equal(page.hasMore, false);
      assert.equal(moviesCalled, 2);
    },
  );
});

test("a fan-out browse pages the merged union without repeats or gaps", async () => {
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_YOUNG = { id: 11, uuid: uuid(111), name: "Young" };
  const TAG_YOUNG_W = { id: 12, uuid: uuid(112), name: "Young Woman" };
  // One free term beside the anchored chip fans out into two native
  // all-of streams: anchor ∧ young, then anchor ∧ young woman. Each
  // stream buffers exactly one exhausted page (next null), so the
  // ordered recency merge interleaves them fairly: page 1 pops the two
  // newest rows (one per stream), page 2 the two remaining. The rows
  // model the native criteria — stream 1's page carries [anchor, young],
  // stream 2's [anchor, young woman] — because a fan-out stream never
  // re-checks its own group locally.
  const youngPage = {
    rows: [
      tpdbRow(uuid(1), "Young r1", "2024-03-01", [TAG_ANCHOR, TAG_YOUNG]),
      tpdbRow(uuid(2), "Young r2", "2024-01-01", [TAG_ANCHOR, TAG_YOUNG]),
    ],
    next: null,
    total: 2,
  };
  const youngWomanPage = {
    rows: [
      tpdbRow(uuid(3), "Young woman r3", "2024-02-01", [
        TAG_ANCHOR,
        TAG_YOUNG_W,
      ]),
      tpdbRow(uuid(4), "Young woman r4", "2023-12-01", [
        TAG_ANCHOR,
        TAG_YOUNG_W,
      ]),
    ],
    next: null,
    total: 2,
  };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR, TAG_YOUNG, TAG_YOUNG_W],
      // Per-call streams restart at upstream page 1 while the fixture's
      // request counter advances across the whole test: entries 1 and 2
      // serve the first call's streams, entries 3 and 4 the second
      // call's streams — the same two listings, because the provider's
      // upstream page 1 has not changed between calls. resetMetaCache
      // between the calls defeats the process-lifetime upstream read
      // cache, so the second call's page reads really reach the fixture.
      moviePages: [youngPage, youngWomanPage, youngPage, youngWomanPage],
      scenes: { count: 0, rows: [] },
      onMovieRequest: () => {
        moviesCalled += 1;
      },
    }),
    async () => {
      const query = {
        type: "movie" as const,
        include: [
          { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
          { name: "young" },
        ],
        exclude: [],
        studioMode: "exact" as const,
        performers: [],
        studios: [],
        performerMode: "all" as const,
        perPage: 2,
      };
      // Page 1: the ordered merge pops the true recency minima across
      // both streams — 2024-03 (stream 1), then 2024-02 (stream 2,
      // newer than stream 1's 2024-01 row). Each stream still holds a
      // buffered row, so the browse continues.
      const page1 = await browseTitles({ ...query, page: 1 }, []);
      assert.deepEqual(
        page1.items.map((d) => d.reference.id),
        [uuid(1), uuid(3)],
      );
      assert.equal(page1.hasMore, true);
      resetMetaCache();
      // Page 2: fresh streams re-read upstream page 1 (requests 3 and
      // 4), so the merge replays the union's prefix past the start
      // offset and slices the next two: 2024-01 (stream 1), 2023-12
      // (stream 2). Both streams exhausted with empty buffers, so the
      // browse ends.
      const page2 = await browseTitles({ ...query, page: 2 }, []);
      assert.deepEqual(
        page2.items.map((d) => d.reference.id),
        [uuid(2), uuid(4)],
      );
      assert.equal(page2.hasMore, false);
      // No repeats, no gaps: pages 1 and 2 are exactly the merged
      // union's four rows, each surfaced once.
      const union = [...page1.items, ...page2.items].map((d) => d.reference.id);
      assert.deepEqual(union, [uuid(1), uuid(3), uuid(2), uuid(4)]);
      assert.equal(new Set(union).size, union.length);
      // One upstream read per stream per browseTitles call.
      assert.equal(moviesCalled, 4);
    },
  );
});

test("a provider outage across fan-out streams stays one named error beside stream 1's rows", async () => {
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_XYZ_A = { id: 16, uuid: uuid(106), name: "XYZ Alpha" };
  const TAG_XYZ_B = { id: 17, uuid: uuid(107), name: "XYZ Beta" };
  let movieReads = 0;
  // scriptedUpstream cannot script per-request statuses: this handler
  // mirrors its /tags and /movies response shapes and answers 500 for
  // every /movies read after the first.
  const handler: FixtureHandler = (req, res) => {
    const path = pathOf(req.url ?? "");
    if (path === "/tags") {
      sendJson(res, 200, {
        data: [TAG_ANCHOR, TAG_XYZ_A, TAG_XYZ_B],
        links: { next: null },
      });
      return;
    }
    if (path === "/movies") {
      movieReads += 1;
      if (movieReads === 1) {
        // Stream 1's first page delivers a real match, then continues.
        sendJson(res, 200, {
          data: [
            tpdbRow(uuid(1), "Kept match", "2025-01-01", [
              TAG_ANCHOR,
              TAG_XYZ_A,
            ]),
          ],
          links: { next: "x" },
          meta: { total: 100 },
        });
        return;
      }
      // Every later read dies: stream 1's continuation and stream 2's
      // first page — both fan-out streams of the one provider fail.
      sendJson(res, 500, { message: "upstream down" });
      return;
    }
    sendJson(res, 404, { message: `fixture has no ${path}` });
  };
  await runBrowse(handler, async () => {
    const page = await browseTitles(
      {
        type: "movie",
        include: [
          { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
          { name: "xyz" },
        ],
        exclude: [],
        studioMode: "exact",
        performers: [],
        studios: [],
        performerMode: "all",
        page: 1,
        perPage: 10,
      },
      [],
    );
    // Stream 1's delivered row survives beside ONE named error: several
    // failing streams of one provider are one story, first failure wins.
    assert.deepEqual(
      page.items.map((d) => d.reference.id),
      [uuid(1)],
    );
    assert.deepEqual(
      page.errors.map((e) => [e.provider, e.code]),
      [["tpdb", "upstream_unavailable"]],
    );
    assert.equal(page.totalCountKnown, false);
    assert.equal(page.hasMore, false);
  });
});

test("a fan-out that never fills degrades to the named scan_ceiling instead of erroring", async () => {
  const TAG_ANCHOR = { id: 15, uuid: uuid(105), name: "Anchor Tag" };
  const TAG_YOUNG = { id: 11, uuid: uuid(111), name: "Young" };
  const TAG_YOUNG_W = { id: 12, uuid: uuid(112), name: "Young Woman" };
  const TAG_OLD = { id: 13, uuid: uuid(113), name: "Old" };
  const TAG_OLD_M = { id: 14, uuid: uuid(114), name: "Old Man" };
  let moviesCalled = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [TAG_ANCHOR, TAG_YOUNG, TAG_YOUNG_W, TAG_OLD, TAG_OLD_M],
      // Every page carries the young half but never the old tag: the local
      // old re-check drops every row, so both fan-out streams scan to the
      // ceiling — a bounded matchless answer, never a 422.
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(2), "Young only", "2024-01-01", [
              TAG_ANCHOR,
              TAG_YOUNG,
            ]),
          ],
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
      const page = await browseTitles(
        {
          type: "movie",
          include: [
            { name: TAG_ANCHOR.name, tpdb: TAG_ANCHOR.uuid },
            { name: "young" },
            { name: "old" },
          ],
          exclude: [],
          studioMode: "exact",
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      assert.deepEqual(page.items, []);
      assert.deepEqual(
        page.errors.map((e) => [e.provider, e.code]),
        [["tpdb", "scan_ceiling"]],
      );
      assert.equal(page.totalCountKnown, false);
      assert.equal(page.hasMore, false);
      // Moved pin (VELV-240): the request's per-provider page pool caps the
      // whole browse at MAX_SCAN_PAGES (40; module-private in
      // src/server/browse.ts) reads — the two fan-out streams share that
      // budget instead of each walking its own 40 (80 before).
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
            performers: [],
            studios: [],
            performerMode: "all",
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
          // Rows the [abc + one xyz id] all-of streams return (the fixture
          // ignores the native filter): the account's hidden tag filters
          // them all on arrival, so the visible yield starves and the
          // fan-out streams still end in the soft degrade with its named
          // error.
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          include: [{ name: TAG_A.name, tpdb: TAG_A.uuid }],
          exclude: [],
          studioMode: "exact",
          // Contract move (VELV-166): the scalar performer key became an
          // entry in the performers array.
          performers: [{ tpdb: performer }],
          studios: [],
          performerMode: "all",
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
      const gql = JSON.parse(body) as {
        query?: string;
        variables?: { t?: string };
      };
      if (gql.query?.includes("queryTags")) {
        sendJson(res, 200, {
          data: { queryTags: { count: stashRows.length, tags: stashRows } },
        });
        return;
      }
      // A cold picker search goes native with a real term: the healthy
      // source answers the rows a relevance search would match, so its
      // contribution stays visible beside the tpdb outage error.
      const term = gql.variables?.t ?? "";
      sendJson(res, 200, {
        data: {
          searchTag:
            term === ""
              ? []
              : stashRows.filter((r) =>
                  r.name.toLowerCase().includes(term.toLowerCase()),
                ),
        },
      });
      return;
    }
    sendJson(res, 404, {});
  };
  await runBrowse(handler, async () => {
    // The TPDB source is down; StashDB answers. The failure is visible and
    // the healthy source's matches are kept (a cold keystroke reads the
    // native search; the listing warm serves the folded-substring rule on
    // later keystrokes).
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

// --- hiddenTitleMatcher: family rule (whole-word sequence), never raw substring ---

test("hiddenTitleMatcher matches UUID, whole label, or word family; never raw substring or blank labels", () => {
  const isHiddenTitle = (d: CatalogDetail, tags: CatalogTagSelection[]) =>
    hiddenTitleMatcher(tags)(d);
  const detail = (tags: { id: string; name: string }[]) =>
    ({
      reference: { provider: "stashdb", kind: "scene", id: uuid(9) },
      title: "t",
      tags,
      credits: [],
      related: [],
      links: [],
      aliases: [],
    }) as CatalogDetail;
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

test("property: matchers compiled once per request agree with a per-title fold on every title", () => {
  // Oracle: a plain reference that refolds the selection and every tag name
  // for each title x selection pair (the rule before the per-request
  // compile). One compiled matcher and one FoldedTags per title must give
  // the same verdict for every title, in every mode, so no fold state leaks
  // between titles or between selections.
  const fold = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]/g, "");
  const words = (v: string) =>
    v
      .toLowerCase()
      .normalize("NFKD")
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== "");
  const reference = (
    d: CatalogDetail,
    sel: CatalogTagSelection,
    mode: "exact" | "family" | "substring",
  ): boolean => {
    const id = d.reference.provider === "tpdb" ? sel.tpdb : sel.stashdb;
    if (id !== undefined && d.tags.some((t) => t.id === id)) return true;
    const label = fold(sel.name);
    if (label === "") return false;
    if (mode === "exact") return d.tags.some((t) => fold(t.name) === label);
    if (mode === "substring") {
      return d.tags.some((t) => fold(t.name).includes(label));
    }
    const want = words(sel.name);
    return d.tags.some((t) => {
      const have = words(t.name);
      for (let i = 0; i + want.length <= have.length; i++) {
        if (want.every((w, j) => have[i + j] === w)) return true;
      }
      return false;
    });
  };
  // A small overlapping vocabulary (case, accents, punctuation, a word that
  // contains another) so matches, near-misses and blank labels all occur.
  const label = fc
    .array(
      fc.tuple(
        fc.constantFrom("Anal", "ÁNAL", "analingus", "Double", "pen", "4K", ""),
        fc.constantFrom(" ", "-", "!", "  ", "_", "é"),
      ),
      { maxLength: 4 },
    )
    .map((parts) => parts.flat().join(""));
  const id = fc.option(fc.constantFrom(uuid(1), uuid(2), uuid(3)), {
    nil: undefined,
  });
  const selection = fc.record({ name: label, tpdb: id, stashdb: id });
  const title = fc.record({
    provider: fc.constantFrom<CatalogProvider>("tpdb", "stashdb"),
    tags: fc.array(
      fc.record({
        id: fc.constantFrom(uuid(1), uuid(2), uuid(3), uuid(4)),
        name: label,
      }),
      { maxLength: 5 },
    ),
  });
  fc.assert(
    fc.property(
      fc.array(selection, { maxLength: 4 }),
      fc.array(title, { minLength: 1, maxLength: 6 }),
      (sels, rows) => {
        const details = rows.map(
          (r, i) =>
            ({
              reference: {
                provider: r.provider,
                kind: r.provider === "tpdb" ? "movie" : "scene",
                id: uuid(100 + i),
              },
              title: "t",
              tags: r.tags,
              credits: [],
              related: [],
              links: [],
              aliases: [],
            }) as CatalogDetail,
        );
        const modes = ["exact", "family", "substring"] as const;
        const compiled = modes.flatMap((mode) =>
          sels.map((sel) => ({ sel, mode, match: tagMatcher(sel, mode) })),
        );
        const hidden = hiddenTitleMatcher(sels);
        for (const d of details) {
          const tags = new FoldedTags(d);
          for (const { sel, mode, match } of compiled) {
            assert.equal(match(tags), reference(d, sel, mode));
          }
          assert.equal(
            hidden(d),
            sels.some((sel) => reference(d, sel, "family")),
          );
        }
      },
    ),
  );
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
          performers: [],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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

test("a free-text exclude carries no provider id and hides by label contains", async () => {
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
          performers: [],
          studios: [],
          performerMode: "all",
          page: 1,
          perPage: 10,
        },
        [],
      );
      // The provider is never asked for a tag id it was never given; the
      // local matcher does the whole exclusion. Contract move: a typed
      // exclude now matches by "contains" like a typed include, so
      // "Analingus" goes too (it used to survive under the word-family
      // rule, which picked tags and hidden tags still use).
      assert.deepEqual(
        page.items.map((d) => d.title),
        [],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 0);
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
          // Contract move (VELV-166): the scalar studio key became an
          // entry in the studios array (slugs stay legal there).
          studios: [{ tpdb: "evilangel" }],
          performers: [],
          performerMode: "all",
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
          // Contract move (VELV-166): the two scalar studio keys became one
          // unified entry; the sides still keep their own clauses.
          studios: [{ tpdb: uuid(3), stashdb: uuid(4) }],
          performers: [],
          performerMode: "all",
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
          include: [{ name: PARENT.name, tpdb: PARENT.uuid }],
          exclude: [],
          studioMode: "exact",
          // Contract move (VELV-166): the scalar performer key became an
          // entry in the performers array.
          performers: [{ tpdb: performer }],
          studios: [],
          performerMode: "all",
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
          performers: [],
          studios: [],
          performerMode: "all",
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
    performers: [],
    studios: [],
    performerMode: "all",
    studioMode: "exact",
    page: 1,
    perPage: 60,
    ...overrides,
  };
}

// Contract move (VELV-166): the source-scoped scalar keys (performerTpdb &
// co.) became entry arrays — every old one-sided-clause pin now rides the
// entries, same sides.
test("planBrowseSides keeps source-scoped filters on the wrong kind: no side qualifies; unions keep the side that can", () => {
  const cases: [BrowseEntity[], BrowseQuery["type"], string][] = [
    [[{ stashdb: uuid(1) }], "movie", "stashdb-only performers"],
    [[{ stashdb: uuid(1) }], "movie", "stashdb-only studios (performers)"],
    [[{ tpdb: uuid(1) }], "scene", "tpdb-only performers"],
    [[{ tpdb: uuid(1) }], "scene", "tpdb-only studios (performers)"],
  ];
  for (const [entries, type, label] of cases) {
    const sides = planBrowseSides(
      planQuery({ type, performers: entries, studios: entries }),
    ).sides;
    assert.deepEqual(sides, [], `${label} on ${type} runs no side`);
  }
  assert.deepEqual(
    planBrowseSides(planQuery({ type: "movie", performerStarred: true })).sides,
    [],
    "starred on movie runs no side",
  );
  // The performer union (both ids) runs the one side the tab names, with
  // its own constraint: Movies shows her TPDB filmography, Scenes her
  // StashDB side.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "movie",
        performers: [{ tpdb: uuid(1), stashdb: uuid(6) }],
      }),
    ).sides,
    ["tpdb"],
  );
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "scene",
        performers: [{ tpdb: uuid(1), stashdb: uuid(6) }],
      }),
    ).sides,
    ["stashdb"],
  );
  // The unified studio tile behaves the same way.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "movie",
        studios: [{ tpdb: uuid(1), stashdb: uuid(2) }],
      }),
    ).sides,
    ["tpdb"],
  );
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "scene",
        studios: [{ tpdb: uuid(1), stashdb: uuid(2) }],
      }),
    ).sides,
    ["stashdb"],
  );
});

test("planBrowseSides refuses withChildren without a StashDB studio and with a TPDB studio", () => {
  assert.throws(
    () => planBrowseSides(planQuery({ studioMode: "withChildren" })),
    /requires a StashDB studio/,
  );
  // A TPDB-only entry cannot ground the parent criterion either.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          studioMode: "withChildren",
          studios: [{ tpdb: uuid(3) }],
        }),
      ),
    /requires a StashDB studio/,
  );
  // Contract move (VELV-166): the scalar pair became one unified entry
  // carrying both ids; the StashDB-only rule and its wording are unchanged.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          studioMode: "withChildren",
          studios: [{ stashdb: uuid(2), tpdb: uuid(3) }],
        }),
      ),
    /StashDB-only/,
  );
});

test("planBrowseSides refuses every filmography combination that upstream rejects", () => {
  // Contract move (VELV-166): the picked performer rides the entries.
  const filmography = {
    performers: [{ tpdb: uuid(4) }],
    type: "all" as const,
  };
  for (const extra of [
    { q: "term" },
    { year: 2024 },
    { date: "2024-02-03" },
    { studios: [{ tpdb: uuid(5) }] },
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
    planBrowseSides(
      planQuery({ studios: [{ stashdb: uuid(2) }], sort: "recency" }),
    ).sides,
    ["stashdb"],
    "recency survives on a StashDB-only All plan",
  );
});

test("planBrowseSides keeps search and sort on the Scenes tab of a unified performer pair", () => {
  // Search no longer refuses, and the default recency order applies.
  const searched = planBrowseSides(
    planQuery({
      type: "scene",
      performers: [{ tpdb: uuid(4), stashdb: uuid(6) }],
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
        performers: [{ tpdb: uuid(4), stashdb: uuid(6) }],
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
    planBrowseSides(planQuery({ performers: [{ stashdb: uuid(6) }] })).sides,
    ["stashdb"],
  );
  assert.deepEqual(
    planBrowseSides(planQuery({ studios: [{ stashdb: uuid(7) }] })).sides,
    ["stashdb"],
  );
  // A unified studio tile carries both ids: the clauses are alternatives,
  // not a conjunction, so both sides run.
  assert.deepEqual(
    planBrowseSides(
      planQuery({ studios: [{ tpdb: uuid(8), stashdb: uuid(7) }] }),
    ).sides,
    ["tpdb", "stashdb"],
  );
  // The performer pair unions by the same alternative-clauses rule as the
  // unified studio tile: both ids together run both sides.
  assert.deepEqual(
    planBrowseSides(
      planQuery({ performers: [{ tpdb: uuid(1), stashdb: uuid(6) }] }),
    ).sides,
    ["tpdb", "stashdb"],
  );
});

test("planBrowseSides derives order: filmography claims none, defaults are release recency", () => {
  const def = planBrowseSides(planQuery());
  assert.deepEqual(def.nativeSort, { key: "recency", direction: "desc" });
  assert.deepEqual(def.mergeOrder, { key: "recency", direction: "desc" });

  const film = planBrowseSides(
    planQuery({ performers: [{ tpdb: uuid(4) }], type: "movie" }),
  );
  assert.equal(film.filmography, true);
  assert.equal(film.nativeSort, undefined);
  assert.equal(film.mergeOrder, undefined);

  // The performer union keeps the filmography route's no-sort claim.
  const union = planBrowseSides(
    planQuery({ performers: [{ tpdb: uuid(4), stashdb: uuid(6) }] }),
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
      planQuery({ performerStarred: true, studios: [{ stashdb: uuid(7) }] }),
    ).sides,
    ["stashdb"],
  );
  // Movies can never match a scenes-only starred filter: the tab keeps the
  // chip in the URL and runs no side (honest empty page).
  assert.deepEqual(
    planBrowseSides(planQuery({ performerStarred: true, type: "movie" })).sides,
    [],
  );
  // Contract move (VELV-166): the two scalar refusals became one — the
  // starred filter refuses picked performers of ANY shape with a single
  // message, so the wording no longer names a provider.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({ performerStarred: true, performers: [{ tpdb: uuid(1) }] }),
      ),
    /A starred-performer filter cannot be combined with picked performers\./,
  );
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          performerStarred: true,
          performers: [{ stashdb: uuid(6) }],
        }),
      ),
    /A starred-performer filter cannot be combined with picked performers\./,
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
    notices: [],
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

// --- VELV-166: several performers and studios, year ranges, or-groups ---

// The entry semantics behind the planner, tested directly: qualification in
// all and any mode with known and unknown ids, the filmography gate, the
// stream seeds, and the merged-sort restriction. All pure — no fixture.
test("sourceRunsFor generalizes the one-sided clause truth table to entries", () => {
  const tpdbOnly = [{ tpdb: uuid(1) }];
  const stashOnly = [{ stashdb: uuid(2) }];
  const unified = [{ tpdb: uuid(1), stashdb: uuid(2) }];
  // No entries: the constraint is absent — both sources qualify.
  assert.equal(sourceRunsFor([], "tpdb", "all"), true);
  assert.equal(sourceRunsFor([], "stashdb", "any"), true);
  // all mode: a source must know EVERY entry.
  assert.equal(sourceRunsFor(tpdbOnly, "tpdb", "all"), true);
  assert.equal(sourceRunsFor(tpdbOnly, "stashdb", "all"), false);
  assert.equal(sourceRunsFor(unified, "tpdb", "all"), true);
  assert.equal(sourceRunsFor(unified, "stashdb", "all"), true);
  // any mode (and studios, always any-of): one known entry suffices.
  assert.equal(sourceRunsFor([...tpdbOnly, ...stashOnly], "tpdb", "any"), true);
  assert.equal(
    sourceRunsFor([...tpdbOnly, ...stashOnly], "stashdb", "any"),
    true,
  );
  // Mixed entries in all mode disqualify both sources.
  const mixed = [...tpdbOnly, ...stashOnly];
  assert.equal(sourceRunsFor(mixed, "tpdb", "all"), false);
  assert.equal(sourceRunsFor(mixed, "stashdb", "all"), false);
});

test("tpdbFilmographyRuns gates on entries, tab and mode", () => {
  const tpdbPerformer = { tpdb: uuid(1) };
  const stashPerformer = { stashdb: uuid(2) };
  // At least one TPDB-known performer and a non-scene tab.
  assert.equal(tpdbFilmographyRuns("all", [tpdbPerformer], "all"), true);
  assert.equal(tpdbFilmographyRuns("movie", [tpdbPerformer], "any"), true);
  // Never on the Scenes tab: StashDB owns the side there.
  assert.equal(tpdbFilmographyRuns("scene", [tpdbPerformer], "all"), false);
  // A stashdb-only entry gives TPDB nothing to page.
  assert.equal(tpdbFilmographyRuns("movie", [stashPerformer], "all"), false);
  // In any mode one TPDB-known entry among unknown ones still runs.
  assert.equal(
    tpdbFilmographyRuns("movie", [stashPerformer, tpdbPerformer], "any"),
    true,
  );
  // In all mode it does not: TPDB cannot know every entry.
  assert.equal(
    tpdbFilmographyRuns("movie", [stashPerformer, tpdbPerformer], "all"),
    false,
  );
});

test("browseSideRuns applies the starred clause to the TPDB side only", () => {
  const tpdbPerformer = { tpdb: uuid(1) };
  assert.deepEqual(browseSideRuns("all", [tpdbPerformer], [], "all", true), {
    tpdb: false,
    stashdb: false,
  });
  // Scene tab: starred kills the TPDB side, and the tpdb-only entry
  // disqualifies the stash side too — no side qualifies at all.
  assert.deepEqual(browseSideRuns("scene", [tpdbPerformer], [], "any", true), {
    tpdb: false,
    stashdb: false,
  });
  // A stashdb-known entry keeps the scene side running under starred.
  assert.deepEqual(
    browseSideRuns("scene", [{ stashdb: uuid(2) }], [], "any", true),
    { tpdb: false, stashdb: true },
  );
  assert.deepEqual(browseSideRuns("all", [tpdbPerformer], [], "all", false), {
    tpdb: true,
    stashdb: false,
  });
});

test("planStreams seeds one stream per upstream list in entry order", () => {
  const P1 = { tpdb: uuid(1), stashdb: uuid(6) };
  const P2 = { tpdb: uuid(2) };
  const S1 = { tpdb: uuid(3) };
  const S2 = { stashdb: uuid(4) };
  // TPDB all-mode filmography: ONE stream, the first known entry's route.
  const allMode = planStreams("movie", [P1, P2], [], "all", "exact", false);
  assert.equal(allMode.filmography, true);
  assert.deepEqual(allMode.seeds, [
    { provider: "tpdb", kind: "movie", filmographyPerformer: uuid(1) },
  ]);
  // TPDB any-mode: one filmography per known entry, sharing a dedupe key.
  const anyMode = planStreams("movie", [P1, P2], [], "any", "exact", false);
  assert.deepEqual(anyMode.seeds, [
    {
      provider: "tpdb",
      kind: "movie",
      filmographyPerformer: uuid(1),
      dedupeKey: "tpdb-filmographies",
    },
    {
      provider: "tpdb",
      kind: "movie",
      filmographyPerformer: uuid(2),
      dedupeKey: "tpdb-filmographies",
    },
  ]);
  // TPDB studios: one seed per known studio id.
  const tpdbStudios = planStreams("movie", [], [S1], "all", "exact", false);
  assert.deepEqual(tpdbStudios.seeds, [
    { provider: "tpdb", kind: "movie", tpdbStudio: uuid(3) },
  ]);
  // StashDB exact studios: every known id in ONE INCLUDES stream.
  const stashExact = planStreams("scene", [], [S2], "all", "exact", false);
  assert.deepEqual(stashExact.seeds, [
    {
      provider: "stashdb",
      kind: "scene",
      studioIds: [uuid(4)],
    },
  ]);
  // StashDB withChildren: one parentStudio stream per studio ≥2.
  const children = planStreams(
    "scene",
    [],
    [{ stashdb: uuid(4) }, { stashdb: uuid(5) }],
    "all",
    "withChildren",
    false,
  );
  assert.deepEqual(children.seeds, [
    {
      provider: "stashdb",
      kind: "scene",
      parentStudioId: uuid(4),
      dedupeKey: "stashdb-parent-studios",
    },
    {
      provider: "stashdb",
      kind: "scene",
      parentStudioId: uuid(5),
      dedupeKey: "stashdb-parent-studios",
    },
  ]);
  // A single withChildren studio keeps the plain single-stream shape.
  const singleChild = planStreams(
    "scene",
    [],
    [{ stashdb: uuid(4) }],
    "all",
    "withChildren",
    false,
  );
  assert.deepEqual(singleChild.seeds, [
    { provider: "stashdb", kind: "scene", parentStudioId: uuid(4) },
  ]);
  // Unified performer pair on Scenes: the stash side alone, all-mode criterion.
  const scenes = planStreams("scene", [P1], [], "all", "exact", false);
  assert.deepEqual(scenes.seeds, [
    {
      provider: "stashdb",
      kind: "scene",
      performerIds: [uuid(6)],
      performerAll: true,
    },
  ]);
  // Starred: the criterion marks present, ids arrive at IO time.
  const starred = planStreams("scene", [], [], "all", "exact", true);
  assert.deepEqual(starred.seeds, [
    {
      provider: "stashdb",
      kind: "scene",
      performerIds: [],
      performerAll: false,
    },
  ]);
});

test("mergedSourceRestricted refuses only sorts outside the mixed vocabulary on merged sources", () => {
  const twoTpdbStudios = planStreams(
    "movie",
    [],
    [{ tpdb: uuid(3) }, { tpdb: uuid(4) }],
    "all",
    "exact",
    false,
  );
  const mergedStash = planStreams(
    "scene",
    [],
    [{ stashdb: uuid(4) }, { stashdb: uuid(5) }],
    "all",
    "withChildren",
    false,
  );
  const single = planStreams(
    "movie",
    [],
    [{ tpdb: uuid(3) }],
    "all",
    "exact",
    false,
  );
  for (const plan of [twoTpdbStudios, mergedStash]) {
    assert.equal(mergedSourceRestricted(plan, "title"), true);
    assert.equal(mergedSourceRestricted(plan, "trending"), true);
    // The mixed vocabulary stays legal.
    assert.equal(mergedSourceRestricted(plan, "recency"), false);
    assert.equal(mergedSourceRestricted(plan, "duration"), false);
    assert.equal(mergedSourceRestricted(plan, undefined), false);
  }
  // A single-stream source is never restricted.
  assert.equal(mergedSourceRestricted(single, "title"), false);
});

test("planBrowseSides refuses a sort a merged multi-list source cannot keep", () => {
  // Two TPDB studio entries merge two site_id lists: only recency/duration
  // may order them. The refusal names the rule.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          type: "movie",
          studios: [{ tpdb: uuid(3) }, { tpdb: uuid(4) }],
          sort: "title",
        }),
      ),
    (err: unknown) =>
      appError(400, "invalid_search")(err) &&
      (err as AppError).message.includes(
        "a merged source supports only recency and duration",
      ),
  );
  // recency stays legal.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "movie",
        studios: [{ tpdb: uuid(3) }, { tpdb: uuid(4) }],
        sort: "recency",
      }),
    ).sides,
    ["tpdb"],
  );
  // withChildren with two stashdb studios merges parent lists: same rule.
  assert.throws(
    () =>
      planBrowseSides(
        planQuery({
          type: "scene",
          studios: [{ stashdb: uuid(4) }, { stashdb: uuid(5) }],
          studioMode: "withChildren",
          sort: "title",
        }),
      ),
    (err: unknown) =>
      appError(400, "invalid_search")(err) &&
      (err as AppError).message.includes(
        "a merged source supports only recency and duration",
      ),
  );
  // A single studio of either shape keeps every sort its side carries.
  assert.deepEqual(
    planBrowseSides(
      planQuery({
        type: "scene",
        studios: [{ stashdb: uuid(4) }],
        sort: "title",
      }),
    ).nativeSort,
    { key: "title" },
  );
});

// --- the caps: 1..5 entries per kind, never the same id twice, never both
// spellings of one kind ---

test("parseBrowseQuery caps entity arrays at five and refuses duplicates and mixed spellings", () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ tpdb: uuid(10 + i) }));
  assert.throws(
    () =>
      parseBrowseQuery(
        new URLSearchParams({
          performers: JSON.stringify(six),
        }),
      ),
    appError(400, "invalid_query"),
    "six performer entries",
  );
  assert.throws(
    () =>
      parseBrowseQuery(new URLSearchParams({ studios: JSON.stringify(six) })),
    appError(400, "invalid_query"),
    "six studio entries",
  );
  // Five is the cap and parses.
  assert.equal(
    parseBrowseQuery(
      new URLSearchParams({
        performers: JSON.stringify(six.slice(0, MAX_BROWSE_ENTITIES)),
      }),
    ).performers.length,
    5,
  );
  // The same provider id twice in one kind would double-count a stream.
  assert.throws(
    () =>
      parseBrowseQuery(
        new URLSearchParams({
          performers: JSON.stringify([{ tpdb: uuid(1) }, { tpdb: uuid(1) }]),
        }),
      ),
    appError(400, "invalid_search"),
    "duplicate tpdb id",
  );
  assert.throws(
    () =>
      parseBrowseQuery(
        new URLSearchParams({
          studios: JSON.stringify([{ stashdb: uuid(2) }, { stashdb: uuid(2) }]),
        }),
      ),
    appError(400, "invalid_search"),
    "duplicate stashdb id",
  );
  // The same uuid under BOTH providers is two identities and stays legal.
  assert.equal(
    parseBrowseQuery(
      new URLSearchParams({
        performers: JSON.stringify([{ tpdb: uuid(1), stashdb: uuid(1) }]),
      }),
    ).performers.length,
    1,
  );
  // Old scalar key + new array key of one kind: two spellings of one filter
  // would silently AND disjoint entry sets.
  assert.throws(
    () =>
      parseBrowseQuery(
        new URLSearchParams({
          performers: JSON.stringify([{ tpdb: uuid(1) }]),
          performerTpdb: uuid(2),
        }),
      ),
    appError(400, "invalid_search"),
    "old + new performer key",
  );
  assert.throws(
    () =>
      parseBrowseQuery(
        new URLSearchParams({
          studios: JSON.stringify([{ stashdb: uuid(2) }]),
          studioStashdb: uuid(3),
        }),
      ),
    appError(400, "invalid_search"),
    "old + new studio key",
  );
  // The other kind's old key composes freely.
  const both = parseBrowseQuery(
    new URLSearchParams({
      performers: JSON.stringify([{ tpdb: uuid(1) }]),
      studioStashdb: uuid(3),
    }),
  );
  assert.deepEqual(both.performers, [{ tpdb: uuid(1) }]);
  assert.deepEqual(both.studios, [{ stashdb: uuid(3) }]);
});

test("parseBrowseQuery validates each entity entry's shape", () => {
  const bad: [string, string, RegExp][] = [
    ["performers", "not-json", /must be a JSON array/],
    // Unknown fields are refused — the entry shape is pinned.
    [
      "performers",
      JSON.stringify([{ tpdb: uuid(1), nickname: "x" }]),
      /accept only name, tpdb and stashdb/,
    ],
    [
      "performers",
      JSON.stringify([{ stashdb: uuid(1) }, "nope"]),
      /entries must be JSON objects/,
    ],
    // A performer entry refuses the TPDB site slug; a studio entry keeps it
    // (cross-provider studio links legitimately carry the slug).
    [
      "performers",
      JSON.stringify([{ tpdb: "evilangel" }]),
      /performers entry tpdb must be a provider UUID\./,
    ],
    // An entry with no id can never qualify a source.
    [
      "performers",
      JSON.stringify([{ name: "Just A Name" }]),
      /needs a TPDB or StashDB id/,
    ],
    ["studios", JSON.stringify([{}]), /needs a TPDB or StashDB id/],
    // Display labels are optional but bounded.
    [
      "performers",
      JSON.stringify([{ name: "x".repeat(121), tpdb: uuid(1) }]),
      /name must be 1\.\.120/,
    ],
    [
      "studios",
      JSON.stringify([{ name: "   ", tpdb: uuid(2) }]),
      /name must be 1\.\.120/,
    ],
    // Ids must be provider UUIDs (or, for studios on TPDB, site slugs).
    [
      "studios",
      JSON.stringify([{ stashdb: "not-a-uuid" }]),
      /entry stashdb must be a provider UUID/,
    ],
  ];
  for (const [key, value, message] of bad) {
    assert.throws(
      () => parseBrowseQuery(new URLSearchParams({ [key]: value })),
      (err: unknown) =>
        appError(400, "invalid_query")(err) &&
        message.test((err as AppError).message),
      `${key}=${value}`,
    );
  }
  // The studio slug acceptance, positively.
  assert.deepEqual(
    parseBrowseQuery(
      new URLSearchParams({
        studios: JSON.stringify([{ tpdb: "evil-angel" }]),
      }),
    ).studios,
    [{ tpdb: "evil-angel" }],
  );
  // Names trim; ids lowercase.
  const normalized = parseBrowseQuery(
    new URLSearchParams({
      performers: JSON.stringify([
        { name: "  Jane Doe  ", tpdb: uuid(1).toUpperCase(), stashdb: uuid(2) },
      ]),
    }),
  );
  assert.deepEqual(normalized.performers, [
    { name: "Jane Doe", tpdb: uuid(1), stashdb: uuid(2) },
  ]);
});

// --- year ranges ---

test("parseBrowseQuery treats a year range as a pair with the old refusals and codes", () => {
  const cases: [string, string][] = [
    ["yearTo=2024", "invalid_search"], // upper bound without the lower one
    ["year=2024&yearTo=2020", "invalid_search"], // inverted range
    [
      "year=2024&yearTo=2026&date=2026-01-31&date_operation=%3C",
      "invalid_search",
    ],
    ["year=2024&yearTo=notayear", "invalid_query"], // shape errors keep invalid_query
    ["year=2024&yearTo=1899", "invalid_query"],
    ["year=2024&yearTo=2101", "invalid_query"],
  ];
  for (const [query, code] of cases) {
    assert.throws(
      () => parseBrowseQuery(new URLSearchParams(query)),
      appError(400, code),
      query,
    );
  }
  // An equal range is a legal single-year window.
  const single = parseBrowseQuery(new URLSearchParams("year=2024&yearTo=2024"));
  assert.equal(single.year, 2024);
  assert.equal(single.yearTo, 2024);
  // A valid range parses both bounds.
  const range = parseBrowseQuery(new URLSearchParams("year=1990&yearTo=2000"));
  assert.equal(range.year, 1990);
  assert.equal(range.yearTo, 2000);
  // The filmography route refuses the year window like any other year
  // filter — parse alone cannot see the combination, so the refusal is
  // plan-level and needs a TPDB-known performer entry.
  const filmographyUrl = `type=movie&performers=${encodeURIComponent(
    JSON.stringify([{ tpdb: uuid(4) }]),
  )}&year=1990&yearTo=2000`;
  assert.throws(
    () =>
      planBrowseSides(parseBrowseQuery(new URLSearchParams(filmographyUrl))),
    appError(400, "invalid_search"),
  );
  // While the plain search keeps it: the plan carries the range through.
  const planned = planBrowseSides(
    parseBrowseQuery(new URLSearchParams("type=all&year=1990&yearTo=2000")),
  );
  assert.deepEqual(planned.sides, ["tpdb", "stashdb"]);
});

test("parseBrowseQuery validates dateTo as the inclusive tail of a date>= range", () => {
  const cases: [string, string][] = [
    ["dateTo=2021-12-31", "invalid_search"], // upper bound without the lower one
    [
      "date=2019-01-01&date_operation=%3C&dateTo=2021-12-31",
      "invalid_search", // only >= composes a range
    ],
    [
      "date=2019-01-01&date_operation=%3E%3D&dateTo=2018-12-31",
      "invalid_search", // inverted range
    ],
    [
      "year=2019&date=2019-01-01&date_operation=%3E%3D&dateTo=2021-12-31",
      "invalid_search", // the year vocabulary never mixes
    ],
    [
      "year=2019&yearTo=2021&date=2019-01-01&date_operation=%3E%3D&dateTo=2021-12-31",
      "invalid_search",
    ],
    [
      "date=2019-01-01&date_operation=%3E%3D&dateTo=notadate",
      "invalid_query", // shape errors keep invalid_query
    ],
    [
      "date=2019-01-01&date_operation=%3E%3D&dateTo=2019-02-30",
      "invalid_query",
    ],
  ];
  for (const [query, code] of cases) {
    assert.throws(
      () => parseBrowseQuery(new URLSearchParams(query)),
      appError(400, code),
      query,
    );
  }
  // A valid range parses all three keys.
  const range = parseBrowseQuery(
    new URLSearchParams(
      "date=2019-01-01&date_operation=%3E%3D&dateTo=2021-12-31",
    ),
  );
  assert.equal(range.date, "2019-01-01");
  assert.equal(range.dateOperation, ">=");
  assert.equal(range.dateTo, "2021-12-31");
});

test("a descending date>= + dateTo range sends the native upper bound and checks both bounds locally", async () => {
  const movieUrls: string[] = [];
  const sceneInputs: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(10), "Inside Movie", "2020-06-01"),
            tpdbRow(uuid(11), "Late Movie", "2022-06-01"),
            // A bogus date maps to no releaseDate, like a missing one.
            tpdbRow(uuid(12), "Undated Movie", "garbage"),
            tpdbRow(uuid(13), "Early Movie", "2018-12-31"),
          ],
          next: null,
          total: 4,
        },
      ],
      scenes: {
        count: 3,
        rows: [
          stashRow(uuid(30), "Inside Scene", "2021-03-03"),
          stashRow(uuid(31), "Late Scene", "2022-03-03"),
          stashRow(uuid(32), "Early Scene", "2018-12-31"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => sceneInputs.push(input),
    }),
    async () => {
      const page = await browseTitles(
        planQuery({
          date: "2019-01-01",
          dateOperation: ">=",
          dateTo: "2021-12-31",
        }),
        [],
      );
      // Deliberate flip: newest-first scans send the upper bound natively.
      // Both local checks still exclude rows outside the inclusive window.
      assert.match(movieUrls[0]!, /date=2021-12-31/);
      assert.match(movieUrls[0]!, /date_operation=%3C%3D/);
      assert.deepEqual(sceneInputs[0]!.date, {
        value: "2022-01-01",
        modifier: "LESS_THAN",
      });
      // Early, late, and undated titles cannot satisfy the window.
      assert.deepEqual(page.items.map((d) => d.title).sort(), [
        "Inside Movie",
        "Inside Scene",
      ]);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
    },
  );
});

/** HTTP fixture with native date filters, date order, and real page offsets.
 * Equal durations preserve catalog order for the non-date cases. */
function rangeScanUpstream(
  catalog: { id: string; date: string }[],
  inputs: Record<string, unknown>[],
): FixtureHandler {
  return (req, res, body) => {
    const path = pathOf(req.url ?? "");
    const movie = path === "/movies";
    if (!movie && path !== "/graphql") {
      sendJson(res, 404, { message: `fixture has no ${path}` });
      return;
    }
    let input: Record<string, unknown>;
    if (movie) {
      input = Object.fromEntries(queryOf(req.url ?? ""));
    } else {
      const gql: { variables: { f: Record<string, unknown> } } =
        JSON.parse(body);
      input = gql.variables.f;
    }
    inputs.push(input);
    const date = movie
      ? undefined
      : (input.date as { value: string; modifier: string } | undefined);
    const cutoff = movie ? (input.date as string | undefined) : date?.value;
    const operation = movie
      ? input.date_operation
      : date?.modifier === "LESS_THAN"
        ? "<"
        : date?.modifier === "GREATER_THAN"
          ? ">"
          : "=";
    const rows = catalog.filter((row) => {
      if (cutoff === undefined) return true;
      switch (operation) {
        case "<":
          return row.date < cutoff;
        case "<=":
          return row.date <= cutoff;
        case ">":
          return row.date > cutoff;
        case ">=":
          return row.date >= cutoff;
        case "=":
          return row.date === cutoff;
        default:
          assert.fail(`Unexpected date operation: ${operation}`);
      }
    });
    const ordered = movie
      ? ["former_released", "recently_released"].includes(String(input.orderBy))
      : input.sort === "DATE";
    if (ordered) {
      const asc = movie
        ? input.orderBy === "former_released"
        : input.direction === "ASC";
      rows.sort((a, b) => (asc ? 1 : -1) * a.date.localeCompare(b.date));
    }
    const page = Number(input.page);
    const perPage = Number(input.per_page);
    const makeRow = movie ? tpdbRow : stashRow;
    const items = rows
      .slice((page - 1) * perPage, page * perPage)
      .map((row) => makeRow(row.id, `Title ${row.id}`, row.date));
    sendJson(
      res,
      200,
      movie
        ? {
            data: items,
            links: { next: page * perPage < rows.length ? "next" : null },
            meta: { total: rows.length },
          }
        : { data: { queryScenes: { count: rows.length, scenes: items } } },
    );
  };
}

const rangeScanOrders = [
  { type: "movie", sort: "recency", direction: "asc" },
  { type: "scene", sort: "date", direction: "asc" },
  { type: "scene", sort: "date", direction: "desc" },
] as const;

for (const order of rangeScanOrders) {
  test(`range scan order ${order.type} ${order.sort} ${order.direction} stops past the terminal date with an exact total`, async () => {
    const terminalDate =
      order.direction === "asc" ? "2012-01-01" : "2010-12-31";
    const inputs: Record<string, unknown>[] = [];
    const catalog = [
      { id: uuid(1), date: "2011-01-01" },
      { id: uuid(2), date: "2011-06-01" },
      { id: uuid(3), date: "2011-12-31" },
      ...Array.from({ length: 2100 }, (_, i) => ({
        id: uuid(100 + i),
        date: terminalDate,
      })),
    ];
    await runBrowse(rangeScanUpstream(catalog, inputs), async () => {
      const page = await browseTitles(
        planQuery({
          ...order,
          date: "2011-01-01",
          dateOperation: ">=",
          dateTo: "2011-12-31",
          perPage: 50,
          page: 2,
        }),
        [],
      );
      assert.deepEqual(page.items, []);
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 3);
      assert.equal(page.hasMore, false);
      assert.deepEqual(page.errors, []);
      assert.ok(inputs.length < 5, `upstream reads: ${inputs.length}`);
    });
  });

  test(`range scan order ${order.type} ${order.sort} ${order.direction} keeps inclusive terminal ties across pages`, async () => {
    const edge = order.direction === "asc" ? "2011-12-31" : "2011-01-01";
    const outside = order.direction === "asc" ? "2012-01-01" : "2010-12-31";
    const inputs: Record<string, unknown>[] = [];
    const catalog = [
      { id: uuid(1), date: "2011-06-01" },
      { id: uuid(2), date: edge },
      { id: uuid(3), date: edge },
      { id: uuid(4), date: edge },
      { id: uuid(5), date: outside },
    ];
    await runBrowse(rangeScanUpstream(catalog, inputs), async () => {
      const ids: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const result = await browseTitles(
          planQuery({
            ...order,
            date: "2011-01-01",
            dateOperation: ">=",
            dateTo: "2011-12-31",
            perPage: 2,
            page,
          }),
          [],
        );
        ids.push(...result.items.map((item) => item.reference.id));
        if (page === 3) {
          assert.equal(result.totalCountKnown, true);
          assert.equal(result.total, 4);
          assert.equal(result.hasMore, false);
        }
      }
      assert.deepEqual(ids.sort(), [uuid(1), uuid(2), uuid(3), uuid(4)].sort());
    });
  });
}

for (const type of ["movie", "scene"] as const) {
  test(`range scan order ${type} duration does not stop before a later in-range page`, async () => {
    const inputs: Record<string, unknown>[] = [];
    // Equal durations form a valid duration order, but not a date order.
    const catalog = [
      { id: uuid(1), date: "2012-01-01" },
      { id: uuid(2), date: "2012-02-01" },
      { id: uuid(3), date: "2011-06-01" },
    ];
    await runBrowse(rangeScanUpstream(catalog, inputs), async () => {
      const page = await browseTitles(
        planQuery({
          type,
          sort: "duration",
          direction: "asc",
          date: "2011-01-01",
          dateOperation: ">=",
          dateTo: "2011-12-31",
          perPage: 2,
        }),
        [],
      );
      assert.deepEqual(
        page.items.map((item) => item.reference.id),
        [uuid(3)],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
      assert.equal(page.hasMore, false);
      assert.equal(inputs.length, 2);
      if (type === "movie") {
        assert.equal(inputs[0]!.date, "2011-01-01");
        assert.equal(inputs[0]!.date_operation, ">=");
      } else {
        assert.deepEqual(inputs[0]!.date, {
          value: "2010-12-31",
          modifier: "GREATER_THAN",
        });
      }
    });
  });

  test(`range scan order ${type} does not infer exhaustion from a missing terminal date`, async () => {
    const scenes = {
      count: 4,
      rows: [
        stashRow(uuid(1), "First", "2011-12-31"),
        stashRow(uuid(9), "Undated", "garbage"),
      ],
    };
    await runBrowse(
      scriptedUpstream({
        tagRows: [],
        moviePages: [
          {
            rows: [
              tpdbRow(uuid(1), "First", "2011-12-31"),
              tpdbRow(uuid(9), "Undated", "garbage"),
            ],
            next: "next",
            total: 4,
          },
          {
            rows: [
              tpdbRow(uuid(2), "Last", "2011-01-01"),
              tpdbRow(uuid(3), "Outside", "2010-12-31"),
            ],
            next: null,
            total: 4,
          },
        ],
        scenes,
        onScenesRequest: (input) => {
          if (input.page === 2) {
            scenes.rows = [
              stashRow(uuid(2), "Last", "2011-01-01"),
              stashRow(uuid(3), "Outside", "2010-12-31"),
            ];
          }
        },
      }),
      async () => {
        const page = await browseTitles(
          planQuery({
            type,
            date: "2011-01-01",
            dateOperation: ">=",
            dateTo: "2011-12-31",
            perPage: 2,
            page: 2,
          }),
          [],
        );
        assert.deepEqual(page.items, []);
        assert.equal(page.totalCountKnown, true);
        assert.equal(page.total, 2);
        assert.equal(page.hasMore, false);
      },
    );
  });
}

// --- or-groups and entities at the fixture level ---

test("StashDB receives one performers criterion: INCLUDES_ALL in all mode, INCLUDES in any mode", async () => {
  const P1 = uuid(1);
  const P2 = uuid(6);
  const sceneInputs: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: {
        count: 1,
        rows: [stashRow(uuid(3), "Their Scene", "2024-03-03")],
      },
      onScenesRequest: (input) => sceneInputs.push(input),
    }),
    async () => {
      const allMode = await browseTitles(
        planQuery({
          type: "scene",
          performers: [
            { stashdb: P1, name: "Jane" },
            { stashdb: P2, name: "Dee" },
          ],
        }),
        [],
      );
      assert.equal(allMode.items.length, 1);
      const anyMode = await browseTitles(
        planQuery({
          type: "scene",
          performerMode: "any",
          performers: [{ stashdb: P1 }, { stashdb: P2 }],
        }),
        [],
      );
      assert.equal(anyMode.items.length, 1);
    },
  );
  assert.deepEqual(sceneInputs[0]!.performers, {
    value: [P1, P2],
    modifier: "INCLUDES_ALL",
  });
  assert.deepEqual(sceneInputs[1]!.performers, {
    value: [P1, P2],
    modifier: "INCLUDES",
  });
});

test("TPDB all-mode filmography keeps only movies crediting every performer", async () => {
  const P1 = uuid(1);
  const P2 = uuid(2);
  const urls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [
            tpdbRow(
              uuid(10),
              "Both Credit",
              "2024-01-01",
              [],
              [
                { id: P1, name: "Jane" },
                { id: P2, name: "Dee" },
              ],
            ),
            tpdbRow(
              uuid(11),
              "Only First",
              "2023-01-01",
              [],
              [{ id: P1, name: "Jane" }],
            ),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, _qs, url) => urls.push(url),
    }),
    async () => {
      // All mode: the route pages ONE performer's list and the visible
      // predicate re-checks the other entries in the rows' credits.
      const page = await browseTitles(
        planQuery({
          type: "movie",
          performers: [{ tpdb: P1 }, { tpdb: P2 }],
        }),
        [],
      );
      assert.match(urls[0]!, new RegExp(`/performers/${P1}/movies`));
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Both Credit"],
      );
      // The upstream list is not AND-ed, so totals degrade to
      // exhaustion-exact over the rows the credits re-check admitted —
      // "Only First" was read upstream and dropped locally.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 1);
    },
  );
});

test("TPDB any-mode filmographies concatenate deduped: a shared movie stays at its first place", async () => {
  const P1 = uuid(1);
  const P2 = uuid(2);
  const SHARED = uuid(9);
  const urls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [
            tpdbRow(
              uuid(10),
              "First Film",
              "2024-02-01",
              [],
              [{ id: P1, name: "Jane" }],
            ),
            tpdbRow(
              SHARED,
              "Shared Movie",
              "2024-01-01",
              [],
              [{ id: P1, name: "Jane" }],
            ),
          ],
          next: null,
          total: 2,
        },
        {
          rows: [
            tpdbRow(
              uuid(20),
              "Second Film",
              "2023-06-01",
              [],
              [{ id: P2, name: "Dee" }],
            ),
            tpdbRow(
              SHARED,
              "Shared Movie",
              "2024-01-01",
              [],
              [{ id: P2, name: "Dee" }],
            ),
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
        planQuery({
          type: "movie",
          performerMode: "any",
          performers: [{ tpdb: P1 }, { tpdb: P2 }],
        }),
        [],
      );
      // Both filmographies ran, in entry order, and the shared movie
      // appears once — at its first place (the first entry's list).
      assert.deepEqual(
        urls.map((u) => (u.match(/performers\/([^/]+)\/movies/) ?? [])[1]),
        [P1, P2],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["First Film", "Shared Movie", "Second Film"],
      );
      // Deduped streams count as locally filtered: exact at exhaustion.
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 3);
    },
  );
});

test("two TPDB studios merge two site_id lists in recency order with the summed total", async () => {
  const S1 = uuid(3);
  const S2 = uuid(4);
  const siteIdsSeen: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [tpdbRow(uuid(10), "Older Movie", "2023-06-01")],
          next: null,
          total: 7,
        },
        {
          rows: [tpdbRow(uuid(20), "Newer Movie", "2024-06-01")],
          next: null,
          total: 5,
        },
      ],
      scenes: { count: 0, rows: [] },
      siteIds: { [S1]: 70, [S2]: 80 },
      onMovieRequest: (_page, qs) => siteIdsSeen.push(qs.get("site_id") ?? "?"),
    }),
    async () => {
      const page = await browseTitles(
        planQuery({
          type: "movie",
          studios: [{ tpdb: S1 }, { tpdb: S2 }],
        }),
        [],
      );
      // One site_id request per entry, in entry order; the slug never rides.
      assert.deepEqual(siteIdsSeen, ["70", "80"]);
      // The lists are disjoint, so the recency merge interleaves them and
      // the provider totals sum exactly.
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Newer Movie", "Older Movie"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 12);
    },
  );
});

test("withChildren with two StashDB studios sends two parentStudio searches and dedupes", async () => {
  const St1 = uuid(4);
  const St2 = uuid(5);
  const sceneInputs: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(30), "Child Scene", "2024-05-01"),
          stashRow(uuid(31), "Second Scene", "2024-04-01"),
        ],
      },
      onScenesRequest: (input) => sceneInputs.push(input),
    }),
    async () => {
      // Both searches return the same rows (the fixture network is one
      // studio family), so the merge sees each scene twice and keeps the
      // first occurrence.
      const page = await browseTitles(
        planQuery({
          type: "scene",
          studios: [{ stashdb: St1 }, { stashdb: St2 }],
          studioMode: "withChildren",
        }),
        [],
      );
      assert.deepEqual(
        sceneInputs.map((input) => input.parentStudio),
        [St1, St2],
      );
      for (const input of sceneInputs) {
        assert.equal(input.studios, undefined, "exact union never rides");
      }
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Child Scene", "Second Scene"],
      );
      assert.equal(page.totalCountKnown, true);
      assert.equal(page.total, 2);
    },
  );
});

test("a descending year range sends the native upper date bound; a lone TPDB year stays native", async () => {
  const movieUrls: string[] = [];
  const sceneInputs: Record<string, unknown>[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(10), "First-Year Movie", "2019-06-01"),
            tpdbRow(uuid(11), "Inside Movie", "2020-06-01"),
            tpdbRow(uuid(12), "Upper Movie", "2021-06-01"),
            tpdbRow(uuid(13), "Late Movie", "2022-06-01"),
            tpdbRow(uuid(14), "Early Movie", "2018-12-31"),
          ],
          next: null,
          total: 5,
        },
        // The second page serves the second browse (each browse reads one
        // page; the scripted upstream hands pages out in request order).
        {
          rows: [
            tpdbRow(uuid(11), "Inside Movie", "2020-06-01"),
            tpdbRow(uuid(13), "Late Movie", "2022-06-01"),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 2,
        rows: [
          stashRow(uuid(30), "Inside Scene", "2020-03-03"),
          stashRow(uuid(31), "Late Scene", "2022-03-03"),
        ],
      },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
      onScenesRequest: (input) => sceneInputs.push(input),
    }),
    async () => {
      const ranged = await browseTitles(
        planQuery({ year: 2019, yearTo: 2021 }),
        [],
      );
      // Deliberate flip: newest-first scans send the upper date bound.
      // TPDB's exact-year filter must not clip a multi-year window.
      assert.match(movieUrls[0]!, /date=2021-12-31/);
      assert.match(movieUrls[0]!, /date_operation=%3C%3D/);
      assert.doesNotMatch(movieUrls[0]!, /year=/);
      assert.deepEqual(sceneInputs[0]!.date, {
        value: "2022-01-01",
        modifier: "LESS_THAN",
      });
      // Both local year bounds exclude early and late rows.
      assert.deepEqual(ranged.items.map((d) => d.title).sort(), [
        "First-Year Movie",
        "Inside Movie",
        "Inside Scene",
        "Upper Movie",
      ]);
      assert.equal(ranged.totalCountKnown, true);
      assert.equal(ranged.total, 4);

      // TPDB keeps its native exact-year filter. This fixture ignores it.
      // StashDB sends an upper date bound and checks the year locally.
      movieUrls.length = 0;
      const lone = await browseTitles(planQuery({ year: 2020 }), []);
      assert.match(movieUrls[0]!, /year=2020/);
      assert.doesNotMatch(movieUrls[0]!, /date=/);
      assert.deepEqual(sceneInputs[1]!.date, {
        value: "2021-01-01",
        modifier: "LESS_THAN",
      });
      assert.deepEqual(lone.items.map((d) => d.title).sort(), [
        "Inside Movie",
        "Inside Scene",
        "Late Movie",
      ]);
      assert.equal(lone.totalCountKnown, true);
      assert.equal(lone.total, 3);
    },
  );
});

test("an or-group include matches either member, ANDs with plains, and drops matchless titles", async () => {
  const A = { id: 11, uuid: uuid(101), name: "Blonde" };
  const B = { id: 12, uuid: uuid(102), name: "Redhead" };
  const C = { id: 13, uuid: uuid(103), name: "Lesbian" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [A, B, C],
      moviePages: [
        {
          rows: [
            tpdbRow(uuid(10), "Blonde And Lesbian", "2024-03-01", [A, C]),
            tpdbRow(uuid(11), "Redhead Only", "2024-02-01", [B]),
            tpdbRow(uuid(12), "Lesbian Only", "2024-01-01", [C]),
            tpdbRow(uuid(13), "Untagged", "2023-01-01"),
          ],
          next: null,
          total: 4,
        },
        // The second and third pages serve the second browse's fan-out
        // streams: the or-group beside the anchored plain fans out into
        // one all-of stream per member (C∧A, then C∧B), so each scripted
        // page models what its stream's native criterion really returns.
        {
          rows: [tpdbRow(uuid(10), "Blonde And Lesbian", "2024-03-01", [A, C])],
          next: null,
          total: 1,
        },
        {
          rows: [
            tpdbRow(uuid(14), "Redhead And Lesbian", "2023-12-01", [B, C]),
          ],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      // The or-group alone: one or-term rides the native any-of criterion
      // exactly (no local re-check needed), so the URL carries tags[..] for
      // both members and never tag_and. The fixture ignores tag params, so
      // all rows surface — the page is as exact as the native criterion.
      const either = await browseTitles(
        planQuery({
          type: "movie",
          include: [
            [
              { name: A.name, tpdb: A.uuid },
              { name: B.name, tpdb: B.uuid },
            ],
          ],
        }),
        [],
      );
      // The any-of criterion carries the rows' numeric tag keys (11, 12),
      // learned from the published tag listing.
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[0]!, /tags%5B12%5D=1|tags\[12\]=1/);
      assert.doesNotMatch(movieUrls[0]!, /tag_and/);
      assert.deepEqual(either.items.map((d) => d.title).sort(), [
        "Blonde And Lesbian",
        "Lesbian Only",
        "Redhead Only",
        "Untagged",
      ]);
      assert.equal(either.totalCountKnown, true);
      assert.equal(either.total, 4);
      // Group + plain AND together: the or-group beside an anchored plain
      // now fans out into one all-of stream per member (C∧A, C∧B) instead
      // of re-checking the group locally. The matchless titles ("Lesbian
      // Only", "Untagged") never surface because the scripted pages model
      // what the native criteria actually return — and the C-only or
      // untagged rows never ride a C∧A or C∧B listing.
      const both = await browseTitles(
        planQuery({
          type: "movie",
          include: [
            [
              { name: A.name, tpdb: A.uuid },
              { name: B.name, tpdb: B.uuid },
            ],
            { name: C.name, tpdb: C.uuid },
          ],
        }),
        [],
      );
      // One row per fan-out stream; the ordered merge sorts them by
      // recency. Totals stay exhaustion-exact: fan-out streams mark
      // themselves locally filtered (the streams' lists overlap in
      // principle), so the count is the consumed rows, and both streams
      // exhausted with empty buffers.
      assert.deepEqual(both.items.map((d) => d.title).sort(), [
        "Blonde And Lesbian",
        "Redhead And Lesbian",
      ]);
      assert.equal(both.totalCountKnown, true);
      assert.equal(both.total, 2);
      // Each fan-out stream carries the plain in its native all-of
      // criterion (tag_and) beside its own group member: stream 1 = C∧A,
      // stream 2 = C∧B.
      assert.match(movieUrls[1]!, /tag_and=1/);
      assert.match(movieUrls[1]!, /tags%5B13%5D=1|tags\[13\]=1/);
      assert.match(movieUrls[1]!, /tags%5B11%5D=1|tags\[11\]=1/);
      assert.match(movieUrls[2]!, /tag_and=1/);
      assert.match(movieUrls[2]!, /tags%5B13%5D=1|tags\[13\]=1/);
      assert.match(movieUrls[2]!, /tags%5B12%5D=1|tags\[12\]=1/);
    },
  );
});

test("an or-group whose other member is absent on a side still matches by its present member", async () => {
  // The grounded describe repair builds groups like TPDB "Anal" or StashDB
  // "Anal Sex": the StashDB-only member has no TPDB label, which must add
  // nothing on TPDB, never mark the whole TPDB side as "cannot match".
  const A = { id: 11, uuid: uuid(101), name: "Anal" };
  const movieUrls: string[] = [];
  await runBrowse(
    scriptedUpstream({
      tagRows: [A],
      moviePages: [
        {
          rows: [tpdbRow(uuid(10), "Anal Movie", "2024-03-01", [A])],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      onMovieRequest: (_page, qs) => movieUrls.push(qs.toString()),
    }),
    async () => {
      const page = await browseTitles(
        planQuery({
          type: "movie",
          include: [
            [
              { name: A.name, tpdb: A.uuid },
              { name: "Anal Sex", stashdb: uuid(202) },
            ],
          ],
        }),
        [],
      );
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Anal Movie"],
      );
      // The present member travels natively.
      assert.match(movieUrls[0]!, /tags%5B11%5D=1|tags\[11\]=1/);
    },
  );
});

test("notices name the sources an entity filter skips or narrows, per tab", async () => {
  const stashOnlyPerformer = { stashdb: uuid(6), name: "Scene Only" };
  const sceneInputs: Record<string, unknown>[] = [];
  let movieCalls = 0;
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [],
      scenes: {
        count: 1,
        rows: [stashRow(uuid(30), "Their Scene", "2024-03-03")],
      },
      onScenesRequest: (input) => sceneInputs.push(input),
      onMovieRequest: () => {
        movieCalls += 1;
      },
    }),
    async () => {
      // All tab, all mode, a stashdb-only performer: TPDB cannot know her,
      // so it runs nothing and the page says so; StashDB runs her scenes.
      const page = await browseTitles(
        planQuery({ performers: [stashOnlyPerformer] }),
        [],
      );
      assert.deepEqual(page.notices, [
        {
          provider: "tpdb",
          kind: "performer",
          code: "not_searched",
          entries: [stashOnlyPerformer],
        },
      ]);
      assert.deepEqual(page.errors, []);
      assert.deepEqual(
        page.items.map((d) => d.title),
        ["Their Scene"],
      );
      assert.equal(movieCalls, 0, "the skipped source never reads upstream");

      // Movies tab: only the TPDB side is judged — no stashdb notice.
      const movies = await browseTitles(
        planQuery({ type: "movie", performers: [stashOnlyPerformer] }),
        [],
      );
      assert.equal(movies.notices.length, 1);
      assert.equal(movies.notices[0]!.provider, "tpdb");
      assert.equal(movies.notices[0]!.code, "not_searched");

      // Any mode with a tpdb-known and a stashdb-only studio: both sources
      // run with the entries they know, each naming the other one.
      const mixed = await browseTitles(
        planQuery({
          type: "scene",
          performerMode: "any",
          studios: [
            { tpdb: uuid(3), name: "Movie Studio" },
            { stashdb: uuid(4) },
          ],
        }),
        [],
      );
      const stashNotice = mixed.notices.find(
        (n) => n.provider === "stashdb" && n.kind === "studio",
      );
      assert.deepEqual(stashNotice, {
        provider: "stashdb",
        kind: "studio",
        code: "not_included",
        entries: [{ tpdb: uuid(3), name: "Movie Studio" }],
      });

      // The old one-id URL on All consolidates to one entry: StashDB
      // cannot know the TPDB id, so it is not_searched; the TPDB side
      // runs her filmography.
      const oldUrl = parseBrowseQuery(
        new URLSearchParams(`performerTpdb=${uuid(1)}`),
      );
      const oldPage = await browseTitles(oldUrl, []);
      assert.deepEqual(oldPage.notices, [
        {
          provider: "stashdb",
          kind: "performer",
          code: "not_searched",
          entries: oldUrl.performers,
        },
      ]);
    },
  );
  assert.ok(sceneInputs.length > 0);
});

test("notices never ride inside errors: a real outage beside a notice stays one story each", async () => {
  await runBrowse(
    scriptedUpstream({
      tagRows: [],
      moviePages: [
        {
          rows: [tpdbRow(uuid(10), "Studio Movie", "2024-01-01")],
          next: null,
          total: 1,
        },
      ],
      scenes: { count: 0, rows: [] },
      siteIds: { [uuid(3)]: 70 },
      stashStatus: 500,
    }),
    async () => {
      // Any mode: the TPDB side runs its studio; the StashDB side is down
      // AND carries an entry it does not know. The page keeps the outage
      // in errors and the narrowing in notices.
      const page = await browseTitles(
        planQuery({
          performerMode: "any",
          studios: [{ tpdb: uuid(3) }, { stashdb: uuid(4) }],
        }),
        [],
      );
      assert.equal(page.errors.length, 1);
      assert.equal(page.errors[0]!.provider, "stashdb");
      const err = page.errors[0] as unknown as Record<string, unknown>;
      assert.equal("kind" in err, false);
      assert.equal("entries" in err, false);
      assert.ok(
        page.notices.some(
          (n) => n.provider === "stashdb" && n.code === "not_included",
        ),
        "the narrowing note stays a notice",
      );
    },
  );
});

test("old one-id URLs and flat include arrays give the same items and totals as the new keys", async () => {
  const A = { id: 11, uuid: uuid(101), name: "Alpha" };
  const B = { id: 12, uuid: uuid(102), name: "Beta" };
  const P = uuid(1);
  const S = uuid(6);
  const movieTitles = (page: BrowsePage) => page.items.map((d) => d.title);
  await runBrowse(
    scriptedUpstream({
      tagRows: [A, B],
      moviePages: [
        {
          rows: [
            tpdbRow(
              uuid(10),
              "Pair Movie",
              "2024-02-01",
              [A, B],
              [{ id: P, name: "Jane" }],
            ),
            tpdbRow(
              uuid(11),
              "Alpha Movie",
              "2024-01-01",
              [A],
              [{ id: P, name: "Jane" }],
            ),
          ],
          next: null,
          total: 2,
        },
        // The three browses below each read one page; the scripted upstream
        // hands pages out in request order, so the fixture repeats the page.
        {
          rows: [
            tpdbRow(
              uuid(10),
              "Pair Movie",
              "2024-02-01",
              [A, B],
              [{ id: P, name: "Jane" }],
            ),
            tpdbRow(
              uuid(11),
              "Alpha Movie",
              "2024-01-01",
              [A],
              [{ id: P, name: "Jane" }],
            ),
          ],
          next: null,
          total: 2,
        },
        {
          rows: [
            tpdbRow(
              uuid(10),
              "Pair Movie",
              "2024-02-01",
              [A, B],
              [{ id: P, name: "Jane" }],
            ),
            tpdbRow(
              uuid(11),
              "Alpha Movie",
              "2024-01-01",
              [A],
              [{ id: P, name: "Jane" }],
            ),
          ],
          next: null,
          total: 2,
        },
      ],
      scenes: {
        count: 1,
        rows: [stashRow(uuid(30), "Pair Scene", "2024-03-03")],
      },
    }),
    async () => {
      // Old scalar performer pair vs new unified entry: same items, totals.
      const oldQuery = parseBrowseQuery(
        new URLSearchParams(`performerTpdb=${P}&performerStashdb=${S}`),
      );
      const newQuery = parseBrowseQuery(
        new URLSearchParams({
          performers: JSON.stringify([{ tpdb: P, stashdb: S }]),
        }),
      );
      assert.deepEqual(newQuery.performers, oldQuery.performers);
      const oldPage = await browseTitles(oldQuery, []);
      const newPage = await browseTitles(newQuery, []);
      assert.deepEqual(movieTitles(oldPage), movieTitles(newPage));
      assert.equal(oldPage.total, newPage.total);
      assert.equal(oldPage.totalCountKnown, newPage.totalCountKnown);
      assert.deepEqual(newPage.notices, oldPage.notices);

      // Old scalar studio pair vs new unified studio entry: same shape.
      const oldStudios = parseBrowseQuery(
        new URLSearchParams(`studioTpdb=${uuid(3)}&studioStashdb=${S}`),
      );
      const newStudios = parseBrowseQuery(
        new URLSearchParams({
          studios: JSON.stringify([{ tpdb: uuid(3), stashdb: S }]),
        }),
      );
      assert.deepEqual(newStudios.studios, oldStudios.studios);

      // A flat include array still parses to plains that AND together —
      // the group syntax added a term shape, never changed the flat one.
      // Both anchored plains ride the native all-of criterion (the fixture
      // ignores tag params, so both rows surface locally unfiltered).
      const flat = parseBrowseQuery(
        new URLSearchParams({
          type: "movie",
          include: JSON.stringify([
            { name: A.name, tpdb: A.uuid },
            { name: B.name, tpdb: B.uuid },
          ]),
        }),
      );
      assert.ok(flat.include.every((term) => !Array.isArray(term)));
      const flatPage = await browseTitles(flat, []);
      assert.deepEqual(flatPage.items.map((d) => d.title).sort(), [
        "Alpha Movie",
        "Pair Movie",
      ]);
      assert.equal(flatPage.totalCountKnown, true);
      assert.equal(flatPage.total, 2);
    },
  );
});

// --- properties: the new parsers at the trust boundary (fast-check,
// fixed seed, fixed run count — CI-stable) ---

const entityArb = fc.record({
  name: fc.option(fc.string({ maxLength: 150 }), { nil: undefined }),
  tpdb: fc.option(
    fc.oneof(
      fc.uuid(),
      fc.constant("evil-angel"),
      fc.constant("not a uuid"),
      fc.constant(""),
    ),
    { nil: undefined },
  ),
  stashdb: fc.option(fc.oneof(fc.uuid(), fc.constant("junk-id")), {
    nil: undefined,
  }),
});

test("property: the entity parser returns 400 or entries inside the caps (seed 42)", () => {
  const paramArb = fc.oneof(
    // Structured-ish entries: the parser's shape rules are under test.
    fc.array(entityArb, { maxLength: MAX_BROWSE_ENTITIES + 2 }),
    // Raw junk that never parses as the pinned shape.
    fc.jsonValue().map((v) => JSON.stringify(v)),
    fc.constant("not json at all"),
    fc.constant("[]"),
  );
  fc.assert(
    fc.property(
      fc.constantFrom("performers", "studios"),
      paramArb,
      (key, raw) => {
        const params = new URLSearchParams();
        if (typeof raw === "string") params.set(key, raw);
        else params.set(key, JSON.stringify(raw));
        try {
          const query = parseBrowseQuery(params);
          const entries =
            key === "performers" ? query.performers : query.studios;
          assert.ok(
            entries.length >= 0 && entries.length <= MAX_BROWSE_ENTITIES,
            `${key} length inside the cap`,
          );
          for (const entry of entries) {
            assert.ok(
              entry.tpdb !== undefined || entry.stashdb !== undefined,
              "every parsed entry carries an id",
            );
            if (entry.name !== undefined) {
              assert.ok(
                entry.name.length >= 1 && entry.name.length <= 120,
                "parsed name is trimmed into 1..120",
              );
            }
            if (entry.tpdb !== undefined) {
              assert.equal(entry.tpdb, entry.tpdb.toLowerCase());
              assert.match(
                entry.tpdb,
                /^[0-9a-f-]{36}$|^[a-z0-9][a-z0-9-]{0,63}$/,
              );
            }
            if (entry.stashdb !== undefined) {
              assert.equal(entry.stashdb, entry.stashdb.toLowerCase());
              assert.match(entry.stashdb, /^[0-9a-f-]{36}$/);
            }
          }
        } catch (err) {
          // The parser is total: every refusal is the pinned 400 family.
          assert.ok(
            err instanceof AppError && err.status === 400,
            `expected a 400 AppError, got ${String(err)}`,
          );
        }
      },
    ),
    { seed: 42, numRuns: 150 },
  );
});

test("property: parseIncludeSelections normalizes groups or refuses with invalid_preferences (seed 42)", () => {
  // Labels stay letter/digit so the folded label is the identity and the
  // comparisons measure parsing, not normalization; punctuation-only labels
  // are generated separately and must always refuse.
  const selectionArb = fc.record({
    name: fc.stringMatching(/^[a-z0-9]{1,12}$/),
    tpdb: fc.option(fc.uuid(), { nil: undefined }),
    stashdb: fc.option(fc.uuid(), { nil: undefined }),
  });
  const elementArb = fc.oneof(
    selectionArb,
    fc.array(selectionArb, { minLength: 1, maxLength: 4 }),
  );
  fc.assert(
    fc.property(fc.array(elementArb, { maxLength: 12 }), (input) => {
      try {
        const out = parseIncludeSelections(input);
        let count = 0;
        const plainLabels = new Set<string>();
        for (const term of out) {
          if (Array.isArray(term)) {
            // A survivor group has 2+ members, each a valid selection, and
            // no two groups share the member-label set.
            assert.ok(term.length >= 2, "groups keep at least two members");
            count += term.length;
          } else {
            count += 1;
            assert.ok(
              !plainLabels.has(term.name),
              `plain labels are unique: ${term.name}`,
            );
            plainLabels.add(term.name);
          }
        }
        assert.ok(count <= 25, `selection cap counted ${count}`);
        // A 1-member group always surfaces as a plain selection.
        for (const raw of input) {
          if (
            Array.isArray(raw) &&
            raw.length === 1 &&
            !plainLabels.has(raw[0]!.name)
          ) {
            // It may also have been consolidated away by label-collision;
            // then some plain with that label exists.
            assert.ok(
              out.some(
                (t) => !Array.isArray(t) && t.name === raw[0]!.name.trim(),
              ) || plainLabels.size === 0,
              "1-member groups unwrap to plains",
            );
          }
        }
      } catch (err) {
        assert.ok(
          err instanceof AppError &&
            err.status === 400 &&
            err.code === "invalid_preferences",
          `expected invalid_preferences, got ${String(err)}`,
        );
      }
    }),
    { seed: 42, numRuns: 150 },
  );
  // Punctuation-only labels inside a valid group still refuse: the group's
  // own parseTagSelections call is the same boundary.
  assert.throws(
    () => parseIncludeSelections([[{ name: "++" }]]),
    appError(400, "invalid_preferences"),
  );
});

test("property: entity and include queries round-trip through the URL form (seed 42)", () => {
  type Entity = {
    name?: string;
    tpdb?: string;
    stashdb?: string;
  };
  // Entries with per-side unique ids: the duplicate-id refusal is a
  // different pin (tested above), so the round trip never hits it. Each
  // entry draws fresh ids from per-side pools sized to the entry count, so
  // no side ever repeats.
  const distinctEntities = (kind: "performer" | "studio") =>
    fc.nat(MAX_BROWSE_ENTITIES - 1).chain((extra) => {
      const n = 1 + extra;
      const tpdbId = fc.uniqueArray(
        kind === "studio"
          ? fc.oneof(fc.uuid(), fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/))
          : fc.uuid(),
        { minLength: n, maxLength: n },
      );
      const stashId = fc.uniqueArray(fc.uuid(), {
        minLength: n,
        maxLength: n,
      });
      const shapes = fc.array(fc.constantFrom("tpdb", "stashdb", "both"), {
        minLength: n,
        maxLength: n,
      });
      const names = fc.array(
        fc.option(fc.stringMatching(/^[a-z0-9]{1,20}$/), { nil: undefined }),
        { minLength: n, maxLength: n },
      );
      return fc
        .tuple(tpdbId, stashId, shapes, names)
        .map(([tpdbIds, stashIds, shapes, names]): Entity[] => {
          let ti = 0;
          let si = 0;
          const entries: Entity[] = [];
          for (let i = 0; i < n; i++) {
            const entry: Entity = {};
            if (names[i] !== undefined) entry.name = names[i];
            if (shapes[i] !== "stashdb") entry.tpdb = tpdbIds[ti++];
            if (shapes[i] !== "tpdb") entry.stashdb = stashIds[si++];
            entries.push(entry);
          }
          return entries;
        });
    });
  // Include terms drawn from one label pool, each label used at most once:
  // plains stay label-unique, groups never share a label set (the collapse
  // rule would drop a term and break the 1:1 input oracle), and every
  // group carries 2-3 members (a 1-member group unwraps to a plain).
  type Term = Entity | Entity[];
  const includeArb = fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,10}$/), {
      minLength: 1,
      maxLength: 11,
    })
    .chain((labels) =>
      fc
        .array(fc.nat(2), { minLength: 1, maxLength: labels.length })
        .map((sizes): Term[] => {
          const terms: Term[] = [];
          let i = 0;
          for (const size of sizes) {
            if (i >= labels.length) break;
            const take = Math.min(size + 1, labels.length - i);
            const members = labels.slice(i, i + take).map((name) => ({
              name,
            }));
            i += take;
            terms.push(take === 1 ? members[0]! : members);
          }
          return terms;
        }),
    );
  fc.assert(
    fc.property(
      distinctEntities("performer"),
      distinctEntities("studio"),
      includeArb,
      fc.option(fc.constantFrom("all", "any"), { nil: undefined }),
      fc.option(
        fc.tuple(
          fc.integer({ min: 1900, max: 2100 }),
          fc.integer({ min: 1900, max: 2100 }),
        ),
        { nil: undefined },
      ),
      (performers, studios, include, performerMode, years) => {
        const params = new URLSearchParams();
        params.set("performers", JSON.stringify(performers));
        params.set("studios", JSON.stringify(studios));
        if (include.length > 0) params.set("include", JSON.stringify(include));
        if (performerMode !== undefined)
          params.set("performerMode", performerMode);
        if (years !== undefined) {
          const [from, to] = years;
          params.set("year", String(Math.min(from, to)));
          params.set("yearTo", String(Math.max(from, to)));
        }
        const p1 = parseBrowseQuery(params);
        // Input oracle: the parse carries the generated shape verbatim.
        // Generated values are plain-keyed (JSON.stringify drops undefined
        // fields) and lowercase, exactly what the parser emits.
        const plainEntity = (e: Entity): Entity => ({
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.tpdb !== undefined ? { tpdb: e.tpdb } : {}),
          ...(e.stashdb !== undefined ? { stashdb: e.stashdb } : {}),
        });
        assert.deepEqual(p1.performers, performers.map(plainEntity));
        assert.deepEqual(p1.studios, studios.map(plainEntity));
        assert.deepEqual(
          p1.include,
          // The parser emits plains first (consolidated), then groups —
          // order each section as generated.
          [
            ...include
              .filter((t): t is Entity => !Array.isArray(t))
              .map((t) => ({
                name: t.name,
                tpdb: t.tpdb,
                stashdb: t.stashdb,
              })),
            ...include
              .filter((t): t is Entity[] => Array.isArray(t))
              .map((t) =>
                t.map((s) => ({
                  name: s.name,
                  tpdb: s.tpdb,
                  stashdb: s.stashdb,
                })),
              ),
          ],
        );
        // Canonical serialization: only the keys that ride the wire.
        const out = new URLSearchParams();
        out.set("performers", JSON.stringify(p1.performers));
        out.set("studios", JSON.stringify(p1.studios));
        if (p1.include.length > 0)
          out.set("include", JSON.stringify(p1.include));
        if (p1.performerMode === "any") out.set("performerMode", "any");
        if (p1.year !== undefined) out.set("year", String(p1.year));
        if (p1.yearTo !== undefined) out.set("yearTo", String(p1.yearTo));
        const p2 = parseBrowseQuery(out);
        // fast-check records are null-prototype; compare through JSON.
        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(p2)),
          JSON.parse(JSON.stringify(p1)),
        );
      },
    ),
    { seed: 42, numRuns: 150 },
  );
});
