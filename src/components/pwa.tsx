"use client";

import { useEffect } from "react";
import packageJson from "../../package.json" with { type: "json" };

// Registers the caching shell worker, production builds only. Only on
// secure contexts: a plain-HTTP LAN origin rejects registration, and the app
// works fine without it. Loopback HTTP (127.0.0.1, localhost) is a secure
// context, so isSecureContext alone does not keep the worker out of
// `bun run dev` — and dev chunk URLs do not change when their content
// changes, so the cache-first worker would pin the first dev build until
// site data is cleared. Dev instead unregisters any worker an earlier dev
// session left behind.
// The ?v= version query gives every build its own script URL, so the browser
// reinstalls the worker after a release and its activate step deletes the
// previous release's cache (public/sw.js reads the query for its cache name).
export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          for (const registration of registrations)
            void registration.unregister();
        })
        .catch((error: unknown) => {
          console.warn("[pwa] service worker cleanup failed", error);
        });
      return;
    }
    navigator.serviceWorker
      .register(`/sw.js?v=${packageJson.version}`)
      .catch((error: unknown) => {
        console.warn("[pwa] service worker registration failed", error);
      });
  }, []);
  return null;
}
