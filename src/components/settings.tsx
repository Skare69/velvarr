"use client";

/*
 * Admin settings page: tab navigation and shared settings operations.
 * Service editors live in their own components. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import { useCallback, useEffect, useState } from "react";
import { ForbiddenPanel } from "./shared.tsx";
import { LimitsPanel, ReleaseStatusPanel } from "./limits.tsx";
import { ConnectionsSettings } from "./connection-settings.tsx";
import { MetadataSettings } from "./metadata-settings.tsx";
import { settingsSectionForHash } from "../lib/provider-settings.ts";
import { useSettingsOperations } from "./settings-service.tsx";

/* ---------- Settings: integrations, Whisparr, providers ---------- */

export function SettingsView() {
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState("connections");
  // A settings deep link names its card, not its tab: Discover's key links
  // target provider headings that live on the metadata tab, whose cards
  // mount only after their config load. The tab flips after mount because
  // SSR renders no hash, and the reveal loop waits for the anchor to exist.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash === "") return;
    setSection(settingsSectionForHash(hash));
    let timer: number | undefined;
    let tries = 0;
    let pins = -1;
    const reveal = () => {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: "start" });
        if (pins < 0) {
          target.focus();
          pins = 0;
          // The cards above the target keep growing as their connection
          // probes return, so the scroll re-pins for a settle window (~2s)
          // instead of racing that layout. Focus moves exactly once.
        } else if (++pins >= 40) return;
      } else if (++tries >= 200) {
        return; // ~10s ceiling: the anchor may never mount.
      }
      timer = window.setTimeout(reveal, 50);
    };
    timer = window.setTimeout(reveal, 50);
    return () => clearTimeout(timer);
  }, []);
  const operations = useSettingsOperations();
  // Stable identity keeps service checks from restarting on parent renders.
  const forbid = useCallback(() => setForbidden(true), []);
  if (forbidden) return <ForbiddenPanel />;

  return (
    <section className="settings-page" aria-label="Settings">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Connect your services and make Velvarr yours.
          </p>
        </div>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {[
          ["connections", "Connections"],
          ["metadata", "Metadata providers"],
          ["system", "System"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            onClick={() => setSection(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div hidden={section !== "connections"}>
        <div className="settings-content">
          <ConnectionsSettings onForbidden={forbid} {...operations} />
        </div>
      </div>
      <div hidden={section !== "metadata"}>
        <div className="settings-content">
          <MetadataSettings onForbidden={forbid} {...operations} />
        </div>
      </div>
      <div hidden={section !== "system"}>
        <div className="settings-content">
          <LimitsPanel />
          <ReleaseStatusPanel />
        </div>
      </div>
    </section>
  );
}
