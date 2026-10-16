import assert from "node:assert/strict";
import { test } from "node:test";

// Import order matters: sw-self.ts installs the fake worker-global self
// before public/sw.js evaluates (the worker registers listeners on `self`
// at load time). Both static — ESM evaluates imports in order.
import "./sw-self.ts";
import "../public/sw.js";

import { deleted, handlers, state, store } from "./sw-self.ts";

const ORIGIN = "https://velvarr.ts.net";

async function drive(request: Request): Promise<Response | undefined> {
  const listener = handlers.fetch;
  if (typeof listener !== "function")
    throw new Error("sw.js registered no fetch listener");
  let responded = false;
  let response: Response | undefined;
  listener({
    request,
    respondWith: (p: Promise<Response>) => {
      responded = true;
      void p.then((r) => {
        response = r;
      });
    },
  });
  const { promise: flushed, resolve: flush } = Promise.withResolvers<void>();
  setImmediate(flush);
  await flushed;
  return responded ? response : undefined;
}

test("service worker caches only same-origin GET /_next/static", async () => {
  const install = handlers.install;
  const activate = handlers.activate;
  if (typeof install !== "function" || typeof activate !== "function") {
    throw new Error("sw.js registered no install/activate listeners");
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    state.fetches += 1;
    return new Response(`chunk-${state.fetches}`);
  };

  try {
    const waits: Promise<unknown>[] = [];
    install({});
    activate({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
    assert.equal(state.skippedWaiting, 1);
    assert.deepEqual(deleted, ["velvarr-shell-v0"]);

    // Outside the gate: POST, /api, cross-origin — browser default applies.
    assert.equal(
      await drive(
        new Request(`${ORIGIN}/_next/static/x.js`, { method: "POST" }),
      ),
      undefined,
    );
    assert.equal(await drive(new Request(`${ORIGIN}/api/requests`)), undefined);
    assert.equal(
      await drive(new Request("https://evil.example/_next/static/x.js")),
      undefined,
    );
    assert.equal(state.fetches, 0);

    // First GET fetches and fills the cache.
    const first = await drive(
      new Request(`${ORIGIN}/_next/static/chunks/main.js`),
    );
    assert.equal(await first?.text(), "chunk-1");
    assert.equal(state.fetches, 1);

    // Second GET is cache-first: same body, no second network call.
    const second = await drive(
      new Request(`${ORIGIN}/_next/static/chunks/main.js`),
    );
    assert.equal(await second?.text(), "chunk-1");
    assert.equal(state.fetches, 1);

    // Failed assets are never cached: a 404 refetches on every load.
    globalThis.fetch = async () => new Response("nope", { status: 404 });
    const missing = () => new Request(`${ORIGIN}/_next/static/missing.js`);
    const a = await drive(missing());
    const b = await drive(missing());
    assert.equal(a?.status, 404);
    assert.equal(b?.status, 404);
    assert.equal(store.has(`${ORIGIN}/_next/static/missing.js`), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
