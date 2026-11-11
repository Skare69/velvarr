/** The AI-assisted matching card's draft/save/check lifecycle, React-free so
 * the rules that keep feedback honest are directly testable.
 *
 * Two outcomes stay apart on purpose. `notice` reports the last save (or its
 * failure); `check` reports the last connection probe of the *saved*
 * settings. A failed probe after a successful save therefore never turns
 * the save into an error, and editing the draft never hides the result of
 * the settings that are still in force. */

import type { JudgmentProvider } from "./contracts.ts";

export type JudgmentSettings = {
  provider: JudgmentProvider;
  url: string;
  model: string;
};

/** Use the same effective selection after a save and a configuration read.
 * An absent backend is standard matching, unless a stored choice or error
 * needs to remain visible so the operator can correct it. */
export function judgmentEditorSettings(
  config: JudgmentSettings & {
    configured: boolean;
    stored: boolean;
    error?: string;
  },
): JudgmentSettings {
  return {
    provider:
      !config.configured && !config.stored && !config.error
        ? "none"
        : config.provider,
    url: config.url,
    model: config.model,
  };
}

export type JudgmentCheck =
  | { state: "checking" }
  | { state: "connected"; provider: JudgmentProvider }
  | { state: "failed"; message: string };

export type JudgmentEditor = {
  /** The persisted settings; `draft` until the first load. */
  saved: JudgmentSettings;
  draft: JudgmentSettings;
  /** The probe of `saved`; null when no probe ran since the last save. */
  check: JudgmentCheck | null;
  /** The last save's outcome. */
  notice: string | null;
};

export type JudgmentEditorAction =
  /** The server's settings arrived: the draft restarts from them. A load
   * after another card's save (for example a new TypeSafe key) can change
   * what a probe would answer, so the old result goes. */
  | { type: "loaded"; settings: JudgmentSettings }
  | { type: "edit"; patch: Partial<JudgmentSettings> }
  | { type: "cancel" }
  /** The PATCH succeeded with these effective settings. */
  | { type: "saved"; settings: JudgmentSettings; notice?: string }
  | { type: "saveFailed"; message: string }
  | { type: "checking" }
  | {
      type: "checked";
      result:
        | { connected: true; provider: JudgmentProvider }
        | {
            connected: false;
            message: string;
          };
    };

export const SAVED_NOTICE = "Settings saved.";
/** The save notice when the effective provider is "none": no probe runs. */
export const SAVED_OFF_NOTICE = "Settings saved. AI-assisted matching is off.";

export function initJudgmentEditor(): JudgmentEditor {
  const settings: JudgmentSettings = {
    provider: "typesafe",
    url: "http://localhost:11434",
    model: "nimble",
  };
  return { saved: settings, draft: settings, check: null, notice: null };
}

export function reduceJudgmentEditor(
  e: JudgmentEditor,
  a: JudgmentEditorAction,
): JudgmentEditor {
  switch (a.type) {
    case "loaded":
      return { ...e, saved: a.settings, draft: a.settings, check: null };
    // The check describes the saved settings, which an edit does not touch.
    // "Settings saved." would claim the edited form is saved, so it goes; a
    // save error stays until the next save attempt.
    case "edit":
      return {
        ...e,
        draft: { ...e.draft, ...a.patch },
        notice:
          e.notice === SAVED_NOTICE || e.notice === SAVED_OFF_NOTICE
            ? null
            : e.notice,
      };
    case "cancel":
      return { ...e, draft: e.saved };
    // A result for the previous settings would describe settings no longer
    // in force.
    case "saved":
      return {
        saved: a.settings,
        draft: a.settings,
        check: null,
        notice:
          a.notice ??
          (a.settings.provider === "none" ? SAVED_OFF_NOTICE : SAVED_NOTICE),
      };
    case "saveFailed":
      return { ...e, notice: a.message };
    case "checking":
      return { ...e, check: { state: "checking" } };
    // Only an awaited probe may land: a stale answer must not describe
    // settings saved after it started.
    case "checked":
      if (e.check?.state !== "checking") return e;
      return {
        ...e,
        check: a.result.connected
          ? { state: "connected", provider: a.result.provider }
          : { state: "failed", message: a.result.message },
      };
  }
}

export function isDirty(e: JudgmentEditor): boolean {
  const { saved, draft } = e;
  if (draft.provider !== saved.provider) return true;
  // TypeSafe saves only the provider, so Ollama fields are not a change.
  if (draft.provider !== "ollama") return false;
  return draft.url !== saved.url || draft.model !== saved.model;
}

/** Which of the card's actions may run now. `configured` is the server's
 * verdict on the saved settings; a probe needs it. A save (`save`, or
 * `reset` back to the environment) waits for a running probe, so the
 * probe's answer always belongs to the settings it tested. */
export function providerSettingsActions(
  e: JudgmentEditor,
  status: { ready: boolean; pending: boolean; configured: boolean },
): { save: boolean; reset: boolean; cancel: boolean; check: boolean } {
  const idle = status.ready && !status.pending && e.check?.state !== "checking";
  const complete =
    e.draft.provider !== "ollama" ||
    (e.draft.url.trim() !== "" && e.draft.model.trim() !== "");
  return {
    save: idle && complete,
    reset: idle,
    cancel: idle && isDirty(e),
    check: idle && status.configured,
  };
}
