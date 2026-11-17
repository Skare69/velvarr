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

test("a reload before any filter set reads the unfiltered list", async () => {
  const h = harness();
  h.ctrl.reload();
  assert.equal(
    h.call(0).path,
    "/api/requests?",
    "no filter travels before the user sets one",
  );
  h.call(0).resolve(page(ids("r", 0, 50), null));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("r", 0, 50));
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

test("two overlapping reloads resolve out of order; the older result is dropped", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("r", 0, 50));

  // A decision's reload is still in flight when a poll starts a second
  // one, and the poll's page lands first.
  h.ctrl.reload();
  h.ctrl.reload();
  h.call(2).resolve(page(ids("n", 0, 50), "c1b"));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("n", 0, 50));
  assert.equal(h.state.refreshing, false);

  // The older read finishes last with its own rows: dropped, not merged.
  h.call(1).resolve(page(ids("o", 0, 50), "c1o"));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("n", 0, 50));
  assert.equal(h.state.list?.nextCursor, "c1b");
  assert.equal(h.state.refreshing, false);
  assert.equal(h.fresh, 2, "one fresh per landed reload");
});

test("a stale failed reload reports nothing over a newer landed read", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.reload();
  h.ctrl.reload();
  h.call(2).resolve(page(ids("n", 0, 50), "c1b"));
  await flush();
  h.call(1).reject(new Error("stale offline"));
  await flush();

  assert.equal(h.state.error, null, "the stale failure is not published");
  assert.deepEqual(rowIds(h.state), ids("n", 0, 50));
  assert.equal(h.state.refreshing, false);
});

test("a reload stops at an empty page even when it carries a cursor", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.reload();
  // The server answered an empty page with a cursor: the loop must not
  // chase it, or a cursor the list never advances would read forever.
  h.call(1).resolve(page([], "c1"));
  await flush();

  assert.equal(h.calls.length, 2, "no second read after the empty page");
  assert.deepEqual(h.state.list, { rows: [], nextCursor: "c1" });
  assert.equal(h.state.refreshing, false);
});

test("Load more ignores a fresh controller, an exhausted list and a running read", async () => {
  const h = harness();
  h.ctrl.loadMore();
  assert.equal(h.calls.length, 0, "no list to continue");
  assert.equal(
    h.state.refreshing,
    false,
    "a fresh controller has no read in flight",
  );
  assert.deepEqual(h.state.more, { loading: false, error: null });

  h.ctrl.setFilters("status=pending");
  h.call(0).resolve(page(ids("r", 0, 50), null));
  await flush();
  h.ctrl.loadMore();
  assert.equal(h.calls.length, 1, "no cursor to continue from");
  assert.equal(h.state.more.loading, false);

  h.ctrl.setFilters("status=approved");
  h.call(1).resolve(page(ids("a", 0, 50), "c1"));
  await flush();
  h.ctrl.loadMore();
  assert.equal(h.calls.length, 3);
  h.ctrl.loadMore();
  assert.equal(h.calls.length, 3, "one continuation at a time");
  assert.equal(h.state.more.loading, true);
});

test("a stale Load more is dropped even when the reloaded cursor matches", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  assert.equal(h.state.more.loading, true);
  const more = h.call(1);
  h.ctrl.reload();
  // The reload lands with the same page boundary the continuation used:
  // the continuation is still stale and must not append over it.
  h.call(2).resolve(page(["n", ...ids("r", 0, 49)], "c1"));
  await flush();
  more.resolve(page(ids("r", 49, 50), "c2"));
  await flush();

  assert.deepEqual(rowIds(h.state), ["n", ...ids("r", 0, 49)]);
  assert.equal(h.state.list?.nextCursor, "c1");
  assert.equal(h.state.more.loading, false);
  assert.equal(h.state.more.error, null);
});

test("a stale failed Load more reports nothing over a newer landed read", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  const more = h.call(1);
  h.ctrl.reload();
  h.call(2).resolve(page(ids("n", 0, 50), "c1b"));
  await flush();
  more.reject(new Error("stale timeout"));
  await flush();

  assert.deepEqual(
    h.state.more,
    { loading: false, error: null },
    "the stale failure is not published",
  );
  assert.deepEqual(rowIds(h.state), ids("n", 0, 50));
  assert.equal(h.state.error, null);
});

test("a Load more dropped by cancel stays dropped across a new reload", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  const more = h.call(1);
  h.ctrl.cancel();
  h.ctrl.reload();
  more.resolve(page(ids("r", 50, 50), "c2"));
  await flush();

  assert.deepEqual(
    rowIds(h.state),
    ids("r", 0, 50),
    "the cancelled continuation never lands",
  );
  assert.equal(h.state.list?.nextCursor, "c1");
  assert.equal(h.state.refreshing, true, "the new reload is still running");

  h.call(2).resolve(page(ids("n", 0, 50), "c1b"));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("n", 0, 50));
  assert.equal(h.state.refreshing, false);
});

