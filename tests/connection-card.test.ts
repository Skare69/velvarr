// Drives the same reducer, save flow, and check flow used by ConnectionCard.
// This is the Connections counterpart to provider-card.test.ts; field-level
// draft/patch validation remains in connection-settings.test.ts, and real
// markup, focus, controls, and layout are exercised by the browser suites.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyConnectionSave,
  checkConnection,
  testConnectionDraft,
  connectionCardBusy,
  initConnectionCard,
  reduceConnectionCard,
  type ConnectionCardAction,
  type ConnectionStatus,
} from "../src/lib/connection-card.ts";
import type {
  ConnectionPatch,
  ConnectionService,
  ConnectionsInfo,
} from "../src/lib/connection-settings.ts";

const settings = (): ConnectionsInfo => ({
  jellyfin: {
    url: "https://jellyfin.example.test",
    externalUrl: "https://watch.example.test",
    serverId: "saved-server",
    libraryIds: ["saved-library"],
    apiKeyConfigured: true,
  },
  whisparr: {
    url: "https://whisparr.example.test",
    apiKeyConfigured: true,
    delivery: {
      enabled: true,
      rootFolderPath: "/data/media",
      qualityProfileId: 7,
      searchOnAdd: false,
    },
    pathMappings: [{ whisparrPrefix: "/data/media", jellyfinPrefix: "/media" }],
  },
});
const verified: ConnectionStatus = {
  configured: true,
  serverName: "Saved server",
};
const failureOf = (error: unknown) => ({
  forbidden:
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 403,
  message: error instanceof Error ? error.message : String(error),
});

function card(
  service: ConnectionService,
  hooks: {
    save?: (body: ConnectionPatch) => Promise<ConnectionsInfo>;
    check?: () => Promise<ConnectionStatus>;
  } = {},
) {
  let info: ConnectionsInfo | undefined = settings();
  let state = initConnectionCard(service);
  const saves: ConnectionPatch[] = [];
  let checks = 0;
  let denials = 0;
  const dispatch = (action: ConnectionCardAction) => {
    state = reduceConnectionCard(state, action);
  };
  const onForbidden = () => {
    denials++;
  };
  const verify = () =>
    checkConnection({
      dispatch,
      failureOf,
      onForbidden,
      performCheck: async () => {
        checks++;
        return hooks.check ? hooks.check() : verified;
      },
    });
  return {
    get state() {
      return state;
    },
    get info() {
      return info;
    },
    get checks() {
      return checks;
    },
    get denials() {
      return denials;
    },
    saves,
    dispatch,
    verify,
    setInfo(value: ConnectionsInfo | undefined) {
      info = value;
    },
    begin() {
      dispatch({ type: "edit", service, info: info! });
    },
    cancel() {
      dispatch({ type: "cancel", service, info });
    },
    draft(changes: Partial<typeof state.draft>) {
      dispatch({ type: "draft", changes });
    },
    apply(
      flags: {
        saving?: boolean;
        configurationUnavailable?: boolean;
        remove?: boolean;
      } = {},
    ) {
      return applyConnectionSave({
        service,
        info,
        state,
        saving: false,
        configurationUnavailable: false,
        remove: false,
        ...flags,
        dispatch,
        failureOf,
        onForbidden,
        verify,
        performSave: async (body) => {
          saves.push(body);
          const data = hooks.save ? await hooks.save(body) : info!;
          info = data;
          return data;
        },
      });
    },
  };
}

