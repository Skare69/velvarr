// The TPDB and StashDB credential editors' blank-Save case at the component
// level (VELV-100): the real Save-click flow and the real editor markup, via
// the exports metadata-settings.tsx renders ProviderCredentialCard with. node --test
// cannot import the .tsx component itself (type stripping does not parse
// JSX), so the card delegates its state (reduceCredentialCard), its Save
// click (applyCredentialSave) and its editor markup (credentialEditorView)
// to src/lib/credential-card.ts, and this file drives exactly those exports.
//
// A blank Save used to close the editor without saving and without a
// message (v0.41.0, fde0b7b): the state and markup assertions below failed
// against that behavior.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyCredentialSave,
  checkConnectionAction,
  credentialCardBusy,
  credentialEditorView,
  initCredentialCard,
  reduceCredentialCard,
  shouldAutoClearOnReject,
  type CredentialCardAction,
  type CredentialCardState,
} from "../src/lib/credential-card.ts";
import type { ProviderCheck } from "../src/lib/contracts.ts";

type SaveRun = {
  state: CredentialCardState;
  actions: CredentialCardAction[];
  /** One entry per network call: [field, trimmed value]. */
  saves: [field: string, value: string][];
  saved: boolean;
};

/** Opens the editor like a user (Edit button, then typing) and runs one
 * Save click through the component's own handler, folding the dispatched
 * actions into the state exactly like useReducer does. */
async function runSave(input: {
  configured: boolean | undefined;
  name: string;
  label: string;
  field: string;
  draft: string;
  /** The destructive clear dialog's click. */
  clear?: boolean;
  /** Overrides the saved notice (the rejected-key auto-clear path). */
  clearNotice?: string;
  fail?: { forbidden?: boolean };
}): Promise<SaveRun> {
  let state = reduceCredentialCard(initCredentialCard(), { type: "edit" });
  state = reduceCredentialCard(state, { type: "draft", value: input.draft });
  const actions: CredentialCardAction[] = [];
  const saves: [field: string, value: string][] = [];
  const { saved } = await applyCredentialSave({
    draft: state.draft,
    clear: input.clear ?? false,
    configured: input.configured,
    name: input.name,
    label: input.label,
    clearNotice: input.clearNotice,
    performSave: async (value) => {
      saves.push([input.field, value]);
      if (input.fail?.forbidden) throw { status: 403 };
      if (input.fail) throw new Error("the key was rejected");
    },
    dispatch: (action) => {
      actions.push(action);
      state = reduceCredentialCard(state, action);
    },
    failureOf: (error) => {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? error.status
          : undefined;
      return {
        forbidden: status === 403,
        message: error instanceof Error ? error.message : String(error),
      };
    },
  });
  return { state, actions, saves, saved };
}

/** Renders the same editor markup metadata-settings.tsx renders for the given
 * state. canEdit mirrors the card (a config row exists, nothing in
 * flight); the busy flags the reducer owns stay false here. */
function renderEditor(input: {
  id: string;
  name: string;
  label: string;
  maxLength: number;
  configured: boolean | undefined;
  state: CredentialCardState;
  saving?: boolean;
}): string {
  return renderToStaticMarkup(
    credentialEditorView({
      id: input.id,
      name: input.name,
      label: input.label,
      maxLength: input.maxLength,
      configured: input.configured,
      state: input.state,
      canEdit: true,
      busy: false,
      saving: input.saving ?? false,
      inputRef: null,
      onDraftChange: () => undefined,
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }),
  );
}

test("a blank Save on a not-configured TPDB editor stays open and names the field", async () => {
  const run = await runSave({
    configured: false,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "",
  });
  assert.deepEqual(run.saves, [], "a blank Save must not reach the API");
  assert.equal(run.state.editing, true, "the editor must stay open");
  assert.equal(run.state.blankMessage, "Enter a TPDB API token.");
  assert.equal(run.state.saved, null, "no save notice may appear");
  assert.equal(run.saved, false, "the click reports that nothing was saved");

  const markup = renderEditor({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 1024,
    configured: false,
    state: run.state,
  });
  assert.match(markup, /id="provider-editor-tpdb"/, "the editor is open");
  assert.match(markup, /aria-describedby="blank-hint-tpdb"/);
  // Rule 35: the failed input itself carries the invalid state.
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /role="status">Enter a TPDB API token\.<\/p>/);
  // Rule 1: a blank draft keeps Save a plain secondary button, enabled.
  assert.match(
    markup,
    /<button type="submit" class="btn">Save<\/button>/,
    "Save stays enabled so the click can explain itself",
  );
});