test("a read in flight across a filter switch never lands", async () => {
  const h = harness();
  h.ctrl.setFilters("status=pending");
  h.call(0).resolve(page(ids("p", 0, 50), "c1"));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("p", 0, 50));

  // One read of the old filter is in flight when the user switches; only
  // the switch's own read may land.
  h.ctrl.reload();
  h.ctrl.setFilters("status=approved");
  h.call(1).resolve(page(ids("p", 0, 50), "c1"));
  await flush();

  assert.equal(h.state.list, null, "the dropped read shows nothing");
  assert.equal(h.state.refreshing, true, "the switch's read is running");
  h.call(2).resolve(page(ids("a", 0, 50), null));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("a", 0, 50));
  assert.equal(h.state.refreshing, false);
});

test("a Load more that repeats a loaded row lands it once", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  // A row arrived above the boundary: the next page repeats the loaded
  // boundary row instead of continuing past it.
  h.ctrl.loadMore();
  assert.equal(h.calls.length, 2);
  h.call(1).resolve(page(["r49", ...ids("s", 0, 49)], "c2"));
  await flush();

  assert.deepEqual(
    rowIds(h.state),
    [...ids("r", 0, 50), ...ids("s", 0, 49)],
    "the repeated boundary row lands once",
  );
  assert.equal(h.state.list?.rows.length, 99);
  assert.deepEqual(h.state.more, { loading: false, error: null });
  assert.equal(h.state.list?.nextCursor, "c2");
});

test("a Load more dropped by a filter switch never lands", async () => {
  const h = harness();
  h.ctrl.setFilters("status=pending");
  h.call(0).resolve(page(ids("p", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  const more = h.call(1);
  h.ctrl.setFilters("status=approved");
  more.resolve(page(ids("p", 50, 50), "c2"));
  await flush();

  assert.equal(h.state.list, null, "the old continuation shows nothing");
  assert.equal(h.state.refreshing, true, "the new filter's read is running");
  h.call(2).resolve(page(ids("a", 0, 50), null));
  await flush();
  assert.deepEqual(rowIds(h.state), ids("a", 0, 50));
  assert.equal(h.state.refreshing, false);
});

test("a reload dedupes rows shared between its own pages", async () => {
  const h = harness();
  h.ctrl.setFilters("type=movie");
  h.call(0).resolve(page(ids("r", 0, 50), "c50"));
  await flush();
  for (let n = 50; n < 300; n += 50) {
    h.ctrl.loadMore();
    h.call(h.calls.length - 1).resolve(page(ids("r", n, 50), `c${n + 50}`));
    await flush();
  }
  assert.deepEqual(rowIds(h.state), ids("r", 0, 300));

  const before = h.calls.length;
  h.ctrl.reload();
  // The boundary row moved between reads: the second page repeats the
  // first page's last row, and the reload must land it once.
  h.call(before).resolve(page(ids("r", 0, 200), "t200"));
  await flush();
  h.call(before + 1).resolve(page(ids("r", 199, 99), null));
  await flush();

  assert.equal(h.calls.length, before + 2);
  assert.deepEqual(
    rowIds(h.state),
    [...ids("r", 0, 200), ...ids("r", 200, 98)],
    "the shared boundary row lands once",
  );
  assert.equal(h.state.list?.nextCursor, null);
  assert.equal(h.state.refreshing, false);
});

test("cancel stops a top read and drops its late response", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.reload();
  assert.equal(h.state.refreshing, true);
  h.ctrl.cancel();
  assert.equal(h.state.refreshing, false);
  assert.deepEqual(h.state.more, { loading: false, error: null });
  h.call(1).resolve(page(ids("n", 0, 50), "c1b"));
  await flush();

  assert.deepEqual(
    rowIds(h.state),
    ids("r", 0, 50),
    "the cancelled read never lands",
  );
  assert.equal(h.state.list?.nextCursor, "c1");
  assert.equal(h.state.refreshing, false);
  assert.equal(h.state.error, null);
});

test("cancel stops a Load more and drops its late response", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  assert.equal(h.state.more.loading, true);
  h.ctrl.cancel();
  assert.deepEqual(h.state.more, { loading: false, error: null });
  h.call(1).resolve(page(ids("r", 50, 50), "c2"));
  await flush();

  assert.deepEqual(rowIds(h.state), ids("r", 0, 50));
  assert.equal(h.state.list?.nextCursor, "c1");
  assert.equal(h.state.more.loading, false);
});

test("cancel keeps the standing Load more error", async () => {
  const h = harness();
  h.ctrl.setFilters("");
  h.call(0).resolve(page(ids("r", 0, 50), "c1"));
  await flush();

  h.ctrl.loadMore();
  h.call(1).reject(new Error("timeout"));
  await flush();
  assert.deepEqual(h.state.more, { loading: false, error: "timeout" });

  h.ctrl.cancel();
  assert.deepEqual(
    h.state.more,
    { loading: false, error: "timeout" },
    "cancel drops reads, not the standing error",
  );
});
