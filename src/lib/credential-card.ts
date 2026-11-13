// The TPDB/StashDB credential card's lifecycle (settings.tsx renders
// ProviderCredentialCard through this module), React-API-free so node --test
// can drive it directly: the test runner cannot import the .tsx component
// itself, because type stripping does not parse JSX. The card keeps its
// feedback honest with two separate outcomes: `saved` reports the last save,
// `check` reports the last connection probe of the *saved* credential. A
// blank Save never fakes either one: with a credential configured a blank
// edit is a Cancel, and with nothing configured the editor stays open and
// names the missing field (v0.41.0 regression, fde0b7b).

import { createElement } from "react";
import type {
  ChangeEvent,
  FormEvent,
  ReactElement,
  ReactNode,
  Ref,
} from "react";
import type { ProviderCheck } from "./contracts.ts";
import { credentialSaveDecision } from "./provider-settings.ts";

/** Everything ProviderCredentialCard renders from its own state. */
export type CredentialCardState = {
  /** The inline editor is open. */
  editing: boolean;
  draft: string;
  /** The live probe of the saved credential. */
  check: ProviderCheck | null;
  checking: boolean;
  checkError: string | null;
  /** The editor's POST test of the draft values. Kept apart from `check` so
   * a test result can never drive the rejected-key auto-delete: only the
   * saved probe may. */
  draftCheck: ProviderCheck | null;
  draftChecking: boolean;
  draftCheckError: string | null;
  saveError: string | null;
  saved: string | null;
  /** Why a blank Save could not act: shown under the input. */
  blankMessage: string | null;
  /** The account may not edit credentials at all. */
  forbidden: boolean;
};

export function initCredentialCard(): CredentialCardState {
  return {
    editing: false,
    draft: "",
    check: null,
    checking: false,
    checkError: null,
    draftCheck: null,
    draftChecking: false,
    draftCheckError: null,
    saveError: null,
    saved: null,
    blankMessage: null,
    forbidden: false,
  };
}

export type CredentialCardAction =
  /** The Edit button opens the editor; the old save notice goes. */
  | { type: "edit" }
  /** Cancel empties the draft and closes the editor. */
  | { type: "cancel" }
  | { type: "draft"; value: string }
  /** A connection check started: its result must not describe the draft. */
  | { type: "checking" }
  | { type: "checked"; check: ProviderCheck }
  | { type: "checkFailed"; message: string }
  /** A draft test of the editor's values started or landed. */
  | { type: "draftChecking" }
  | { type: "draftChecked"; check: ProviderCheck }
  | { type: "draftCheckFailed"; message: string }
  | { type: "forbidden" }
  /** One Save click starts by dropping the previous save outcome. */
  | { type: "saveStarted" }
  /** A blank Save with nothing configured asks for the key instead. */
  | { type: "blankRejected"; message: string }
  | { type: "saved"; notice: string }
  /** A failed save keeps the editor open; a forbidden account is a state,
   * not a message. */
  | { type: "saveFailed"; message: string; forbidden: boolean };

/** The draft's own result dies with the draft: a changed or cleared editor
 * would otherwise show a verdict for values nobody can see anymore. */
function dropDraftResult(state: CredentialCardState): CredentialCardState {
  return state.draftCheck === null &&
    !state.draftChecking &&
    state.draftCheckError === null
    ? state
    : {
        ...state,
        draftCheck: null,
        draftChecking: false,
        draftCheckError: null,
      };
}