test("a blank Save on a not-configured StashDB editor names the field", async () => {
  const run = await runSave({
    configured: false,
    name: "StashDB",
    label: "API key",
    field: "stashdbApiKey",
    draft: "   ",
  });
  assert.deepEqual(run.saves, []);
  assert.equal(run.state.editing, true, "the editor must stay open");
  assert.equal(run.state.blankMessage, "Enter a StashDB API key.");
  const markup = renderEditor({
    id: "stashdb",
    name: "StashDB",
    label: "API key",
    maxLength: 512,
    configured: false,
    state: run.state,
  });
  assert.match(markup, /role="status">Enter a StashDB API key\.<\/p>/);
});

test("a blank Save on a configured StashDB editor is a Cancel: Save sits disabled", async () => {
  const run = await runSave({
    configured: true,
    name: "StashDB",
    label: "API key",
    field: "stashdbApiKey",
    draft: "",
  });
  assert.deepEqual(run.saves, []);
  assert.equal(run.state.editing, true, "the editor must stay open");
  assert.equal(
    run.state.blankMessage,
    null,
    "no field message for a blank edit of a saved key",
  );
  const markup = renderEditor({
    id: "stashdb",
    name: "StashDB",
    label: "API key",
    maxLength: 512,
    configured: true,
    state: run.state,
  });
  // Rule 1: a blank draft is not a decision, so Save keeps the plain style
  // even though the click is a Cancel (the disabled state already blocks it).
  assert.match(
    markup,
    /<button type="submit" class="btn" disabled="">Save<\/button>/,
  );
  assert.equal(markup.includes("blank-hint-stashdb"), false);
  assert.match(
    markup,
    /placeholder="Leave blank to keep the current credential"/,
  );
});

test("a blank Save while the configuration is still loading is a Cancel too", async () => {
  const run = await runSave({
    configured: undefined,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "",
  });
  assert.deepEqual(run.saves, []);
  assert.equal(run.state.editing, true, "the editor must stay open");
  assert.equal(run.state.blankMessage, null);
});

test("a typed draft still saves the trimmed value and closes with the notice", async () => {
  const run = await runSave({
    configured: false,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "  tok ",
  });
  assert.deepEqual(run.saves, [["tpdbApiToken", "tok"]]);
  assert.equal(run.saved, true);
  assert.equal(run.state.editing, false, "the editor closes after a save");
  assert.equal(run.state.draft, "");
  assert.equal(run.state.saved, "Credential saved.");
  assert.equal(run.state.blankMessage, null);
});

test("the confirmed clear stores an empty value even over a typed draft", async () => {
  const run = await runSave({
    configured: true,
    name: "StashDB",
    label: "API key",
    field: "stashdbApiKey",
    draft: "sk-x",
    clear: true,
  });
  assert.deepEqual(run.saves, [["stashdbApiKey", ""]]);
  assert.equal(run.state.editing, false);
  assert.equal(
    run.state.saved,
    "Stored credential cleared. Environment settings apply.",
  );
});

test("a failed save keeps the editor open and shows the error, not a notice", async () => {
  const run = await runSave({
    configured: false,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "tok",
    fail: {},
  });
  assert.deepEqual(run.saves, [["tpdbApiToken", "tok"]]);
  assert.equal(run.saved, false);
  assert.equal(run.state.editing, true, "a failed save must not close");
  assert.equal(run.state.saveError, "the key was rejected");
  assert.equal(run.state.saved, null);
});

test("a forbidden save marks the card instead of an error row", async () => {
  const run = await runSave({
    configured: false,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "tok",
    fail: { forbidden: true },
  });
  assert.equal(run.state.editing, true);
  assert.equal(run.state.forbidden, true);
  assert.equal(run.state.saveError, null);
});

