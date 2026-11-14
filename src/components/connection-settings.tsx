"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useReducer,
  useState,
  type FormEvent,
} from "react";
import { checkConnectionAction } from "../lib/settings-service.ts";
import {
  connectionDraftChanged,
  connectionFieldErrors,
  type ConnectionFieldErrors,
  type ConnectionDraft,
  type ConnectionPatch,
  type ConnectionService,
  type ConnectionsInfo,
} from "../lib/connection-settings.ts";
import {
  applyConnectionSave,
  checkConnection,
  testConnectionDraft,
  connectionCardBusy,
  initConnectionCard,
  reduceConnectionCard,
  type ConnectionStatus,
} from "../lib/connection-card.ts";
import { api, ErrorPanel, Icon } from "./shared.tsx";
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
  type SettingsOperations,
} from "./settings-service.tsx";

type SaveConnection = (body: ConnectionPatch) => Promise<ConnectionsInfo>;
export function ConnectionsSettings({
  onForbidden,
  saving,
  runOperation,
}: SettingsOperations & { onForbidden: () => void }) {
  const [jellyfinEditing, setJellyfinEditing] = useState(false);
  const { info, loadError, load, save, unavailable } =
    useSettingsConfiguration<ConnectionsInfo>({ runOperation, onForbidden });

  return (
    <>
      {loadError && (
        <ErrorPanel
          title="Connection configuration read failed"
          message={loadError}
          onRetry={load}
        />
      )}
      {(["jellyfin", "whisparr"] as const).map((service) => (
        <ConnectionCard
          key={service}
          service={service}
          primaryAction={service === "jellyfin" || !jellyfinEditing}
          onEditingChange={
            service === "jellyfin" ? setJellyfinEditing : undefined
          }
          info={info}
          configurationUnavailable={unavailable}
          saving={saving}
          runOperation={runOperation}
          onSave={save}
          onForbidden={onForbidden}
        />
      ))}
    </>
  );
}

