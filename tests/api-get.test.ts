// The GET cache and dedupe coordination behind useApiGet
// (src/lib/api-get.ts), pinned without a React harness. The card bug: a
// manual reload() joined an in-flight GET that may have been sent before the
// mutation it re-read, so the pre-mutation response was shown and cached.
// The rules: a manual read never joins; a response (success or failure)
// lands only while its request is still the current entry for the path.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ApiGetCache, logApiFailure } from "../src/lib/api-get.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a manual reload during an in-flight GET issues a second request and its result wins", async () => {
  const cache = new ApiGetCache();
  const first = deferred<string>();
  const second = deferred<string>();
  const fetches = [first.promise, second.promise];
  let calls = 0;
  const fetch = () => fetches[calls++]!;

  const background = cache.get("p", fetch, false); // in flight
  const reload = cache.get("p", fetch, true); // must not join it
  assert.equal(calls, 2);

  first.resolve("pre-mutation");
  assert.equal(await background, "pre-mutation");
  assert.equal(cache.peek("p"), undefined); // superseded response never lands
  second.resolve("post-mutation");
  assert.equal(await reload, "post-mutation");
  assert.equal(cache.peek("p"), "post-mutation");
});

test("concurrent non-manual GETs share one request and cache it", async () => {
  const cache = new ApiGetCache();
  const d = deferred<number>();
  let calls = 0;
  const fetch = () => (calls++, d.promise);

  const a = cache.get("p", fetch, false);
  const b = cache.get("p", fetch, false);
  assert.equal(b, a); // deduped
  assert.equal(calls, 1);
  d.resolve(7);
  assert.equal(await a, 7);
  assert.equal(cache.peek("p"), 7);
});

test("an older late failure does not evict a newer cached response", async () => {
  const cache = new ApiGetCache();
  const stale = deferred<string>();
  const fetches = [stale.promise, Promise.resolve("fresh")];
  let calls = 0;
  const fetch = () => fetches[calls++]!;

  const a = cache.get("p", fetch, false);
  const b = cache.get("p", fetch, true); // manual reload supersedes it
  stale.reject(new Error("gone"));
  await assert.rejects(a);
  assert.equal(await b, "fresh");
  assert.equal(cache.peek("p"), "fresh");
});

test("the FIFO cap evicts the oldest entry and a re-read moves a key to the end", async () => {
  const cache = new ApiGetCache();
  const CAP = 100; // must match ApiGetCache.CAP (private)
  const fill = async (from: number, to: number) => {
    for (let i = from; i < to; i++)
      await cache.get(`p${i}`, () => Promise.resolve(i), false);
  };

  await fill(0, CAP);
  assert.ok(cache.has("p0"), "at exactly CAP entries nothing is evicted yet");
  await fill(CAP, CAP + 1); // p100 lands: size CAP+1 → the oldest (p0) goes
  assert.equal(cache.has("p0"), false);
  assert.ok(cache.has("p1"), "the rest of the entries stay cached");

  // Re-reading p1 must move it to the end of the FIFO, so the next
  // eviction takes p2, not the re-read p1.
  await cache.get("p1", () => Promise.resolve("refreshed"), false);
  await fill(CAP + 1, CAP + 2); // p101 lands: size CAP+1 → oldest goes
  assert.ok(cache.has("p1"), "the re-read p1 survives the eviction");
  assert.equal(cache.has("p2"), false, "the eviction took p2 instead");
  assert.equal(cache.peek("p1"), "refreshed");
});

test("clear() drops cached entries, not just in-flight reads", async () => {
  const cache = new ApiGetCache();
  await cache.get("keep", () => Promise.resolve("v"), false);
  assert.ok(cache.has("keep"));
  cache.clear();
  assert.equal(cache.has("keep"), false);
});

test("a response that lands after clear() is never cached", async () => {
  const cache = new ApiGetCache();
  const d = deferred<string>();
  const pending = cache.get("p", () => d.promise, false);
  cache.clear(); // sign-out: the response belongs to the previous account
  d.resolve("previous account");
  assert.equal(await pending, "previous account");
  assert.equal(cache.peek("p"), undefined);
});

// VELV-167: a rejected request used to vanish — api() threw, the load-more
// block rendered a fixed string, and the console said nothing, so a 422
// whose message names the fix ("narrow the filters") was undiagnosable.
// The logged line is the diagnosis: method, full path (its query string is
// the exact filter parameters the user set), status, the server's error
// code, and the server's message. This request is the card's own: an
// anchored Married tag plus a label-only "anal" term at page 2.
test("a failed filter request logs path, status, code, and message", () => {
  const include = JSON.stringify([
    { name: "Married", stashdb: "1bb6aca0-c820-4cca-b02a-6b8dfb927ed4" },
    { name: "anal" },
  ]);
  const path = `/api/browse?include=${encodeURIComponent(include)}&perPage=27&page=2`;
  const message =
    "Browse reached its upstream page limit before filling this page; narrow the filters.";
  const error = mock.method(console, "error");
  try {
    logApiFailure("GET", path, 422, "query_too_broad", message);
    assert.equal(error.mock.callCount(), 1);
    const line = error.mock.calls[0]?.arguments[0];
    assert.equal(
      line,
      `[velvarr:api] GET ${path} → 422 query_too_broad: ${message}`,
    );
  } finally {
    error.mock.restore();
  }
});