test("typing after a rejected blank Save clears the field message", () => {
  let state = reduceCredentialCard(initCredentialCard(), { type: "edit" });
  state = reduceCredentialCard(state, { type: "draft", value: "" });
  state = reduceCredentialCard(state, { type: "saveStarted" });
  state = reduceCredentialCard(state, {
    type: "blankRejected",
    message: "Enter a TPDB API token.",
  });
  assert.equal(state.editing, true);
  state = reduceCredentialCard(state, { type: "draft", value: "x" });
  assert.equal(state.blankMessage, null);
  assert.equal(state.draft, "x");
  assert.equal(state.saveError, null);
});

test("cancel empties the draft and closes the editor", () => {
  let state = reduceCredentialCard(initCredentialCard(), { type: "edit" });
  state = reduceCredentialCard(state, { type: "draft", value: "tok" });
  state = reduceCredentialCard(state, { type: "cancel" });
  assert.equal(state.editing, false);
  assert.equal(state.draft, "");
  assert.equal(state.saveError, null);
  assert.equal(state.blankMessage, null);
});

test("a not-configured editor offers no Cancel; a configured one does", () => {
  const base = {
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 512,
    state: initCredentialCard(),
  };
  // The card keeps the editor open while no key exists, so Cancel could
  // not close it.
  assert.doesNotMatch(renderEditor({ ...base, configured: false }), />Cancel</);
  assert.match(renderEditor({ ...base, configured: true }), />Cancel</);
  // Still loading: the editor only opened through Edit, so Cancel stays.
  assert.match(renderEditor({ ...base, configured: undefined }), />Cancel</);
});

test("a rejected key reopens the editor; an outage does not", () => {
  const failed = (code: string) =>
    reduceCredentialCard(initCredentialCard(), {
      type: "checked",
      check: {
        provider: "tpdb",
        configured: true,
        verified: false,
        error: { code, message: "x" },
      },
    });
  assert.equal(failed("upstream_auth").editing, true);
  assert.equal(failed("upstream_timeout").editing, false);
});

test("Save carries the accent fill only while the draft has text", () => {
  const base = {
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 512,
    configured: false,
  };
  const blank = renderEditor({ ...base, state: initCredentialCard() });
  assert.match(blank, /<button type="submit" class="btn">Save<\/button>/);
  const typed = reduceCredentialCard(initCredentialCard(), {
    type: "draft",
    value: "tok",
  });
  assert.match(
    renderEditor({ ...base, state: typed }),
    /<button type="submit" class="btn btn-accent">Save<\/button>/,
  );
});

test("while saving, Save reads Saving… and sets aria-busy", () => {
  const markup = renderEditor({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 512,
    configured: true,
    state: initCredentialCard(),
    saving: true,
  });
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, />Saving…</);
  assert.equal(markup.includes(">Save</button>"), false);
});

test("a configured editor marks its key optional; a fresh one does not", () => {
  const base = {
    id: "stashdb",
    name: "StashDB",
    label: "API key",
    maxLength: 512,
    state: initCredentialCard(),
  };
  // Rule 9: the label may keep its saved value when left blank.
  assert.match(renderEditor({ ...base, configured: true }), /\(optional\)</);
  assert.doesNotMatch(
    renderEditor({ ...base, configured: false }),
    /\(optional\)/,
  );
});

test("only a rejected stored credential auto-clears", () => {
  // The auto-clear deletes only a key the check fingerprinted (VELV-130
  // send-back): a rejected check without a keyFingerprint probed the
  // environment fallback — often under a stale config that still says
  // "stored" — and an automatic delete never falls back to the
  // unconditional manual clear. The server's compare-and-set refuses any
  // guarded clear whose fingerprint no longer matches.
  const rejected = (code: string, keyFingerprint?: string): ProviderCheck => ({
    provider: "tpdb",
    configured: true,
    verified: false,
    error: { code, message: "x" },
    ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
  });
  const verified: ProviderCheck = {
    provider: "tpdb",
    configured: true,
    verified: true,
    account: "someone",
  };
  const fingerprint = "3f9a".repeat(8);
  // The trigger: the provider proved a stored key wrong, and the check
  // vouches for exactly that key.
  assert.equal(
    shouldAutoClearOnReject({
      check: rejected("upstream_auth", fingerprint),
      source: "stored",
    }),
    true,
  );
  // A rejection without a fingerprint probed the environment fallback:
  // there is no stored key this check can vouch for, so never arm.
  assert.equal(
    shouldAutoClearOnReject({
      check: rejected("upstream_auth"),
      source: "stored",
    }),
    false,
  );
  // An environment key cannot be deleted.
  assert.equal(
    shouldAutoClearOnReject({
      check: rejected("upstream_auth", fingerprint),
      source: "environment",
    }),
    false,
  );
  // A config row still loading cannot decide either.
  assert.equal(
    shouldAutoClearOnReject({
      check: rejected("upstream_auth", fingerprint),
      source: undefined,
    }),
    false,
  );
  // Nothing but upstream_auth proves the key wrong.
  assert.equal(
    shouldAutoClearOnReject({
      check: rejected("upstream_timeout", fingerprint),
      source: "stored",
    }),
    false,
  );
  assert.equal(
    shouldAutoClearOnReject({
      check: verified,
      source: "stored",
    }),
    false,
  );
});