function ConnectionCard({
  service,
  primaryAction,
  onEditingChange,
  info,
  configurationUnavailable,
  saving,
  runOperation,
  onSave,
  onForbidden,
}: SettingsOperations & {
  service: ConnectionService;
  primaryAction: boolean;
  onEditingChange?: (editing: boolean) => void;
  info?: ConnectionsInfo;
  configurationUnavailable: boolean;
  onSave: SaveConnection;
  onForbidden: () => void;
}) {
  const name = service === "jellyfin" ? "Jellyfin" : "Whisparr";
  const [editor, dispatch] = useReducer(
    reduceConnectionCard,
    service,
    initConnectionCard,
  );
  const {
    status,
    checking,
    checkError,
    editing: manuallyEditing,
    draftStatus,
    draftChecking,
    draftCheckError,
    draft,
    pending,
    saveError,
    saved,
  } = editor;
  const editing =
    manuallyEditing || (info !== undefined && !info[service]?.apiKeyConfigured);
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);
  const testSequence = useRef(0);
  const openedMissing = useRef(false);
  useEffect(() => {
    if (info && !info[service]?.apiKeyConfigured && !openedMissing.current) {
      openedMissing.current = true;
      dispatch({ type: "initialize", service, info });
    }
  }, [info, service]);
  const inputRef = useRef<HTMLInputElement>(null);
  const { editRef, noticeRef } = useEditorFocusReturn(editing);
  const removeRef = useRef<HTMLDialogElement>(null);
  const editorId = useId();
  const busy = connectionCardBusy(editor, saving);
  const unsaved =
    editing &&
    info !== undefined &&
    connectionDraftChanged(service, draft, info);
  const configured =
    status?.configured ??
    (info ? Boolean(info[service]?.apiKeyConfigured) : undefined);
  const failure = checkError ?? status?.error?.message;

  const verify = useCallback(
    () =>
      checkConnection({
        dispatch,
        performCheck: () =>
          runOperation(() => api<ConnectionStatus>("/api/admin/" + service)),
        failureOf: settingsFailureOf,
        onForbidden,
      }),
    [service, runOperation, onForbidden],
  );
  useEffect(() => {
    void verify();
  }, [verify]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const patch = (changes: Partial<ConnectionDraft>) => {
    testSequence.current++;
    dispatch({ type: "draft", changes });
  };
  function begin() {
    testSequence.current++;
    if (info) dispatch({ type: "edit", service, info });
  }
  function cancel() {
    testSequence.current++;
    dispatch({ type: "cancel", service, info });
  }
  async function apply(remove = false) {
    await applyConnectionSave({
      service,
      info,
      state: editor,
      saving,
      configurationUnavailable,
      remove,
      dispatch,
      performSave: (body) => {
        testSequence.current++;
        return onSave(body);
      },
      verify,
      failureOf: settingsFailureOf,
      onForbidden,
    });
  }
  const state: ConnectionStateLabel = checking
    ? "Checking…"
    : unsaved
      ? "Unsaved changes"
      : failure
        ? "Connection failed"
        : status
          ? status.configured
            ? "Connected"
            : "Not configured"
          : !info
            ? "Loading configuration…"
            : configured
              ? "Not checked"
              : "Not configured";
  const checkMode = checkConnectionAction({
    editorOpen: editing,
    savedCheckFailed: Boolean(failure) || configurationUnavailable,
  });
  const testDraft = () => {
    const sequence = ++testSequence.current;
    return testConnectionDraft({
      isCurrent: () => testSequence.current === sequence,
      dispatch,
      failureOf: settingsFailureOf,
      onForbidden,
      performTest: () =>
        runOperation(() =>
          api<ConnectionStatus>("/api/admin/" + service + "/test", {
            method: "POST",
            body: JSON.stringify({
              url: draft.url.trim(),
              ...(service === "jellyfin"
                ? { externalUrl: draft.externalUrl.trim() }
                : {}),
              ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
            }),
          }),
        ),
    });
  };
  const checkButton =
    checkMode === null ? null : (
      <SettingsCheckButton
        checking={checking || draftChecking}
        disabled={busy || (checkMode === "draft" && configurationUnavailable)}
        onCheck={() => void (checkMode === "draft" ? testDraft() : verify())}
      />
    );
  const testFailure = draftCheckError ?? draftStatus?.error?.message;
  const current = info?.[service];
  const fieldErrors =
    saveError && info ? connectionFieldErrors(service, draft, info) : {};
  const saveFeedback = (
    <SettingsSaveFeedback
      notice={saved}
      error={Object.keys(fieldErrors).length ? null : saveError}
      errorTitle={"Saving " + name + " settings failed"}
      noticeRef={noticeRef}
    />
  );

  return (
    <section className="panel p-5" aria-labelledby={service + "-heading"}>
      <SettingsServiceHeading
        id={service + "-heading"}
        title={name}
        description={
          service === "jellyfin"
            ? "Your media server, accounts, and playback connection."
            : "Your download connection, delivery settings, and library path mappings."
        }
        status={
          <>
            <ConnectionState state={state} />
            {!unsaved && !checking && !failure && status?.configured && (
              <span className="text-muted">
                {status.serverName ?? status.appName ?? name}
                {status.version ? " · " + status.version : ""}
              </span>
            )}
            {service === "whisparr" && info?.whisparr && (
              <span className="chip">
                {info.whisparr.delivery?.enabled
                  ? "Delivery enabled"
                  : "Delivery paused"}
              </span>
            )}
          </>
        }
      />
      {current?.url && (
        <p className="mt-3 break-all text-sm text-muted">{current.url}</p>
      )}
      {service === "jellyfin" && info && (
        <p className="mt-2 text-sm text-muted">
          {info.jellyfin.libraryIds.length} selected librar
          {info.jellyfin.libraryIds.length === 1 ? "y" : "ies"}
        </p>
      )}
      {failure && !unsaved && !checking && (
        <div className="mt-3">
          <ErrorPanel
            title={name + " connection check failed"}
            message={failure}
          />
        </div>
      )}
      {!editing && (
        <div className="settings-service-buttons settings-card-actions">
          <button
            type="button"
            className="btn"
            ref={editRef}
            disabled={busy || !info || configurationUnavailable}
            onClick={begin}
          >
            <Icon name="edit" />
            Edit
          </button>
          {checkButton}
        </div>
      )}
      {editing && info && (
        <form
          id={editorId}
          className="settings-service-editor"
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void apply();
          }}
        >
          <fieldset disabled={busy || configurationUnavailable}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={editorId + "-url"}>
                  {name} URL
                </label>
                <input
                  ref={inputRef}
                  {...fieldErrorAttributes(editorId, "url", fieldErrors)}
                  id={editorId + "-url"}
                  className="input mt-2"
                  type="text"
                  autoComplete="off"
                  maxLength={2048}
                  value={draft.url}
                  onChange={(event) => patch({ url: event.target.value })}
                />
                <ConnectionFieldFeedback
                  id={editorId}
                  field="url"
                  errors={fieldErrors}
                />
              </div>
              {service === "jellyfin" && (
                <div>
                  <label className="label" htmlFor={editorId + "-external"}>
                    Jellyfin external URL
                  </label>
                  <input
                    id={editorId + "-external"}
                    {...fieldErrorAttributes(
                      editorId,
                      "externalUrl",
                      fieldErrors,
                    )}
                    className="input mt-2"
                    type="text"
                    autoComplete="off"
                    maxLength={2048}
                    value={draft.externalUrl}
                    onChange={(event) =>
                      patch({ externalUrl: event.target.value })
                    }
                  />
                  <ConnectionFieldFeedback
                    id={editorId}
                    field="externalUrl"
                    errors={fieldErrors}
                  />
                </div>
              )}
              <div>
                <label className="label" htmlFor={editorId + "-key"}>
                  {name} API key{current?.apiKeyConfigured ? " (optional)" : ""}
                </label>
                <input
                  id={editorId + "-key"}
                  {...fieldErrorAttributes(editorId, "apiKey", fieldErrors)}
                  className="input mt-2"
                  type="password"
                  autoComplete="off"
                  maxLength={512}
                  value={draft.apiKey}
                  placeholder={
                    current?.apiKeyConfigured
                      ? "Leave blank to keep the current credential"
                      : "Enter credential"
                  }
                  onChange={(event) => patch({ apiKey: event.target.value })}
                />
                <ConnectionFieldFeedback
                  id={editorId}
                  field="apiKey"
                  errors={fieldErrors}
                />
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">
              Check connection tests the values in this editor without saving.
              Leave the API key blank to use the saved credential. Moving to
              another server origin requires its API key again.
              {service === "jellyfin" &&
                " The external URL is the address your browser uses for playback; the Jellyfin server identity stays the same."}
            </p>
            {service === "whisparr" && (
              <WhisparrFields
                draft={draft}
                status={draftStatus ?? status}
                patch={patch}
                id={editorId}
                errors={fieldErrors}
              />
            )}
            <div className="settings-service-buttons settings-card-actions">
              <button
                type="submit"
                className={unsaved && primaryAction ? "btn btn-accent" : "btn"}
                aria-busy={pending || undefined}
              >
                <Icon name="check" />
                {pending ? "Saving…" : "Save"}
              </button>
              {current?.apiKeyConfigured && (
                <button type="button" className="btn" onClick={cancel}>
                  <Icon name="close" />
                  Cancel
                </button>
              )}
              {checkButton}
            </div>
          </fieldset>
          {saveFeedback}
          {testFailure && (
            <div className="mt-3">
              <ErrorPanel
                title={name + " connection test failed"}
                message={testFailure}
              />
            </div>
          )}
          {!testFailure && draftStatus && (
            <p className="mt-2 text-sm text-muted">
              {draftStatus.configured
                ? "Connection works" +
                  (draftStatus.version ? ": " + draftStatus.version : ".")
                : "Not configured — enter a URL and API key to test."}
            </p>
          )}
        </form>
      )}
      {editing && service === "whisparr" && info?.whisparr && (
        <>
          <div className="settings-destructive-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => removeRef.current?.showModal()}
            >
              <Icon name="trash" />
              Remove connection
            </button>
          </div>
          <SettingsConfirmationDialog
            dialogRef={removeRef}
            title="Remove the Whisparr connection?"
            cancelLabel="Keep connection"
            confirmLabel="Remove connection"
            disabled={busy}
            onConfirm={() => void apply(true)}
          >
            This removes the saved URL, credential, delivery settings, and path
            mappings. Approved requests remain in Velvarr until delivery is
            configured again.
          </SettingsConfirmationDialog>
        </>
      )}
      {!editing && saveFeedback}
    </section>
  );
}

