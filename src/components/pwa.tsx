"use client";

import { useEffect } from "react";

// Registers the caching shell worker, production builds only. Loopback HTTP
// (127.0.0.1, localhost) is a secure context, so isSecureContext alone does
// not keep the worker out of `bun run dev` — and dev chunk URLs do not
// change when their content changes, so the cache-first worker would pin
// the first dev build until site data is cleared. Dev instead unregisters
// any worker an earlier dev session left behind.
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
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("[pwa] service worker registration failed", error);
    });
  }, []);
  return null;
}