test("the rejected-key auto-clear reports the deletion in its own notice", async () => {
  const notice =
    "TPDB rejected the stored API token, so Velvarr deleted it. Add a new API token.";
  const run = await runSave({
    configured: true,
    name: "TPDB",
    label: "API token",
    field: "tpdbApiToken",
    draft: "",
    clear: true,
    clearNotice: notice,
  });
  assert.deepEqual(run.saves, [["tpdbApiToken", ""]]);
  assert.equal(run.saved, true);
  assert.equal(run.state.saved, notice);
});

test("Check connection shows for the draft in the editor, retries a failed saved check, hides otherwise", () => {
  // Editor open: the button always tests the form's values, saved check
  // aside.
  assert.equal(
    checkConnectionAction({ editorOpen: true, savedCheckFailed: false }),
    "draft",
  );
  assert.equal(
    checkConnectionAction({ editorOpen: true, savedCheckFailed: true }),
    "draft",
  );
  // Closed: only a failed saved check keeps the button (the GET retry).
  assert.equal(
    checkConnectionAction({ editorOpen: false, savedCheckFailed: true }),
    "retry",
  );
  assert.equal(
    checkConnectionAction({ editorOpen: false, savedCheckFailed: false }),
    null,
  );
});

test("a draft test result lands apart from the saved check and never auto-clears", () => {
  const rejected: ProviderCheck = {
    provider: "tpdb",
    configured: true,
    verified: false,
    error: { code: "upstream_auth", message: "x" },
  };
  let state = reduceCredentialCard(initCredentialCard(), { type: "edit" });
  state = reduceCredentialCard(state, { type: "draftChecking" });
  assert.equal(state.draftChecking, true);
  state = reduceCredentialCard(state, {
    type: "draftChecked",
    check: rejected,
  });
  // The result describes the draft only: the saved check stays empty, so the
  // rejected-key auto-delete (which reads `check` alone) has nothing to fire
  // on and the stored credential survives.
  assert.equal(state.check, null);
  assert.equal(state.draftChecking, false);
  assert.deepEqual(state.draftCheck, rejected);
  // A rejected draft is not proof about the saved key: the editor state and
  // the request error channel stay untouched.
  assert.equal(state.editing, true);
  assert.equal(state.checkError, null);
});

test("a draft test result dies with the draft", () => {
  const verified: ProviderCheck = {
    provider: "tpdb",
    configured: true,
    verified: true,
    account: "someone",
  };
  const withResult = reduceCredentialCard(
    reduceCredentialCard(
      reduceCredentialCard(initCredentialCard(), { type: "edit" }),
      { type: "draftChecked", check: verified },
    ),
    { type: "draft", value: "tok" },
  );
  assert.equal(withResult.draftCheck, null);
  // Editing also keeps the editing state and the draft itself.
  assert.equal(withResult.editing, true);
  assert.equal(withResult.draft, "tok");
  const cancelled = reduceCredentialCard(
    reduceCredentialCard(
      reduceCredentialCard(initCredentialCard(), { type: "edit" }),
      { type: "draftChecked", check: verified },
    ),
    { type: "cancel" },
  );
  assert.equal(cancelled.draftCheck, null);
  const saved = reduceCredentialCard(
    reduceCredentialCard(
      reduceCredentialCard(initCredentialCard(), { type: "edit" }),
      { type: "draftChecked", check: verified },
    ),
    { type: "saved", notice: "Credential saved." },
  );
  assert.equal(saved.draftCheck, null);
});

