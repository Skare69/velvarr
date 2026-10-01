"use client";

/*
 * Admin settings page: integration forms, Jellyfin/Whisparr status cards
 * and metadata provider credentials. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ProviderStatus,
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
}

interface JellyfinStatus {
  configured: boolean;
  serverName?: string;
  version?: string;
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
const PROVIDER_STATE: Record<ProviderStatus["tpdb"], string> = {
  not_configured: "Not configured",
  not_verified: "API key present — not verified",
};

/* ---------- Settings: integrations, Whisparr, providers ---------- */

export function SettingsView() {
  const { providers } = useSession();
  const [forbidden, setForbidden] = useState(false);
  const [section, setSection] = useState("connections");
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
          <div className="connection-status-grid">
            <JellyfinCard onForbidden={() => setForbidden(true)} />
            <WhisparrCard onForbidden={() => setForbidden(true)} />
          </div>
          <IntegrationsForm onForbidden={() => setForbidden(true)} />
        </div>
      </div>
      <div hidden={section !== "metadata"}>
        <ProvidersCard providers={providers} />
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
      });
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

  if (loadError)
    return (
      <ErrorPanel
        title="Integrations unavailable"
        message={loadError}
        onRetry={load}
      />
    );
  if (!info)
    return (
      <div className="panel p-4" aria-label="Loading integrations">
        <div className="skel h-40 w-full" />
      </div>
    );

  return (
    <form className="panel p-5" onSubmit={(e) => void save(e)} noValidate>
      <h3 className="font-semibold">Integrations</h3>
      <p className="mt-1 text-sm text-muted">
        Jellyfin server <span className="chip">{info.jellyfin.serverId}</span> ·{" "}
        {info.jellyfin.libraryIds.length} configured librar
        {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"} (grants are not
        changed here)
      </p>

      {error && (
        <div className="mt-4" role="alert">
          <ErrorPanel message={error} />
        </div>
      )}
      {saved && (
        <div className="panel mt-4 p-3 text-sm" role="status">
          {saved}
        </div>
      )}

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
            onChange={(e) => setJellyfinApiKey(e.target.value)}
          />
        </div>
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
            onChange={(e) => setWhisparrApiKey(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Whisparr delivery</legend>
        <p className="mt-1 text-sm text-muted">
          With delivery disabled, approved requests are held inside Velvarr —
          never dropped, never sent to Whisparr until you enable this.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="check"
                checked={deliveryEnabled}
                disabled={!hasUrl || pending}
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
                disabled={!hasUrl || pending}
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
                disabled={!hasUrl || pending}
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
                disabled={!hasUrl || pending}
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
                disabled={!hasUrl || pending}
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
                disabled={!hasUrl || pending}
                onChange={(e) => setSearchOnAdd(e.target.checked)}
              />
              Search Whisparr as soon as a request is sent
            </label>
          </div>
        </div>
      </fieldset>

      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Path mappings (Whisparr → Jellyfin)</legend>
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
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, whisparrPrefix: e.target.value } : x,
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
                disabled={!hasUrl || pending}
                onChange={(e) =>
                  setMappings((cur) =>
                    cur.map((x, j) =>
                      j === i ? { ...x, jellyfinPrefix: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={!hasUrl || pending}
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
          disabled={!hasUrl || pending || mappings.length >= 50}
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

      <button type="submit" className="btn btn-accent mt-4" disabled={pending}>
        {pending ? "Saving…" : "Save integrations"}
      </button>
    </form>
  );
}

function WhisparrCard({ onForbidden }: { onForbidden: () => void }) {
  const {
    data: status,
    error,
    err,
    loading,
    reload,
  } = useApiGet<WhisparrStatus>("/api/admin/whisparr", []);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const ready = status !== null || error !== null;

  useEffect(() => {
    if (status !== null) setCheckedAt(new Date().toLocaleTimeString());
  }, [status]);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Whisparr</h3>
        <button
          type="button"
          className="btn"
          onClick={reload}
          disabled={loading}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {!ready ? (
        <div className="mt-3 space-y-2" aria-label="Checking Whisparr">
          <div className="skel h-5 w-1/2" />
          <div className="skel h-5 w-2/3" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Whisparr unavailable"
            message={error}
            onRetry={reload}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Add the Whisparr URL and API key above to enable
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
    loading,
    reload,
  } = useApiGet<JellyfinStatus>("/api/admin/jellyfin", []);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const ready = status !== null || error !== null;

  useEffect(() => {
    if (status !== null) setCheckedAt(new Date().toLocaleTimeString());
  }, [status]);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">Jellyfin</h3>
        <button
          type="button"
          className="btn"
          onClick={reload}
          disabled={loading}
        >
          {loading ? "Testing…" : "Test connection"}
        </button>
      </div>

      {!ready ? (
        <div className="mt-3 space-y-2" aria-label="Checking Jellyfin">
          <div className="skel h-5 w-1/2" />
        </div>
      ) : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Jellyfin unavailable"
            message={error}
            onRetry={reload}
          />
        </div>
      ) : !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Not configured. Save the Jellyfin URL and API key above to enable the
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

// Shape of one entry in GET /api/admin/integrations → providers.
type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};

// Shape returned by GET /api/admin/providers (ProviderVerification).
type ProviderCheckRow =
  | { provider: "tpdb" | "stashdb"; configured: false }
  | {
      provider: "tpdb" | "stashdb";
      configured: true;
      verified: true;
      account: string;
    };

function ProvidersCard({ providers }: { providers: ProviderStatus | null }) {
  const [check, setCheck] = useState<ProviderCheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [shape, setShape] = useState<{
    tpdb: ProviderConfigRow;
    stashdb: ProviderConfigRow;
    typesafe: ProviderConfigRow;
  } | null>(null);
  const [tpdbToken, setTpdbToken] = useState("");
  const [stashdbKey, setStashdbKey] = useState("");
  const [typesafeKey, setTypesafeKey] = useState("");
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api<{ providers: ProviderCheckRow[] }>("/api/admin/providers")
      .then((d) => setCheck(d.providers))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(messageOf(e));
      });
  }, []);

  const loadShape = useCallback(() => {
    api<{
      providers: {
        tpdb: ProviderConfigRow;
        stashdb: ProviderConfigRow;
        typesafe: ProviderConfigRow;
      };
    }>("/api/admin/integrations")
      .then((d) => setShape(d.providers))
      .catch(() => setShape(null));
  }, []);

  useEffect(load, [load]);
  useEffect(loadShape, [loadShape]);

  const apply = async (body: Record<string, string>) => {
    setPending(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setTpdbToken("");
      setStashdbKey("");
      setTypesafeKey("");
      setSaved(true);
      load();
      loadShape();
    } catch (e) {
      setSaveError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  const save = () => {
    const body: Record<string, string> = {};
    if (tpdbToken.trim() !== "") body.tpdbApiToken = tpdbToken.trim();
    if (stashdbKey.trim() !== "") body.stashdbApiKey = stashdbKey.trim();
    if (typesafeKey.trim() !== "") body.typesafeApiKey = typesafeKey.trim();
    if (Object.keys(body).length > 0) apply(body);
  };

  const rows = [
    {
      id: "tpdb" as const,
      name: "TPDB",
      value: tpdbToken,
      field: "tpdbApiToken" as const,
      setValue: setTpdbToken,
    },
    {
      id: "stashdb" as const,
      name: "StashDB",
      value: stashdbKey,
      field: "stashdbApiKey" as const,
      setValue: setStashdbKey,
    },
    {
      id: "typesafe" as const,
      name: "TypeSafe",
      value: typesafeKey,
      field: "typesafeApiKey" as const,
      setValue: setTypesafeKey,
    },
  ];

  return (
    <div className="panel p-5">
      <h3 className="font-semibold">Metadata providers</h3>
      <p className="mt-1 text-sm text-muted">
        Credentials saved here (encrypted) take precedence over the environment;
        the live check against the provider is the real proof. A failed live
        check is an outage or a bad key, never an empty catalog.
      </p>
      <dl className="mt-3 space-y-2 text-sm">
        {rows.map(({ id, name }) => {
          const state = id === "typesafe" ? undefined : providers?.[id];
          const live = check?.find((r) => r.provider === id);
          const conf = shape?.[id];
          return (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <dt className="font-medium">{name}</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {id === "typesafe" ? (
                  <span className="chip">
                    {conf?.configured
                      ? "AI-assisted matching on"
                      : "Off — no key"}
                  </span>
                ) : (
                  <span className="chip">
                    {state ? PROVIDER_STATE[state] : "Unknown"}
                  </span>
                )}
                {conf && conf.source === "stored" ? (
                  <span className="chip chip-accent">Stored</span>
                ) : conf && conf.configured ? (
                  <span className="chip">From environment</span>
                ) : null}
                {id === "typesafe" || forbidden ? null : live ? (
                  live.configured ? (
                    <span className="chip chip-accent">
                      Verified · {live.account}
                    </span>
                  ) : (
                    <span className="chip">Live check: not configured</span>
                  )
                ) : (
                  <span className="chip">Live check pending</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {forbidden ? (
        <p className="mt-3 text-sm text-muted">
          Editing and live verification need an administrator account.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map(({ id, name, value, field, setValue }) => {
            const conf = shape?.[id];
            return (
              <div key={field}>
                <label className="label" htmlFor={`provider-${id}`}>
                  {name} {id === "tpdb" ? "API token" : "API key"}
                  {id === "typesafe" ? " (optional)" : ""}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={`provider-${id}`}
                    className="input max-w-md"
                    type="password"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={
                      conf && conf.source === "stored"
                        ? "Stored — leave blank to keep"
                        : conf && conf.configured
                          ? "Configured via environment"
                          : "Not configured"
                    }
                  />
                  {conf && conf.source === "stored" ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={pending}
                      onClick={() => apply({ [field]: "" })}
                    >
                      Clear stored
                    </button>
                  ) : null}
                </div>
                {id === "typesafe" ? (
                  <p className="mt-1 text-sm text-muted">
                    Enables AI-assisted matching: a Jellyfin item whose title
                    only nearly matches a request is judged &ldquo;same
                    work?&rdquo; and flagged for administrator review instead of
                    counting as missing. Without a key everything still works,
                    just with exact matching only.
                  </p>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-accent"
              disabled={pending}
              onClick={save}
            >
              Save credentials
            </button>
            <span className="text-sm text-muted">
              Saving stores the key encrypted and re-runs the live check.
            </span>
          </div>
          {saved ? (
            <p className="text-sm text-muted">
              Saved. Live check refreshed below.
            </p>
          ) : null}
          {saveError ? (
            <ErrorPanel
              title="Saving provider credentials failed"
              message={saveError}
              onRetry={save}
            />
          ) : null}
        </div>
      )}
      {forbidden ? null : error ? (
        <div className="mt-3">
          <ErrorPanel
            title="Live provider check failed"
            message={error}
            onRetry={load}
          />
        </div>
      ) : null}
    </div>
  );
}
