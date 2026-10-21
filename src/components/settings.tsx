"use client";

/*
 * Admin settings page: integration forms, Jellyfin/Whisparr status cards
 * and metadata provider credentials. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  IntegrationConfig,
  JudgmentProvider,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../lib/contracts.ts";
import {
  ApiError,
  api,
  ErrorPanel,
  ForbiddenPanel,
  messageOf,
  useApiGet,
  useSession,
} from "./shared.tsx";
import { LimitsPanel, ReleaseStatusPanel } from "./limits.tsx";

/* ---------- App-local API view records (not in contracts.ts) ---------- */

interface WhisparrStatus {
  configured: boolean;
  version?: string;
  appName?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
  error?: { code: string; message: string };
}

interface JellyfinStatus {
  configured: boolean;
  serverName?: string;
  version?: string;
  error?: { code: string; message: string };
}
interface IntegrationsInfo {
  jellyfin: {
    url: string;
    externalUrl: string;
    serverId: string;
    libraryIds: string[];
    apiKeyConfigured: boolean;
  };
  whisparr: {
    url: string;
    apiKeyConfigured: boolean;
    delivery: WhisparrDelivery | null;
    pathMappings: WhisparrPathMapping[];
  } | null;
}
/* ---------- Settings: integrations, Whisparr, providers ---------- */

