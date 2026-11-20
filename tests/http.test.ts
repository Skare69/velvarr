import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";

import { AppError, requestJsonBytes } from "../src/server/http.ts";

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
