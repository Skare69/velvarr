// Fake worker-global self for public/sw.js. The worker module reads
// `self.addEventListener` while it loads, so this must evaluate before
// sw.js does: sw.test.ts imports this file first and ESM guarantees the
// order (which is also why there is no dynamic import).

export const handlers: Record<string, (event: unknown) => void> = {};
export const deleted: string[] = [];
export const store: Map<string, Response> = new Map();
export const state = { fetches: 0, skippedWaiting: 0 };

// `globalThis.self` is typed as the DOM Window global, so a plain assignment
// cannot typecheck; defineProperty sets the real runtime global with no cast.
Object.defineProperty(globalThis, "self", {
  configurable: true,
  writable: true,
  value: {
    location: { origin: "https://velvarr.ts.net" },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers[type] = handler;
    },
    skipWaiting: () => {
      state.skippedWaiting += 1;
    },
    clients: { claim: async () => {} },
    caches: {
      open: async () => ({
        // Real CacheStorage hands back a fresh copy per match; mirror that,
        // because a Response body can be read only once.
        match: async (request: Request) =>
          store.get(new URL(request.url).href)?.clone(),
        put: async (request: Request, response: Response) => {
          store.set(new URL(request.url).href, response.clone());
        },
      }),
      keys: async () => ["velvarr-shell-v0", "velvarr-shell-v1"],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    },
  },
});
