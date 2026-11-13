// Large-library regressions use synthetic records and loopback fixtures only.
// No operator titles, paths, API keys, or library responses enter these tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findWhisparrItemByPath,
  prefetchWhisparrMovieList,
  resolveIdentitiesByPath,
} from "../src/server/whisparr.ts";
import {
  WH_KEY,
  appError,
  pathOf,
  sendJson,
  whisparrConfig,
  withFixture,
} from "./fixture.ts";

const MIB = 1024 * 1024;
const PATH = "/library/movies/feature-42/movie.mkv";
const identity = (id: number) =>
  `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const REFERENCE = { provider: "tpdb", kind: "movie", id: identity(42) };
const ROWS = Array.from({ length: 2500 }, (_, index) => ({
  id: index + 1,
  itemType: "movie",
  tpdbId: identity(index + 1),
  path: `/library/movies/feature-${index + 1}`,
  // Collection size comes from metadata the path resolver does not need.
  overview: "x".repeat(1024),
}));
const BODY = Buffer.from(JSON.stringify(ROWS));
assert.ok(BODY.byteLength > 2 * MIB && BODY.byteLength < 4 * MIB);

test("large collections resolve details and list items through one shared fetch", async () => {
  await withFixture(
    (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(pathOf(req.url ?? ""), "/api/v3/movie");
      assert.equal(req.headers["x-api-key"], WH_KEY);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(BODY);
    },
    async (fx) => {
      const config = whisparrConfig(fx.origin);
      prefetchWhisparrMovieList(config);
      const [first, second, list] = await Promise.all([
        findWhisparrItemByPath(config, [PATH]),
        findWhisparrItemByPath(config, [PATH]),
        resolveIdentitiesByPath(config, [
          { id: "library-item", paths: [PATH] },
        ]),
      ]);
      assert.deepEqual(first, REFERENCE);
      assert.deepEqual(second, REFERENCE);
      assert.deepEqual(list.get("library-item"), REFERENCE);
      assert.equal(fx.log.length, 1);
    },
  );
});

test("compacting a large collection preserves ambiguous path detection", async () => {
  await withFixture(
    (_req, res) => {
      sendJson(res, 200, [
        ...ROWS,
        {
          ...ROWS[41],
          tpdbId: identity(99999),
          path: "/library/movies/feature-42",
        },
      ]);
    },
    async (fx) => {
      await assert.rejects(
        findWhisparrItemByPath(whisparrConfig(fx.origin), [PATH]),
        appError(409, "ambiguous_identity"),
      );
    },
  );
});

test("compacted records retain both explicit and legacy scene identities", async () => {
  await withFixture(
    (_req, res) =>
      sendJson(res, 200, [
        ...ROWS,
        {
          itemType: "scene",
          stashId: identity(3000),
          path: "/library/scenes/explicit",
        },
        {
          itemType: "scene",
          foreignId: identity(3001),
          tmdbId: 0,
          path: "/library/scenes/legacy",
        },
      ]),
    async (fx) => {
      const config = whisparrConfig(fx.origin);
      for (const [name, id] of [
        ["explicit", 3000],
        ["legacy", 3001],
      ] as const) {
        assert.deepEqual(
          await findWhisparrItemByPath(config, [
            `/library/scenes/${name}/scene.mkv`,
          ]),
          { provider: "stashdb", kind: "scene", id: identity(id) },
        );
      }
      assert.equal(fx.log.length, 1);
    },
  );
});

test("changing credentials cannot reuse another key's cached collection", async () => {
  await withFixture(
    (req, res) => {
      if (req.headers["x-api-key"] !== WH_KEY) return sendJson(res, 401, {});
      sendJson(res, 200, [ROWS[41]]);
    },
    async (fx) => {
      const config = whisparrConfig(fx.origin);
      assert.deepEqual(await findWhisparrItemByPath(config, [PATH]), REFERENCE);
      await assert.rejects(
        findWhisparrItemByPath(
          {
            ...config,
            whisparr: { url: fx.origin, apiKey: "different-key" },
          },
          [PATH],
        ),
        appError(401, "upstream_auth"),
      );
      assert.equal(fx.log.length, 2);
    },
  );
});

// Counts mappedPrefix calls: it walks the configured mappings once per
// Whisparr path it maps, so the count is the number of paths mapped.
class CountedMappings extends Array<{
  whisparrPrefix: string;
  jellyfinPrefix: string;
}> {
  walks = 0;
  override [Symbol.iterator]() {
    this.walks += 1;
    return super[Symbol.iterator]();
  }
}

test("a 50-entry page against a 50 000-title list maps each title once per cached list", async () => {
  const titles = 50_000;
  const rows = Array.from({ length: titles }, (_, index) => ({
    itemType: "movie",
    tpdbId: identity(index + 1),
    path: `/whisparr/movies/feature-${index + 1}`,
  }));
  const page = Array.from({ length: 50 }, (_, index) => {
    const n = index * 997 + 1;
    return {
      id: `item-${n}`,
      paths: [`/library/movies/feature-${n}/movie.mkv`],
    };
  });
  await withFixture(
    (_req, res) => sendJson(res, 200, rows),
    async (fx) => {
      const mappings = new CountedMappings();
      mappings.push({
        whisparrPrefix: "/whisparr/movies",
        jellyfinPrefix: "/library/movies",
      });
      const base = whisparrConfig(fx.origin);
      const config = {
        ...base,
        whisparr: { ...base.whisparr!, pathMappings: mappings },
      };
      // A detail lookup fetches the list and builds the path index.
      assert.equal(
        await findWhisparrItemByPath(config, ["/elsewhere/movie.mkv"]),
        null,
      );
      assert.equal(mappings.walks, titles);

      for (let round = 0; round < 2; round += 1) {
        const started = performance.now();
        const resolved = await resolveIdentitiesByPath(config, page);
        const elapsed = performance.now() - started;
        assert.equal(resolved.size, page.length);
        for (const entry of page) {
          const n = Number(entry.id.slice("item-".length));
          assert.deepEqual(resolved.get(entry.id), {
            provider: "tpdb",
            kind: "movie",
            id: identity(n),
          });
        }
        // Pages reuse the index: no title is mapped again, and a page
        // costs lookups only, never a pass over the whole list.
        assert.equal(mappings.walks, titles);
        assert.ok(elapsed < 1000, `page took ${elapsed.toFixed(0)} ms`);
      }
      assert.equal(fx.log.length, 1);
    },
  );
});
