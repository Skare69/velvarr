import type { ProviderCheck } from "./contracts.ts";

/** What one provider credential card shows about its connection. */
export type ConnectionState =
  | "unsaved"
  | "checking"
  | "connected"
  | "failed"
  | "not_configured"
  | "unknown";

export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  unsaved: "Unsaved changes",
  checking: "Checking…",
  connected: "Connected",
  failed: "Failed",
  not_configured: "Not configured",
  unknown: "Unknown",
};

/** Precedence, first match wins:
 * 1. a non-blank draft → "unsaved": the live result describes the saved key,
 *    not the typed one, so it must not read as proof for the draft;
 * 2. a check in flight → "checking";
 * 3. the request itself failed → "failed";
 * 4. no result yet → "unknown";
 * 5. no key saved or in the environment → "not_configured";
 * 6. the provider accepted the key → "connected", else "failed". */
export function connectionState(input: {
  draft: string;
  checking: boolean;
  check: ProviderCheck | null;
  requestError: string | null;
}): ConnectionState {
  const { draft, checking, check, requestError } = input;
  if (draft.trim() !== "") return "unsaved";
  if (checking) return "checking";
  if (requestError !== null) return "failed";
  if (check === null) return "unknown";
  if (!check.configured) return "not_configured";
  return check.verified ? "connected" : "failed";
}

export function canSaveCredential(input: {
  draft: string;
  pending: boolean;
}): boolean {
  return input.draft.trim() !== "" && !input.pending;
}

/** Testing with an unsaved draft would test the old key, so a draft blocks
 * it. `configured` is undefined while the config shape is still loading. */
export function canTestCredential(input: {
  draft: string;
  pending: boolean;
  checking: boolean;
  configured: boolean | undefined;
}): boolean {
  return (
    !input.pending &&
    !input.checking &&
    input.draft.trim() === "" &&
    input.configured !== false
  );
}

/** Only a stored key can be cleared; an environment key stays. */
export function canClearCredential(input: {
  source: "stored" | "environment" | undefined;
  pending: boolean;
}): boolean {
  return input.source === "stored" && !input.pending;
}

/** Saves and live probes share persisted configuration. Queue both kinds of
 * operation, including same-tick calls, and recover after a failed request. */
export function createProviderSettingsQueue() {
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
