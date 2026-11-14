import type { ProviderCheck } from "./contracts.ts";

import type { ConnectionState } from "./settings-service.ts";

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

/** Which Settings tab a deep link's hash targets. Discover's key links point
 * at provider card headings (`provider-heading-tpdb` /
 * `provider-heading-stashdb`), which live on the metadata tab; any other hash
 * (the Jellyfin heading, or none) stays on the default Connections tab. */
export function settingsSectionForHash(
  hash: string,
): "connections" | "metadata" {
  return hash.startsWith("#provider-heading-") ? "metadata" : "connections";
}

export const CREDENTIAL_SAVED_NOTICE = "Credential saved.";
export const CREDENTIAL_CLEARED_NOTICE =
  "Stored credential cleared. Environment settings apply.";

/** What one Save click on a credential editor does, decided before any
 * network call so the button's disabled state and the click cannot drift
 * apart (metadata-settings.tsx renders both from this decision):
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

/** Only a stored key can be cleared; an environment key stays. */
export function canClearCredential(input: {
  source: "stored" | "environment" | undefined;
  pending: boolean;
}): boolean {
  return input.source === "stored" && !input.pending;
}
