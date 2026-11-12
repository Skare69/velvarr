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
import type { ChangeEvent, FormEvent, ReactElement, Ref } from "react";
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
  | { type: "forbidden" }
  /** One Save click starts by dropping the previous save outcome. */
  | { type: "saveStarted" }
  /** A blank Save with nothing configured asks for the key instead. */
  | { type: "blankRejected"; message: string }
  | { type: "saved"; notice: string }
  /** A failed save keeps the editor open; a forbidden account is a state,
   * not a message. */
  | { type: "saveFailed"; message: string; forbidden: boolean };

export function reduceCredentialCard(
  state: CredentialCardState,
  action: CredentialCardAction,
): CredentialCardState {
  switch (action.type) {
    case "edit":
      return { ...state, editing: true, saved: null };
    case "cancel":
      return {
        ...state,
        draft: "",
        saveError: null,
        blankMessage: null,
        editing: false,
      };
    case "draft":
      return {
        ...state,
        draft: action.value,
        saveError: null,
        blankMessage: null,
      };
    case "checking":
      return { ...state, checking: true, check: null, checkError: null };
    case "checked":
      return { ...state, checking: false, check: action.check };
    case "checkFailed":
      return { ...state, checking: false, checkError: action.message };
    case "forbidden":
      return { ...state, forbidden: true, checking: false };
    case "saveStarted":
      return { ...state, saveError: null, saved: null, blankMessage: null };
    case "blankRejected":
      return { ...state, blankMessage: action.message };
    case "saved":
      return { ...state, saved: action.notice, draft: "", editing: false };
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
  return saving || state.checking || state.forbidden;
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
    input.dispatch({ type: "saved", notice: save.notice });
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
  /** Focus returns to this input when the editor opens. */
  inputRef: Ref<HTMLInputElement>;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
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
      input.name + " " + input.label,
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
      { className: "settings-service-buttons mt-4" },
      createElement(
        "button",
        {
          type: "submit",
          className: "btn btn-accent",
          disabled: !input.canEdit || saveDecision.action === "cancel",
        },
        "Save",
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "btn",
          disabled: input.busy,
          onClick: input.onCancel,
        },
        "Cancel",
      ),
    ),
  );
}
