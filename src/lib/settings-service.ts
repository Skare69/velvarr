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