test("a draft test in flight counts as busy", () => {
  let state = reduceCredentialCard(initCredentialCard(), {
    type: "draftChecking",
  });
  assert.equal(credentialCardBusy(state, false), true);
  state = reduceCredentialCard(state, {
    type: "draftChecked",
    check: {
      provider: "tpdb",
      configured: true,
      verified: true,
      account: "someone",
    },
  });
  assert.equal(credentialCardBusy(state, false), false);
});

test("init state has every flag settled", () => {
  assert.deepEqual(initCredentialCard(), {
    editing: false,
    draft: "",
    check: null,
    checking: false,
    checkError: null,
    draftCheck: null,
    draftChecking: false,
    draftCheckError: null,
    saveError: null,
    saved: null,
    blankMessage: null,
    forbidden: false,
  });
});

test("the saved check runs through checking, checked and checkFailed", () => {
  let state = reduceCredentialCard(initCredentialCard(), { type: "checking" });
  assert.equal(state.checking, true);
  assert.equal(state.check, null);
  assert.equal(state.checkError, null);
  state = reduceCredentialCard(state, {
    type: "checked",
    check: {
      provider: "tpdb",
      configured: true,
      verified: true,
      account: "someone",
    },
  });
  assert.equal(state.checking, false, "a landed check clears its flag");
  assert.deepEqual(state.check, {
    provider: "tpdb",
    configured: true,
    verified: true,
    account: "someone",
  });
  state = reduceCredentialCard(initCredentialCard(), { type: "checking" });
  state = reduceCredentialCard(state, { type: "checkFailed", message: "down" });
  assert.equal(state.checking, false);
  assert.equal(state.check, null);
  assert.equal(state.checkError, "down");
});

test("only a configured, rejected saved check reopens the editor", () => {
  const reopen = (check: ProviderCheck) =>
    reduceCredentialCard(initCredentialCard(), { type: "checked", check })
      .editing;
  // A check that ran without a stored key proves nothing about the editor.
  assert.equal(reopen({ provider: "tpdb", configured: false }), false);
  // A verified check needs no edit either.
  assert.equal(
    reopen({
      provider: "tpdb",
      configured: true,
      verified: true,
      account: "someone",
    }),
    false,
  );
});

test("a draft check failure lands in its own error channel", () => {
  let state = reduceCredentialCard(initCredentialCard(), { type: "edit" });
  state = reduceCredentialCard(state, { type: "draftChecking" });
  state = reduceCredentialCard(state, {
    type: "draftCheckFailed",
    message: "down",
  });
  assert.equal(state.draftChecking, false);
  assert.equal(state.draftCheckError, "down");
  assert.equal(state.draftCheck, null);
});

test("a forbidden account stops both request channels", () => {
  let state = reduceCredentialCard(initCredentialCard(), { type: "checking" });
  state = reduceCredentialCard(state, { type: "draftChecking" });
  state = reduceCredentialCard(state, { type: "forbidden" });
  assert.equal(state.forbidden, true);
  assert.equal(state.checking, false);
  assert.equal(state.draftChecking, false);
});

test("typing drops any draft check state: in flight, landed or failed", () => {
  const verified: ProviderCheck = {
    provider: "tpdb",
    configured: true,
    verified: true,
    account: "someone",
  };
  const typing = (state: CredentialCardState) =>
    reduceCredentialCard(state, { type: "draft", value: "x" });
  // Typing abandons the in-flight round trip with the draft.
  assert.equal(
    typing(
      reduceCredentialCard(
        reduceCredentialCard(initCredentialCard(), { type: "edit" }),
        { type: "draftChecking" },
      ),
    ).draftChecking,
    false,
  );
  const failed = typing(
    reduceCredentialCard(
      reduceCredentialCard(initCredentialCard(), { type: "edit" }),
      { type: "draftCheckFailed", message: "boom" },
    ),
  );
  assert.equal(failed.draftCheckError, null);
  const landed = typing(
    reduceCredentialCard(
      reduceCredentialCard(initCredentialCard(), { type: "edit" }),
      { type: "draftChecked", check: verified },
    ),
  );
  assert.equal(landed.draftChecking, false);
  assert.equal(landed.draftCheck, null);
});

