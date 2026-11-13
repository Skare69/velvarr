import type { RequestListItem, RequestListResponse } from "./contracts.ts";
import { REQUEST_PAGE_MAX, REQUEST_PAGE_SIZE } from "./decisions.ts";

/** The Requests view's list state, kept free of React so tests can drive the
 * read ordering directly. */
export type RequestPagesState = {
  /** null until the first read of the current filters lands. */
  list: { rows: RequestListItem[]; nextCursor: string | null } | null;
  /** The last top read failed. */
  error: string | null;
  /** A top read is in flight. */
  refreshing: boolean;
  more: { loading: boolean; error: string | null };
};

export const INITIAL_REQUEST_PAGES: RequestPagesState = {
  list: null,
  error: null,
  refreshing: false,
  more: { loading: false, error: null },
};

/** GET /api/requests with the active filters plus page params; only
 * non-default values travel. */
export function requestsPath(
  filters: string,
  page: { limit?: number; cursor?: string | null },
): string {
  const p = new URLSearchParams(filters);
  if (page.limit !== undefined && page.limit !== REQUEST_PAGE_SIZE)
    p.set("limit", String(page.limit));
  if (page.cursor != null) p.set("cursor", page.cursor);
  return `/api/requests?${p}`;
}

function appendNew(
  rows: RequestListItem[],
  seen: Set<string>,
  page: RequestListItem[],
): void {
  for (const r of page) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
  }
}

export function createRequestPages(deps: {
  fetchPage: (path: string) => Promise<RequestListResponse>;
  onChange: (state: RequestPagesState) => void;
  /** Called after each successful top read. */
  onFresh: () => void;
  describe: (e: unknown) => string;
}) {
  let state = INITIAL_REQUEST_PAGES;
  let filters = "";
  // Every top read, filter switch and cancel bumps the generation; a read
  // that finds it changed drops its result, success and failure alike.
  let generation = 0;

  const publish = (patch: Partial<RequestPagesState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  /** Re-reads from the top as many rows as are loaded (at least one page),
   * in pages of at most REQUEST_PAGE_MAX, so a decision or a poll keeps the
   * rows the user paged through in place. */
  // ponytail: a reload costs ceil(loaded / REQUEST_PAGE_MAX) reads.
  const reload = () => {
    const gen = ++generation;
    const target = Math.max(state.list?.rows.length ?? 0, REQUEST_PAGE_SIZE);
    publish({
      error: null,
      refreshing: true,
      more: { loading: false, error: null },
    });
    void (async () => {
      const rows: RequestListItem[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      try {
        do {
          const limit = Math.min(
            Math.max(target - rows.length, 1),
            REQUEST_PAGE_MAX,
          );
          const page = await deps.fetchPage(
            requestsPath(filters, { limit, cursor }),
          );
          if (gen !== generation) return;
          appendNew(rows, seen, page.requests);
          cursor = page.nextCursor;
          if (page.requests.length === 0) break;
        } while (rows.length < target && cursor !== null);
      } catch (e) {
        if (gen === generation)
          publish({ error: deps.describe(e), refreshing: false });
        return;
      }
      publish({ list: { rows, nextCursor: cursor }, refreshing: false });
      deps.onFresh();
    })();
  };

  const loadMore = () => {
    const list = state.list;
    if (
      list === null ||
      list.nextCursor === null ||
      state.refreshing ||
      state.more.loading
    )
      return;
    const gen = generation;
    const cursor = list.nextCursor;
    // A continuation applies only to the list whose cursor it used.
    const current = () =>
      gen === generation && state.list?.nextCursor === cursor;
    publish({ more: { loading: true, error: null } });
    deps.fetchPage(requestsPath(filters, { cursor })).then(
      (page) => {
        const prev = state.list;
        if (!current() || prev === null) return;
        const rows = [...prev.rows];
        appendNew(rows, new Set(rows.map((r) => r.id)), page.requests);
        publish({
          list: { rows, nextCursor: page.nextCursor },
          more: { loading: false, error: null },
        });
      },
      (e: unknown) => {
        if (current())
          publish({ more: { loading: false, error: deps.describe(e) } });
      },
    );
  };

  return {
    /** A filter change never shows rows of the previous filter, and its
     * first read is one page. */
    setFilters(next: string) {
      filters = next;
      generation++;
      publish({ list: null });
      reload();
    },
    reload,
    loadMore,
    /** Drops the results of in-flight reads; a later setFilters or reload
     * starts over. */
    cancel() {
      generation++;
      publish({
        refreshing: false,
        more: { loading: false, error: state.more.error },
      });
    },
  };
}
