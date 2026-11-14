// The AI-assisted matching card's lifecycle (src/lib/judgment-editor.ts).
// The save notice and the connection probe are separate outcomes: the probe
// describes the *saved* settings, so a draft edit keeps it, a new save
// drops it, and a failed probe after a save never turns the save into an
// error.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initJudgmentEditor,
  isDirty,
  judgmentCheckDisabledReason,
  judgmentEditorSettings,
  providerSettingsActions,
  reduceJudgmentEditor,
  type JudgmentConfig,
  type JudgmentEditor,
  type JudgmentEditorAction,
  type JudgmentSettings,
} from "../src/lib/judgment-editor.ts";

const ollama: JudgmentSettings = {
  provider: "ollama",
  url: "http://ollama.lan:11434",
  model: "nimble",
};
const idle = { ready: true, pending: false, configured: true };

function run(...actions: JudgmentEditorAction[]): JudgmentEditor {
  return actions.reduce(reduceJudgmentEditor, initJudgmentEditor());
}

const failedCheck: JudgmentEditorAction[] = [
  { type: "loaded", settings: ollama },
  { type: "checking" },
  { type: "checked", result: { connected: false, message: "Model missing." } },
];

test("the editor starts on the TypeSafe defaults", () => {
  assert.deepEqual(initJudgmentEditor(), {
    saved: {
      provider: "typesafe",
      url: "http://localhost:11434",
      model: "nimble",
    },
    draft: {
      provider: "typesafe",
      url: "http://localhost:11434",
      model: "nimble",
    },
    check: null,
    notice: null,
  });
});

test("a draft edit keeps the saved settings' failure message", () => {
  const e = run(...failedCheck, {
    type: "edit",
    patch: { model: "tev1" },
  });
  assert.deepEqual(e.check, { state: "failed", message: "Model missing." });
  assert.equal(e.draft.model, "tev1");
  assert.equal(e.saved.model, "nimble");
});

test("a save drops the old probe result and reports the save", () => {
  const next = { ...ollama, model: "tev1" };
  const e = run(...failedCheck, { type: "saved", settings: next });
  assert.equal(e.check, null);
  assert.equal(e.notice, "Settings saved.");
  assert.deepEqual(e.saved, next);
  assert.deepEqual(e.draft, next);
});

test("a failed probe after a save leaves the save notice intact", () => {
  const e = run(
    { type: "loaded", settings: ollama },
    { type: "saved", settings: ollama },
    { type: "checking" },
    { type: "checked", result: { connected: false, message: "Timed out." } },
  );
  assert.equal(e.notice, "Settings saved.");
  assert.deepEqual(e.check, { state: "failed", message: "Timed out." });
});

test("a new probe result replaces the previous one", () => {
  const e = run(...failedCheck, { type: "checking" });
  assert.deepEqual(e.check, { state: "checking" });
  const done = reduceJudgmentEditor(e, {
    type: "checked",
    result: { connected: true, provider: "ollama" },
  });
  assert.deepEqual(done.check, { state: "connected", provider: "ollama" });
});

test("a probe answer that arrives after a reload is dropped", () => {
  // A reload (another card saved a credential) restarts from the server's
  // settings; the probe started before it describes what came before.
  const e = run(
    { type: "loaded", settings: ollama },
    { type: "checking" },
    { type: "loaded", settings: ollama },
    { type: "checked", result: { connected: true, provider: "ollama" } },
  );
  assert.equal(e.check, null);
});

test("a failed save keeps the probe of the settings still in force", () => {
  const e = run(...failedCheck, {
    type: "saveFailed",
    message: "Ollama URL is invalid.",
  });
  assert.equal(e.notice, "Ollama URL is invalid.");
  assert.deepEqual(e.check, { state: "failed", message: "Model missing." });
  // The save error describes the draft being fixed, so editing keeps it.
  const edited = reduceJudgmentEditor(e, {
    type: "edit",
    patch: { url: "http://ollama:11434" },
  });
  assert.equal(edited.notice, "Ollama URL is invalid.");
});

test("an edit after a save drops the saved notice, not the probe", () => {
  const e = run(
    { type: "loaded", settings: ollama },
    { type: "saved", settings: ollama },
    { type: "checking" },
    { type: "checked", result: { connected: false, message: "Timed out." } },
    { type: "edit", patch: { model: "tev1" } },
  );
  assert.equal(e.notice, null);
  assert.deepEqual(e.check, { state: "failed", message: "Timed out." });
});

