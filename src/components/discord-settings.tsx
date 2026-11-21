"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  parseDiscordWebhook,
  type DiscordCheck,
  type DiscordSettingsInfo,
} from "../lib/discord-settings.ts";
import { checkConnectionAction, runProbe } from "../lib/settings-service.ts";
import { ApiError, api, ErrorPanel, Icon, messageOf } from "./shared.tsx";
import {
  ConnectionState,
  SettingsCheckButton,
  SettingsConfirmationDialog,
  SettingsSaveFeedback,
  SettingsServiceHeading,
  useEditorFocusReturn,
  useSettingsConfiguration,
  type ConnectionStateLabel,
  type SettingsOperations,
} from "./settings-service.tsx";

type DiscordPatch = {
  discordWebhookUrl?: string;
  discordIncludeTitles?: boolean | null;
};

export function DiscordSettings({
  saving,
  runOperation,
  onForbidden,
  primaryAction,
}: SettingsOperations & { onForbidden: () => void; primaryAction: boolean }) {
  const { info, loadError, load, save, unavailable } =
    useSettingsConfiguration<{ discord: DiscordSettingsInfo }>({
      runOperation,
      onForbidden,
    });
  const config = info?.discord;
  const [manuallyEditing, setEditing] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [titles, setTitles] = useState<boolean | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [check, setCheck] = useState<DiscordCheck>();
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [draftCheck, setDraftCheck] = useState<DiscordCheck>();
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftChecking, setDraftChecking] = useState(false);
  const savedSequence = useRef(0);
  const draftSequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const clearRef = useRef<HTMLDialogElement>(null);
  const resetRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const editing =
    manuallyEditing || config?.configured === false || Boolean(fieldError);
  const { editRef, noticeRef } = useEditorFocusReturn(editing);
  const includeTitles = titles ?? config?.includeTitles ?? false;
  const dirty =
    Boolean(webhookUrl.trim()) ||
    (titles !== null && titles !== config?.includeTitles);
  const busy =
    saving || pending || forbidden || unavailable || checking || draftChecking;

  const verify = useCallback(
    async (queued: boolean) => {
      const sequence = ++savedSequence.current;
      setChecking(true);
      setCheckError(null);
      try {
        const result = await (queued ? runOperation : runProbe)(() =>
          api<DiscordCheck>("/api/admin/discord"),
        );
        if (sequence === savedSequence.current) setCheck(result);
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          setForbidden(true);
          onForbidden();
        } else if (sequence === savedSequence.current)
          setCheckError(messageOf(error));
      } finally {
        if (sequence === savedSequence.current) setChecking(false);
      }
    },
    [runOperation, onForbidden],
  );
  useEffect(() => {
    void verify(false);
    return () => {
      savedSequence.current++;
      draftSequence.current++;
    };
  }, [verify]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function clearDraftVerdict() {
    draftSequence.current++;
    setDraftChecking(false);
    setDraftCheck(undefined);
    setDraftError(null);
    setNotice(null);
    setSaveError(null);
  }
  function closeEditor() {
    clearDraftVerdict();
    setWebhookUrl("");
    setTitles(null);
    setFieldError(null);
    setEditing(false);
  }
  function validate() {
    const invalid =
      webhookUrl.trim() !== "" && !parseDiscordWebhook(webhookUrl.trim());
    setFieldError(
      invalid
        ? "Enter an HTTPS Discord webhook URL with no query string or fragment."
        : null,
    );
    if (invalid) inputRef.current?.focus();
    return !invalid;
  }
  async function testDraft() {
    if (busy || !validate()) return;
    const sequence = ++draftSequence.current;
    setDraftChecking(true);
    setDraftCheck(undefined);
    setDraftError(null);
    try {
      const value = webhookUrl.trim();
      const result = await runProbe(() =>
        api<DiscordCheck>("/api/admin/discord/test", {
          method: "POST",
          body: JSON.stringify(value ? { webhookUrl: value } : {}),
        }),
      );
      if (sequence === draftSequence.current) setDraftCheck(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setForbidden(true);
        onForbidden();
      } else if (sequence === draftSequence.current)
        setDraftError(messageOf(error));
    } finally {
      if (sequence === draftSequence.current) setDraftChecking(false);
    }
  }
  async function apply(body: DiscordPatch, message: string) {
    if (busy || !config) return;
    setPending(true);
    clearDraftVerdict();
    savedSequence.current++;
    try {
      await save(body);
      closeEditor();
      setNotice(message);
      await verify(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setForbidden(true);
        onForbidden();
      } else setSaveError(messageOf(error));
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!validate() || !dirty) return;
    const body: DiscordPatch = {};
    if (webhookUrl.trim()) body.discordWebhookUrl = webhookUrl.trim();
    if (titles !== null && titles !== config?.includeTitles)
      body.discordIncludeTitles = titles;
    void apply(body, "Discord settings saved.");
  }

  const savedFailure = checkError ?? check?.error?.message;
  const draftFailure = draftError ?? draftCheck?.error?.message;
  const displayedCheck = editing && draftCheck ? draftCheck : check;
  let state: ConnectionStateLabel;
  if (unavailable)
    state = loadError ? "Configuration error" : "Loading configuration…";
  else if (checking || draftChecking) state = "Checking…";
  else if (editing && (draftFailure || draftCheck))
    state = draftFailure
      ? "Connection failed"
      : draftCheck?.configured
        ? "Connected"
        : "Not configured";
  else if (editing && dirty) state = "Unsaved changes";
  else if (savedFailure) state = "Connection failed";
  else if (displayedCheck)
    state = displayedCheck.configured ? "Connected" : "Not configured";
  else state = config?.configured ? "Not checked" : "Not configured";
  const checkAction = checkConnectionAction({
    editorOpen: editing,
    savedCheckFailed: Boolean(savedFailure),
  });
  const outcome = draftFailure
    ? "failed"
    : draftCheck?.configured
      ? "connected"
      : null;

  return (
    <section className="panel p-5" aria-labelledby="discord-heading">
      <SettingsServiceHeading
        id="discord-heading"
        title="Discord"
        description="Notifications when requested titles are acquired or available."
        status={
          <>
            <ConnectionState state={state} />
            {config?.configured && config.source === "environment" && (
              <span className="text-sm text-muted">From environment</span>
            )}
          </>
        }
        action={
          !editing && (
            <div className="settings-service-buttons">
              <button
                ref={editRef}
                type="button"
                className="btn"
                disabled={busy || !config}
                aria-expanded={false}
                aria-controls={`${id}-editor`}
                onClick={() => {
                  clearDraftVerdict();
                  setEditing(true);
                }}
              >
                <Icon name="edit" />
                Edit
              </button>
              {checkAction === "retry" && (
                <SettingsCheckButton
                  checking={checking}
                  disabled={busy}
                  onCheck={() => void verify(false)}
                />
              )}
            </div>
          )
        }
      />
      {loadError && (
        <div className="mt-3">
          <ErrorPanel
            title="Discord configuration read failed"
            message={loadError}
            onRetry={load}
          />
        </div>
      )}
      {editing && (
        <form
          id={`${id}-editor`}
          className="settings-service-editor"
          onSubmit={submit}
          noValidate
        >
          <fieldset disabled={busy} className="space-y-4">
            <div>
              <label className="label" htmlFor={`${id}-webhook`}>
                Webhook URL
              </label>
              <input
                ref={inputRef}
                id={`${id}-webhook`}
                className="input mt-2"
                type="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                value={webhookUrl}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={`${id}-help${fieldError ? ` ${id}-error` : ""}`}
                onChange={(event) => {
                  setWebhookUrl(event.target.value);
                  setFieldError(null);
                  clearDraftVerdict();
                }}
              />
              <p id={`${id}-help`} className="mt-2 text-sm text-muted">
                Use an HTTPS webhook URL from discord.com or discordapp.com.
                Leave blank to keep the current webhook. Saved URLs stay hidden.
              </p>
              {fieldError && (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="mt-2 text-sm text-danger"
                >
                  {fieldError}
                </p>
              )}
            </div>
            <div>
              <span className="label" id={`${id}-titles`}>
                Include titles
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={includeTitles}
                aria-labelledby={`${id}-titles`}
                onClick={() => {
                  setTitles(!includeTitles);
                  clearDraftVerdict();
                }}
              >
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span className="switch-state">
                  {includeTitles ? "On" : "Off"}
                </span>
              </button>
              <p className="mt-2 text-sm text-muted">
                Off sends identity-only notifications without title names.
              </p>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2 settings-card-actions">
            <button
              type="submit"
              className={primaryAction && dirty ? "btn btn-accent" : "btn"}
              disabled={busy || !dirty}
              aria-busy={pending}
            >
              <Icon name="check" />
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving || pending || forbidden}
              onClick={closeEditor}
            >
              <Icon name="close" />
              Cancel
            </button>
            <SettingsCheckButton
              checking={draftChecking}
              disabled={busy}
              helpId={`${id}-check-help`}
              outcome={outcome}
              onCheck={() => void testDraft()}
            />
          </div>
          <SettingsSaveFeedback
            notice={notice}
            noticeRef={noticeRef}
            error={saveError}
            errorTitle="Discord settings save failed"
          />
          <p id={`${id}-check-help`} className="mt-2 text-sm text-muted">
            Check the typed URL or current webhook without a save. No message is
            sent to Discord.
          </p>
          {(draftCheck || draftFailure) && (
            <p className="mt-2 text-sm text-muted" role="status">
              {draftFailure
                ? "Draft connection check failed."
                : draftCheck?.configured
                  ? "Draft connection check passed. No settings were saved."
                  : "Draft connection check: no webhook is configured."}
            </p>
          )}
          {draftFailure && (
            <div className="mt-3">
              <ErrorPanel
                title="Draft Discord connection failed"
                message={draftFailure}
              />
            </div>
          )}
        </form>
      )}
      {!editing && (
        <SettingsSaveFeedback
          notice={notice}
          noticeRef={noticeRef}
          error={saveError}
          errorTitle="Discord settings save failed"
        />
      )}
      {savedFailure && (
        <div className="mt-3">
          <ErrorPanel
            title="Saved Discord connection failed"
            message={savedFailure}
          />
        </div>
      )}
      {config?.stored && (
        <div className="settings-destructive-row">
          {config.source === "stored" && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => clearRef.current?.showModal()}
            >
              <Icon name="trash" />
              Clear stored credential
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => resetRef.current?.showModal()}
          >
            <Icon name="undo" />
            Use environment settings
          </button>
        </div>
      )}
      <SettingsConfirmationDialog
        dialogRef={clearRef}
        title="Clear the stored Discord credential?"
        cancelLabel="Keep credential"
        confirmLabel="Clear credential"
        disabled={busy}
        onConfirm={() =>
          void apply(
            { discordWebhookUrl: "" },
            "Stored Discord credential cleared.",
          )
        }
      >
        The webhook returns to its environment setting. The Include titles
        override stays unchanged.
      </SettingsConfirmationDialog>
      <SettingsConfirmationDialog
        dialogRef={resetRef}
        title="Use Discord environment settings?"
        cancelLabel="Keep stored settings"
        confirmLabel="Use environment settings"
        disabled={busy}
        onConfirm={() =>
          void apply(
            { discordWebhookUrl: "", discordIncludeTitles: null },
            "Discord now uses environment settings.",
          )
        }
      >
        Remove both stored overrides. The webhook and Include titles return to
        their environment settings.
      </SettingsConfirmationDialog>
    </section>
  );
}
