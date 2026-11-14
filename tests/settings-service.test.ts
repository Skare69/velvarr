import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECTION_STATE_LABEL,
  createSettingsOperationQueue,
} from "../src/lib/settings-service.ts";

test("the connection chip copy is pinned for every state", () => {
  assert.deepEqual(CONNECTION_STATE_LABEL, {
    unsaved: "Unsaved changes",
    checking: "Checking…",
    connected: "Connected",
    failed: "Connection failed",
    not_configured: "Not configured",
    unknown: "Not checked",
  });
});

test("settings saves and probes share one queue even when requested in the same tick", async () => {
  const run = createSettingsOperationQueue();
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

test("a failed settings probe cannot block later saves or checks", async () => {
  const run = createSettingsOperationQueue();
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