test("saving provider none says matching is off; an edit clears that too", () => {
  const off = { ...ollama, provider: "none" as const };
  const e = run(
    { type: "loaded", settings: ollama },
    { type: "saved", settings: off },
  );
  assert.equal(e.notice, "Settings saved. AI-assisted matching is off.");
  const edited = reduceJudgmentEditor(e, {
    type: "edit",
    patch: { provider: "typesafe" },
  });
  assert.equal(edited.notice, null);
});

test("cancel restores the saved settings and keeps the probe", () => {
  const e = run(
    ...failedCheck,
    { type: "edit", patch: { provider: "typesafe" } },
    { type: "cancel" },
  );
  assert.deepEqual(e.draft, ollama);
  assert.equal(e.check?.state, "failed");
});

test("actions: cancel only for a real change, no save or reset during a probe", () => {
  const loaded = run({ type: "loaded", settings: ollama });
  assert.deepEqual(providerSettingsActions(loaded, idle), {
    save: true,
    reset: true,
    cancel: false,
    check: true,
  });
  // TypeSafe saves only the provider: stale Ollama fields are no change.
  const typesafe = run(
    { type: "loaded", settings: { ...ollama, provider: "typesafe" } },
    { type: "edit", patch: { url: "http://elsewhere:11434" } },
  );
  assert.equal(providerSettingsActions(typesafe, idle).cancel, false);

  const edited = reduceJudgmentEditor(loaded, {
    type: "edit",
    patch: { model: " " },
  });
  const actions = providerSettingsActions(edited, idle);
  assert.equal(actions.cancel, true);
  assert.equal(actions.save, false, "an Ollama draft needs a model");

  const probing = reduceJudgmentEditor(loaded, { type: "checking" });
  assert.deepEqual(providerSettingsActions(probing, idle), {
    save: false,
    reset: false,
    cancel: false,
    check: false,
  });
  assert.equal(
    providerSettingsActions(loaded, { ...idle, configured: false }).check,
    false,
  );
});

test("a provider change or an ollama url change dirties the draft", () => {
  const providerChanged = run(
    { type: "loaded", settings: ollama },
    { type: "edit", patch: { provider: "typesafe" } },
  );
  assert.equal(isDirty(providerChanged), true);
  const urlOnly = run(
    { type: "loaded", settings: ollama },
    { type: "edit", patch: { url: "http://elsewhere:11434" } },
  );
  assert.equal(isDirty(urlOnly), true);
  // TypeSafe saves only the provider, so url and model are not a change.
  const typesafeUrl = run(
    { type: "loaded", settings: { ...ollama, provider: "typesafe" } },
    { type: "edit", patch: { url: "http://elsewhere:11434" } },
  );
  assert.equal(isDirty(typesafeUrl), false);
});

test("actions wait for ready and for the server round trip", () => {
  const loaded = run({ type: "loaded", settings: ollama });
  assert.deepEqual(providerSettingsActions(loaded, { ...idle, ready: false }), {
    save: false,
    reset: false,
    cancel: false,
    check: false,
  });
  assert.deepEqual(
    providerSettingsActions(loaded, { ...idle, pending: true }),
    {
      save: false,
      reset: false,
      cancel: false,
      check: false,
    },
  );
});

test("a typesafe draft is complete without url or model", () => {
  const e = run({
    type: "loaded",
    settings: { provider: "typesafe", url: "", model: "" },
  });
  assert.equal(providerSettingsActions(e, idle).save, true);
});

test("an ollama draft needs a non-blank url", () => {
  const e = run(
    { type: "loaded", settings: ollama },
    { type: "edit", patch: { url: "   " } },
  );
  assert.equal(providerSettingsActions(e, idle).save, false);
});

test("saving a cleared default backend agrees with the configuration sync", () => {
  const config = {
    ...ollama,
    provider: "typesafe" as const,
    configured: false,
    stored: false,
  };
  const saved = judgmentEditorSettings(config);
  const e = run({ type: "saved", settings: saved });
  assert.equal(e.saved.provider, "none");
  assert.deepEqual(e.saved, judgmentEditorSettings(config));
  assert.equal(e.notice, "Settings saved. AI-assisted matching is off.");
  assert.equal(e.check, null);
  assert.equal(
    providerSettingsActions(e, { ...idle, configured: false }).check,
    false,
  );
});

