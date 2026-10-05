// The GET cache and dedupe coordination behind useApiGet
// (src/lib/api-get.ts), pinned without a React harness. The card bug: a
// manual reload() joined an in-flight GET that may have been sent before the
// mutation it re-read, so the pre-mutation response was shown and cached.
// The rules: a manual read never joins; a response (success or failure)
// lands only while its request is still the current entry for the path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiGetCache } from "../src/lib/api-get.ts";

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

test("a response that lands after clear() is never cached", async () => {
  const cache = new ApiGetCache();
  const d = deferred<string>();
  const pending = cache.get("p", () => d.promise, false);
  cache.clear(); // sign-out: the response belongs to the previous account
  d.resolve("previous account");
  assert.equal(await pending, "previous account");
  assert.equal(cache.peek("p"), undefined);
});
