"use client";

import { useEffect, useRef, useReducer, useState, type FormEvent } from "react";
import type { JudgmentProvider } from "../lib/contracts.ts";
import {
  type JudgmentConfig,
  initJudgmentEditor,
  judgmentCheckDisabledReason,
  judgmentEditorSettings,
  providerSettingsActions,
  reduceJudgmentEditor,
} from "../lib/judgment-editor.ts";
import { runProbe } from "../lib/settings-service.ts";
import {
  ApiError,
  api,
  ErrorPanel,
  Icon,
  messageOf,
  useSession,
} from "./shared.tsx";
import {
  ConnectionState,
  SettingsCheckButton,
  SettingsConfirmationDialog,
  SettingsSaveFeedback,
  useSettingsConfiguration,
  SettingsServiceHeading,
  useEditorFocusReturn,
  type ConnectionStateLabel,
  type RunSettingsOperation,
  type SettingsOperations,
} from "./settings-service.tsx";
import type {
  ProseChatConfig,
  ProviderConfigRow,
  ProviderSettingsInfo,
  ProviderSettingsPatch,
  SaveProviderSettings,
} from "./metadata-settings.tsx";

/** The AI tab: library matching and natural-language search. It reads
 * the same settings response as the Metadata providers tab, on its own. */
export function AiSettings({
  saving,
  runOperation,
  onForbidden,
}: SettingsOperations & { onForbidden: () => void }) {
  const { refreshSession } = useSession();
  const { info, loadError, load, save, unavailable } =
    useSettingsConfiguration<ProviderSettingsInfo>({
      runOperation,
      onForbidden,
      onSaved: () => {
        refreshSession().catch(() => undefined);
      },
    });

  return (
    <>
      {loadError && (
        <ErrorPanel
          title="AI configuration read failed"
          message={loadError}
          onRetry={load}
        />
      )}
      <JudgmentCard
        config={info?.judgment}
        configurationUnavailable={unavailable}
        keyConfig={info?.providers.typesafe}
        saving={saving}
        runOperation={runOperation}
        onSave={save}
      />
      <ProseSearchCard
        config={info?.proseChat}
        configurationUnavailable={unavailable}
        saving={saving}
        runOperation={runOperation}
        onSave={save}
      />
    </>
  );
}