test("normalizing a saved backend keeps configured, stored, and invalid choices", () => {
  for (const status of [
    { configured: true, stored: false },
    { configured: false, stored: true },
    {
      configured: false,
      stored: false,
      error: "Invalid provider configuration.",
    },
  ]) {
    const config = { ...ollama, ...status };
    assert.deepEqual(judgmentEditorSettings(config), ollama);
  }
});

test("a normalized save and configuration sync preserve the subsequent probe result", () => {
  const config = { ...ollama, configured: true, stored: true };
  let e = run(
    { type: "saved", settings: judgmentEditorSettings(config) },
    { type: "checking" },
  );
  // The component only reloads when these effective settings differ.
  assert.deepEqual(e.saved, judgmentEditorSettings(config));
  e = reduceJudgmentEditor(e, {
    type: "checked",
    result: { connected: false, message: "Connection refused." },
  });
  assert.deepEqual(e.check, {
    state: "failed",
    message: "Connection refused.",
  });
  assert.equal(e.notice, "Settings saved.");
});

// The check button's disabled reason: metadata-settings.tsx renders it as the help
// line under the saved settings and as the button's title.
const setupHint =
  "Enter your TypeSafe API key, then save to check the connection.";
const erroredConfig: JudgmentConfig = {
  ...ollama,
  provider: "typesafe",
  configured: false,
  stored: false,
  error:
    'VELVARR_JUDGMENT_PROVIDER has an invalid value "bogus"; judgment features stay disabled until it is "typesafe", "ollama", or "none".',
};

test("a configuration error outranks the setup hint for the check reason", () => {
  // v0.41.0 regression: the server reports an errored configuration as not
  // configured, so the setup hint fired and told the operator to enter a
  // key the "TypeSafe key: From environment" line says is already present.
  assert.equal(
    judgmentCheckDisabledReason(erroredConfig, false, setupHint),
    "Fix the configuration error below, then check again.",
  );
});

test("a dirty draft keeps the setup hint even with a configuration error", () => {
  // The error panel hides while the draft is dirty, and a save always
  // sends the provider: stored values override the environment, so the
  // error reason would point at an error that is no longer below.
  assert.equal(
    judgmentCheckDisabledReason(erroredConfig, true, setupHint),
    setupHint,
  );
});

test("the check reason falls back to the setup hint and clears when ready", () => {
  const unconfigured: JudgmentConfig = {
    ...ollama,
    provider: "typesafe",
    configured: false,
    stored: false,
  };
  assert.equal(
    judgmentCheckDisabledReason(unconfigured, false, setupHint),
    setupHint,
  );
  const ready: JudgmentConfig = { ...unconfigured, configured: true };
  assert.equal(judgmentCheckDisabledReason(ready, false, setupHint), undefined);
  assert.equal(judgmentCheckDisabledReason(ready, true, setupHint), setupHint);
  assert.equal(
    judgmentCheckDisabledReason(undefined, false, setupHint),
    "Loading saved configuration.",
  );
});

test("opening an AI editor clears an old save notice without discarding the saved diagnosis", () => {
  const previous = run(
    { type: "saved", settings: ollama },
    { type: "checking" },
    { type: "checked", result: { connected: true, provider: "ollama" } },
  );
  const opened = reduceJudgmentEditor(previous, { type: "begin" });
  assert.equal(opened.notice, null);
  assert.deepEqual(opened.draft, previous.saved);
  assert.equal(opened.check, previous.check);
});

test("a new AI save attempt drops stale success feedback while preserving saved settings and diagnosis", () => {
  const previous = run(
    { type: "saved", settings: ollama },
    { type: "checking" },
    {
      type: "checked",
      result: { connected: false, message: "Previous probe failed" },
    },
  );
  const saving = reduceJudgmentEditor(previous, { type: "saveStarted" });
  assert.equal(saving.notice, null);
  assert.equal(saving.saved, previous.saved);
  assert.equal(saving.check, previous.check);
});
