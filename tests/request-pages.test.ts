// The Requests view's list controller, driven by hand: every read is a
// deferred promise the test resolves, so the read orderings a user can cause
// (a filter switch during a decision, Load more during a Refresh, a poll over
// many loaded rows) are pinned without a browser.

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RequestListItem,
  RequestListResponse,
} from "../src/lib/contracts.ts";
import {
  createRequestPages,
  INITIAL_REQUEST_PAGES,
  requestsPath,
  type RequestPagesState,
} from "../src/lib/request-pages.ts";

type Call = {
  path: string;
  resolve: (page: RequestListResponse) => void;
  reject: (e: unknown) => void;
};

function harness() {
  const calls: Call[] = [];
  let state: RequestPagesState = INITIAL_REQUEST_PAGES;
  let fresh = 0;
  const ctrl = createRequestPages({
    fetchPage: (path) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<RequestListResponse>();
      calls.push({ path, resolve, reject });
      return promise;
    },
    onChange: (s) => {
      state = s;
    },
    onFresh: () => {
      fresh++;
    },
    describe: (e) => (e instanceof Error ? e.message : String(e)),
  });
  return {
    calls,
    /** The i-th read issued; fails the test when it was never issued. */
    call(i: number): Call {
      const c = calls[i];
      assert.ok(c, `read ${i} was not issued`);
      return c;
    },
    ctrl,
    get state() {
      return state;
    },
    get fresh() {
      return fresh;
    },
  };
}

/** Lets every settled read run its continuation (and issue its next read). */
async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

const ids = (prefix: string, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);

const page = (
  rowIds: string[],
  nextCursor: string | null,
): RequestListResponse => ({
  requests: rowIds.map((id) => ({ id }) as RequestListItem),
  nextCursor,
  pendingApprovals: 0,
});

const params = (path: string) => new URL(path, "http://x").searchParams;
const rowIds = (s: RequestPagesState) => s.list?.rows.map((r) => r.id);

test("a reload after a filter switch reads the new filters; the old read is dropped", async () => {
  const h = harness();
  h.ctrl.setFilters("status=pending");
  h.call(0).resolve(page(["p1"], null));
  await flush();
  assert.deepEqual(rowIds(h.state), ["p1"]);

  // A decision lands and reloads, then the user switches filter before the
  // reload resolves.
  h.ctrl.reload();
  const switchAt = h.calls.length;
  h.ctrl.setFilters("status=approved");
  // The decision's reload of a second PATCH lands after the switch.
  h.ctrl.reload();

  h.call(switchAt - 1).resolve(page(["p1", "p2"], null));
  await flush();
  assert.equal(h.state.list, null, "old filter rows never show");

  for (const c of h.calls.slice(switchAt))
    assert.equal(params(c.path).get("status"), "approved", c.path);
  assert.equal(h.calls.length, switchAt + 2);
  h.call(switchAt).resolve(page(["a0"], null));
  h.call(switchAt + 1).resolve(page(["a1", "a2"], null));
  await flush();
  assert.deepEqual(rowIds(h.state), ["a1", "a2"]);
  assert.equal(h.state.refreshing, false);
});

test("Load more waits for a refresh and continues from the refreshed cursor", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.reload();
  assert.equal(h.state.refreshing, true);
  const issued = h.calls.length;
  h.ctrl.loadMore();
  assert.equal(h.calls.length, issued, "no continuation during a top read");
  assert.equal(h.state.more.loading, false);

  // A newer row arrived: the former page boundary moved one row down.
  h.call(issued - 1).resolve(page(["n", ...ids("r", 0, 49)], "c1b"));
  await flush();
  assert.equal(h.state.refreshing, false);
  h.ctrl.loadMore();
  assert.equal(h.calls.length, issued + 1);
  assert.equal(params(h.call(issued).path).get("cursor"), "c1b");
  h.call(issued).resolve(page(ids("r", 49, 50), "c2"));
  await flush();
  assert.equal(h.state.list?.rows.length, 100);
  assert.ok(rowIds(h.state)?.includes("r49"), "boundary row kept");
  assert.equal(h.state.list?.nextCursor, "c2");
});

test("a continuation that resolves after a newer reload is dropped", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  assert.equal(h.state.more.loading, true);
  const more = h.call(1);
  h.ctrl.reload();
  assert.equal(h.state.more.loading, false);
  h.call(2).resolve(page(["n", ...ids("r", 0, 49)], "c1b"));
  await flush();
  more.resolve(page(ids("r", 50, 50), "c2"));
  await flush();

  assert.deepEqual(rowIds(h.state), ["n", ...ids("r", 0, 49)]);
  assert.equal(h.state.list?.nextCursor, "c1b");
  assert.equal(h.state.more.loading, false);
});

test("a reload keeps every loaded row, at most REQUEST_PAGE_MAX per read", async () => {
  const h = harness();
  h.ctrl.setFilters("type=movie");
  h.call(0).resolve(page(ids("r", 0, 50), "c50"));
  await flush();
  for (let n = 50; n < 300; n += 50) {
    h.ctrl.loadMore();
    const c = h.call(h.calls.length - 1);
    assert.equal(params(c.path).get("cursor"), `c${n}`);
    c.resolve(page(ids("r", n, 50), `c${n + 50}`));
    await flush();
  }
  assert.equal(h.state.list?.rows.length, 300);

  const before = h.calls.length;
  h.ctrl.reload();
  const first = params(h.call(before).path);
  assert.equal(first.get("limit"), "200");
  assert.equal(first.get("cursor"), null);
  assert.equal(first.get("type"), "movie");
  h.call(before).resolve(page(ids("r", 0, 200), "t200"));
  await flush();
  const second = params(h.call(before + 1).path);
  assert.equal(second.get("limit"), "100");
  assert.equal(second.get("cursor"), "t200");
  assert.equal(second.get("type"), "movie");
  h.call(before + 1).resolve(page(ids("r", 200, 100), "t300"));
  await flush();

  assert.equal(h.calls.length, before + 2);
  assert.deepEqual(rowIds(h.state), ids("r", 0, 300));
  assert.equal(h.state.list?.nextCursor, "t300");
  assert.equal(h.state.refreshing, false);
});

test("a failed top read keeps the loaded rows and reports the error", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(["r0", "r1"], null));
  await flush();
  assert.equal(h.fresh, 1);

  h.ctrl.reload();
  h.call(1).reject(new Error("offline"));
  await flush();
  assert.equal(h.state.error, "offline");
  assert.equal(h.state.refreshing, false);
  assert.deepEqual(rowIds(h.state), ["r0", "r1"]);
  assert.equal(h.fresh, 1, "a failed read is not fresh");
});

test("a failed Load more keeps the loaded rows and reports the error", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  h.call(1).reject(new Error("timeout"));
  await flush();
  assert.deepEqual(h.state.more, { loading: false, error: "timeout" });
  assert.equal(h.state.error, null);
  assert.deepEqual(rowIds(h.state), ids("r", 0, 50));
  assert.equal(h.state.list?.nextCursor, "c1");
});

test("requestsPath omits the default limit and encodes the cursor", () => {
  assert.equal(
    requestsPath("status=pending", { limit: 50 }),
    "/api/requests?status=pending",
  );
  assert.equal(requestsPath("", { cursor: null }), "/api/requests?");
  const path = requestsPath("type=movie", { limit: 120, cursor: "1:a&b=c" });
  assert.equal(path, "/api/requests?type=movie&limit=120&cursor=1%3Aa%26b%3Dc");
  assert.equal(params(path).get("cursor"), "1:a&b=c");
});
