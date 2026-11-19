"use client";

/*
 * Admin settings page: tab navigation and shared settings operations.
 * Service editors live in their own components. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import { useCallback, useEffect, useState } from "react";
import { ForbiddenPanel } from "./shared.tsx";
import { ConnectionsSettings } from "./connection-settings.tsx";
import { MetadataSettings } from "./metadata-settings.tsx";
import { AiSettings } from "./ai-settings.tsx";
import {
  SETTINGS_SECTIONS,
  settingsSectionForHash,
  type SettingsSection,
} from "../lib/provider-settings.ts";
import { useSettingsOperations } from "./settings-service.tsx";

/* ---------- Settings: integrations, Whisparr, providers ---------- */

export function SettingsView() {
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState<SettingsSection>("connections");
  // The hash names the tab (`#ai`) or a card on it. A card deep link (e.g.
  // Discover's key links to provider headings) also scrolls to its card,
  // whose tab mounts the card only after its config load. The tab flips
  // after mount because SSR renders no hash, and the reveal loop waits for
  // the anchor to exist.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash === "") return;
    setSection(settingsSectionForHash(hash));
    // A tab anchor names no card: nothing to scroll to.
    if (SETTINGS_SECTIONS.some((s) => hash === "#" + s)) return;
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
        {(
          [
            ["connections", "Connections"],
            ["metadata", "Metadata providers"],
            ["ai", "AI"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            onClick={() => {
              setSection(id);
              // Replace, not push: a reload keeps the tab, and Back still
              // leaves Settings instead of walking through tab clicks.
              history.replaceState(history.state, "", "#" + id);
            }}
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
      <div hidden={section !== "ai"}>
        <div className="settings-content">
          <AiSettings onForbidden={forbid} {...operations} />
        </div>
      </div>
    </section>
  );
}
