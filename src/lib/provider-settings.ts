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

export const CREDENTIAL_SAVED_NOTICE = "Credential saved.";
export const CREDENTIAL_CLEARED_NOTICE =
  "Stored credential cleared. Environment settings apply.";

/** What one Save click on a credential editor does, decided before any
 * network call so the button's disabled state and the click cannot drift
 * apart (settings.tsx renders both from this decision):
 * - a non-blank draft saves the trimmed value;
 * - the confirmed clear (destructive dialog) saves "" so the environment
 *   settings apply again, even over a typed draft;
 * - a blank draft keeps the current credential, so with a credential
 *   configured ("true", or still loading) the decision is "cancel": the
 *   button renders disabled and the click leaves the editor open instead
 *   of closing it like a silent save (v0.41.0 regression, fde0b7b);
 * - with nothing configured the blank editor is the setup path, so the
 *   decision is "ask": the editor stays open and the message names the
 *   missing field. */
export type CredentialSaveDecision =
  | { action: "save"; value: string; notice: string }
  | { action: "cancel" }
  | { action: "ask"; message: string };

export function credentialSaveDecision(input: {
  draft: string;
  clear: boolean;
  configured: boolean | undefined;
  name: string;
  label: string;
}): CredentialSaveDecision {
  if (input.clear)
    return { action: "save", value: "", notice: CREDENTIAL_CLEARED_NOTICE };
  const value = input.draft.trim();
  if (value !== "")
    return { action: "save", value, notice: CREDENTIAL_SAVED_NOTICE };
  if (input.configured !== false) return { action: "cancel" };
  return {
    action: "ask",
    message: "Enter a " + input.name + " " + input.label + ".",
  };
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