function WhisparrFields({
  draft,
  status,
  patch,
  id,
  errors,
}: {
  errors: ConnectionFieldErrors;
  draft: ConnectionDraft;
  status: ConnectionStatus | null;
  patch: (value: Partial<ConnectionDraft>) => void;
  id: string;
}) {
  const roots = status?.rootFolders?.map((root) => root.path) ?? [];
  if (draft.rootFolderPath && !roots.includes(draft.rootFolderPath))
    roots.unshift(draft.rootFolderPath);
  const profiles = [...(status?.profiles ?? [])];
  const savedProfile = Number(draft.qualityProfileId);
  if (
    draft.qualityProfileId &&
    Number.isInteger(savedProfile) &&
    !profiles.some((profile) => profile.id === savedProfile)
  )
    profiles.push({ id: savedProfile, name: "Saved profile #" + savedProfile });
  return (
    <>
      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Whisparr delivery</legend>
        <p className="mt-1 text-sm text-muted">
          With delivery disabled, approved requests are held inside Velvarr
          until you enable it.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="check"
              checked={draft.deliveryEnabled}
              onChange={(event) =>
                patch({
                  deliveryEnabled: event.target.checked,
                  rootFolderPath: draft.rootFolderPath || roots[0] || "",
                  qualityProfileId:
                    draft.qualityProfileId ||
                    (profiles[0] ? String(profiles[0].id) : ""),
                })
              }
            />
            Send approved requests to Whisparr
          </label>
          <div>
            <label className="label" htmlFor={id + "-root"}>
              Root folder
            </label>
            {roots.length ? (
              <div className="settings-select mt-2">
                <select
                  id={id + "-root"}
                  {...fieldErrorAttributes(id, "rootFolderPath", errors)}
                  className="input"
                  value={draft.rootFolderPath}
                  onChange={(event) =>
                    patch({ rootFolderPath: event.target.value })
                  }
                >
                  <option value="">Choose a root folder</option>
                  {roots.map((root) => (
                    <option key={root} value={root}>
                      {root}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input
                id={id + "-root"}
                {...fieldErrorAttributes(id, "rootFolderPath", errors)}
                className="input mt-2"
                type="text"
                autoComplete="off"
                maxLength={1024}
                placeholder="Whisparr download root, e.g. /data/media"
                value={draft.rootFolderPath}
                onChange={(event) =>
                  patch({ rootFolderPath: event.target.value })
                }
              />
            )}
            <ConnectionFieldFeedback
              id={id}
              field="rootFolderPath"
              errors={errors}
            />
          </div>
          <div>
            <label className="label" htmlFor={id + "-profile"}>
              Quality profile
            </label>
            {profiles.length ? (
              <div className="settings-select mt-2">
                <select
                  id={id + "-profile"}
                  {...fieldErrorAttributes(id, "qualityProfileId", errors)}
                  className="input"
                  value={draft.qualityProfileId}
                  onChange={(event) =>
                    patch({ qualityProfileId: event.target.value })
                  }
                >
                  <option value="">Choose a quality profile</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input
                id={id + "-profile"}
                {...fieldErrorAttributes(id, "qualityProfileId", errors)}
                className="input mt-2"
                type="number"
                min={1}
                step={1}
                value={draft.qualityProfileId}
                onChange={(event) =>
                  patch({ qualityProfileId: event.target.value })
                }
              />
            )}
            <ConnectionFieldFeedback
              id={id}
              field="qualityProfileId"
              errors={errors}
            />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="check"
              checked={draft.searchOnAdd}
              onChange={(event) => patch({ searchOnAdd: event.target.checked })}
            />
            Search Whisparr as soon as a request is sent
          </label>
        </div>
      </fieldset>
      <fieldset className="mt-4 border-t border-edge pt-4">
        <legend className="label">Path mappings (Whisparr → Jellyfin)</legend>
        <p className="mt-1 text-sm text-muted">
          Prefix pairs that line Whisparr download paths up with Jellyfin
          library paths. Only needed when the two roots differ.
        </p>
        {draft.pathMappings.map((pair, index) => (
          <div key={index} className="mt-3 flex flex-wrap items-end gap-2">
            {(["whisparrPrefix", "jellyfinPrefix"] as const).map((field) => (
              <div key={field} className="min-w-40 flex-1">
                <label className="label" htmlFor={`${id}-${field}-${index}`}>
                  {field === "whisparrPrefix"
                    ? "Whisparr prefix"
                    : "Jellyfin prefix"}
                </label>
                <input
                  id={`${id}-${field}-${index}`}
                  className="input mt-2"
                  type="text"
                  autoComplete="off"
                  maxLength={1024}
                  value={pair[field]}
                  onChange={(event) =>
                    patch({
                      pathMappings: draft.pathMappings.map((value, i) =>
                        i === index
                          ? { ...value, [field]: event.target.value }
                          : value,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="btn"
              aria-label={`Remove path mapping ${index + 1}`}
              onClick={() =>
                patch({
                  pathMappings: draft.pathMappings.filter(
                    (_, i) => i !== index,
                  ),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn mt-3"
          disabled={draft.pathMappings.length >= 50}
          onClick={() =>
            patch({
              pathMappings: [
                ...draft.pathMappings,
                { whisparrPrefix: "", jellyfinPrefix: "" },
              ],
            })
          }
        >
          Add mapping
        </button>
      </fieldset>
    </>
  );
}

function fieldErrorAttributes(
  id: string,
  field: keyof ConnectionDraft,
  errors: ConnectionFieldErrors,
) {
  return {
    "aria-invalid": errors[field] ? (true as const) : undefined,
    "aria-describedby": errors[field] ? `${id}-${field}-error` : undefined,
  };
}
function ConnectionFieldFeedback({
  id,
  field,
  errors,
}: {
  id: string;
  field: keyof ConnectionDraft;
  errors: ConnectionFieldErrors;
}) {
  return errors[field] ? (
    <p
      id={`${id}-${field}-error`}
      role="alert"
      className="mt-2 text-sm text-danger"
    >
      {errors[field]}
    </p>
  ) : null;
}
