// Jellyfin/Whisparr card lifecycle, used by connection-settings.tsx and tested
// directly by connection-card.test.ts. Draft validation stays in
// connection-settings.ts; this module coordinates editor and request outcomes.
import type { SettingsFailureOf } from "./settings-service.ts";
import {
  connectionDraft,
  connectionDraftChanged,
  connectionPatch,
  type ConnectionDraft,
  type ConnectionPatch,
  type ConnectionService,
  type ConnectionsInfo,
} from "./connection-settings.ts";

export type ConnectionStatus = {
  configured: boolean;
  serverName?: string;
  appName?: string;
  version?: string;
  rootFolders?: { id: number; path: string }[];
  profiles?: { id: number; name: string }[];
  error?: { code: string; message: string };
};

export type ConnectionCardState = {
  status: ConnectionStatus | null;
  checking: boolean;
  checkError: string | null;
  editing: boolean;
  draft: ConnectionDraft;
  pending: boolean;
  saveError: string | null;
  saved: string | null;
};

export function initConnectionCard(
  service: ConnectionService,
): ConnectionCardState {
  return {
    status: null,
    checking: false,
    checkError: null,
    editing: false,
    draft: connectionDraft(service),
    pending: false,
    saveError: null,
    saved: null,
  };
}

export type ConnectionCardAction =
  | { type: "edit"; service: ConnectionService; info: ConnectionsInfo }
  | { type: "cancel"; service: ConnectionService; info?: ConnectionsInfo }
  | { type: "draft"; changes: Partial<ConnectionDraft> }
  | { type: "checking" }
  | { type: "checked"; status: ConnectionStatus }
  | { type: "checkFailed"; message: string }
  | { type: "checkFinished" }
  | { type: "saveStarted" }
  | { type: "unchanged" }
  | { type: "saving" }
  | { type: "saved"; draft: ConnectionDraft; notice: string }
  | { type: "saveFailed"; message: string }
  | { type: "saveFinished" };

export function reduceConnectionCard(
  state: ConnectionCardState,
  action: ConnectionCardAction,
): ConnectionCardState {
  switch (action.type) {
    case "edit":
    case "cancel":
      return {
        ...state,
        draft: connectionDraft(action.service, action.info),
        editing: action.type === "edit",
        saved: null,
        saveError: null,
      };
    case "draft":
      return {
        ...state,
        draft: { ...state.draft, ...action.changes },
        saveError: null,
        saved: null,
      };
    case "checking":
      return { ...state, checking: true, checkError: null };
    case "checked":
      return { ...state, status: action.status };
    case "checkFailed":
      return { ...state, checkError: action.message };
    case "checkFinished":
      return { ...state, checking: false };
    case "saveStarted":
      return { ...state, saveError: null, saved: null };
    case "unchanged":
      return { ...state, saved: "No changes to save." };
    case "saving":
      return { ...state, pending: true };
    case "saved":
      return {
        ...state,
        draft: action.draft,
        saved: action.notice,
        editing: false,
        status: null,
      };
    case "saveFailed":
      return { ...state, saveError: action.message };
    case "saveFinished":
      return { ...state, pending: false };
  }
}

export function connectionCardBusy(
  state: ConnectionCardState,
  saving: boolean,
) {
  return saving || state.pending || state.checking;
}

type ConnectionFailure = {
  dispatch: (action: ConnectionCardAction) => void;
  failureOf: SettingsFailureOf;
  onForbidden: () => void;
};

/** Expected probe failures report a diagnosis without rejecting a successful
 * save. The caller supplies the same shared queue used by the other cards. */
export async function checkConnection(
  input: ConnectionFailure & {
    performCheck: () => Promise<ConnectionStatus>;
  },
): Promise<void> {
  input.dispatch({ type: "checking" });
  try {
    input.dispatch({ type: "checked", status: await input.performCheck() });
  } catch (error) {
    const failure = input.failureOf(error);
    if (failure.forbidden) input.onForbidden();
    else input.dispatch({ type: "checkFailed", message: failure.message });
  } finally {
    input.dispatch({ type: "checkFinished" });
  }
}

/** Save/confirmed removal flow used by the real form and removal dialog.
 * Persistence finishes before the new saved settings are probed. */
export async function applyConnectionSave(
  input: ConnectionFailure & {
    service: ConnectionService;
    info?: ConnectionsInfo;
    state: ConnectionCardState;
    saving: boolean;
    configurationUnavailable: boolean;
    remove: boolean;
    performSave: (body: ConnectionPatch) => Promise<ConnectionsInfo>;
    verify: () => Promise<void>;
  },
): Promise<{ saved: boolean }> {
  const { service, info, state } = input;
  if (
    !info ||
    connectionCardBusy(state, input.saving) ||
    input.configurationUnavailable
  )
    return { saved: false };
  input.dispatch({ type: "saveStarted" });
  let body: ConnectionPatch;
  try {
    body = input.remove
      ? { whisparrUrl: "" }
      : connectionPatch(service, state.draft, info);
    if (!input.remove && !connectionDraftChanged(service, state.draft, info)) {
      input.dispatch({ type: "unchanged" });
      return { saved: false };
    }
  } catch (error) {
    input.dispatch({
      type: "saveFailed",
      message: input.failureOf(error).message,
    });
    return { saved: false };
  }
  input.dispatch({ type: "saving" });
  try {
    const data = await input.performSave(body);
    input.dispatch({
      type: "saved",
      draft: connectionDraft(service, data),
      notice: input.remove
        ? "Whisparr connection removed."
        : (service === "jellyfin" ? "Jellyfin" : "Whisparr") +
          " settings saved.",
    });
    await input.verify();
    return { saved: true };
  } catch (error) {
    const failure = input.failureOf(error);
    if (failure.forbidden) input.onForbidden();
    else input.dispatch({ type: "saveFailed", message: failure.message });
    return { saved: false };
  } finally {
    input.dispatch({ type: "saveFinished" });
  }
}