/** Metadata credentials stay separate from the optional AI provider. */
function JudgmentCard({
  config,
  keyConfig,
  configurationUnavailable,
  saving,
  onSave,
  runOperation,
}: {
  config?: JudgmentConfig;
  configurationUnavailable: boolean;
  keyConfig?: ProviderConfigRow;
  saving: boolean;
  onSave: SaveProviderSettings;
  runOperation: RunSettingsOperation;
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
  const { provider, url, model } = editor.draft;
  const checking = editor.check?.state === "checking";
  const connected = editor.check?.state === "connected";
  const busy = saving || checking || forbidden || configurationUnavailable;
  const actions = providerSettingsActions(editor, {
    ready: Boolean(config),
    pending: saving || forbidden || configurationUnavailable,
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
    ? "Exact names only"
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
    dispatch({ type: "begin" });
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
    dispatch({ type: "saveStarted" });
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
      if (verify && data.judgment.configured) await check(true);
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
        ? "Exact names only saved. AI matching is off."
        : "Settings saved.",
      !standard,
    );
  }

  async function check(queued: boolean) {
    dispatch({ type: "checking" });
    try {
      const result = await (queued ? runOperation : runProbe)(() =>
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
    <>
      {config && !standard && <ConnectionState state={connectionState} />}
      {!editing && (
        <span className={config && !standard ? "text-muted" : "chip"}>
          {config
            ? standard
              ? "Exact names only"
              : providerName
            : "Loading configuration…"}
        </span>
      )}
    </>
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
      {editing && checkDisabledReason && (
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

  const saveFeedback = (
    <SettingsSaveFeedback
      notice={!unsaved ? editor.notice : null}
      error={saveError}
      errorTitle="Saving AI settings failed"
      noticeRef={noticeRef}
    />
  );
  const checkButton = (
    <SettingsCheckButton
      checking={checking}
      disabled={busy || Boolean(checkDisabledReason)}
      helpId={checkDisabledReason ? "judgment-check-help" : undefined}
      onCheck={() => void check(false)}
    />
  );

  return (
    <section className="panel p-5" aria-labelledby="judgment-heading">
      <SettingsServiceHeading
        id="judgment-heading"
        title="Smarter library matching"
        description="AI flags possible matches between requested titles and differently named titles in your Jellyfin library for administrator review. It also sorts similar titles on detail pages and suggests up to three real tags for search terms."
        status={status}
        action={
          !editing && (
            <div className="settings-service-buttons">
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
              {/* As on every service card: Check only as the retry after a
                  failed saved check. */}
              {!standard && editor.check?.state === "failed" && checkButton}
            </div>
          )
        }
      />
      <p className="mt-3 text-sm text-muted">
        AI never marks a title as available. Titles with different years never
        match.
      </p>
      <p className="mt-3 text-sm text-muted">
        Titles and catalog details go to the selected AI service for matching
        and similar-title sorting. Tag suggestions also send member search terms
        after you save the TypeSafe key or Ollama choice in Settings.
      </p>
      <p className="mt-3 text-sm text-muted">
        Hosted TypeSafe is a third party. A local Ollama server keeps this data
        on your network.
      </p>
      {!editing &&
        (standard ? (
          <>
            <p className="mt-3 text-sm text-muted">
              Only exact names match, without calls to an AI service.
            </p>
          </>
        ) : (
          details
        ))}
      <p className="mt-3 text-sm text-muted">
        Natural-language search has its own card. Exact names only does not turn
        it off.
      </p>
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
                  ["none", "Exact names only"],
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
                Only exact names match, without calls to an AI service.
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
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        setSaveError(null);
                      }}
                      placeholder={
                        keyConfig?.configured
                          ? "Leave blank to keep the current credential"
                          : "Enter your TypeSafe API key"
                      }
                    />
                    <p className="text-sm text-muted">
                      Optional. Without a key, Exact names only remains active.
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
                      onChange={(event) => {
                        dispatch({
                          type: "edit",
                          patch: { url: event.target.value },
                        });
                        setSaveError(null);
                      }}
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
                      onChange={(event) => {
                        dispatch({
                          type: "edit",
                          patch: { model: event.target.value },
                        });
                        setSaveError(null);
                      }}
                    />
                    <p className="text-sm text-muted">
                      Use a reachable Ollama server with a decision model such
                      as nimble or tev1.
                    </p>
                  </>
                )}
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
          {saveFeedback}
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
            <SettingsConfirmationDialog
              dialogRef={clearKeyRef}
              title="Clear the stored TypeSafe credential?"
              cancelLabel="Keep credential"
              confirmLabel="Clear credential"
              disabled={busy}
              onConfirm={() =>
                void apply(
                  { typesafeApiKey: "" },
                  "Stored TypeSafe credential cleared. Environment settings apply.",
                )
              }
            >
              The stored key is deleted from storage. Environment settings
              apply. Without a key, Exact names only remains active.
            </SettingsConfirmationDialog>
            <SettingsConfirmationDialog
              dialogRef={useEnvRef}
              title="Use environment settings?"
              cancelLabel="Keep AI settings"
              confirmLabel="Use environment settings"
              disabled={busy}
              onConfirm={() =>
                void apply(
                  { judgmentProvider: "", ollamaUrl: "", ollamaModel: "" },
                  "Using environment settings. Check the saved connection to verify the selected model.",
                )
              }
            >
              The stored AI settings are deleted. The provider, URL and model
              then come from the environment. Check the saved connection
              afterwards to verify the selected model.
            </SettingsConfirmationDialog>
          </>
        )}
      {!editing && saveFeedback}
      {/* The title chip already says Checking… / Connected; only a failure
          needs a line, because the chip cannot say why. */}
      {editor.check?.state === "failed" && !unsaved && (
        <p className="judgment-check mt-2" data-state="failed" role="status">
          {editor.check.message}
        </p>
      )}
      {forbidden && (
        <p className="mt-3 text-sm text-muted">
          An administrator account is required to configure the model.
        </p>
      )}
    </section>
  );
}

type ProseCheck =
  | { state: "checking" }
  | { state: "connected" }
  | { state: "failed"; message: string };

/** Known OpenAI-compatible servers. A preset fills only the base URL: model
 * names change too often to pin, so the admin still types the model. */
const PROSE_PRESETS = [
  ["Anthropic", "https://api.anthropic.com/v1"],
  ["OpenAI", "https://api.openai.com/v1"],
  ["Ollama (this machine)", "http://localhost:11434/v1"],
] as const;

/** Natural-language search on Browse: the admin points it at an
 * OpenAI-compatible chat server. Its switch is separate from library
 * matching. The key is write-only and shows only as Stored/Not configured. */