export function reduceCredentialCard(
  state: CredentialCardState,
  action: CredentialCardAction,
): CredentialCardState {
  switch (action.type) {
    case "edit":
      return { ...dropDraftResult(state), editing: true, saved: null };
    case "cancel":
      return {
        ...dropDraftResult(state),
        draft: "",
        saveError: null,
        blankMessage: null,
        editing: false,
      };
    case "draft":
      return {
        ...dropDraftResult(state),
        draft: action.value,
        saveError: null,
        blankMessage: null,
      };
    case "checking":
      return { ...state, checking: true, check: null, checkError: null };
    case "checked":
      return {
        ...state,
        checking: false,
        check: action.check,
        // Only a proven rejection reopens the editor: the key is wrong and
        // needs replacing. An outage or timeout says nothing about the key.
        editing:
          state.editing ||
          (action.check.configured &&
            !action.check.verified &&
            action.check.error.code === "upstream_auth"),
      };
    case "checkFailed":
      return { ...state, checking: false, checkError: action.message };
    case "draftChecking":
      return {
        ...state,
        draftChecking: true,
        draftCheck: null,
        draftCheckError: null,
      };
    case "draftChecked":
      return {
        ...state,
        draftChecking: false,
        draftCheck: action.check,
      };
    case "draftCheckFailed":
      return {
        ...state,
        draftChecking: false,
        draftCheckError: action.message,
      };
    case "forbidden":
      return {
        ...state,
        forbidden: true,
        checking: false,
        draftChecking: false,
      };
    case "saveStarted":
      return { ...state, saveError: null, saved: null, blankMessage: null };
    case "blankRejected":
      return { ...state, blankMessage: action.message };
    case "saved":
      return {
        ...dropDraftResult(state),
        saved: action.notice,
        draft: "",
        editing: false,
      };
    case "saveFailed":
      return action.forbidden
        ? { ...state, forbidden: true }
        : { ...state, saveError: action.message };
  }
}

/** Parent busy flags plus the card's own request states. */
export function credentialCardBusy(
  state: CredentialCardState,
  saving: boolean,
): boolean {
  return saving || state.checking || state.draftChecking || state.forbidden;
}

/** Which Check connection a service card shows, decided before render so the
 * button and the click cannot drift apart:
 * - the editor is open → "draft": the button POSTs the form's values (a
 *   blank secret field means "use the saved secret");
 * - closed with a failed saved check → "retry": the GET probe of the saved
 *   settings again;
 * - otherwise hidden: the page probes every saved connection on load, and
 *   the status chip beside the title carries the result. */
export function checkConnectionAction(input: {
  editorOpen: boolean;
  savedCheckFailed: boolean;
}): "draft" | "retry" | null {
  if (input.editorOpen) return "draft";
  return input.savedCheckFailed ? "retry" : null;
}

/** The one rejected check that deletes the stored credential on its own:
 * the provider answered "unauthorized", so the stored key is proven wrong
 * and keeping it only fails every later call. The check must also carry a
 * keyFingerprint: without one the probe probed the environment fallback,
 * not a stored key this check can vouch for — and an automatic delete
 * never falls back to the unconditional manual clear (VELV-130
 * send-back). The server's compare-and-set still refuses any guarded
 * clear whose fingerprint no longer matches. Nothing else may clear: an
 * environment key cannot be deleted, and any other error code (timeout,
 * unavailable, forbidden, not_found, bad_response) says nothing about the
 * key. */
export function shouldAutoClearOnReject(input: {
  check: ProviderCheck;
  source: "stored" | "environment" | undefined;
}): boolean {
  return (
    input.source === "stored" &&
    input.check.configured &&
    !input.check.verified &&
    input.check.error.code === "upstream_auth" &&
    input.check.keyFingerprint !== undefined
  );
}

/** One Save click's full flow, shared by the Save button's form submit and
 * the destructive clear dialog. The decision is the same one the editor's
 * Save button renders, so the button and the click cannot drift apart.
 * Returns whether a credential was saved or cleared, so the caller
 * re-verifies the connection exactly then. */
export async function applyCredentialSave(input: {
  draft: string;
  clear: boolean;
  configured: boolean | undefined;
  name: string;
  label: string;
  /** Performs the network save or clear for the already trimmed value. */
  performSave: (value: string) => Promise<void>;
  dispatch: (action: CredentialCardAction) => void;
  /** Replaces the decision's notice for one clear: the rejected-key
   * auto-clear explains the deletion, not the generic cleared text. */
  clearNotice?: string;
  /** Classifies a failed performSave; messageOf stays the caller's job so
   * this module never imports client code. */
  failureOf: (error: unknown) => { forbidden: boolean; message: string };
}): Promise<{ saved: boolean }> {
  input.dispatch({ type: "saveStarted" });
  const save = credentialSaveDecision({
    draft: input.draft,
    clear: input.clear,
    configured: input.configured,
    name: input.name,
    label: input.label,
  });
  if (save.action !== "save") {
    // A blank edit of a configured credential is a Cancel: the disabled
    // button normally blocks it, and an Enter submission lands here and
    // keeps the editor open instead of faking a save. With nothing
    // configured the click keeps the editor open and names the field.
    if (save.action === "ask") {
      input.dispatch({ type: "blankRejected", message: save.message });
    }
    return { saved: false };
  }
  try {
    await input.performSave(save.value);
    input.dispatch({ type: "saved", notice: input.clearNotice ?? save.notice });
    return { saved: true };
  } catch (error) {
    const failure = input.failureOf(error);
    input.dispatch({
      type: "saveFailed",
      message: failure.message,
      forbidden: failure.forbidden,
    });
    return { saved: false };
  }
}

