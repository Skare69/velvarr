"use client";

import { useCallback, useEffect, useRef, useReducer } from "react";
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
  type RunSettingsOperation,
  type SettingsOperations,
} from "./settings-service.tsx";
import type { JudgmentConfig } from "../lib/judgment-editor.ts";
import {
  CONNECTION_STATE_LABEL,
  checkConnectionAction,
  runProbe,
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
// The AI tab (ai-settings.tsx) reads the same response.
export type ProviderConfigRow = {
  configured: boolean;
  source: "stored" | "environment";
};
export type ProseChatConfig = {
  enabled: boolean;
  url: string;
  model: string;
  keyStored: boolean;
  configured: boolean;
  error?: string;
};
export type ProviderSettingsInfo = {
  providers: Record<CredentialProvider | "typesafe", ProviderConfigRow>;
  judgment: JudgmentConfig;
  proseChat: ProseChatConfig;
};
export type ProviderSettingsPatch = Partial<
  Omit<NonNullable<IntegrationConfig["providers"]>, "judgmentProvider"> & {
    judgmentProvider: JudgmentProvider | "";
    tpdbApiTokenExpect: string;
    stashdbApiKeyExpect: string;
  }
>;
export type SaveProviderSettings = (
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

  const verify = useCallback(
    async (queued: boolean) => {
      dispatch({ type: "checking" });
      try {
        dispatch({
          type: "checked",
          check: await (queued ? runOperation : runProbe)(() =>
            api<ProviderCheck>("/api/admin/providers/" + id),
          ),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 403)
          dispatch({ type: "forbidden" });
        else dispatch({ type: "checkFailed", message: messageOf(error) });
      }
    },
    [id, runOperation],
  );

  // The editor's test: POSTs the values on screen (blank key = saved
  // credential), stores nothing. Its result lands in draftCheck, which the
  // rejected-key auto-delete never reads — only the saved probe (`check`) is.
  const testDraft = useCallback(async () => {
    dispatch({ type: "draftChecking" });
    try {
      const key = editor.draft.trim();
      dispatch({
        type: "draftChecked",
        check: await runProbe(() =>
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
    void verify(false);
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
    if (saved) await verify(true);
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
        if (saved) await verify(true);
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
        onCheck={() =>
          void (checkMode === "draft" ? testDraft() : verify(false))
        }
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
        action={
          !editorOpen && (
            <div className="settings-service-buttons">
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
              {/* Only after a failed saved check: the retry. */}
              {checkButton}
            </div>
          )
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