test("busy covers a saving click, the saved check and a forbidden account", () => {
  assert.equal(credentialCardBusy(initCredentialCard(), true), true);
  const checking = reduceCredentialCard(initCredentialCard(), {
    type: "checking",
  });
  assert.equal(credentialCardBusy(checking, false), true);
  const forbidden = reduceCredentialCard(initCredentialCard(), {
    type: "forbidden",
  });
  assert.equal(credentialCardBusy(forbidden, false), true);
});

test("the editor markup carries the ids, classes and copy the styles key on", () => {
  const markup = renderEditor({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 1024,
    configured: false,
    state: initCredentialCard(),
  });
  assert.match(markup, /class="settings-service-editor"/);
  assert.match(
    markup,
    /<label class="label" for="provider-tpdb">TPDB API token<\/label>/,
  );
  assert.match(
    markup,
    /<input id="provider-tpdb" class="input mt-2" type="password" autoComplete="off" maxLength="1024" placeholder="Enter credential" value=""/,
  );
  // Rule 35: nothing disables the failed field's input when editing is allowed.
  assert.doesNotMatch(markup, /<input[^>]*disabled/);
  assert.match(
    markup,
    /<p class="mt-2 text-sm text-muted">Saved credentials are encrypted and take precedence over the environment\. Check connection tests this draft without saving; a blank field uses the saved credential or environment fallback\.<\/p>/,
  );
  assert.match(
    markup,
    /<div class="settings-service-buttons settings-card-actions">/,
  );
});

test("a blank rejection hint carries its own id, class and role", () => {
  const state = reduceCredentialCard(
    reduceCredentialCard(initCredentialCard(), { type: "edit" }),
    { type: "blankRejected", message: "Enter a TPDB API token." },
  );
  const markup = renderEditor({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 1024,
    configured: false,
    state,
  });
  assert.match(
    markup,
    /<p id="blank-hint-tpdb" class="mt-2 text-sm text-muted" role="status">Enter a TPDB API token\.<\/p>/,
  );
});

test("a blank-spaces draft keeps Save plain even though a click would cancel", () => {
  const spaces = reduceCredentialCard(
    reduceCredentialCard(initCredentialCard(), { type: "edit" }),
    { type: "draft", value: "   " },
  );
  const markup = renderEditor({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 1024,
    configured: true,
    state: spaces,
  });
  assert.match(
    markup,
    /<button type="submit" class="btn" disabled="">Save<\/button>/,
  );
});

test("a configured editor's Cancel is a real button that busy disables", () => {
  const base = {
    id: "stashdb",
    name: "StashDB",
    label: "API key",
    maxLength: 512,
    state: initCredentialCard(),
  };
  assert.match(
    renderEditor({ ...base, configured: true }),
    /<button type="button" class="btn">Cancel<\/button>/,
  );
  const markup = renderToStaticMarkup(
    credentialEditorView({
      ...base,
      configured: true,
      canEdit: true,
      busy: true,
      saving: false,
      inputRef: null,
      onDraftChange: () => undefined,
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }),
  );
  assert.match(
    markup,
    /<button type="button" class="btn" disabled="">Cancel<\/button>/,
  );
});

test("optional card furniture renders and the input wiring calls through", () => {
  const drafted: string[] = [];
  const el = credentialEditorView({
    id: "tpdb",
    name: "TPDB",
    label: "API token",
    maxLength: 1024,
    configured: true,
    state: initCredentialCard(),
    canEdit: true,
    busy: false,
    saving: false,
    inputRef: null,
    onDraftChange: (value: string) => drafted.push(value),
    onCancel: () => undefined,
    onSubmit: () => undefined,
    // Element icons instead of text: element and text children render
    // adjacent in static markup, so the pins cannot split on a comment node.
    icons: { save: createElement("i"), cancel: createElement("i") },
    trailing: "T",
  });
  const markup = renderToStaticMarkup(el);
  assert.match(markup, /<i><\/i>Save</);
  assert.match(markup, /<i><\/i>Cancel</);
  assert.match(markup, /T<\/div>/);
  // ReactElement types props as unknown; the tree is built two statements
  // above, so children[1] is the password input by construction.
  const tree = el.props as {
    children: [
      object,
      {
        type: string;
        props: { onChange: (event: { target: { value: string } }) => void };
      },
    ];
  };
  const input = tree.children[1];
  assert.equal(input.type, "input");
  input.props.onChange({ target: { value: "abc" } });
  assert.deepEqual(drafted, ["abc"]);
});
