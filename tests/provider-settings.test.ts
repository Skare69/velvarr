// Per-provider credential card state: which chip a card shows and which
// actions it allows. The precedence keeps a typed key from reading as proven
// by the saved key's live result.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCheck } from "../src/lib/contracts.ts";
import {
  canClearCredential,
  canTestCredential,
  connectionState,
  credentialSaveDecision,
} from "../src/lib/provider-settings.ts";

const verified: ProviderCheck = {
  provider: "tpdb",
  configured: true,
  verified: true,
  account: "admin",
};
const rejected: ProviderCheck = {
  provider: "tpdb",
  configured: true,
  verified: false,
  error: { code: "tpdb_auth", message: "Key rejected." },
};
const absent: ProviderCheck = { provider: "stashdb", configured: false };

const base = {
  draft: "",
  checking: false,
  check: null as ProviderCheck | null,
  requestError: null as string | null,
};

test("a non-blank draft is unsaved, even over a check in flight", () => {
  assert.equal(
    connectionState({ ...base, draft: "new-key", checking: true }),
    "unsaved",
  );
});

test("a non-blank draft is unsaved, even over a verified result", () => {
  assert.equal(
    connectionState({ ...base, draft: " k ", check: verified }),
    "unsaved",
  );
});

test("a whitespace-only draft is not unsaved", () => {
  assert.equal(
    connectionState({ ...base, draft: "  \t", check: verified }),
    "connected",
  );
});

test("a check in flight is checking, even over a previous result", () => {
  assert.equal(
    connectionState({ ...base, checking: true, check: verified }),
    "checking",
  );
});

test("a failed request is failed, even with a previous verified result", () => {
  assert.equal(
    connectionState({ ...base, requestError: "Network down", check: verified }),
    "failed",
  );
});

test("no result and no error is unknown", () => {
  assert.equal(connectionState(base), "unknown");
});

test("configured false is not configured", () => {
  assert.equal(connectionState({ ...base, check: absent }), "not_configured");
});

test("a rejected key is failed", () => {
  assert.equal(connectionState({ ...base, check: rejected }), "failed");
});

test("an accepted key is connected", () => {
  assert.equal(connectionState({ ...base, check: verified }), "connected");
});

// The blank-Save regression (v0.41.0, fde0b7b): a blank click closed the
// editor without saving and without a message, so a not-configured provider
// looked set up. A blank edit of a configured credential is a Cancel (the
// button renders it disabled); with nothing configured the click keeps the
// editor open and names the missing field. The old canSaveCredential
// pending pin moved here: the component gates pending via actions.canEdit,
// it never passed pending: true to the helper.

test("a blank Save on a configured credential is a Cancel, so the button sits disabled", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "",
      clear: false,
      configured: true,
      name: "TPDB",
      label: "API token",
    }),
    { action: "cancel" },
  );
});

test("a blank Save while the configuration is still loading is a Cancel too", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "   ",
      clear: false,
      configured: undefined,
      name: "StashDB",
      label: "API key",
    }),
    { action: "cancel" },
  );
});

test("a blank Save with nothing configured keeps the editor open and names the TPDB field", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "",
      clear: false,
      configured: false,
      name: "TPDB",
      label: "API token",
    }),
    { action: "ask", message: "Enter a TPDB API token." },
  );
});

test("a blank Save with nothing configured names the StashDB field", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "",
      clear: false,
      configured: false,
      name: "StashDB",
      label: "API key",
    }),
    { action: "ask", message: "Enter a StashDB API key." },
  );
});

test("a non-blank Save stores the trimmed draft", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "  tok ",
      clear: false,
      configured: true,
      name: "TPDB",
      label: "API token",
    }),
    { action: "save", value: "tok", notice: "Credential saved." },
  );
});

test("a confirmed clear stores an empty value even with a draft", () => {
  assert.deepEqual(
    credentialSaveDecision({
      draft: "tok",
      clear: true,
      configured: true,
      name: "StashDB",
      label: "API key",
    }),
    {
      action: "save",
      value: "",
      notice: "Stored credential cleared. Environment settings apply.",
    },
  );
});

const testable = {
  draft: "",
  pending: false,
  checking: false,
  configured: true as boolean | undefined,
};

test("test is allowed with no draft and a configured key", () => {
  assert.equal(canTestCredential(testable), true);
});

test("test is blocked by a draft, but not by whitespace", () => {
  assert.equal(canTestCredential({ ...testable, draft: "new" }), false);
  assert.equal(canTestCredential({ ...testable, draft: "  " }), true);
});

test("test is blocked while pending or checking", () => {
  assert.equal(canTestCredential({ ...testable, pending: true }), false);
  assert.equal(canTestCredential({ ...testable, checking: true }), false);
});

test("test is blocked when not configured, allowed while unknown", () => {
  assert.equal(canTestCredential({ ...testable, configured: false }), false);
  assert.equal(canTestCredential({ ...testable, configured: undefined }), true);
});

test("clear is allowed only for a stored key", () => {
  assert.equal(canClearCredential({ source: "stored", pending: false }), true);
  assert.equal(
    canClearCredential({ source: "environment", pending: false }),
    false,
  );
  assert.equal(
    canClearCredential({ source: undefined, pending: false }),
    false,
  );
});

test("clear is blocked while a request is pending", () => {
  assert.equal(canClearCredential({ source: "stored", pending: true }), false);
});