for (const service of ["jellyfin", "whisparr"] as const) {
  const name = service === "jellyfin" ? "Jellyfin" : "Whisparr";

  test(`${name}: Edit and Cancel preserve the saved diagnosis and discard drafts and save errors`, () => {
    const h = card(service);
    h.dispatch({ type: "checked", status: verified });
    h.dispatch({ type: "saveFailed", message: "previous failure" });
    h.begin();
    assert.equal(h.state.editing, true);
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.saved, null);
    h.draft({ apiKey: "unsaved-key", url: "https://unsaved.example.test" });
    h.dispatch({ type: "saveFailed", message: "save failed" });
    h.cancel();
    assert.equal(h.state.editing, false);
    assert.equal(h.state.draft.apiKey, "");
    assert.equal(h.state.draft.url, h.info![service]!.url);
    assert.equal(h.state.status, verified);
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.saved, null);
    assert.deepEqual(h.saves, []);
  });

  test(`${name}: unchanged Save stays open, gives feedback, and neither saves nor probes`, async () => {
    const h = card(service);
    h.begin();
    const result = await h.apply();
    assert.equal(result.saved, false);
    assert.equal(h.state.editing, true);
    assert.equal(h.state.saved, "No changes to save.");
    assert.equal(h.state.pending, false);
    assert.deepEqual(h.saves, []);
    assert.equal(h.checks, 0);
  });

  test(`${name}: invalid Save retains the editor and draft without sending a request`, async () => {
    const h = card(service);
    h.begin();
    h.draft({ url: "", apiKey: "keep-this-draft" });
    const result = await h.apply();
    assert.equal(result.saved, false);
    assert.equal(h.state.editing, true);
    assert.equal(h.state.draft.apiKey, "keep-this-draft");
    assert.ok(h.state.saveError);
    assert.equal(h.state.saved, null);
    assert.equal(h.state.pending, false);
    assert.deepEqual(h.saves, []);
    assert.equal(h.checks, 0);
    h.draft({ url: "https://fixed.example.test" });
    assert.equal(h.state.saveError, null);
  });

  test(`${name}: Save stays pending until persistence and its subsequent probe finish`, async () => {
    let persist!: (info: ConnectionsInfo) => void;
    let probe!: (status: ConnectionStatus) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const persistence = new Promise<ConnectionsInfo>((resolve) => {
      persist = resolve;
    });
    const diagnosis = new Promise<ConnectionStatus>((resolve) => {
      probe = resolve;
    });
    const h = card(service, {
      save: () => persistence,
      check: () => {
        assert.equal(h.state.editing, false);
        assert.equal(
          h.state.status,
          null,
          "the old diagnosis cannot describe the new settings",
        );
        assert.equal(h.state.saved, name + " settings saved.");
        started();
        return diagnosis;
      },
    });
    h.dispatch({ type: "checked", status: verified });
    h.begin();
    h.draft({ apiKey: " replacement " });
    const applying = h.apply();
    assert.equal(connectionCardBusy(h.state, false), true);
    assert.equal(h.state.editing, true);
    assert.equal(h.checks, 0, "no probe before persistence finishes");
    const saved = settings();
    persist(saved);
    await probeStarted;
    assert.equal(h.state.pending, true);
    assert.equal(h.state.checking, true);
    probe({ configured: true, version: "new" });
    assert.equal((await applying).saved, true);
    assert.equal(h.info, saved);
    assert.equal(h.state.draft.apiKey, "");
    assert.equal(h.state.editing, false);
    assert.equal(connectionCardBusy(h.state, false), false);
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.status?.version, "new");
    assert.equal(h.checks, 1);
    assert.equal(h.saves.length, 1);
    assert.equal(
      h.saves[0]![service === "jellyfin" ? "jellyfinApiKey" : "whisparrApiKey"],
      "replacement",
    );
    assert.equal(
      service === "jellyfin"
        ? "whisparrUrl" in h.saves[0]!
        : "jellyfinUrl" in h.saves[0]!,
      false,
    );
  });

  test(`${name}: a failed Save retains the draft and previous diagnosis and can be retried`, async () => {
    let fail = true;
    const h = card(service, {
      save: async () => {
        if (fail) throw new Error("persistence failed");
        return settings();
      },
    });
    h.dispatch({ type: "checked", status: verified });
    h.begin();
    h.draft({ apiKey: "retry-key" });
    assert.equal((await h.apply()).saved, false);
    assert.equal(h.state.editing, true);
    assert.equal(h.state.draft.apiKey, "retry-key");
    assert.equal(h.state.status, verified);
    assert.equal(h.state.saveError, "persistence failed");
    assert.equal(h.state.saved, null);
    assert.equal(connectionCardBusy(h.state, false), false);
    assert.equal(h.checks, 0);
    fail = false;
    assert.equal((await h.apply()).saved, true);
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.saved, name + " settings saved.");
    assert.equal(h.state.editing, false);
    assert.equal(h.saves.length, 2);
    assert.equal(h.checks, 1);
  });

  test(`${name}: a rejected post-save probe does not turn persistence into a failed Save`, async () => {
    const h = card(service, {
      check: async () => {
        throw new Error("probe unavailable");
      },
    });
    h.dispatch({ type: "checked", status: verified });
    h.begin();
    h.draft({ apiKey: "new-key" });
    assert.equal((await h.apply()).saved, true);
    assert.equal(h.state.editing, false);
    assert.equal(h.state.saved, name + " settings saved.");
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.checkError, "probe unavailable");
    assert.equal(h.state.status, null);
    assert.equal(connectionCardBusy(h.state, false), false);
  });

  test(`${name}: a service-reported failure remains separate from the save notice`, async () => {
    const status: ConnectionStatus = {
      configured: true,
      error: { code: "upstream", message: "service rejected the key" },
    };
    const h = card(service, { check: async () => status });
    h.begin();
    h.draft({ apiKey: "new-key" });
    assert.equal((await h.apply()).saved, true);
    assert.equal(h.state.saved, name + " settings saved.");
    assert.equal(h.state.status, status);
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.checkError, null);
    assert.equal(h.state.pending, false);
  });

  test(`${name}: forbidden Save invokes the permission boundary without a generic save error`, async () => {
    const h = card(service, {
      save: async () => {
        throw { status: 403 };
      },
    });
    h.begin();
    h.draft({ apiKey: "unsaved-key" });
    assert.equal((await h.apply()).saved, false);
    assert.equal(h.denials, 1);
    assert.equal(h.state.editing, true);
    assert.equal(h.state.draft.apiKey, "unsaved-key");
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.saved, null);
    assert.equal(h.state.pending, false);
    assert.equal(h.checks, 0);
  });

  test(`${name}: forbidden post-save probe retains the save outcome and releases pending state`, async () => {
    const h = card(service, {
      check: async () => {
        throw { status: 403 };
      },
    });
    h.begin();
    h.draft({ apiKey: "new-key" });
    assert.equal((await h.apply()).saved, true);
    assert.equal(h.denials, 1);
    assert.equal(h.state.saved, name + " settings saved.");
    assert.equal(h.state.saveError, null);
    assert.equal(h.state.checkError, null);
    assert.equal(connectionCardBusy(h.state, false), false);
  });

  test(`${name}: loading configuration and busy states block Save before any state change`, async () => {
    for (const blocked of [
      "missing config",
      "configuration error",
      "shared save",
      "card save",
      "card check",
    ]) {
      const h = card(service);
      h.begin();
      h.draft({ apiKey: "blocked-key" });
      if (blocked === "missing config") h.setInfo(undefined);
      if (blocked === "card save") h.dispatch({ type: "saving" });
      if (blocked === "card check") h.dispatch({ type: "checking" });
      const before = h.state;
      assert.equal(
        (
          await h.apply({
            saving: blocked === "shared save",
            configurationUnavailable: blocked === "configuration error",
          })
        ).saved,
        false,
        blocked,
      );
      assert.equal(h.state, before, blocked);
      assert.deepEqual(h.saves, [], blocked);
      assert.equal(h.checks, 0, blocked);
    }
  });
}

