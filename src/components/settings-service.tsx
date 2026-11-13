"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  createSettingsOperationQueue,
  type SettingsFailureOf,
} from "../lib/settings-service.ts";
import { ApiError, api, ErrorPanel, messageOf } from "./shared.tsx";

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
export type ConnectionStateLabel = keyof typeof CONNECTION_STATE_CLASSES;

export function ConnectionState({ state }: { state: ConnectionStateLabel }) {
  return (
    <span className={"connection-state " + CONNECTION_STATE_CLASSES[state]}>
      {state}
    </span>
  );
}

export function SettingsServiceHeading({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-service-summary">
      <div className="settings-service-heading">
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="settings-service-buttons">{children}</div>}
    </div>
  );
}

export type RunSettingsOperation = <T>(
  operation: () => Promise<T>,
) => Promise<T>;
export type SettingsOperations = {
  saving: boolean;
  runOperation: RunSettingsOperation;
};

/** All settings writes and probes share a queue, including across hidden tabs.
 * A probe sees the saved settings; concurrent PATCH snapshots cannot undo one
 * another. A rejected operation releases the queue for the next request. */
export function useSettingsOperations(): SettingsOperations {
  const [saving, setSaving] = useState(false);
  const [runQueued] = useState(createSettingsOperationQueue);
  const operationCount = useRef(0);
  const runOperation: RunSettingsOperation = useCallback(
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
  return { saving, runOperation };
}

/** Closing an inline editor returns focus to Edit. While a post-save probe
 * disables Edit, the save notice keeps keyboard focus on the same card. */
export function useEditorFocusReturn(editing: boolean) {
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

/** Identical read/write mechanics for each tab; cards remain mounted while
 * reads fail, and their saved-service probes run independently. */
export function useSettingsConfiguration<T>({
  runOperation,
  onForbidden,
  onSaved,
}: {
  runOperation: RunSettingsOperation;
  onForbidden: () => void;
  onSaved?: () => void;
}) {
  const [info, setInfo] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api<T>("/api/admin/integrations")
      .then(setInfo)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 403) onForbidden();
        else setLoadError(messageOf(error));
      })
      .finally(() => setLoading(false));
  }, [onForbidden]);
  useEffect(load, [load]);
  const save = (body: object) =>
    runOperation(async () => {
      const data = await api<T>("/api/admin/integrations", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setInfo(data);
      setLoadError(null);
      onSaved?.();
      return data;
    });
  return {
    info,
    loadError,
    load,
    save,
    unavailable: loading || Boolean(loadError),
  };
}

export const settingsFailureOf: SettingsFailureOf = (error) => ({
  forbidden: error instanceof ApiError && error.status === 403,
  message: messageOf(error),
});

/** Keep save feedback at the same location next to every editor's actions. */
export function SettingsSaveFeedback({
  notice,
  error,
  errorTitle,
  noticeRef,
}: {
  notice?: string | null;
  error?: string | null;
  errorTitle: string;
  noticeRef?: Ref<HTMLParagraphElement>;
}) {
  return (
    <>
      {notice && (
        <p
          ref={noticeRef}
          className="mt-3 text-sm text-muted"
          role="status"
          tabIndex={-1}
        >
          {notice}
        </p>
      )}
      {error && (
        <div className="mt-3">
          <ErrorPanel title={errorTitle} message={error} />
        </div>
      )}
    </>
  );
}

/** All destructive settings actions use one accessible dialog structure. */
export function SettingsConfirmationDialog({
  dialogRef,
  title,
  children,
  cancelLabel,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  title: string;
  children: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <dialog ref={dialogRef} className="bulk-dialog" aria-labelledby={titleId}>
      <div className="p-5">
        <h3 id={titleId} className="font-semibold">
          {title}
        </h3>
        <p className="mt-2 text-sm text-muted">{children}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => dialogRef.current?.close()}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={disabled}
            onClick={() => {
              dialogRef.current?.close();
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function SettingsCheckButton({
  checking,
  disabled,
  helpId,
  onCheck,
}: {
  checking: boolean;
  disabled: boolean;
  helpId?: string;
  onCheck: () => void;
}) {
  return (
    <button
      type="button"
      className="btn"
      disabled={disabled}
      aria-describedby={helpId}
      onClick={onCheck}
    >
      {checking ? "Checking…" : "Check connection"}
    </button>
  );
}
