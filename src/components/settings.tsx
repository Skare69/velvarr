"use client";

/*
 * Admin settings page: tab navigation and shared settings operations.
 * Service editors live in their own components. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import { useCallback, useState } from "react";
import { ForbiddenPanel } from "./shared.tsx";
import { LimitsPanel, ReleaseStatusPanel } from "./limits.tsx";
import { ConnectionsSettings } from "./connection-settings.tsx";
import { MetadataSettings } from "./metadata-settings.tsx";
import { useSettingsOperations } from "./settings-service.tsx";

/* ---------- Settings: integrations, Whisparr, providers ---------- */

export function SettingsView() {
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState("connections");
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
