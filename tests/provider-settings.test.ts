import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initJudgmentEditor,
  providerSettingsActions,
  reduceJudgmentEditor,
} from "../src/lib/provider-settings.ts";

test("a failed or pending configuration read leaves saved-provider checks available", () => {
  assert.deepEqual(
    providerSettingsActions({ configLoaded: false, busy: false }),
    { canCheck: true, canEdit: false, canUseEnvironment: false },
  );
  assert.equal(
    providerSettingsActions({ configLoaded: true, busy: false }).canEdit,
    true,
  );
});

test("saving, checking, or forbidden admission keeps provider actions disabled", () => {
  // Each card includes all three conditions in its shared busy flag.
  for (const configLoaded of [false, true]) {
    const actions = providerSettingsActions({ configLoaded, busy: true });
    assert.equal(actions.canCheck, false);
    assert.equal(actions.canEdit, false);
  }
});

test("a replacement credential draft cannot check the old saved credential", () => {
  const actions = providerSettingsActions({
    configLoaded: true,
    busy: false,
    unsaved: true,
  });
  assert.equal(actions.canCheck, false);
  assert.equal(actions.canEdit, true);
});

test("every stored judgment choice, including no AI, can return to the environment", () => {
  for (const provider of ["none", "typesafe", "ollama"] as const) {
    const config = { provider, stored: true };
    assert.equal(
      providerSettingsActions({
        configLoaded: true,
        busy: false,
        storedJudgment: config.stored,
      }).canUseEnvironment,
      true,
      config.provider,
    );
  }
});

test("environment-only judgment settings do not offer a redundant reset", () => {
  assert.equal(
    providerSettingsActions({
      configLoaded: true,
      busy: false,
      storedJudgment: false,
    }).canUseEnvironment,
    false,
  );
});

test("a busy stored judgment editor keeps its reset action visible but cannot edit", () => {
  const actions = providerSettingsActions({
    configLoaded: true,
    busy: true,
    storedJudgment: true,
  });
  assert.equal(actions.canUseEnvironment, true);
  assert.equal(actions.canEdit, false);
});

test("opening and canceling an AI edit preserves a failed connection and its explanation", () => {
  const failed = reduceJudgmentEditor(initJudgmentEditor(), {
    type: "checked",
    connected: false,
    message: "TypeSafe rejected the saved credential.",
  });
  const editing = reduceJudgmentEditor(failed, { type: "edit" });
  assert.equal(editing.editing, true);
  assert.equal(editing.connected, false);
  assert.equal(editing.message, failed.message);
  assert.deepEqual(reduceJudgmentEditor(editing, { type: "cancel" }), failed);
});

test("repeated edits preserve successful feedback until a save or check replaces it", () => {
  const connected = reduceJudgmentEditor(initJudgmentEditor(), {
    type: "checked",
    connected: true,
    message: "Ollama answered a decision successfully.",
  });
  let state = connected;
  for (let i = 0; i < 2; i++) {
    state = reduceJudgmentEditor(state, { type: "edit" });
    // Provider, URL, and key drafts are separate from this saved feedback.
    state = reduceJudgmentEditor(state, { type: "cancel" });
    assert.deepEqual(state, connected);
  }
});

test("successful persistence closes the editor and invalidates the old connection result", () => {
  let state = reduceJudgmentEditor(initJudgmentEditor(), {
    type: "checked",
    connected: false,
    message: "The old saved connection failed.",
  });
  state = reduceJudgmentEditor(state, { type: "edit" });
  state = reduceJudgmentEditor(state, {
    type: "saved",
    message: "Standard matching saved. AI-assisted matching is disabled.",
  });
  assert.deepEqual(state, {
    editing: false,
    connected: null,
    message: "Standard matching saved. AI-assisted matching is disabled.",
  });
});

test("a new AI check replaces both the old badge and explanation", () => {
  let state = reduceJudgmentEditor(initJudgmentEditor(), {
    type: "checked",
    connected: true,
    message: "Previous connection worked.",
  });
  state = reduceJudgmentEditor(state, { type: "checking" });
  assert.deepEqual(state, {
    editing: false,
    connected: null,
    message: null,
  });
  state = reduceJudgmentEditor(state, {
    type: "checked",
    connected: false,
    message: "The server is now unavailable.",
  });
  assert.equal(state.connected, false);
  assert.equal(state.message, "The server is now unavailable.");
});
