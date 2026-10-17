// Caching shell worker: installability needs a worker, speed needs one too.
// It serves only immutable build assets; /api, documents and everything else
// pass through untouched, so live data is never read from a cache.
// Cache name is per build: pwa.tsx registers /sw.js?v=<package version>, so
// every release gets a fresh cache and the activate cleanup below deletes the
// previous release's one. Without a version (bare /sw.js) the fallback keeps
// the worker working until the next versioned activation replaces it.
const CACHE = `velvarr-shell-v${new URL(self.location.href).searchParams.get("v") ?? "0"}`;
const PREFIX = "/_next/static/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => self.caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(PREFIX)) return;
  event.respondWith(
    (async () => {
      const cache = await self.caches.open(CACHE);
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});