export function SettingsView() {
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState("connections");
  // Stable identity: IntegrationsForm's load useCallback depends on this, so a
  // fresh arrow on every render would refetch and wipe unsaved draft edits.
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
          <IntegrationsForm onForbidden={forbid} />
        </div>
      </div>
      <div hidden={section !== "metadata"}>
        <div className="settings-content">
          <MetadataSettings />
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

function IntegrationsForm({ onForbidden }: { onForbidden: () => void }) {
  const [info, setInfo] = useState<IntegrationsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [jellyfinApiKey, setJellyfinApiKey] = useState("");
  const [whisparrUrl, setWhisparrUrl] = useState("");
  const [whisparrApiKey, setWhisparrApiKey] = useState("");
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [rootFolderPath, setRootFolderPath] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const [mappings, setMappings] = useState<WhisparrPathMapping[]>([]);
  const [whisparrStatus, setWhisparrStatus] = useState<WhisparrStatus | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api<IntegrationsInfo>("/api/admin/integrations")
      .then((d) => {
        setInfo(d);
        setJellyfinUrl(d.jellyfin.url);
        setExternalUrl(d.jellyfin.externalUrl);
        setWhisparrUrl(d.whisparr?.url ?? "");
        setDeliveryEnabled(d.whisparr?.delivery?.enabled ?? false);
        setRootFolderPath(d.whisparr?.delivery?.rootFolderPath ?? "");
        setQualityProfileId(
          d.whisparr?.delivery
            ? String(d.whisparr.delivery.qualityProfileId)
            : "",
        );
        setSearchOnAdd(d.whisparr?.delivery?.searchOnAdd ?? true);
        setMappings(d.whisparr?.pathMappings ?? []);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) onForbidden();
        else setLoadError(messageOf(e));
      })
      .finally(() => setLoading(false));
    // Read-only status supplies the real root folders / quality profiles; when
    // it is unavailable the form falls back to manual entry below.
    api<WhisparrStatus>("/api/admin/whisparr")
      .then(setWhisparrStatus)
      .catch(() => setWhisparrStatus(null));
  }, [onForbidden]);

  useEffect(load, [load]);

  // Select choices; the currently stored value is always offered so a stale
  // status can never silently change what will be saved.
  const hasUrl = whisparrUrl.trim() !== "";
  const fieldsDisabled = pending || loading || !!loadError;
  const rootChoices = (() => {
    const paths = whisparrStatus?.rootFolders?.map((rf) => rf.path) ?? [];
    if (rootFolderPath !== "" && !paths.includes(rootFolderPath))
      return [rootFolderPath, ...paths];
    return paths;
  })();
  const profileChoices = (() => {
    const known = whisparrStatus?.profiles ?? [];
    const id = Number(qualityProfileId);
    if (
      qualityProfileId !== "" &&
      Number.isInteger(id) &&
      !known.some((p) => p.id === id)
    )
      return [...known, { id, name: `Saved profile #${id}` }];
    return known;
  })();
  const effectiveRoot = rootFolderPath || rootChoices[0] || "";
  const effectiveProfile =
    qualityProfileId || (profileChoices[0] ? String(profileChoices[0].id) : "");
  const halfMappings = mappings.filter(
    (m) =>
      (m.whisparrPrefix.trim() === "") !== (m.jellyfinPrefix.trim() === ""),
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!info || loadError || loading || pending) return;
    setError(null);
    setSaved(null);
    if (!jellyfinUrl.trim() || !externalUrl.trim()) {
      setError("Jellyfin URL and external URL are required.");
      return;
    }
    if (!hasUrl && whisparrApiKey.trim() !== "") {
      setError(
        "A Whisparr API key needs the Whisparr URL — the URL is the connection, the key authenticates it.",
      );
      return;
    }
    const profile = Number(effectiveProfile);
    if (
      hasUrl &&
      (deliveryEnabled || info?.whisparr?.delivery) &&
      (!Number.isInteger(profile) || profile < 1)
    ) {
      setError("Choose a quality profile (a positive whole number).");
      return;
    }
    if (hasUrl && deliveryEnabled && !effectiveRoot.trim()) {
      setError("A root folder is required while delivery is enabled.");
      return;
    }
    if (hasUrl && halfMappings.length > 0) {
      setError(
        "Each path mapping needs both a Whisparr prefix and a Jellyfin prefix.",
      );
      return;
    }
    setPending(true);
    try {
      await api<unknown>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify({
          jellyfinUrl: jellyfinUrl.trim(),
          jellyfinExternalUrl: externalUrl.trim(),
          ...(jellyfinApiKey ? { jellyfinApiKey } : {}),
          whisparrUrl: whisparrUrl.trim(),
          ...(whisparrApiKey ? { whisparrApiKey } : {}),
          // Delivery travels only when it exists on either side: enabled now,
          // or previously configured (an omitted key would drop it wholesale).
          // A first-time save with delivery off stores none — profiles and
          // roots can be chosen after the connection probe succeeds.
          ...(hasUrl && (deliveryEnabled || info?.whisparr?.delivery)
            ? {
                delivery: {
                  enabled: deliveryEnabled,
                  rootFolderPath: effectiveRoot.trim(),
                  qualityProfileId: profile,
                  searchOnAdd,
                },
                pathMappings: mappings
                  .filter(
                    (m) =>
                      m.whisparrPrefix.trim() !== "" &&
                      m.jellyfinPrefix.trim() !== "",
                  )
                  .map((m) => ({
                    whisparrPrefix: m.whisparrPrefix.trim(),
                    jellyfinPrefix: m.jellyfinPrefix.trim(),
                  })),
              }
            : {}),
        }),
      });
      setJellyfinApiKey("");
      setWhisparrApiKey("");
      setSaved("Integrations updated.");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) onForbidden();
      else setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="settings-connections"
      onSubmit={(e) => void save(e)}
      noValidate
    >
      <section className="panel p-5" aria-labelledby="jellyfin-settings-title">
        <div className="settings-service-heading">
          <h2 id="jellyfin-settings-title">Jellyfin</h2>
          <p>Your media server, accounts, and playback connection.</p>
        </div>
        <JellyfinCard onForbidden={onForbidden} />
        {info ? (
          <>
            <p className="mt-3 text-sm text-muted">
              Server <span className="chip">{info.jellyfin.serverId}</span> ·{" "}
              {info.jellyfin.libraryIds.length} configured librar
              {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"} (grants are
              not changed here)
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="int-jf-url">
                  Jellyfin URL
                </label>
                <input
                  id="int-jf-url"
                  type="text"
                  className="input"
                  autoComplete="off"
                  maxLength={300}
                  value={jellyfinUrl}
                  disabled={fieldsDisabled}
                  onChange={(e) => setJellyfinUrl(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="int-jf-ext">
                  Jellyfin external URL
                </label>
                <input
                  id="int-jf-ext"
                  type="text"
                  className="input"
                  autoComplete="off"
                  maxLength={300}
                  value={externalUrl}
                  disabled={fieldsDisabled}
                  onChange={(e) => setExternalUrl(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="int-jf-key">
                  Jellyfin API key
                </label>
                <input
                  id="int-jf-key"
                  type="password"
                  className="input"
                  autoComplete="off"
                  placeholder={
                    info.jellyfin.apiKeyConfigured
                      ? "Configured — leave blank to keep"
                      : "Not set"
                  }
                  value={jellyfinApiKey}
                  disabled={fieldsDisabled}
                  onChange={(e) => setJellyfinApiKey(e.target.value)}
                />
              </div>
            </div>
          </>
        ) : (
          <ConnectionSettingsPlaceholder
            service="Jellyfin"
            failed={!!loadError}
          />
        )}
      </section>
      <section className="panel p-5" aria-labelledby="whisparr-settings-title">
        <div className="settings-service-heading">
          <h2 id="whisparr-settings-title">Whisparr</h2>
          <p>
            Your download connection, delivery settings, and library path
            mappings.
          </p>
        </div>
        <WhisparrCard onForbidden={onForbidden} />
        {info ? (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="int-w-url">
                  Whisparr URL (blank removes it, with delivery settings)
                </label>
                <input
                  id="int-w-url"
                  type="text"
                  className="input"
                  autoComplete="off"
                  maxLength={300}
                  value={whisparrUrl}
                  disabled={fieldsDisabled}
                  onChange={(e) => setWhisparrUrl(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="int-w-key">
                  Whisparr API key
                </label>
                <input
                  id="int-w-key"
                  type="password"
                  className="input"
                  autoComplete="off"
                  placeholder={
                    info.whisparr?.apiKeyConfigured
                      ? "Configured — leave blank to keep"
                      : "Not set"
                  }
                  value={whisparrApiKey}
                  disabled={fieldsDisabled}
                  onChange={(e) => setWhisparrApiKey(e.target.value)}
                />
              </div>
            </div>

            <fieldset className="mt-4 border-t border-edge pt-4">
              <legend className="label">Whisparr delivery</legend>
              <p className="mt-1 text-sm text-muted">
                With delivery disabled, approved requests are held inside
                Velvarr — never dropped, never sent to Whisparr until you enable
                this.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="check"
                      checked={deliveryEnabled}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setDeliveryEnabled(e.target.checked)}
                    />
                    Send approved requests to Whisparr
                  </label>
                </div>
                <div>
                  <label className="label" htmlFor="int-w-root">
                    Root folder
                  </label>
                  {rootChoices.length > 0 ? (
                    <select
                      id="int-w-root"
                      className="input"
                      value={effectiveRoot}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setRootFolderPath(e.target.value)}
                    >
                      {rootChoices.map((path) => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="int-w-root"
                      type="text"
                      className="input"
                      autoComplete="off"
                      maxLength={1024}
                      placeholder="Whisparr download root, e.g. /data/adult"
                      value={rootFolderPath}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setRootFolderPath(e.target.value)}
                    />
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="int-w-profile">
                    Quality profile
                  </label>
                  {profileChoices.length > 0 ? (
                    <select
                      id="int-w-profile"
                      className="input"
                      value={effectiveProfile}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setQualityProfileId(e.target.value)}
                    >
                      {profileChoices.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="int-w-profile"
                      type="number"
                      min={1}
                      step={1}
                      className="input"
                      value={qualityProfileId}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setQualityProfileId(e.target.value)}
                    />
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="check"
                      checked={searchOnAdd}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) => setSearchOnAdd(e.target.checked)}
                    />
                    Search Whisparr as soon as a request is sent
                  </label>
                </div>
              </div>
            </fieldset>

            <fieldset className="mt-4 border-t border-edge pt-4">
              <legend className="label">
                Path mappings (Whisparr → Jellyfin)
              </legend>
              <p className="mt-1 text-sm text-muted">
                Prefix pairs that line Whisparr download paths up with Jellyfin
                library paths. Only needed when the two roots differ.
              </p>
              {mappings.map((m, i) => (
                <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-40 flex-1">
                    <label className="label" htmlFor={`map-w-${i}`}>
                      Whisparr prefix
                    </label>
                    <input
                      id={`map-w-${i}`}
                      type="text"
                      className="input"
                      autoComplete="off"
                      maxLength={1024}
                      value={m.whisparrPrefix}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) =>
                        setMappings((cur) =>
                          cur.map((x, j) =>
                            j === i
                              ? { ...x, whisparrPrefix: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <label className="label" htmlFor={`map-j-${i}`}>
                      Jellyfin prefix
                    </label>
                    <input
                      id={`map-j-${i}`}
                      type="text"
                      className="input"
                      autoComplete="off"
                      maxLength={1024}
                      value={m.jellyfinPrefix}
                      disabled={!hasUrl || fieldsDisabled}
                      onChange={(e) =>
                        setMappings((cur) =>
                          cur.map((x, j) =>
                            j === i
                              ? { ...x, jellyfinPrefix: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={!hasUrl || fieldsDisabled}
                    onClick={() =>
                      setMappings((cur) => cur.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn mt-3"
                disabled={!hasUrl || fieldsDisabled || mappings.length >= 50}
                onClick={() =>
                  setMappings((cur) => [
                    ...cur,
                    { whisparrPrefix: "", jellyfinPrefix: "" },
                  ])
                }
              >
                Add mapping
              </button>
            </fieldset>
          </>
        ) : (
          <ConnectionSettingsPlaceholder
            service="Whisparr"
            failed={!!loadError}
          />
        )}
      </section>
      <div className="panel p-5 settings-connection-save">
        {loadError && (
          <ErrorPanel
            title={
              saved
                ? "Saved, but settings could not be reloaded"
                : "Connection settings unavailable"
            }
            message={loadError}
            onRetry={load}
          />
        )}
        {error && <ErrorPanel title="Changes not saved" message={error} />}
        <div
          role="status"
          aria-atomic="true"
          className={saved ? "settings-save-status" : "sr-only"}
        >
          {saved}
        </div>
        <div className="settings-connection-actions">
          <p className="text-sm text-muted">
            Save changes to both connections together. Leave configured API keys
            blank to keep them.
          </p>
          <button
            type="submit"
            className="btn btn-accent"
            disabled={fieldsDisabled || !info}
          >
            {pending ? "Saving…" : "Save integrations"}
          </button>
        </div>
      </div>
    </form>
  );
}

// Configuration may fail independently of the read-only status requests.
// Keep each status card at a stable position while only its fields wait.
function ConnectionSettingsPlaceholder({
  service,
  failed,
}: {
  service: string;
  failed: boolean;
}) {
  return (
    <div className="mt-4" role="group" aria-label={`${service} settings`}>
      <p className="text-sm text-muted" role={failed ? undefined : "status"}>
        {failed
          ? "Connection settings could not be loaded. Retry below."
          : "Loading connection settings…"}
      </p>
      {!failed && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2" aria-hidden="true">
          <div className="skel h-10 w-full" />
          <div className="skel h-10 w-full" />
        </div>
      )}
    </div>
  );
}

function WhisparrCard({ onForbidden }: { onForbidden: () => void }) {
  const {
    data: status,
    error,
    err,
    revalidating,
    reload,
  } = useApiGet<WhisparrStatus>("/api/admin/whisparr", []);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const ready = status !== null || error !== null;

  // Stamp only a check that finished: a remount revalidating the cached
  // snapshot must not present it as "Checked <now>".
  useEffect(() => {
    if (status !== null && !revalidating)
      setCheckedAt(new Date().toLocaleTimeString());
  }, [status, revalidating]);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <div className="settings-connection-status">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">
          <span className="sr-only">Whisparr </span>Connection status
        </h3>
        <button
          type="button"
          className="btn"
          onClick={reload}
          disabled={revalidating}
        >
          {revalidating ? "Checking…" : "Refresh"}
        </button>
      </div>

      {!ready ? (
        <div
          className="mt-3 space-y-2"
          role="status"
          aria-label="Checking Whisparr"
        >
          <div className="skel h-5 w-1/2" />
          <div className="skel h-5 w-2/3" />
        </div>
      ) : (error ?? status?.error) ? (
        <div className="mt-3">
          <ErrorPanel
            title="Whisparr unavailable"
            message={
              error ?? `${status?.error?.code}: ${status?.error?.message}`
            }
            onRetry={reload}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Add the Whisparr URL and API key below to enable
          read-only status.
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Application</dt>
            <dd className="font-medium">
              {status.appName ?? "Whisparr"}
              {status.version ? ` ${status.version}` : ""}
            </dd>
          </div>
          {checkedAt && (
            <div className="flex gap-2">
              <dt className="text-muted">Checked</dt>
              <dd>{checkedAt}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted">Root folders</dt>
            <dd className="mt-1">
              {status.rootFolders?.length ? (
                <ul className="space-y-1">
                  {status.rootFolders.map((rf) => (
                    <li key={rf.id} className="chip">
                      {rf.path}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Quality profiles</dt>
            <dd className="mt-1">
              {status.profiles?.length ? (
                <span className="text-muted">
                  {status.profiles.map((p) => p.name).join(", ")}
                </span>
              ) : (
                <span className="text-muted">None returned</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
function JellyfinCard({ onForbidden }: { onForbidden: () => void }) {
  const {
    data: status,
    error,
    err,
    revalidating,
    reload,
  } = useApiGet<JellyfinStatus>("/api/admin/jellyfin", []);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const ready = status !== null || error !== null;

  // Stamp only a check that finished: a remount revalidating the cached
  // snapshot must not present it as "Checked <now>".
  useEffect(() => {
    if (status !== null && !revalidating)
      setCheckedAt(new Date().toLocaleTimeString());
  }, [status, revalidating]);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <div className="settings-connection-status">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">
          <span className="sr-only">Jellyfin </span>Connection status
        </h3>
        <button
          type="button"
          className="btn"
          onClick={reload}
          disabled={revalidating}
        >
          {revalidating ? "Testing…" : "Test connection"}
        </button>
      </div>

      {!ready ? (
        <div
          className="mt-3 space-y-2"
          role="status"
          aria-label="Checking Jellyfin"
        >
          <div className="skel h-5 w-1/2" />
        </div>
      ) : (error ?? status?.error) ? (
        <div className="mt-3">
          <ErrorPanel
            title="Jellyfin unavailable"
            message={
              error ?? `${status?.error?.code}: ${status?.error?.message}`
            }
            onRetry={reload}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Save the Jellyfin URL and API key below to enable the
          connection check.
        </p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Connected</dt>
            <dd className="font-medium">
              {status.serverName ?? "Jellyfin"}
              {status.version ? ` ${status.version}` : ""}
            </dd>
          </div>
          {checkedAt && (
            <div className="flex gap-2">
              <dt className="text-muted">Checked</dt>
              <dd>{checkedAt}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

// Shape of the settings response; credentials themselves are never returned.
type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};
type CredentialProvider = "tpdb" | "stashdb";
type JudgmentConfig = {
  provider: JudgmentProvider;
  url: string;
  model: string;
  configured: boolean;
  stored: boolean;
  error?: string;
};
type ProviderSettingsInfo = {
  providers: Record<CredentialProvider | "typesafe", ProviderConfigRow>;
  judgment: JudgmentConfig;
};
type ProviderSettingsPatch = Partial<
  Omit<NonNullable<IntegrationConfig["providers"]>, "judgmentProvider"> & {
    judgmentProvider: JudgmentProvider | "";
  }
>;
type SaveProviderSettings = (body: ProviderSettingsPatch) => Promise<void>;
type ProviderCheckRow =
  | { provider: CredentialProvider; configured: false }
  | {
      provider: CredentialProvider;
      configured: true;
      verified: true;
      account: string;
    }
  | {
      provider: CredentialProvider;
      configured: true;
      verified: false;
      error: { code: string; message: string };
    };

const CREDENTIAL_ROWS = [
  {
    id: "tpdb",
    name: "TPDB",
    field: "tpdbApiToken",
    label: "API token",
    maxLength: 1024,
    description: "Movie metadata, performers, studios, and tags.",
  },
  {
    id: "stashdb",
    name: "StashDB",
    field: "stashdbApiKey",
    label: "API key",
    maxLength: 512,
    description: "Scene metadata, performers, studios, and tags.",
  },
] as const;

const CONNECTION_STATE_CLASSES = {
  "Loading configuration…": "",
  "Checking…": "",
  "Unsaved changes": "",
  "Not configured": "",
  "Not checked": "",
  Connected: "is-ok",
  "Connection failed": "is-error",
  "Configuration error": "is-error",
} as const;
type ConnectionStateLabel = keyof typeof CONNECTION_STATE_CLASSES;

function ConnectionState({ state }: { state: ConnectionStateLabel }) {
  return (
    <span className={"connection-state " + CONNECTION_STATE_CLASSES[state]}>
      {state}
    </span>
  );
}

function MetadataSettings() {
  const { refreshSession } = useSession();
  const [info, setInfo] = useState<ProviderSettingsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const load = useCallback(() => {
    setLoadError(null);
    api<ProviderSettingsInfo>("/api/admin/integrations")
      .then(setInfo)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 403)
          setForbidden(true);
        else setLoadError(messageOf(error));
      });
  }, []);
  useEffect(load, [load]);

  const save: SaveProviderSettings = async (body) => {
    // Metadata and AI settings share one stored configuration. Serialize all
    // writes without resetting another card's draft.
    if (savingRef.current)
      throw new Error("Wait for the current save to finish.");
    savingRef.current = true;
    setSaving(true);
    try {
      const data = await api<ProviderSettingsInfo>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setInfo(data);
      setLoadError(null);
      refreshSession().catch(() => undefined);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (forbidden) return <ForbiddenPanel />;
  return (
    <>
      {loadError && (
        <ErrorPanel
          title="Provider configuration read failed"
          message={loadError}
          onRetry={load}
        />
      )}
      {CREDENTIAL_ROWS.map((row) => (
        <ProviderCredentialCard
          key={row.id}
          {...row}
          config={info?.providers[row.id]}
          saving={saving}
          onSave={save}
        />
      ))}
      <JudgmentCard
        config={info?.judgment}
        keyConfig={info?.providers.typesafe}
        saving={saving}
        onSave={save}
      />
    </>
  );
}

function ProviderCredentialCard({
  id,
  name,
  field,
  label,
  maxLength,
  description,
  config,
  saving,
  onSave,
}: {
  config?: ProviderConfigRow;
  saving: boolean;
  onSave: SaveProviderSettings;
} & (typeof CREDENTIAL_ROWS)[number]) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<ProviderCheckRow | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const verify = useCallback(async () => {
    setChecking(true);
    setCheck(null);
    setCheckError(null);
    try {
      setCheck(await api<ProviderCheckRow>("/api/admin/providers/" + id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      else setCheckError(messageOf(error));
    } finally {
      setChecking(false);
    }
  }, [id]);
  useEffect(() => {
    void verify();
  }, [verify]);

  function cancel() {
    setDraft("");
    setSaveError(null);
    setEditing(false);
  }

  async function apply(clear = false) {
    setSaveError(null);
    setSaved(null);
    try {
      // A blank edit keeps the current credential; removal is explicit.
      if (clear || draft.trim()) {
        await onSave({ [field]: clear ? "" : draft.trim() });
        setSaved(
          clear
            ? "Stored credential cleared. Environment settings apply."
            : "Credential saved.",
        );
      }
      setDraft("");
      setEditing(false);
      if (clear || draft.trim()) await verify();
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      else setSaveError(messageOf(error));
    }
  }

  // Checks read persisted credentials; a replacement draft is not yet verified.
  const unsaved = editing && draft.trim() !== "";
  const error =
    checkError ??
    (check?.configured && !check.verified ? check.error.message : null);
  const busy = saving || checking || forbidden;
  const connectionState: ConnectionStateLabel = (() => {
    if (checking) return "Checking…";
    if (unsaved) return "Unsaved changes";
    if (error) return "Connection failed";
    if (check?.configured && check.verified) return "Connected";
    if (!config) return "Loading configuration…";
    return config.configured ? "Not checked" : "Not configured";
  })();
  return (
    <section
      className="panel p-5 settings-service"
      aria-labelledby={"provider-heading-" + id}
    >
      <div className="settings-service-summary">
        <div className="settings-service-heading">
          <h2 id={"provider-heading-" + id}>{name}</h2>
          <p>{description}</p>
        </div>
        <div className="settings-service-buttons">
          <button
            type="button"
            className="btn"
            disabled={busy || !config || unsaved}
            title={
              unsaved
                ? "Save or cancel your changes before checking the connection."
                : undefined
            }
            onClick={() => void verify()}
          >
            Check connection
          </button>
          {!editing && (
            <button
              type="button"
              className="btn"
              disabled={busy || !config}
              aria-expanded={false}
              aria-controls={"provider-editor-" + id}
              onClick={() => {
                setSaved(null);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      <div className="settings-service-status" aria-live="polite">
        <ConnectionState state={connectionState} />
        {!unsaved && check?.configured && check.verified && (
          <span className="text-muted">{check.account}</span>
        )}
        {config?.configured && (
          <span className="chip">
            {config.source === "stored"
              ? "Stored credential"
              : "From environment"}
          </span>
        )}
      </div>
      {editing && (
        <form
          id={"provider-editor-" + id}
          className="settings-service-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && config) void apply();
          }}
        >
          <label className="label" htmlFor={"provider-" + id}>
            {name} {label}
          </label>
          <input
            id={"provider-" + id}
            className="input mt-2"
            type="password"
            autoComplete="off"
            maxLength={maxLength}
            disabled={busy || !config}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaveError(null);
            }}
            placeholder={
              config?.configured
                ? "Leave blank to keep the current credential"
                : "Enter credential"
            }
          />
          <p className="mt-2 text-sm text-muted">
            Saved credentials are encrypted and take precedence over the
            environment. Connection checks use the saved credential or
            environment fallback.
          </p>
          <div className="settings-service-buttons mt-4">
            <button
              type="submit"
              className="btn btn-accent"
              disabled={busy || !config}
            >
              Save
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={cancel}
            >
              Cancel
            </button>
            {config?.source === "stored" && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void apply(true)}
              >
                Clear stored credential
              </button>
            )}
          </div>
        </form>
      )}
      {saved && (
        <p className="mt-3 text-sm text-muted" role="status">
          {saved}
        </p>
      )}
      {saveError && (
        <div className="mt-3">
          <ErrorPanel
            title={"Saving " + name + " credential failed"}
            message={saveError}
          />
        </div>
      )}
      {error && !unsaved && (
        <div className="mt-3">
          <ErrorPanel
            title={name + " connection check failed"}
            message={error}
            onRetry={busy ? undefined : () => void verify()}
          />
        </div>
      )}
      {forbidden && (
        <p className="mt-3 text-sm text-muted">
          An administrator account is required to edit and verify credentials.
        </p>
      )}
    </section>
  );
}

/** Metadata credentials stay separate from the optional AI provider. */
function JudgmentCard({
  config,
  keyConfig,
  saving,
  onSave,
}: {
  config?: JudgmentConfig;
  keyConfig?: ProviderConfigRow;
  saving: boolean;
  onSave: SaveProviderSettings;
}) {
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<JudgmentProvider>("none");
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = saving || checking || forbidden;
  // With no configured or explicitly selected backend, present standard
  // matching. An explicit "none" save also overrides environment credentials.
  const savedProvider =
    config && !config.configured && !config.stored && !config.error
      ? "none"
      : config?.provider;
  const displayedProvider = editing ? provider : savedProvider;
  const standard = displayedProvider === "none";
  const providerName = standard
    ? "Standard matching"
    : displayedProvider === "ollama"
      ? "Ollama"
      : "TypeSafe";
  const displayedUrl = editing ? url.trim() : config?.url;
  const displayedModel = editing ? model.trim() : config?.model;
  const unsaved =
    editing &&
    Boolean(config) &&
    (provider !== savedProvider ||
      (provider === "typesafe"
        ? apiKey.trim() !== ""
        : provider === "ollama" &&
          (url.trim() !== config?.url || model.trim() !== config?.model)));
  const setupMessage =
    displayedProvider === "ollama"
      ? "Enter your Ollama URL and model, then save to check the connection."
      : "Enter your TypeSafe API key, then save to check the connection.";
  const checkDisabledReason = !config
    ? "Loading saved configuration."
    : unsaved || !config.configured
      ? setupMessage
      : config.error;

  function begin() {
    if (!config) return;
    setProvider(savedProvider ?? "none");
    setUrl(config.url);
    setModel(config.model);
    setApiKey("");
    setMessage(null);
    setSaveError(null);
    setEditing(true);
  }

  function cancel() {
    setApiKey("");
    setSaveError(null);
    setEditing(false);
  }

  async function apply(
    body: ProviderSettingsPatch,
    success: string,
    verify = false,
  ) {
    setSaveError(null);
    setMessage(null);
    try {
      await onSave(body);
      setApiKey("");
      setConnected(null);
      setEditing(false);
      // Probe only after persistence succeeds: the endpoint reads saved settings,
      // not the draft. A failed probe must not turn a successful save into an error.
      if (verify) await check();
      else setMessage(success);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      else setSaveError(messageOf(error));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !config) return;
    await apply(
      provider === "ollama"
        ? {
            judgmentProvider: provider,
            ollamaUrl: url.trim(),
            ollamaModel: model.trim(),
          }
        : {
            judgmentProvider: provider,
            ...(provider === "typesafe" && apiKey.trim()
              ? { typesafeApiKey: apiKey.trim() }
              : {}),
          },
      standard
        ? "Standard matching saved. AI-assisted matching is disabled."
        : "",
      !standard,
    );
  }

  async function check() {
    setChecking(true);
    setMessage(null);
    try {
      const result = await api<{
        provider: JudgmentProvider;
        connected: boolean;
        error?: string;
      }>("/api/admin/judgment/check", { method: "POST", body: "{}" });
      setConnected(result.connected);
      setMessage(
        result.connected
          ? `${result.provider === "ollama" ? "Ollama" : "TypeSafe"} answered a decision successfully.`
          : (result.error ?? "Connection failed."),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      setConnected(false);
      setMessage(messageOf(error));
    } finally {
      setChecking(false);
    }
  }

  const connectionState: ConnectionStateLabel = (() => {
    if (checking) return "Checking…";
    if (unsaved) return "Unsaved changes";
    if (config?.error) return "Configuration error";
    if (connected === false) return "Connection failed";
    if (connected) return "Connected";
    return config?.configured ? "Not checked" : "Not configured";
  })();
  const status = (
    <div className="settings-service-status" aria-live="polite">
      {!editing && (
        <span className="chip">
          {config
            ? standard
              ? "Standard matching (no AI)"
              : providerName
            : "Loading configuration…"}
        </span>
      )}
      {config && !standard && <ConnectionState state={connectionState} />}
    </div>
  );

  const details = (
    <>
      {status}
      {!editing && (
        <p className="mt-3 text-sm text-muted">
          {displayedProvider === "ollama"
            ? (displayedUrl || "URL not set") +
              " · " +
              (displayedModel || "Model not set")
            : "TypeSafe key: " +
              (keyConfig?.configured
                ? keyConfig.source === "stored"
                  ? "Stored"
                  : "From environment"
                : "Not configured")}
        </p>
      )}
      {!editing && checkDisabledReason && (
        <p id="judgment-check-help" className="mt-3 text-sm text-muted">
          {checkDisabledReason}
        </p>
      )}
      {config?.error && !unsaved && (
        <div className="mt-3">
          <ErrorPanel
            title="Judgment configuration error"
            message={config.error}
          />
        </div>
      )}
    </>
  );

  const checkButton = (
    <button
      type="button"
      className="btn"
      disabled={busy || Boolean(checkDisabledReason)}
      title={checkDisabledReason}
      aria-describedby={
        !editing && checkDisabledReason ? "judgment-check-help" : undefined
      }
      onClick={() => void check()}
    >
      {checking ? "Checking…" : "Check connection"}
    </button>
  );

  return (
    <section
      className="panel p-5 settings-service"
      aria-labelledby="judgment-heading"
    >
      <div className="settings-service-summary">
        <div className="settings-service-heading">
          <h2 id="judgment-heading">AI-assisted matching</h2>
        </div>
        {!editing && (
          <div className="settings-service-buttons">
            {!standard && checkButton}
            <button
              type="button"
              className="btn"
              disabled={busy || !config}
              aria-expanded={false}
              aria-controls="judgment-editor"
              onClick={begin}
            >
              Edit
            </button>
          </div>
        )}
      </div>
      {!editing &&
        (standard ? (
          <>
            {status}
            <p className="mt-3 text-sm text-muted">
              Use standard matching without calling an AI service.
            </p>
          </>
        ) : (
          <div className="mt-3">{details}</div>
        ))}
      {editing && (
        <form
          id="judgment-editor"
          className="settings-service-editor"
          onSubmit={(event) => void save(event)}
        >
          <div className="space-y-3">
            <label className="label" htmlFor="judgment-provider">
              Provider
            </label>
            <div className="settings-select max-w-md">
              <select
                id="judgment-provider"
                className="input"
                disabled={busy}
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as JudgmentProvider);
                  setSaveError(null);
                  setMessage(null);
                }}
              >
                <option value="none">Standard matching (no AI)</option>
                <option value="typesafe">TypeSafe</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            {standard ? (
              <p className="text-sm text-muted">
                Use standard matching without calling an AI service.
              </p>
            ) : (
              <>
                {details}
                {provider === "typesafe" ? (
                  <>
                    <label className="label" htmlFor="typesafe-key">
                      TypeSafe API key
                    </label>
                    <input
                      id="typesafe-key"
                      className="input"
                      type="password"
                      autoComplete="off"
                      maxLength={512}
                      disabled={busy}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        keyConfig?.configured
                          ? "Leave blank to keep the current credential"
                          : "Enter your TypeSafe API key"
                      }
                    />
                    <p className="text-sm text-muted">
                      Optional. Without a key, standard matching remains active.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="label" htmlFor="ollama-url">
                      Ollama URL
                    </label>
                    <input
                      id="ollama-url"
                      className="input"
                      type="url"
                      required
                      disabled={busy}
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                    <label className="label" htmlFor="ollama-model">
                      Decision model
                    </label>
                    <input
                      id="ollama-model"
                      className="input"
                      required
                      disabled={busy}
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <p className="text-sm text-muted">
                      Use a reachable Ollama server with a decision model such
                      as nimble or tev1.
                    </p>
                  </>
                )}
                <p className="text-sm text-muted">
                  Tag suggestions send search terms to {providerName}. Matches
                  still require administrator review.
                </p>
              </>
            )}
            <div className="settings-service-buttons">
              <button
                type="submit"
                className="btn btn-accent"
                disabled={
                  busy ||
                  (provider === "ollama" && (!url.trim() || !model.trim()))
                }
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </button>
              {!standard && checkButton}
              {provider === "typesafe" && keyConfig?.source === "stored" && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void apply(
                      { typesafeApiKey: "" },
                      "Stored TypeSafe credential cleared. Environment settings apply.",
                    )
                  }
                >
                  Clear stored credential
                </button>
              )}
              {!standard && config?.stored && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void apply(
                      { judgmentProvider: "", ollamaUrl: "", ollamaModel: "" },
                      "Using environment settings. Check the saved connection to verify the selected model.",
                    )
                  }
                >
                  Use environment settings
                </button>
              )}
            </div>
          </div>
        </form>
      )}
      {message && !unsaved && (
        <p className="mt-3 text-sm text-muted" role="status">
          {message}
        </p>
      )}
      {saveError && (
        <div className="mt-3">
          <ErrorPanel title="Saving AI settings failed" message={saveError} />
        </div>
      )}
      {forbidden && (
        <p className="mt-3 text-sm text-muted">
          An administrator account is required to configure the model.
        </p>
      )}
    </section>
  );
}