test("connection cards initialize independently and editor mapping changes cannot mutate saved configuration", () => {
  const jellyfin = card("jellyfin"),
    whisparr = card("whisparr");
  assert.equal(jellyfin.state.editing, false);
  assert.equal(jellyfin.state.checking, false);
  assert.equal(jellyfin.state.status, null);
  assert.equal(connectionCardBusy(jellyfin.state, false), false);
  assert.equal(connectionCardBusy(jellyfin.state, true), true);
  whisparr.begin();
  whisparr.state.draft.pathMappings[0]!.jellyfinPrefix = "/unsaved";
  assert.equal(
    whisparr.info!.whisparr!.pathMappings[0]!.jellyfinPrefix,
    "/media",
  );
  assert.deepEqual(jellyfin.state.draft.pathMappings, []);
  whisparr.cancel();
  whisparr.begin();
  assert.equal(whisparr.state.draft.pathMappings[0]!.jellyfinPrefix, "/media");
});

test("a check retries after failure, clears the old transport error, and preserves save feedback", async () => {
  let answer!: (status: ConnectionStatus) => void;
  const pending = new Promise<ConnectionStatus>((resolve) => {
    answer = resolve;
  });
  const h = card("jellyfin", { check: () => pending });
  h.dispatch({
    type: "saved",
    draft: h.state.draft,
    notice: "Jellyfin settings saved.",
  });
  h.dispatch({ type: "checkFailed", message: "old failure" });
  const verifying = h.verify();
  assert.equal(h.state.checking, true);
  assert.equal(h.state.checkError, null);
  assert.equal(h.state.saved, "Jellyfin settings saved.");
  answer(verified);
  await verifying;
  assert.equal(h.state.status, verified);
  assert.equal(h.state.saved, "Jellyfin settings saved.");
  assert.equal(h.state.checking, false);
});

