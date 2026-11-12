// Per-provider credential card state: which chip a card shows and which
// actions it allows. The precedence keeps a typed key from reading as proven
// by the saved key's live result.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCheck } from "../src/lib/contracts.ts";
import {
  CONNECTION_STATE_LABEL,
  createProviderSettingsQueue,
  canClearCredential,
  canSaveCredential,
  canTestCredential,
  connectionState,
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

test("the connection chip copy is pinned for every state", () => {
  assert.deepEqual(CONNECTION_STATE_LABEL, {
    unsaved: "Unsaved changes",
    checking: "Checking…",
    connected: "Connected",
    failed: "Failed",
    not_configured: "Not configured",
    unknown: "Unknown",
  });
});

test("save needs a non-blank draft", () => {
  assert.equal(canSaveCredential({ draft: "key", pending: false }), true);
  assert.equal(canSaveCredential({ draft: "   ", pending: false }), false);
  assert.equal(canSaveCredential({ draft: "", pending: false }), false);
});

test("save is blocked while a request is pending", () => {
  assert.equal(canSaveCredential({ draft: "key", pending: true }), false);
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

test("provider saves and probes share one queue even when requested in the same tick", async () => {
  const run = createProviderSettingsQueue();
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = run(async () => {
    events.push("save started");
    await barrier;
    events.push("save finished");
    return "saved";
  });
  const probe = run(async () => {
    events.push("probe");
    return "checked";
  });
  await Promise.resolve();
  assert.deepEqual(events, ["save started"]);
  release();
  assert.deepEqual(await Promise.all([save, probe]), ["saved", "checked"]);
  assert.deepEqual(events, ["save started", "save finished", "probe"]);
});

test("a failed provider probe cannot block later saves or checks", async () => {
  const run = createProviderSettingsQueue();
  const failure = new Error("Synthetic probe failure");
  const probe = run(async () => {
    throw failure;
  });
  const save = run(async () => "saved after failure");
  await assert.rejects(probe, (error) => error === failure);
  assert.equal(await save, "saved after failure");
  assert.equal(
    await run(async () => "checked after save"),
    "checked after save",
  );
});
