// The per-tab GET cache and request dedupe behind useApiGet, extracted so the
// coordination is testable without a React harness (tests/api-get.test.ts).
// Two rules matter:
// - A manual read (a reload()) never joins an in-flight GET: the in-flight
//   request may have been sent before the mutation the reload re-reads, so
//   joining it would resolve with pre-mutation state and cache it.
// - A response fills the cache only while its request is still the current
//   entry for the path. Once clear() wipes the map or a newer read replaces
//   the entry, a late response is dropped, so an older result — success or
//   failure — never overwrites or evicts a newer one. This one guard also
//   covers the sign-out case clearApiCache cared about.

export class ApiGetCache {
  // Cached GET responses, keyed by path; FIFO-capped; re-putting a key moves
  // it to the end.
  private cache = new Map<string, unknown>();
  private static readonly CAP = 100;

  // Concurrent identical GETs share one request.
  private inFlight = new Map<string, Promise<unknown>>();

  /** Cached response for `path`, or undefined on a miss. */
  peek(path: string): unknown {
    return this.cache.get(path);
  }

  has(path: string): boolean {
    return this.cache.has(path);
  }

  /** Drops every cached and in-flight read (sign-out, 401). */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** One GET of `path`: joins the in-flight request unless `manual`, and
   * caches success (or drops the cached snapshot on failure) only while this
   * request is still the current one for the path. */
  get<T>(path: string, fetch: () => Promise<T>, manual: boolean): Promise<T> {
    if (!manual) {
      const run = this.inFlight.get(path);
      if (run) return run as Promise<T>;
    }
    const pending: Promise<T> = fetch()
      .then((d) => {
        if (this.inFlight.get(path) === pending) {
          this.cache.delete(path); // re-set moves the key to the end (FIFO order)
          this.cache.set(path, d);
          if (this.cache.size > ApiGetCache.CAP) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
        return d;
      })
      .catch((e: unknown) => {
        if (this.inFlight.get(path) === pending) this.cache.delete(path);
        throw e;
      })
      .finally(() => {
        if (this.inFlight.get(path) === pending) this.inFlight.delete(path);
      });
    this.inFlight.set(path, pending);
    return pending;
  }
}