test("confirmed Whisparr removal ignores an invalid draft, sends only removal, and checks the result", async () => {
  const removed = { ...settings(), whisparr: null };
  const h = card("whisparr", {
    save: async () => removed,
    check: async () => ({ configured: false }),
  });
  h.begin();
  h.draft({ url: "", qualityProfileId: "invalid", apiKey: "discard-me" });
  assert.equal((await h.apply({ remove: true })).saved, true);
  assert.deepEqual(h.saves, [{ whisparrUrl: "" }]);
  assert.equal(h.state.saved, "Whisparr connection removed.");
  assert.equal(h.state.draft.url, "");
  assert.equal(h.state.draft.apiKey, "");
  assert.equal(h.state.editing, false);
  assert.equal(h.state.status?.configured, false);
  assert.equal(h.state.pending, false);
  assert.equal(h.checks, 1);
});

test("failed Whisparr removal preserves the saved connection and editable draft", async () => {
  const h = card("whisparr", {
    save: async () => {
      throw new Error("remove failed");
    },
  });
  h.dispatch({ type: "checked", status: verified });
  h.begin();
  h.draft({ url: "https://unsaved.example.test" });
  assert.equal((await h.apply({ remove: true })).saved, false);
  assert.equal(h.state.editing, true);
  assert.equal(h.state.draft.url, "https://unsaved.example.test");
  assert.equal(h.info!.whisparr!.url, "https://whisparr.example.test");
  assert.equal(h.state.status, verified);
  assert.equal(h.state.saveError, "remove failed");
  assert.equal(h.state.saved, null);
  assert.equal(h.state.pending, false);
  assert.equal(h.checks, 0);
});

test("connection probes remain independent of configuration reads", async () => {
  const h = card("jellyfin");
  h.setInfo(undefined);
  await h.verify();
  assert.equal(h.state.status, verified);
  assert.equal(h.state.checking, false);
  assert.equal(h.checks, 1);
  assert.deepEqual(h.saves, []);
});

for (const service of ["jellyfin", "whisparr"] as const) {
  test(`${service}: draft tests leave saved settings and diagnoses unchanged and edits clear their verdict`, async () => {
    const h = card(service);
    h.dispatch({ type: "checked", status: verified });
    h.begin();
    h.draft({ apiKey: "unsaved-key" });
    const rejected = {
      configured: true,
      error: { code: "upstream_auth", message: "Draft rejected" },
    };
    await testConnectionDraft({
      dispatch: h.dispatch,
      performTest: async () => rejected,
      failureOf,
      onForbidden: () => assert.fail("Unexpected permission failure"),
    });
    assert.equal(h.state.status, verified);
    assert.equal(h.state.draftStatus, rejected);
    assert.equal(h.state.draft.apiKey, "unsaved-key");
    assert.equal(h.state.draftChecking, false);
    assert.deepEqual(h.saves, []);
    h.draft({ apiKey: "corrected-key" });
    assert.equal(h.state.draftStatus, null);
    assert.equal(h.state.draftCheckError, null);
  });
  test(`${service}: failed draft tests release busy state without converting a saved diagnosis or deleting a key`, async () => {
    const h = card(service);
    h.dispatch({ type: "checked", status: verified });
    h.begin();
    await testConnectionDraft({
      dispatch: h.dispatch,
      performTest: async () => {
        throw new Error("Draft test unavailable");
      },
      failureOf,
      onForbidden: () => assert.fail("Unexpected permission failure"),
    });
    assert.equal(h.state.status, verified);
    assert.equal(h.state.draftCheckError, "Draft test unavailable");
    assert.equal(connectionCardBusy(h.state, false), false);
    assert.deepEqual(h.saves, []);
  });
}

for (const service of ["jellyfin", "whisparr"] as const) {
  for (const fails of [false, true]) {
    test(`${service}: ignore a late ${fails ? "failed" : "successful"} draft test after the form changes`, async () => {
      const h = card(service);
      h.dispatch({ type: "checked", status: verified });
      h.begin();
      let finish!: () => void;
      let current = true;
      const pending = testConnectionDraft({
        dispatch: h.dispatch,
        failureOf,
        onForbidden: () => assert.fail("Unexpected denial"),
        isCurrent: () => current,
        performTest: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (fails) throw new Error("Obsolete failure");
          return verified;
        },
      });
      assert.equal(h.state.draftChecking, true);
      current = false;
      h.draft({ apiKey: "newer-draft" });
      finish();
      await pending;
      assert.equal(h.state.draftStatus, null);
      assert.equal(h.state.draftCheckError, null);
      assert.equal(h.state.draftChecking, false);
      assert.equal(h.state.status, verified);
      assert.equal(h.state.draft.apiKey, "newer-draft");
      assert.deepEqual(h.saves, []);
    });
  }
}
