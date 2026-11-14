// Common settings vocabulary and operation ordering for both tabs.
/** Connection vocabulary shared by both settings tabs. */
export type ConnectionState =
  | "unsaved"
  | "checking"
  | "connected"
  | "failed"
  | "not_configured"
  | "unknown";

export const CONNECTION_STATE_LABEL = {
  unsaved: "Unsaved changes",
  checking: "Checking…",
  connected: "Connected",
  failed: "Connection failed",
  not_configured: "Not configured",
  unknown: "Not checked",
} as const;

export type SettingsFailureOf = (error: unknown) => {
  forbidden: boolean;
  message: string;
};

/** Saves and live probes share persisted configuration. Queue both kinds of
 * operation, including same-tick calls, and recover after a failed request. */
export function createSettingsOperationQueue() {
  let tail = Promise.resolve();
  return function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
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