function ProseSearchCard({
  config,
  configurationUnavailable,
  saving,
  onSave,
  runOperation,
}: {
  config?: ProseChatConfig;
  configurationUnavailable: boolean;
  saving: boolean;
  onSave: SaveProviderSettings;
  runOperation: RunSettingsOperation;
}) {
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [check, setCheck] = useState<ProseCheck | null>(null);
  // The editor's check tests the typed values; its result is the draft's,
  // never the saved status, so it clears on every edit and on close.
  const [draft, setDraft] = useState<ProseCheck | null>(null);
  const [models, setModels] = useState<{
    ids: string[];
    error?: string;
  } | null>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const { editRef, noticeRef } = useEditorFocusReturn(editing);
  const clearKeyRef = useRef<HTMLDialogElement>(null);
  const checking = check?.state === "checking" || draft?.state === "checking";
  const busy = saving || checking || forbidden || configurationUnavailable;
  useEffect(() => setDraft(null), [url, model, apiKey]);
  // The server's model list for the typed URL (and key), read once the
  // typing settles. A list that cannot load leaves the field free text.
  useEffect(() => {
    setModels(null);
    const target = url.trim();
    if (!editing || !enabled || !/^https?:\/\/\S+$/.test(target)) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const key = apiKey.trim();
      api<{ models: string[]; error?: string }>("/api/admin/prose/models", {
        method: "POST",
        body: JSON.stringify({ url: target, ...(key ? { apiKey: key } : {}) }),
      })
        .then((r) => live && setModels({ ids: r.models, error: r.error }))
        .catch(
          (error: unknown) =>
            live && setModels({ ids: [], error: messageOf(error) }),
        );
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [editing, enabled, url, apiKey]);
  useEffect(() => {
    if (editing) selectRef.current?.focus();
  }, [editing]);
  const unsaved =
    editing &&
    Boolean(config) &&
    (enabled !== config?.enabled ||
      url.trim() !== config?.url ||
      model.trim() !== config?.model ||
      apiKey.trim() !== "");
  // On needs both values; Off keeps whatever is stored for a later switch-on.
  const complete = !enabled || (url.trim() !== "" && model.trim() !== "");
  const checkDisabledReason = !config
    ? "Loading saved configuration."
    : url.trim() === "" || model.trim() === ""
      ? "Enter the server URL and model to check the connection."
      : undefined;

  function begin() {
    if (!config) return;
    setNotice(null);
    setEnabled(config.enabled);
    setUrl(config.url);
    setModel(config.model);
    setApiKey("");
    setSaveError(null);
    setDraft(null);
    setEditing(true);
  }

  function cancel() {
    setApiKey("");
    setSaveError(null);
    setDraft(null);
    setEditing(false);
  }

  /** Tests the form's values; nothing is stored. A blank key reuses the
   * stored one only on the stored server's origin (the server decides). */
  async function runDraft() {
    setDraft({ state: "checking" });
    const key = apiKey.trim();
    try {
      const result = await runProbe(() =>
        api<{ connected: boolean; error?: string }>("/api/admin/prose/test", {
          method: "POST",
          body: JSON.stringify({
            url: url.trim(),
            model: model.trim(),
            ...(key ? { apiKey: key } : {}),
          }),
        }),
      );
      setDraft(
        result.connected
          ? { state: "connected" }
          : { state: "failed", message: result.error ?? "Connection failed." },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      setDraft({ state: "failed", message: messageOf(error) });
    }
  }

  async function runCheck(queued: boolean) {
    setCheck({ state: "checking" });
    try {
      const result = await (queued ? runOperation : runProbe)(() =>
        api<{ connected: boolean; error?: string }>("/api/admin/prose/check", {
          method: "POST",
          body: "{}",
        }),
      );
      setCheck(
        result.connected
          ? { state: "connected" }
          : { state: "failed", message: result.error ?? "Connection failed." },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      setCheck({ state: "failed", message: messageOf(error) });
    }
  }

  // Like the other service cards, the saved connection is checked once when
  // Settings opens. The check only reads the server's model list (no chat
  // request), so it costs nothing on a hosted server.
  const checkedOnLoad = useRef(false);
  useEffect(() => {
    // Decided on the first configuration read only: a later save that turns
    // the card on runs its own check, so this must not add a second one.
    if (checkedOnLoad.current || !config) return;
    checkedOnLoad.current = true;
    if (config.configured) void runCheck(false);
    // runCheck reads only stable setters and props: one run per mount.
  }, [config]);

  async function apply(body: ProviderSettingsPatch, success: string) {
    if (busy || !config) return null;
    setSaveError(null);
    setNotice(null);
    try {
      const data = await onSave(body);
      setApiKey("");
      setCheck(null);
      setNotice(success);
      setEditing(false);
      // Probe only after persistence succeeds: the endpoint reads saved settings.
      // A failed probe must not turn a successful save into an error.
      if (data.proseChat.configured) await runCheck(true);
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      else setSaveError(messageOf(error));
      return null;
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !config || !complete) return;
    const key = apiKey.trim();
    await apply(
      {
        proseChatEnabled: enabled,
        proseChatUrl: url.trim(),
        proseChatModel: model.trim(),
        ...(key ? { proseChatApiKey: key } : {}),
      },
      enabled ? "Settings saved." : "Natural-language search is off.",
    );
  }

  const connectionState: ConnectionStateLabel = (() => {
    if (checking) return "Checking…";
    if (editing && draft?.state === "connected") return "Connected";
    if (editing && draft?.state === "failed") return "Connection failed";
    if (unsaved) return "Unsaved changes";
    if (config?.error) return "Configuration error";
    if (check?.state === "failed") return "Connection failed";
    if (check?.state === "connected") return "Connected";
    return config?.configured ? "Not checked" : "Not configured";
  })();
  // One chip beside the title: while On (or with a pending change or a
  // draft result) the connection state, which already implies On; while
  // Off a neutral "Off" chip, because nothing is checked while off.
  const status = !config ? (
    <span className="text-muted">Loading configuration…</span>
  ) : config.enabled || unsaved || (editing && draft) ? (
    <ConnectionState state={connectionState} />
  ) : (
    <span className="chip">Off</span>
  );

  const saveFeedback = (
    <SettingsSaveFeedback
      notice={!unsaved ? notice : null}
      error={saveError}
      errorTitle="Saving natural-language search settings failed"
      noticeRef={noticeRef}
    />
  );
  const checkButton = (
    <SettingsCheckButton
      checking={checking}
      disabled={busy || Boolean(checkDisabledReason)}
      helpId={checkDisabledReason ? "prose-check-help" : undefined}
      onCheck={() => void runDraft()}
    />
  );

  return (
    <section className="panel p-5" aria-labelledby="prose-heading">
      <SettingsServiceHeading
        id="prose-heading"
        title="Natural-language search"
        status={status}
        action={
          !editing && (
            <div className="settings-service-buttons">
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
              {/* The retry after a failed saved check re-reads the saved
                  settings (the editor's Check tests the draft instead). */}
              {check?.state === "failed" && (
                <SettingsCheckButton
                  checking={checking}
                  disabled={busy}
                  onCheck={() => void runCheck(false)}
                />
              )}
            </div>
          )
        }
      />
      <p className="mt-3 text-sm text-muted">
        Members describe what they want in plain words on Browse, and this
        OpenAI-compatible chat server turns the text into filters.
      </p>
      <p className="mt-2 text-sm text-muted">
        Member search text goes to this server. This switch is separate from
        Smarter library matching.
      </p>
      {!editing && config && (
        <p className="mt-3 text-sm text-muted">
          {"Server URL: " +
            (config.url || "Not set") +
            " · Model: " +
            (config.model || "Not set") +
            " · API key: " +
            (config.keyStored ? "Stored" : "Not configured")}
        </p>
      )}
      {editing && enabled && checkDisabledReason && (
        <p id="prose-check-help" className="mt-3 text-sm text-muted">
          {checkDisabledReason}
        </p>
      )}
      {config?.error && !unsaved && (
        <div className="mt-3">
          <ErrorPanel
            title="Natural-language search configuration error"
            message={config.error}
          />
        </div>
      )}
      {editing && (
        <form
          id="prose-editor"
          className="settings-service-editor"
          onSubmit={(event) => void save(event)}
        >
          <div className="space-y-3">
            {/* One on/off setting: a switch (role="switch"), its state
                written beside it so it is never shown by color alone. */}
            <span className="label" id="prose-enabled-label">
              Natural-language search
            </span>
            <button
              type="button"
              role="switch"
              ref={selectRef}
              className="switch"
              aria-checked={enabled}
              aria-labelledby="prose-enabled-label"
              disabled={busy}
              onClick={() => {
                setEnabled((on) => !on);
                setSaveError(null);
              }}
            >
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
              <span className="switch-state">{enabled ? "On" : "Off"}</span>
            </button>
            {/* Off needs no server: the fields show only while On. Their
                values stay in the draft and in storage for a later On. */}
            {enabled && (
              <>
                <label className="label" htmlFor="prose-chat-preset">
                  Server
                </label>
                {/* The selection is derived from the URL, so editing the URL by
                hand falls back to Custom and no second state can drift. */}
                <select
                  id="prose-chat-preset"
                  className="input"
                  disabled={busy}
                  value={
                    PROSE_PRESETS.find(
                      ([, presetUrl]) =>
                        presetUrl === url.trim().replace(/\/+$/, ""),
                    )?.[1] ?? ""
                  }
                  onChange={(event) => {
                    // Custom empties the URL: keeping a preset's URL would select
                    // that preset again, since the selection follows the URL.
                    setUrl(event.target.value);
                    setSaveError(null);
                  }}
                >
                  <option value="">Custom</option>
                  {PROSE_PRESETS.map(([label, presetUrl]) => (
                    <option key={presetUrl} value={presetUrl}>
                      {label}
                    </option>
                  ))}
                </select>
                <label className="label" htmlFor="prose-chat-url">
                  Server URL
                </label>
                <input
                  id="prose-chat-url"
                  className="input"
                  type="url"
                  required={enabled}
                  maxLength={2048}
                  disabled={busy}
                  value={url}
                  placeholder="http://localhost:11434/v1"
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setSaveError(null);
                  }}
                />
                <p className="text-sm text-muted">
                  Pick a server to fill its URL, or choose Custom and enter the
                  base URL of any OpenAI-compatible API. If Velvarr runs in
                  Docker, a local Ollama is at
                  http://host.docker.internal:11434/v1.
                </p>
                <label className="label" htmlFor="prose-chat-key">
                  API key (optional)
                </label>
                <input
                  id="prose-chat-key"
                  className="input"
                  type="password"
                  autoComplete="off"
                  maxLength={512}
                  disabled={busy}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setSaveError(null);
                  }}
                  placeholder={
                    config?.keyStored
                      ? "Leave blank to keep the current credential"
                      : "Enter an API key if the server needs one"
                  }
                />
                <p className="text-sm text-muted">
                  Optional. Hosted models can refuse adult text; a local model
                  avoids this.
                </p>
                <label className="label" htmlFor="prose-chat-model">
                  Model
                </label>
                {/* A text field with the server's models as suggestions: a server
                without a model list, or a model it does not list, still works. */}
                <input
                  id="prose-chat-model"
                  className="input"
                  list="prose-chat-models"
                  autoComplete="off"
                  required={enabled}
                  maxLength={128}
                  disabled={busy}
                  value={model}
                  aria-describedby="prose-chat-models-note"
                  onChange={(event) => {
                    setModel(event.target.value);
                    setSaveError(null);
                  }}
                />
                <datalist id="prose-chat-models">
                  {models?.ids.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <p
                  id="prose-chat-models-note"
                  className="text-sm text-muted"
                  aria-live="polite"
                >
                  {models === null
                    ? "Enter the server URL to list its models."
                    : models.error !== undefined
                      ? `The model list could not load: ${models.error} Type the model name.`
                      : models.ids.length === 0
                        ? "The server lists no models. Type the model name."
                        : `${new Intl.NumberFormat().format(models.ids.length)} models from this server. Pick one or type a name.`}
                </p>
                {draft?.state === "failed" && (
                  <ErrorPanel
                    title="Natural-language search connection check failed"
                    message={draft.message}
                  />
                )}
              </>
            )}
            <div className="settings-service-buttons settings-card-actions">
              <button
                type="submit"
                className="btn btn-accent"
                disabled={busy || !config || !complete}
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
              {enabled && checkButton}
            </div>
          </div>
          {saveFeedback}
        </form>
      )}
      {editing && config?.keyStored && (
        <>
          {/* Clearing deletes a stored secret, so it lives in its own row
              below the form and asks first. */}
          <div className="settings-destructive-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => clearKeyRef.current?.showModal()}
            >
              <Icon name="trash" />
              Clear stored credential
            </button>
          </div>
          <SettingsConfirmationDialog
            dialogRef={clearKeyRef}
            title="Clear the stored natural-language search credential?"
            cancelLabel="Keep credential"
            confirmLabel="Clear credential"
            disabled={busy}
            onConfirm={() =>
              void apply(
                { proseChatApiKey: "" },
                "Stored natural-language search credential cleared.",
              )
            }
          >
            The stored key is deleted from storage. Requests to the chat server
            then go without a key.
          </SettingsConfirmationDialog>
        </>
      )}
      {!editing && saveFeedback}
      {/* The title chip already says Checking… / Connected; only a failure
          needs a line, because the chip cannot say why. */}
      {check?.state === "failed" && !unsaved && (
        <p className="judgment-check mt-2" data-state="failed" role="status">
          {"Connection failed: " + check.message}
        </p>
      )}
      {forbidden && (
        <p className="mt-3 text-sm text-muted">
          An administrator account is required to configure natural-language
          search.
        </p>
      )}
    </section>
  );
}
