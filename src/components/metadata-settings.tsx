"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useReducer,
  useState,
  type FormEvent,
} from "react";
import type {
  CredentialProvider,
  ProviderCheck,
  IntegrationConfig,
  JudgmentProvider,
} from "../lib/contracts.ts";
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
  settingsFailureOf,
  useSettingsConfiguration,
  SettingsServiceHeading,
  useEditorFocusReturn,
  type ConnectionStateLabel,
  type RunSettingsOperation,
  type SettingsOperations,
} from "./settings-service.tsx";
import {
  type JudgmentConfig,
  initJudgmentEditor,
  judgmentCheckDisabledReason,
  judgmentEditorSettings,
  providerSettingsActions,
  reduceJudgmentEditor,
} from "../lib/judgment-editor.ts";
import {
  CONNECTION_STATE_LABEL,
  checkConnectionAction,
} from "../lib/settings-service.ts";
import {
  canClearCredential,
  connectionState,
} from "../lib/provider-settings.ts";
import {
  applyCredentialSave,
  shouldAutoClearOnReject,
  credentialCardBusy,
  credentialEditorView,
  initCredentialCard,
  reduceCredentialCard,
} from "../lib/credential-card.ts";

// Shape of the settings response; credentials themselves are never returned.
type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};
type ProviderSettingsInfo = {
  providers: Record<CredentialProvider | "typesafe", ProviderConfigRow>;
  judgment: JudgmentConfig;
};
type ProviderSettingsPatch = Partial<
  Omit<NonNullable<IntegrationConfig["providers"]>, "judgmentProvider"> & {
    judgmentProvider: JudgmentProvider | "";
    tpdbApiTokenExpect: string;
    stashdbApiKeyExpect: string;
  }
>;
type SaveProviderSettings = (
  body: ProviderSettingsPatch,
) => Promise<ProviderSettingsInfo>;

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

export function MetadataSettings({
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
          configurationUnavailable={unavailable}
          saving={saving}
          runOperation={runOperation}
          onSave={save}
        />
      ))}
      <JudgmentCard
        config={info?.judgment}
        configurationUnavailable={unavailable}
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
  configurationUnavailable,
  saving,
  onSave,
  runOperation,
}: {
  config?: ProviderConfigRow;
  configurationUnavailable: boolean;
  saving: boolean;
  onSave: SaveProviderSettings;
  runOperation: RunSettingsOperation;
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
  const failureOf = settingsFailureOf;

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
  // enters here, and neither does a rejection without a keyFingerprint: that
  // probe hit the environment fallback, so there is no stored key to delete
  // and the auto-clear never falls back to the unconditional clear. The
  // clear is guarded: it echoes the check's keyFingerprint
  // in `<field>Expect`, and the server refuses (409) when the stored key
  // changed under the failed probe, so a key another tab saved meanwhile
  // survives. One attempt per check result: every result is decided exactly
  // once, so a config refresh from any save on the page cannot replay a
  // stale rejection, and a result landing while a clear is in flight stays
  // decided-skipped (its failure chip and the Check button carry it).
  const clearing = useRef(false);
  const handledCheck = useRef<ProviderCheck | null>(null);
  useEffect(() => {
    const check = editor.check;
    if (!check || handledCheck.current === check) return;
    // No source row yet: leave the check unmarked and retry when it lands.
    if (!config) return;
    handledCheck.current = check;
    if (clearing.current) return;
    const fingerprint =
      check.configured && !check.verified ? check.keyFingerprint : undefined;
    // The fingerprint guards the delete: without one the probe probed the
    // environment fallback, not a stored key this check can vouch for, so
    // the auto-clear never falls back to the unconditional clear.
    if (
      !shouldAutoClearOnReject({ check, source: config.source }) ||
      fingerprint === undefined
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
            onSave({
              [field]: value,
              [`${field}Expect`]: fingerprint,
            }).then(() => undefined),
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
    canEdit: !busy && !configurationUnavailable && Boolean(config),
    canClear: canClearCredential({
      source: config?.source,
      pending: busy || configurationUnavailable,
    }),
  };
  const state = connectionState({
    draft: editorOpen ? editor.draft : "",
    checking: editor.checking,
    check: editor.check,
    requestError: editor.checkError,
  });
  const connectionStateLabel = CONNECTION_STATE_LABEL[state];
  // One Check connection at a time: the open editor's POST of the draft
  // values, or — on a closed card whose saved check failed — the GET retry.
  // A connected or unchecked closed card shows no Check: the page probed the
  // saved connection on load, and the chip beside the title carries it.
  const checkMode = checkConnectionAction({
    editorOpen,
    savedCheckFailed:
      error !== null || editor.checking || configurationUnavailable,
  });
  const checkButton =
    checkMode === null ? null : (
      <SettingsCheckButton
        checking={editor.draftChecking || editor.checking}
        disabled={busy || (checkMode === "draft" && configurationUnavailable)}
        onCheck={() => void (checkMode === "draft" ? testDraft() : verify())}
      />
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
  const saveFeedback = (
    <SettingsSaveFeedback
      notice={editor.saved}
      error={editor.saveError}
      errorTitle={"Saving " + name + " credential failed"}
      noticeRef={noticeRef}
    />
  );
  return (
    <section className="panel p-5" aria-labelledby={"provider-heading-" + id}>
      <SettingsServiceHeading
        id={"provider-heading-" + id}
        title={name}
        description={description}
        status={
          <>
            <ConnectionState state={connectionStateLabel} />
            {config?.configured && config.source === "environment" && (
              <span className="chip">From environment</span>
            )}
          </>
        }
      />
      {config?.configured === false && (
        <p className="mt-2 text-sm text-muted">
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
          feedback: saveFeedback,
          inputRef,
          onDraftChange: (value) => dispatch({ type: "draft", value }),
          onCancel: cancel,
          onSubmit: (event) => {
            event.preventDefault();
            if (!busy && !configurationUnavailable && config) void apply();
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
          <SettingsConfirmationDialog
            dialogRef={clearRef}
            title={"Clear the stored " + name + " credential?"}
            cancelLabel="Keep credential"
            confirmLabel="Clear credential"
            disabled={!actions.canClear}
            onConfirm={() => void apply(true)}
          >
            The encrypted credential is deleted from storage. {name} then falls
            back to the environment settings, and connection checks use that
            fallback.
          </SettingsConfirmationDialog>
        </>
      )}
      {!editorOpen && saveFeedback}
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
    <>
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
      onCheck={() => void check()}
    />
  );

  return (
    <section className="panel p-5" aria-labelledby="judgment-heading">
      <SettingsServiceHeading
        id="judgment-heading"
        title="AI-assisted matching"
        status={status}
      />
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
              apply; without a key, standard matching remains active.
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
      {forbidden && (
        <p className="mt-3 text-sm text-muted">
          An administrator account is required to configure the model.
        </p>
      )}
    </section>
  );
}