/** The inline editor's markup, built with createElement so node --test can
 * render the exact elements the component renders. The Save button's
 * disabled state and the click both read credentialSaveDecision, so they
 * cannot drift apart. */
export function credentialEditorView(input: {
  id: string;
  name: string;
  label: string;
  maxLength: number;
  configured: boolean | undefined;
  state: CredentialCardState;
  canEdit: boolean;
  busy: boolean;
  /** A save is in flight: Save reads "Saving…" and sets aria-busy. */
  saving: boolean;
  /** Focus returns to this input when the editor opens. */
  inputRef: Ref<HTMLInputElement>;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
  /** House icons for Save and Cancel; lib code cannot import the .tsx set. */
  icons?: { save: ReactNode; cancel: ReactNode };
  /** Card actions that share the editor's action row (Check connection). */
  trailing?: ReactNode;
}): ReactElement {
  const saveDecision = credentialSaveDecision({
    draft: input.state.draft,
    clear: false,
    configured: input.configured,
    name: input.name,
    label: input.label,
  });
  return createElement(
    "form",
    {
      id: "provider-editor-" + input.id,
      className: "settings-service-editor",
      onSubmit: input.onSubmit,
    },
    createElement(
      "label",
      { className: "label", htmlFor: "provider-" + input.id },
      // Rule 9: a configured key may stay as-is when left blank, so the
      // label says so (the .label style already carries the muted tone).
      input.name + " " + input.label + (input.configured ? " (optional)" : ""),
    ),
    createElement("input", {
      id: "provider-" + input.id,
      ref: input.inputRef,
      className: "input mt-2",
      type: "password",
      autoComplete: "off",
      maxLength: input.maxLength,
      disabled: !input.canEdit,
      "aria-describedby": input.state.blankMessage
        ? "blank-hint-" + input.id
        : undefined,
      // Rule 35: the failed field itself carries the state.
      "aria-invalid": input.state.blankMessage ? true : undefined,
      value: input.state.draft,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        input.onDraftChange(event.target.value),
      placeholder: input.configured
        ? "Leave blank to keep the current credential"
        : "Enter credential",
    }),
    input.state.blankMessage
      ? createElement(
          "p",
          {
            id: "blank-hint-" + input.id,
            className: "mt-2 text-sm text-muted",
            role: "status",
          },
          input.state.blankMessage,
        )
      : null,
    createElement(
      "p",
      { className: "mt-2 text-sm text-muted" },
      "Saved credentials are encrypted and take precedence over the environment. Connection checks use the saved credential or environment fallback.",
    ),
    createElement(
      "div",
      { className: "settings-service-buttons settings-card-actions" },
      createElement(
        "button",
        {
          type: "submit",
          // Rule 1: the accent fill marks the decision; a blank draft keeps
          // Save a plain secondary button (a blank Save explains itself).
          className: input.state.draft.trim() !== "" ? "btn btn-accent" : "btn",
          disabled: !input.canEdit || saveDecision.action === "cancel",
          "aria-busy": input.saving || undefined,
        },
        input.icons?.save ?? null,
        input.saving ? "Saving…" : "Save",
      ),
      // With nothing configured the editor is the card's only state, so a
      // Cancel that cannot close it is omitted.
      input.configured === false
        ? null
        : createElement(
            "button",
            {
              type: "button",
              className: "btn",
              disabled: input.busy,
              onClick: input.onCancel,
            },
            input.icons?.cancel ?? null,
            "Cancel",
          ),
      input.trailing ?? null,
    ),
  );
}
