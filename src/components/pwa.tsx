"use client";

import { useEffect } from "react";

// Registers the caching shell worker. Only on secure contexts: a plain-HTTP
// LAN origin rejects registration, and the app works fine without it.
export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("[pwa] service worker registration failed", error);
    });
  }, []);
  return null;
}
