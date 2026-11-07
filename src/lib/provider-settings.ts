/** Provider probes read persisted settings on the server, independently of
 * the configuration read used to populate editable fields. */
export function providerSettingsActions({
  configLoaded,
  busy,
  unsaved = false,
  storedJudgment = false,
}: {
  configLoaded: boolean;
  busy: boolean;
  unsaved?: boolean;
  storedJudgment?: boolean;
}) {
  return {
    canCheck: !busy && !unsaved,
    canEdit: !busy && configLoaded,
    // An explicit no-AI choice is also a stored override of the environment.
    canUseEnvironment: storedJudgment,
  };
}

export type JudgmentEditor = {
  editing: boolean;
  connected: boolean | null;
  message: string | null;
};

export type JudgmentEditorAction =
  | { type: "edit" }
  | { type: "cancel" }
  | { type: "saved"; message: string }
  | { type: "checking" }
  | { type: "checked"; connected: boolean; message: string };

export function initJudgmentEditor(): JudgmentEditor {
  return { editing: false, connected: null, message: null };
}

/** Draft edits do not invalidate the saved connection result. Only a
 * successful save or a new check replaces its badge and explanation. */
export function reduceJudgmentEditor(
  state: JudgmentEditor,
  action: JudgmentEditorAction,
): JudgmentEditor {
  switch (action.type) {
    case "edit":
      return { ...state, editing: true };
    case "cancel":
      return { ...state, editing: false };
    case "saved":
      return { editing: false, connected: null, message: action.message };
    case "checking":
      return { ...state, connected: null, message: null };
    case "checked":
      return {
        ...state,
        connected: action.connected,
        message: action.message,
      };
  }
}
