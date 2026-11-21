import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import packageJson from "../package.json" with { type: "json" };

import {
  AppError,
  createStashdbRateLimit,
  requestBytes,
  requestJsonBytes,
  upstreamCheckError,
} from "../src/server/http.ts";

const REQUESTS = 200;
// Keep-alive leaves at most the in-flight socket plus a freshly opened
// replacement open; a leaked unread body pins one socket per request.
const BOUNDED = 3;

function neverEndingErrorServer(): Promise<Server> {
  const { promise, resolve } = Promise.withResolvers<Server>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.write("x".repeat(65536));
    // Deliberately never end(): the error body stays open, like a
    // wedged upstream.
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
  return promise;
}

function mismatchedTypeServer(): Promise<Server> {
  const { promise, resolve } = Promise.withResolvers<Server>();
  const server: Server = createServer((_req, res) => {
    // 200 OK with a non-JSON body that never ends: trips the content-type
    // guard, whose throw abandons the body unread mid-stream.
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("not json");
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
  return promise;
}

function openConnections(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.getConnections((err, n) => (err ? reject(err) : resolve(n)));
  return promise;
}

// Socket teardown is a real OS event that fake timers cannot drive, so the
// steady-state count is polled until it settles (immediately when the bodies
// are released) instead of sleeping a guessed duration.
async function settledOpen(server: Server): Promise<number> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const open = await openConnections(server);
    if (open <= BOUNDED || Date.now() > deadline) return open;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function track(server: Server, t: { after: (fn: () => void) => unknown }) {
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
}

test("unread error bodies keep no sockets open after repeated 500s", async (t) => {
  const server = await neverEndingErrorServer();
  track(server, t);
  const addr = server.address() as AddressInfo;
  const token = "test-token";
  const codes = new Set<string>();
  for (let i = 0; i < REQUESTS; i++) {
    try {
      await requestJsonBytes(`http://127.0.0.1:${addr.port}`, "/x", token);
      assert.fail("request should have thrown");
    } catch (err) {
      assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
      codes.add(err.code);
    }
  }
  assert.deepEqual([...codes], ["upstream_unavailable"]);
  const open = await settledOpen(server);
  assert.ok(
    open <= BOUNDED,
    `${open} sockets still open after ${REQUESTS} error responses; body cancel is missing`,
  );
});

test("an unexpected content type keeps no sockets open when repeated", async (t) => {
  const server = await mismatchedTypeServer();
  track(server, t);
  const addr = server.address() as AddressInfo;
  const token = "test-token";
  const codes = new Set<string>();
  for (let i = 0; i < REQUESTS; i++) {
    try {
      await requestJsonBytes(`http://127.0.0.1:${addr.port}`, "/x", token);
      assert.fail("request should have thrown");
    } catch (err) {
      assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
      codes.add(err.code);
    }
  }
  assert.deepEqual([...codes], ["upstream_bad_response"]);
  const open = await settledOpen(server);
  assert.ok(
    open <= BOUNDED,
    `${open} sockets still open after ${REQUESTS} content-type rejections; body cancel is missing`,
  );
});

test("provider API and artwork requests identify the current Velvarr version", async (t) => {
  const seen: { ua: string | undefined; hasKey: boolean }[] = [];
  const { promise, resolve } = Promise.withResolvers<Server>();
  const server: Server = createServer((req, res) => {
    seen.push({
      ua: req.headers["user-agent"],
      hasKey: req.headers.apikey !== undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
  await promise;
  track(server, t);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const service of ["stashdb", "tpdb"] as const) {
    await requestJsonBytes(base, "/graphql", "test-api-key", { service });
    await requestBytes(base, "/images/fixture", "", { service });
  }
  const ua = `Velvarr/${packageJson.version} (+https://github.com/Skare69/velvarr)`;
  assert.deepEqual(seen, [
    { ua, hasKey: true },
    { ua, hasKey: false },
    { ua, hasKey: false },
    { ua, hasKey: false },
  ]);
});

function rateLimited(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.status, 503);
  assert.equal(error.code, "upstream_rate_limited");
  assert.equal(error.upstreamStatus, undefined);
  assert.deepEqual(upstreamCheckError(error), {
    code: error.code,
    message: error.message,
  });
  return true;
}

test("public StashDB API and artwork share a budget across credentials", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    sent.push(url.hostname);
    return new Response("{}", {
      status: url.pathname === "/failure" ? 503 : 200,
      headers: { "content-type": "application/json" },
    });
  });

  // Invalid requests consume no provider budget.
  await assert.rejects(
    requestJsonBytes("https://stashdb.org", "/graphql", "bad", {
      service: "stashdb",
    }),
    { code: "invalid_token" },
  );
  const api = () =>
    requestJsonBytes("https://stashdb.org", "/graphql", "test-api-key", {
      service: "stashdb",
    });
  const art = () =>
    requestBytes("https://stashdb.org", "/images/fixture", "", {
      service: "stashdb",
    });
  await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? requestJsonBytes(
            "https://STASHDB.org",
            "/graphql",
            `fixture-key-${i}`,
            {
              service: "stashdb",
            },
          )
        : art(),
    ),
  );
  await assert.rejects(api(), rateLimited);
  await assert.rejects(art(), rateLimited);
  assert.equal(sent.length, 60, "blocked requests never reach fetch");

  // The public provider policy does not throttle a private Stash-Box or TPDB.
  for (const base of [
    "http://127.0.0.1:6789",
    "https://private-stash.example",
  ]) {
    for (let i = 0; i < 61; i++) {
      await requestJsonBytes(base, "/graphql", "test-api-key", {
        service: "stashdb",
      });
    }
  }
  await requestJsonBytes(
    "https://api.theporndb.net",
    "/movies",
    "test-api-key",
    {
      service: "tpdb",
    },
  );
  assert.equal(sent.filter((host) => host === "stashdb.org").length, 60);

  clock = 59_999;
  await assert.rejects(api(), rateLimited);
  clock = 60_000;
  // A failed upstream attempt still consumes one dispatch.
  await assert.rejects(
    requestJsonBytes("https://stashdb.org", "/failure", "test-api-key", {
      service: "stashdb",
    }),
    { code: "upstream_unavailable", upstreamStatus: 503 },
  );
  for (let i = 0; i < 59; i++) await api();
  await assert.rejects(api(), rateLimited);
  assert.equal(sent.filter((host) => host === "stashdb.org").length, 120);
});

test("StashDB budget releases each request only at its window boundary", () => {
  let clock = 0;
  const slot = createStashdbRateLimit(() => clock);
  for (let i = 0; i < 30; i++) slot();
  clock = 10_000;
  for (let i = 0; i < 30; i++) slot();
  clock = 59_999;
  assert.throws(slot, rateLimited);
  clock = 60_000;
  for (let i = 0; i < 30; i++) slot();
  assert.throws(slot, rateLimited);
  clock = 69_999;
  assert.throws(slot, rateLimited);
  clock = 70_000;
  for (let i = 0; i < 30; i++) slot();
  assert.throws(slot, rateLimited);
});

test("StashDB rate limit agrees with a rolling-window reference", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 2_000 }), {
        minLength: 100,
        maxLength: 300,
      }),
      (deltas) => {
        let clock = 0;
        const slot = createStashdbRateLimit(() => clock);
        let accepted: number[] = [];
        for (const delta of deltas) {
          clock += delta;
          accepted = accepted.filter((time) => time > clock - 60_000);
          if (accepted.length === 60) {
            assert.throws(slot, rateLimited);
          } else {
            slot();
            accepted.push(clock);
          }
        }
      },
    ),
  );
});
