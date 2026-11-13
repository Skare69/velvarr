"use client";

/*
 * Admin settings page: integration forms, Jellyfin/Whisparr status cards
 * and metadata provider credentials. Routed by Shell (?view=settings);
 * administrator accounts only.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useReducer,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  CredentialProvider,
  ProviderCheck,
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
  Icon,
  messageOf,
  useApiGet,
  useSession,
} from "./shared.tsx";
import { LimitsPanel, ReleaseStatusPanel } from "./limits.tsx";
import {
  initJudgmentEditor,
  judgmentCheckDisabledReason,
  judgmentEditorSettings,
  providerSettingsActions,
  reduceJudgmentEditor,
} from "../lib/judgment-editor.ts";
import {
  canClearCredential,
  connectionState,
  createProviderSettingsQueue,
  settingsSectionForHash,
} from "../lib/provider-settings.ts";
import {
  applyCredentialSave,
  checkConnectionAction,
  credentialCardBusy,
  credentialEditorView,
  initCredentialCard,
  reduceCredentialCard,
  shouldAutoClearOnReject,
} from "../lib/credential-card.ts";

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

/** One editor's POST connection test of the form's current values. The saved
 * status chip never reads it: the chip describes the saved connection only. */
type DraftTest = {
  checking: boolean;
  /** Success line, e.g. "Connection works: 10.9.0". */
  ok: string | null;
  /** Upstream rejection, delivered inside the 200 status payload. */
  failed: string | null;
  /** The request itself failed, or the draft is not configured. */
  error: string | null;
};
const noDraftTest: DraftTest = {
  checking: false,
  ok: null,
  failed: null,
  error: null,
};
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
  // Stable identity: IntegrationsForm's load useCallback depends on this, so
  // a fresh arrow on every render would refetch and wipe unsaved draft edits.
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
  // Each editor's own POST test of the values on screen; results never feed
  // the saved status chip and never persist anything.
  const [jellyfinTest, setJellyfinTest] = useState<DraftTest>(noDraftTest);
  const [whisparrTest, setWhisparrTest] = useState<DraftTest>(noDraftTest);
  // Rule 35: each field's validation error shows at that field. The save-row
  // ErrorPanel stays for server errors only.
  const [fieldErrors, setFieldErrors] = useState<
    Partial<
      Record<
        "jellyfinUrl" | "externalUrl" | "whisparrUrl" | "profile" | "root",
        string
      >
    >
  >({});
  const [saved, setSaved] = useState<string | null>(null);
  // Each connection card shows its fields only while editing, like the
  // provider cards. Save submits the whole form; unchanged fields resave as
  // loaded.
  const [editing, setEditing] = useState({ jellyfin: false, whisparr: false });
  const jellyfinFocus = useEditorFocusReturn(editing.jellyfin);
  const whisparrFocus = useEditorFocusReturn(editing.whisparr);

  const applyJellyfin = (d: IntegrationsInfo) => {
    setJellyfinUrl(d.jellyfin.url);
    setExternalUrl(d.jellyfin.externalUrl);
    setJellyfinApiKey("");
  };
  const applyWhisparr = (d: IntegrationsInfo) => {
    setWhisparrUrl(d.whisparr?.url ?? "");
    setWhisparrApiKey("");
    setDeliveryEnabled(d.whisparr?.delivery?.enabled ?? false);
    setRootFolderPath(d.whisparr?.delivery?.rootFolderPath ?? "");
    setQualityProfileId(
      d.whisparr?.delivery ? String(d.whisparr.delivery.qualityProfileId) : "",
    );
    setSearchOnAdd(d.whisparr?.delivery?.searchOnAdd ?? true);
    setMappings(d.whisparr?.pathMappings ?? []);
  };

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api<IntegrationsInfo>("/api/admin/integrations")
      .then((d) => {
        setInfo(d);
        applyJellyfin(d);
        applyWhisparr(d);
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
    // apply* only call stable state setters, so they need no dependency.
  }, [onForbidden]);

  useEffect(load, [load]);

  // A card with a field error, or Whisparr with nothing configured yet,
  // stays open: hiding the field that needs input would hide the fix.
  const jellyfinOpen =
    editing.jellyfin || !!fieldErrors.jellyfinUrl || !!fieldErrors.externalUrl;
  const whisparrOpen =
    editing.whisparr ||
    (info !== null && info.whisparr === null) ||
    !!fieldErrors.whisparrUrl ||
    !!fieldErrors.profile ||
    !!fieldErrors.root;
  const cancelJellyfin = () => {
    if (info) applyJellyfin(info);
    setJellyfinTest(noDraftTest);
    setFieldErrors(({ jellyfinUrl: _u, externalUrl: _e, ...rest }) => rest);
    setEditing((s) => ({ ...s, jellyfin: false }));
  };
  const cancelWhisparr = () => {
    if (info) applyWhisparr(info);
    setWhisparrTest(noDraftTest);
    setFieldErrors(
      ({ whisparrUrl: _u, profile: _p, root: _r, ...rest }) => rest,
    );
    setError(null);
    setEditing((s) => ({ ...s, whisparr: false }));
  };

  const hasUrl = whisparrUrl.trim() !== "";
  const fieldsDisabled = pending || loading || !!loadError;

  // The POST tests fire the values currently in the form, saved secret
  // included by omission (a blank key field means "use the saved one").
  // Nothing is stored: the saved configuration only changes on Save.
  async function testJellyfin() {
    setJellyfinTest({ ...noDraftTest, checking: true });
    try {
      const status = await api<JellyfinStatus>("/api/admin/jellyfin/test", {
        method: "POST",
        body: JSON.stringify({
          url: jellyfinUrl.trim(),
          externalUrl: externalUrl.trim(),
          ...(jellyfinApiKey ? { apiKey: jellyfinApiKey } : {}),
        }),
      });
      setJellyfinTest({
        checking: false,
        ok: status.configured
          ? status.version
            ? "Connection works: " + status.version
            : "Connection works."
          : null,
        failed: status.error?.message ?? null,
        error: status.configured
          ? null
          : "Not configured — enter the API key to test.",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        onForbidden();
        return;
      }
      setJellyfinTest({ ...noDraftTest, error: messageOf(err) });
    }
  }
  async function testWhisparr() {
    setWhisparrTest({ ...noDraftTest, checking: true });
    try {
      const status = await api<WhisparrStatus>("/api/admin/whisparr/test", {
        method: "POST",
        body: JSON.stringify({
          url: whisparrUrl.trim(),
          ...(whisparrApiKey ? { apiKey: whisparrApiKey } : {}),
        }),
      });
      setWhisparrTest({
        checking: false,
        ok: status.configured
          ? status.version
            ? "Connection works: " + status.version
            : "Connection works."
          : null,
        failed: status.error?.message ?? null,
        // A blank URL means "no Whisparr", and the test reports it as such.
        error: status.configured ? null : "Whisparr is not configured.",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        onForbidden();
        return;
      }
      setWhisparrTest({ ...noDraftTest, error: messageOf(err) });
    }
  }
  // A result describes the values it tested; a changed field invalidates it.
  const jellyfinTestResult =
    jellyfinTest.failed || jellyfinTest.error ? (
      <div className="mt-3">
        <ErrorPanel
          title="Jellyfin connection test failed"
          message={jellyfinTest.failed ?? jellyfinTest.error ?? ""}
        />
      </div>
    ) : jellyfinTest.ok ? (
      <p className="mt-2 text-sm text-muted">{jellyfinTest.ok}</p>
    ) : null;
  const whisparrTestResult =
    whisparrTest.failed || whisparrTest.error ? (
      <div className="mt-3">
        <ErrorPanel
          title="Whisparr connection test failed"
          message={whisparrTest.failed ?? whisparrTest.error ?? ""}
        />
      </div>
    ) : whisparrTest.ok ? (
      <p className="mt-2 text-sm text-muted">{whisparrTest.ok}</p>
    ) : null;
  const jellyfinCheck = (
    <button
      type="button"
      className="btn"
      disabled={fieldsDisabled || jellyfinTest.checking}
      onClick={() => void testJellyfin()}
    >
      <Icon name="refresh" />
      {jellyfinTest.checking ? "Checking…" : "Check connection"}
    </button>
  );
  const whisparrCheck = (
    <button
      type="button"
      className="btn"
      disabled={fieldsDisabled || whisparrTest.checking}
      onClick={() => void testWhisparr()}
    >
      <Icon name="refresh" />
      {whisparrTest.checking ? "Checking…" : "Check connection"}
    </button>
  );

  // Select choices; the currently stored value is always offered so a stale
  // status can never silently change what will be saved.
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
    setFieldErrors({});
    const fe: typeof fieldErrors = {};
    if (!jellyfinUrl.trim()) fe.jellyfinUrl = "Enter the Jellyfin URL.";
    if (!externalUrl.trim())
      fe.externalUrl = "Enter the Jellyfin external URL.";
    if (!hasUrl && whisparrApiKey.trim() !== "") {
      fe.whisparrUrl =
        "A Whisparr API key needs the Whisparr URL — the URL is the connection, the key authenticates it.";
    }
    const profile = Number(effectiveProfile);
    if (
      hasUrl &&
      (deliveryEnabled || info?.whisparr?.delivery) &&
      (!Number.isInteger(profile) || profile < 1)
    ) {
      fe.profile = "Choose a quality profile (a positive whole number).";
    }
    if (hasUrl && deliveryEnabled && !effectiveRoot.trim()) {
      fe.root = "A root folder is required while delivery is enabled.";
    }
    if (Object.keys(fe).length > 0) {
      setFieldErrors(fe);
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
      setJellyfinTest(noDraftTest);
      setWhisparrTest(noDraftTest);
      setSaved("Integrations updated.");
      setEditing({ jellyfin: false, whisparr: false });
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
        <JellyfinCard
          onForbidden={onForbidden}
          open={jellyfinOpen}
          check={jellyfinCheck}
          testResult={jellyfinTestResult}
          actions={
            !info ? null : jellyfinOpen ? (
              <>
                <button
                  type="submit"
                  className="btn btn-accent"
                  disabled={fieldsDisabled}
                  aria-busy={pending || undefined}
                >
                  <Icon name="check" />
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pending}
                  onClick={cancelJellyfin}
                >
                  <Icon name="close" />
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                ref={jellyfinFocus.editRef}
                className="btn"
                disabled={fieldsDisabled}
                onClick={() => setEditing((s) => ({ ...s, jellyfin: true }))}
              >
                <Icon name="edit" />
                Edit
              </button>
            )
          }
        >
          {info && (
            <p className="mt-3 text-sm text-muted">
              Server <span className="chip">{info.jellyfin.serverId}</span> ·{" "}
              {info.jellyfin.libraryIds.length} configured librar
              {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"} (grants are
              not changed here)
            </p>
          )}
          {info ? (
            jellyfinOpen && (
              <>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="int-jf-url">
                      Jellyfin URL
                    </label>
                    <input
                      id="int-jf-url"
                      type="url"
                      autoComplete="url"
                      className="input"
                      maxLength={300}
                      value={jellyfinUrl}
                      disabled={fieldsDisabled}
                      onChange={(e) => {
                        setJellyfinUrl(e.target.value);
                        setJellyfinTest(noDraftTest);
                      }}
                      aria-invalid={fieldErrors.jellyfinUrl ? true : undefined}
                      aria-describedby={
                        fieldErrors.jellyfinUrl ? "int-jf-url-error" : undefined
                      }
                    />
                    {fieldErrors.jellyfinUrl && (
                      <p
                        id="int-jf-url-error"
                        className="mt-2 text-sm text-danger"
                      >
                        {fieldErrors.jellyfinUrl}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="label" htmlFor="int-jf-ext">
                      Jellyfin external URL
                    </label>
                    <input
                      id="int-jf-ext"
                      type="url"
                      autoComplete="url"
                      className="input"
                      maxLength={300}
                      value={externalUrl}
                      disabled={fieldsDisabled}
                      onChange={(e) => {
                        setExternalUrl(e.target.value);
                        setJellyfinTest(noDraftTest);
                      }}
                      aria-invalid={fieldErrors.externalUrl ? true : undefined}
                      aria-describedby={
                        fieldErrors.externalUrl ? "int-jf-ext-error" : undefined
                      }
                    />
                    {fieldErrors.externalUrl && (
                      <p
                        id="int-jf-ext-error"
                        className="mt-2 text-sm text-danger"
                      >
                        {fieldErrors.externalUrl}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="label" htmlFor="int-jf-key">
                      Jellyfin API key (optional)
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
                      onChange={(e) => {
                        setJellyfinApiKey(e.target.value);
                        setJellyfinTest(noDraftTest);
                      }}
                    />
                  </div>
                </div>
              </>
            )
          ) : (
            <ConnectionSettingsPlaceholder
              service="Jellyfin"
              failed={!!loadError}
            />
          )}
        </JellyfinCard>
      </section>
      <section className="panel p-5" aria-labelledby="whisparr-settings-title">
        <WhisparrCard
          onForbidden={onForbidden}
          open={whisparrOpen}
          check={whisparrCheck}
          testResult={whisparrTestResult}
          actions={
            !info ? null : whisparrOpen ? (
              <>
                <button
                  type="submit"
                  className="btn btn-accent"
                  disabled={fieldsDisabled}
                  aria-busy={pending || undefined}
                >
                  <Icon name="check" />
                  {pending ? "Saving…" : "Save"}
                </button>
                {info.whisparr !== null && (
                  <button
                    type="button"
                    className="btn"
                    disabled={pending}
                    onClick={cancelWhisparr}
                  >
                    <Icon name="close" />
                    Cancel
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                ref={whisparrFocus.editRef}
                className="btn"
                disabled={fieldsDisabled}
                onClick={() => setEditing((s) => ({ ...s, whisparr: true }))}
              >
                <Icon name="edit" />
                Edit
              </button>
            )
          }
        >
          {info ? (
            whisparrOpen && (
              <>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="int-w-url">
                      Whisparr URL (blank removes it, with delivery settings)
                    </label>
                    <input
                      id="int-w-url"
                      type="url"
                      autoComplete="url"
                      className="input"
                      maxLength={300}
                      value={whisparrUrl}
                      disabled={fieldsDisabled}
                      onChange={(e) => {
                        setWhisparrUrl(e.target.value);
                        setWhisparrTest(noDraftTest);
                      }}
                      aria-invalid={fieldErrors.whisparrUrl ? true : undefined}
                      aria-describedby={
                        fieldErrors.whisparrUrl ? "int-w-url-error" : undefined
                      }
                    />
                    {fieldErrors.whisparrUrl && (
                      <p
                        id="int-w-url-error"
                        className="mt-2 text-sm text-danger"
                      >
                        {fieldErrors.whisparrUrl}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="label" htmlFor="int-w-key">
                      Whisparr API key (optional)
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
                      onChange={(e) => {
                        setWhisparrApiKey(e.target.value);
                        setWhisparrTest(noDraftTest);
                      }}
                    />
                  </div>
                </div>

                <fieldset className="mt-4 border-t border-edge pt-4">
                  <legend className="label">Whisparr delivery</legend>
                  <p className="mt-1 text-sm text-muted">
                    With delivery disabled, approved requests are held inside
                    Velvarr — never dropped, never sent to Whisparr until you
                    enable this.
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
                          aria-invalid={fieldErrors.root ? true : undefined}
                          aria-describedby={
                            fieldErrors.root ? "int-w-root-error" : undefined
                          }
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
                          aria-invalid={fieldErrors.root ? true : undefined}
                          aria-describedby={
                            fieldErrors.root ? "int-w-root-error" : undefined
                          }
                        />
                      )}
                      {fieldErrors.root && (
                        <p
                          id="int-w-root-error"
                          className="mt-2 text-sm text-danger"
                        >
                          {fieldErrors.root}
                        </p>
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
                          aria-invalid={fieldErrors.profile ? true : undefined}
                          aria-describedby={
                            fieldErrors.profile
                              ? "int-w-profile-error"
                              : undefined
                          }
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
                          aria-invalid={fieldErrors.profile ? true : undefined}
                          aria-describedby={
                            fieldErrors.profile
                              ? "int-w-profile-error"
                              : undefined
                          }
                        />
                      )}
                      {fieldErrors.profile && (
                        <p
                          id="int-w-profile-error"
                          className="mt-2 text-sm text-danger"
                        >
                          {fieldErrors.profile}
                        </p>
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
                    Prefix pairs that line Whisparr download paths up with
                    Jellyfin library paths. Only needed when the two roots
                    differ.
                  </p>
                  {mappings.map((m, i) => (
                    <div
                      key={i}
                      className="mt-2 flex flex-wrap items-end gap-2"
                    >
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
                    disabled={
                      !hasUrl || fieldsDisabled || mappings.length >= 50
                    }
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
            )
          ) : (
            <ConnectionSettingsPlaceholder
              service="Whisparr"
              failed={!!loadError}
            />
          )}
        </WhisparrCard>
      </section>
      {(loadError || error || saved) && (
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
        </div>
      )}
      {/* Always mounted, so a screen reader announces the save result. */}
      <div
        role="status"
        aria-atomic="true"
        className={saved ? "settings-save-status" : "sr-only"}
      >
        {saved}
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

function WhisparrCard({
  onForbidden,
  children,
  actions,
  open,
  check,
  testResult,
}: {
  onForbidden: () => void;
  /** The card's settings fields. */
  children: ReactNode;
  /** Edit, or Save and Cancel while open. */
  actions: ReactNode;
  /** The settings editor is open. */
  open: boolean;
  /** The open editor's Check connection button (POSTs the form draft). */
  check: ReactNode;
  /** The draft test's result, shown under the action row. */
  testResult?: ReactNode;
}) {
  const {
    data: status,
    error,
    err,
    revalidating,
    reload,
  } = useApiGet<WhisparrStatus>("/api/admin/whisparr", []);
  const ready = status !== null || error !== null;
  const savedCheckFailed = Boolean(error ?? status?.error);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <>
      <ServiceHeading
        id="whisparr-settings-title"
        title="Whisparr"
        description="Your download connection, delivery settings, and library path mappings."
        state={serviceState(ready, savedCheckFailed, status)}
        detail={
          status?.configured && !savedCheckFailed
            ? `${status.appName ?? "Whisparr"} ${status.version ?? ""}`.trim()
            : null
        }
      />
      {savedCheckFailed ? (
        <div className="mt-3">
          <ErrorPanel
            title="Whisparr unavailable"
            message={
              error ?? `${status?.error?.code}: ${status?.error?.message}`
            }
          />
        </div>
      ) : ready && !status?.configured ? (
        <p className="mt-3 text-sm text-muted">
          Add the Whisparr URL and API key below to enable read-only status.
        </p>
      ) : !status?.configured ? null : (
        <dl className="mt-3 space-y-2 text-sm">
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
      {children}
      <CheckConnectionRow
        reload={reload}
        checking={revalidating}
        retry={
          checkConnectionAction({
            editorOpen: open,
            savedCheckFailed,
          }) === "retry"
        }
        check={open ? check : null}
      >
        {actions}
      </CheckConnectionRow>
      {open ? testResult : null}
    </>
  );
}
function JellyfinCard({
  onForbidden,
  children,
  actions,
  open,
  check,
  testResult,
}: {
  onForbidden: () => void;
  /** The card's settings fields. */
  children: ReactNode;
  /** Edit, or Save and Cancel while open. */
  actions: ReactNode;
  /** The settings editor is open. */
  open: boolean;
  /** The open editor's Check connection button (POSTs the form draft). */
  check: ReactNode;
  /** The draft test's result, shown under the action row. */
  testResult?: ReactNode;
}) {
  const {
    data: status,
    error,
    err,
    revalidating,
    reload,
  } = useApiGet<JellyfinStatus>("/api/admin/jellyfin", []);
  const ready = status !== null || error !== null;
  const savedCheckFailed = Boolean(error ?? status?.error);

  useEffect(() => {
    if (err !== null && err.status === 403) onForbidden();
  }, [err, onForbidden]);

  return (
    <>
      <ServiceHeading
        id="jellyfin-settings-title"
        title="Jellyfin"
        description="Your media server, accounts, and playback connection."
        state={serviceState(ready, savedCheckFailed, status)}
        detail={
          status?.configured && !savedCheckFailed
            ? `${status.serverName ?? "Jellyfin"} ${status.version ?? ""}`.trim()
            : null
        }
      />
      {savedCheckFailed ? (
        <div className="mt-3">
          <ErrorPanel
            title="Jellyfin unavailable"
            message={
              error ?? `${status?.error?.code}: ${status?.error?.message}`
            }
          />
        </div>
      ) : (
        ready &&
        !status?.configured && (
          <p className="mt-3 text-sm text-muted">
            Save the Jellyfin URL and API key below to enable the connection
            check.
          </p>
        )
      )}
      {children}
      <CheckConnectionRow
        reload={reload}
        checking={revalidating}
        retry={
          checkConnectionAction({
            editorOpen: open,
            savedCheckFailed,
          }) === "retry"
        }
        check={open ? check : null}
      >
        {actions}
      </CheckConnectionRow>
      {open ? testResult : null}
    </>
  );
}

/** Title with its status chip beside it, then the description, as on the
 * provider cards. `detail` names the connected server and version; it shows
 * only while the saved check is Connected, and absent fields are dropped. */
function ServiceHeading({
  id,
  title,
  description,
  state,
  detail,
}: {
  id: string;
  title: string;
  description: string;
  state: ConnectionStateLabel;
  detail?: string | null;
}) {
  return (
    <div className="settings-service-heading">
      <div className="settings-title-row">
        <h2 id={id}>{title}</h2>
        <div className="settings-service-status" aria-live="polite">
          <ConnectionState state={state} />
          {state === "Connected" && detail ? (
            <span className="text-muted">{detail}</span>
          ) : null}
        </div>
      </div>
      <p>{description}</p>
    </div>
  );
}

/** The card's one action row, right-aligned after its content without a
 * divider: Edit (or Save and Cancel plus the editor's Check connection while
 * open), then — on a closed card whose saved check failed — the GET probe
 * again. */
function CheckConnectionRow({
  reload,
  checking,
  retry,
  check,
  children,
}: {
  reload: () => void;
  checking: boolean;
  /** Closed card with a failed saved check: show the GET retry. */
  retry: boolean;
  /** The open editor's Check connection button, if the editor is open. */
  check: ReactNode | null;
  children: ReactNode;
}) {
  return (
    <div className="settings-service-buttons settings-card-actions">
      {children}
      {check}
      {retry && (
        <button
          type="button"
          className="btn"
          onClick={reload}
          disabled={checking}
        >
          <Icon name="refresh" />
          {checking ? "Checking…" : "Check connection"}
        </button>
      )}
    </div>
  );
}

// Shape of the settings response; credentials themselves are never returned.
type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};
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
type SaveProviderSettings = (
  body: ProviderSettingsPatch,
) => Promise<ProviderSettingsInfo>;
type RunProviderOperation = <T>(operation: () => Promise<T>) => Promise<T>;

const CREDENTIAL_ROWS = [
  {
    id: "tpdb",
    name: "TPDB",
    field: "tpdbApiToken",
    label: "API token",
    maxLength: 1024,
    description: "Movie metadata, performers, studios, and tags.",
    keyUrl: "https://theporndb.net/user/api-tokens",
    keyHelp: "Create a token under API tokens on ThePornDB.",
  },
  {
    id: "stashdb",
    name: "StashDB",
    field: "stashdbApiKey",
    label: "API key",
    maxLength: 512,
    description: "Scene metadata, performers, studios, and tags.",
    // The key lives on the account's own user page (/users/<name>), which
    // Velvarr cannot know, so the link opens the site and the text says where.
    keyUrl: "https://stashdb.org/",
    keyHelp: "Sign in, open your user page, and copy the API key there.",
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

/** Jellyfin and Whisparr speak the same status chip as the provider cards. */
function serviceState(
  ready: boolean,
  failed: boolean,
  status: { configured?: boolean } | null,
): ConnectionStateLabel {
  if (!ready) return "Checking…";
  if (failed) return "Connection failed";
  return status?.configured ? "Connected" : "Not configured";
}

/** WCAG 2.4.3 (focus order): closing an inline editor must not drop keyboard
 * focus on <body>. Focus returns to the card's Edit button; while the
 * post-save probe keeps that button disabled, focus parks on the save
 * notice line (tabIndex={-1}) instead. */
function useEditorFocusReturn(editing: boolean) {
  const editRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const closePending = useRef(false);
  useEffect(() => {
    if (editing) {
      closePending.current = true;
      return;
    }
    if (!closePending.current) return;
    closePending.current = false;
    const edit = editRef.current;
    if (edit && !edit.disabled) edit.focus();
    else noticeRef.current?.focus();
  }, [editing]);
  return { editRef, noticeRef };
}

function MetadataSettings() {
  const { refreshSession } = useSession();
  const [info, setInfo] = useState<ProviderSettingsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runQueued] = useState(createProviderSettingsQueue);
  const operationCount = useRef(0);
  const runOperation: RunProviderOperation = useCallback(
    async (operation) => {
      operationCount.current++;
      setSaving(true);
      try {
        return await runQueued(operation);
      } finally {
        operationCount.current--;
        if (operationCount.current === 0) setSaving(false);
      }
    },
    [runQueued],
  );

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

  const save: SaveProviderSettings = (body) =>
    runOperation(async () => {
      // All metadata/AI saves and probes use one queue. A probe always reads
      // persisted settings, and a failed operation cannot block the next one.
      const data = await api<ProviderSettingsInfo>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setInfo(data);
      setLoadError(null);
      refreshSession().catch(() => undefined);
      return data;
    });

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
          runOperation={runOperation}
          onSave={save}
        />
      ))}
      <JudgmentCard
        config={info?.judgment}
        keyConfig={info?.providers.typesafe}
        saving={saving}
        runOperation={runOperation}
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
  keyUrl,
  keyHelp,
  config,
  saving,
  onSave,
  runOperation,
}: {
  config?: ProviderConfigRow;
  saving: boolean;
  onSave: SaveProviderSettings;
  runOperation: RunProviderOperation;
} & (typeof CREDENTIAL_ROWS)[number]) {
  const [editor, dispatch] = useReducer(
    reduceCredentialCard,
    undefined,
    initCredentialCard,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // A missing key has nothing to show but its input, so the editor stays open.
  const editorOpen = editor.editing || config?.configured === false;
  // Focus returns when the editor closes, also after a first key's save.
  const { editRef, noticeRef } = useEditorFocusReturn(editorOpen);
  // Deleting a stored credential is destructive, so the click first opens this
  // confirmation; the id must be unique — this card renders once per provider.
  const clearRef = useRef<HTMLDialogElement>(null);
  const clearTitleId = useId();
  useEffect(() => {
    if (editor.editing) inputRef.current?.focus();
  }, [editor.editing]);

  const verify = useCallback(async () => {
    dispatch({ type: "checking" });
    try {
      dispatch({
        type: "checked",
        check: await runOperation(() =>
          api<ProviderCheck>("/api/admin/providers/" + id),
        ),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        dispatch({ type: "forbidden" });
      else dispatch({ type: "checkFailed", message: messageOf(error) });
    }
  }, [id, runOperation]);

  // The editor's test: POSTs the values on screen (blank key = saved
  // credential), stores nothing. Its result lands in draftCheck, which the
  // rejected-key auto-delete never reads — only the saved probe (`check`) is.
  const testDraft = useCallback(async () => {
    dispatch({ type: "draftChecking" });
    try {
      const key = editor.draft.trim();
      dispatch({
        type: "draftChecked",
        check: await runOperation(() =>
          api<ProviderCheck>("/api/admin/providers/" + id + "/test", {
            method: "POST",
            body: JSON.stringify(key === "" ? {} : { key }),
          }),
        ),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        dispatch({ type: "forbidden" });
      else dispatch({ type: "draftCheckFailed", message: messageOf(error) });
    }
  }, [id, runOperation, editor.draft]);
  useEffect(() => {
    void verify();
  }, [verify]);

  function cancel() {
    dispatch({ type: "cancel" });
  }

  // One classifier for every save/clear path, so a 403 always becomes the
  // card's forbidden state, never an error row.
  const failureOf = (error: unknown) => ({
    forbidden: error instanceof ApiError && error.status === 403,
    message: messageOf(error),
  });

  async function apply(clear = false) {
    const { saved } = await applyCredentialSave({
      draft: editor.draft,
      clear,
      configured: config?.configured,
      name,
      label,
      performSave: (value) => onSave({ [field]: value }).then(() => undefined),
      dispatch,
      failureOf,
    });
    if (saved) await verify();
  }

  // A stored credential the provider just rejected deletes itself at once —
  // no dialog, the provider proved the key wrong. An environment source never
  // enters here. One delete at a time: results that land while a clear and
  // its re-check are in flight (a config refresh, a duplicate check, the
  // re-check itself) are skipped, so a rejected fallback cannot loop.
  const clearing = useRef(false);
  useEffect(() => {
    if (!editor.check || !config || clearing.current) return;
    if (
      !shouldAutoClearOnReject({ check: editor.check, source: config.source })
    )
      return;
    clearing.current = true;
    void (async () => {
      try {
        const { saved } = await applyCredentialSave({
          draft: "",
          clear: true,
          configured: config.configured,
          name,
          label,
          clearNotice:
            name +
            " rejected the stored " +
            label +
            ", so Velvarr deleted it. Add a new " +
            label +
            ".",
          performSave: (value) =>
            onSave({ [field]: value }).then(() => undefined),
          dispatch,
          failureOf,
        });
        if (saved) await verify();
      } finally {
        clearing.current = false;
      }
    })();
  }, [editor.check, config]);

  // Checks read persisted credentials; a replacement draft is not yet verified.
  const unsaved = editorOpen && editor.draft.trim() !== "";
  const error =
    editor.checkError ??
    (editor.check?.configured && !editor.check.verified
      ? editor.check.error.message
      : null);
  const busy = credentialCardBusy(editor, saving);
  const actions = {
    canEdit: !busy && Boolean(config),
    canClear: canClearCredential({ source: config?.source, pending: busy }),
  };
  const state = connectionState({
    draft: editorOpen ? editor.draft : "",
    checking: editor.checking,
    check: editor.check,
    requestError: editor.checkError,
  });
  const stateLabels = {
    unsaved: "Unsaved changes",
    checking: "Checking…",
    connected: "Connected",
    failed: "Connection failed",
    not_configured: "Not configured",
    unknown: "Not checked",
  } as const;
  const connectionStateLabel: ConnectionStateLabel = stateLabels[state];
  // One Check connection at a time: the open editor's POST of the draft
  // values, or — on a closed card whose saved check failed — the GET retry.
  // A connected or unchecked closed card shows no Check: the page probed the
  // saved connection on load, and the chip beside the title carries it.
  const checkMode = checkConnectionAction({
    editorOpen,
    savedCheckFailed: error !== null,
  });
  const checkButton =
    checkMode === null ? null : (
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void (checkMode === "draft" ? testDraft() : verify())}
      >
        <Icon name="refresh" />
        {editor.draftChecking || editor.checking
          ? "Checking…"
          : "Check connection"}
      </button>
    );
  // The draft test's verdict, under the editor's action row. It dies with
  // the draft (reduceCredentialCard clears it on edit/cancel/save), and the
  // auto-clear never reads it.
  const draftTest = editor.draftCheckError
    ? { ok: null as string | null, failed: editor.draftCheckError }
    : editor.draftCheck === null
      ? null
      : !editor.draftCheck.configured
        ? { ok: name + " is not configured.", failed: null }
        : editor.draftCheck.verified
          ? {
              ok: "Connection works: " + editor.draftCheck.account,
              failed: null,
            }
          : { ok: null, failed: editor.draftCheck.error.message };
  return (
    <section className="panel p-5" aria-labelledby={"provider-heading-" + id}>
      <div className="settings-service-summary">
        <div className="settings-service-heading">
          {/* The status sits right beside the title it describes. */}
          <div className="settings-title-row">
            {/* tabIndex=-1: the deep-link reveal focuses this heading, which
                keeps the announcement with the target instead of page top. */}
            <h2 id={"provider-heading-" + id} tabIndex={-1}>
              {name}
            </h2>
            <div className="settings-service-status" aria-live="polite">
              <ConnectionState state={connectionStateLabel} />
              {/* A stored key is the default; only the environment source
                  needs saying (it is why no Clear button shows). */}
              {config?.configured && config.source === "environment" && (
                <span className="chip">From environment</span>
              )}
            </div>
          </div>
          <p>{description}</p>
          {/* Where to get a key matters only while none is configured. */}
          {config?.configured === false && (
            <p>
              {keyHelp}{" "}
              <a
                className="settings-key-link"
                href={keyUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {new URL(keyUrl).host}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          )}
        </div>
      </div>
      {/* Rule 26: a check failure sits right under the status it explains,
       * above the editor. The "Check connection" button is the retry. */}
      {error && !unsaved && (
        <div className="mt-3">
          <ErrorPanel
            title={name + " connection check failed"}
            message={error}
          />
        </div>
      )}
      {/* One action row, right-aligned after the content, no divider:
          Edit and Check connection; while editing, the editor's own row
          holds Save, Cancel, and Check connection. */}
      {!editorOpen && (
        <div className="settings-service-buttons settings-card-actions">
          <button
            type="button"
            ref={editRef}
            className="btn"
            disabled={!actions.canEdit}
            onClick={() => dispatch({ type: "edit" })}
          >
            <Icon name="edit" />
            Edit
          </button>
          {checkButton}
        </div>
      )}
      {editorOpen &&
        credentialEditorView({
          id,
          name,
          label,
          maxLength,
          configured: config?.configured,
          state: editor,
          canEdit: actions.canEdit,
          busy,
          saving,
          inputRef,
          onDraftChange: (value) => dispatch({ type: "draft", value }),
          onCancel: cancel,
          onSubmit: (event) => {
            event.preventDefault();
            if (!busy && config) void apply();
          },
          trailing: checkButton,
          icons: {
            save: <Icon name="check" />,
            cancel: <Icon name="close" />,
          },
        })}
      {/* The draft test's verdict, under the editor's action row. */}
      {editorOpen && draftTest?.failed && (
        <div className="mt-3">
          <ErrorPanel
            title={name + " connection test failed"}
            message={draftTest.failed}
          />
        </div>
      )}
      {editorOpen && draftTest?.ok && (
        <p className="mt-2 text-sm text-muted">{draftTest.ok}</p>
      )}
      {config?.configured && config.source === "stored" && (
        <>
          {/* Deleting the stored credential is destructive, so the action
              lives in its own row below the card's content and asks first.
              It shows without Edit: removing a key needs no new one. */}
          <div className="settings-destructive-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={!actions.canClear}
              onClick={() => clearRef.current?.showModal()}
            >
              <Icon name="trash" />
              Clear stored credential
            </button>
          </div>
          <dialog
            ref={clearRef}
            className="bulk-dialog"
            aria-labelledby={clearTitleId}
          >
            <div className="p-5">
              <h3 id={clearTitleId} className="font-semibold">
                Clear the stored {name} credential?
              </h3>
              <p className="mt-2 text-sm text-muted">
                The encrypted credential is deleted from storage. {name} then
                falls back to the environment settings, and connection checks
                use that fallback.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => clearRef.current?.close()}
                >
                  Keep credential
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!actions.canClear}
                  onClick={() => {
                    clearRef.current?.close();
                    void apply(true);
                  }}
                >
                  Clear credential
                </button>
              </div>
            </div>
          </dialog>
        </>
      )}
      {editor.saved && (
        <p
          ref={noticeRef}
          className="mt-3 text-sm text-muted"
          role="status"
          tabIndex={-1}
        >
          {editor.saved}
        </p>
      )}
      {editor.saveError && (
        <div className="mt-3">
          <ErrorPanel
            title={"Saving " + name + " credential failed"}
            message={editor.saveError}
          />
        </div>
      )}
      {editor.forbidden && (
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
  runOperation,
}: {
  config?: JudgmentConfig;
  keyConfig?: ProviderConfigRow;
  saving: boolean;
  onSave: SaveProviderSettings;
  runOperation: RunProviderOperation;
}) {
  const [editor, dispatch] = useReducer(
    reduceJudgmentEditor,
    undefined,
    initJudgmentEditor,
  );
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The provider choice is a segmented control now; opening the editor puts
  // the focus on the selected segment.
  const selectRef = useRef<HTMLButtonElement>(null);
  const { editRef, noticeRef } = useEditorFocusReturn(editing);
  // Both actions below delete stored settings, so each click first opens a
  // confirmation dialog (unique ids: dialogs resolve aria-labelledby by id).
  const clearKeyRef = useRef<HTMLDialogElement>(null);
  const useEnvRef = useRef<HTMLDialogElement>(null);
  const clearKeyTitleId = useId();
  const useEnvTitleId = useId();
  const { provider, url, model } = editor.draft;
  const checking = editor.check?.state === "checking";
  const connected = editor.check?.state === "connected";
  const busy = saving || checking || forbidden;
  const actions = providerSettingsActions(editor, {
    ready: Boolean(config),
    pending: saving || forbidden,
    configured: Boolean(config?.configured),
  });
  const savedProvider = config && judgmentEditorSettings(config).provider;
  useEffect(() => {
    if (!config) return;
    const settings = judgmentEditorSettings(config);
    if (
      settings.provider !== editor.saved.provider ||
      settings.url !== editor.saved.url ||
      settings.model !== editor.saved.model
    ) {
      dispatch({ type: "loaded", settings });
    }
  }, [config, editor.saved]);
  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);
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
  const checkDisabledReason = judgmentCheckDisabledReason(
    config,
    unsaved,
    setupMessage,
  );

  function begin() {
    if (!config) return;
    dispatch({ type: "cancel" });
    setApiKey("");
    setSaveError(null);
    setEditing(true);
  }

  function cancel() {
    setApiKey("");
    setSaveError(null);
    dispatch({ type: "cancel" });
    setEditing(false);
  }

  async function apply(
    body: ProviderSettingsPatch,
    success: string,
    verify = false,
  ) {
    setSaveError(null);
    try {
      const data = await onSave(body);
      setApiKey("");
      dispatch({
        type: "saved",
        settings: judgmentEditorSettings(data.judgment),
        notice: success,
      });
      setEditing(false);
      // Probe only after persistence succeeds: the endpoint reads saved settings,
      // not the draft. A failed probe must not turn a successful save into an error.
      if (verify && data.judgment.configured) await check();
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
        : "Settings saved.",
      !standard,
    );
  }

  async function check() {
    dispatch({ type: "checking" });
    try {
      const result = await runOperation(() =>
        api<{
          provider: JudgmentProvider;
          connected: boolean;
          error?: string;
        }>("/api/admin/judgment/check", { method: "POST", body: "{}" }),
      );
      dispatch({
        type: "checked",
        result: result.connected
          ? { connected: true, provider: result.provider }
          : { connected: false, message: result.error ?? "Connection failed." },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      dispatch({
        type: "checked",
        result: { connected: false, message: messageOf(error) },
      });
    }
  }

  const connectionState: ConnectionStateLabel = (() => {
    if (checking) return "Checking…";
    if (unsaved) return "Unsaved changes";
    if (config?.error) return "Configuration error";
    if (editor.check?.state === "failed") return "Connection failed";
    if (connected) return "Connected";
    return config?.configured ? "Not checked" : "Not configured";
  })();
  const status = (
    <div className="settings-service-status" aria-live="polite">
      {config && !standard && <ConnectionState state={connectionState} />}
      {!editing && (
        <span className={config && !standard ? "text-muted" : "chip"}>
          {config
            ? standard
              ? "Standard matching (no AI)"
              : providerName
            : "Loading configuration…"}
        </span>
      )}
    </div>
  );

  const details = (
    <>
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
      {checkDisabledReason && (
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
      aria-describedby={checkDisabledReason ? "judgment-check-help" : undefined}
      onClick={() => void check()}
    >
      <Icon name="refresh" />
      {checking ? "Checking…" : "Check connection"}
    </button>
  );

  return (
    <section className="panel p-5" aria-labelledby="judgment-heading">
      <div className="settings-service-summary">
        <div className="settings-service-heading">
          <div className="settings-title-row">
            <h2 id="judgment-heading">AI-assisted matching</h2>
            {status}
          </div>
        </div>
      </div>
      {!editing &&
        (standard ? (
          <>
            <p className="mt-3 text-sm text-muted">
              Use standard matching without calling an AI service.
            </p>
          </>
        ) : (
          details
        ))}
      {!editing && (
        <div className="settings-service-buttons settings-card-actions">
          <button
            type="button"
            ref={editRef}
            className="btn"
            disabled={busy || !config}
            onClick={begin}
          >
            <Icon name="edit" />
            Edit
          </button>
          {!standard && checkButton}
        </div>
      )}
      {editing && (
        <form
          id="judgment-editor"
          className="settings-service-editor"
          onSubmit={(event) => void save(event)}
        >
          <div className="space-y-3">
            <span className="label" id="judgment-provider-label">
              Provider
            </span>
            {/* Rule 39: three exclusive options show at once as a segmented
             * control, not a dropdown. */}
            <div
              role="group"
              aria-labelledby="judgment-provider-label"
              className="segmented"
            >
              {(
                [
                  ["none", "Standard matching"],
                  ["typesafe", "TypeSafe"],
                  ["ollama", "Ollama"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  ref={provider === value ? selectRef : undefined}
                  aria-pressed={provider === value}
                  disabled={busy}
                  onClick={() => {
                    dispatch({ type: "edit", patch: { provider: value } });
                    setSaveError(null);
                  }}
                >
                  {label}
                </button>
              ))}
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
                      TypeSafe API key (optional)
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
                      onChange={(event) =>
                        dispatch({
                          type: "edit",
                          patch: { url: event.target.value },
                        })
                      }
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
                      onChange={(event) =>
                        dispatch({
                          type: "edit",
                          patch: { model: event.target.value },
                        })
                      }
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
            <div className="settings-service-buttons settings-card-actions">
              <button
                type="submit"
                className="btn btn-accent"
                disabled={!actions.save}
              >
                <Icon name="check" />
                Save
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={cancel}
              >
                <Icon name="close" />
                Cancel
              </button>
              {!standard && checkButton}
            </div>
          </div>
        </form>
      )}
      {editing &&
        ((provider === "typesafe" && keyConfig?.source === "stored") ||
          config?.stored) && (
          <>
            {/* Both actions delete stored settings, so they live in their own
                row below the form and each asks first. */}
            <div className="settings-destructive-row">
              {provider === "typesafe" && keyConfig?.source === "stored" && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => clearKeyRef.current?.showModal()}
                >
                  <Icon name="trash" />
                  Clear stored credential
                </button>
              )}
              {config?.stored && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => useEnvRef.current?.showModal()}
                >
                  <Icon name="undo" />
                  Use environment settings
                </button>
              )}
            </div>
            <dialog
              ref={clearKeyRef}
              className="bulk-dialog"
              aria-labelledby={clearKeyTitleId}
            >
              <div className="p-5">
                <h3 id={clearKeyTitleId} className="font-semibold">
                  Clear the stored TypeSafe credential?
                </h3>
                <p className="mt-2 text-sm text-muted">
                  The stored key is deleted from storage. Environment settings
                  apply; without a key, standard matching remains active.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => clearKeyRef.current?.close()}
                  >
                    Keep credential
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      clearKeyRef.current?.close();
                      void apply(
                        { typesafeApiKey: "" },
                        "Stored TypeSafe credential cleared. Environment settings apply.",
                      );
                    }}
                  >
                    Clear credential
                  </button>
                </div>
              </div>
            </dialog>
            <dialog
              ref={useEnvRef}
              className="bulk-dialog"
              aria-labelledby={useEnvTitleId}
            >
              <div className="p-5">
                <h3 id={useEnvTitleId} className="font-semibold">
                  Use environment settings?
                </h3>
                <p className="mt-2 text-sm text-muted">
                  The stored AI settings are deleted. The provider, URL and
                  model then come from the environment. Check the saved
                  connection afterwards to verify the selected model.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => useEnvRef.current?.close()}
                  >
                    Keep AI settings
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      useEnvRef.current?.close();
                      void apply(
                        {
                          judgmentProvider: "",
                          ollamaUrl: "",
                          ollamaModel: "",
                        },
                        "Using environment settings. Check the saved connection to verify the selected model.",
                      );
                    }}
                  >
                    Use environment settings
                  </button>
                </div>
              </div>
            </dialog>
          </>
        )}
      {editor.notice && !unsaved && (
        <p
          ref={noticeRef}
          className="mt-3 text-sm text-muted"
          role="status"
          tabIndex={-1}
        >
          {editor.notice}
        </p>
      )}
      {editor.check && !unsaved && (
        <p
          className="judgment-check mt-2"
          data-state={editor.check.state}
          role="status"
        >
          {editor.check.state === "checking"
            ? "Checking the saved connection…"
            : editor.check.state === "connected"
              ? `${editor.check.provider === "ollama" ? "Ollama" : "TypeSafe"} answered a decision successfully.`
              : editor.check.message}
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
