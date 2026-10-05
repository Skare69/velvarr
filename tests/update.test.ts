// The update chip's one decision: is the latest GitHub release newer than
// this build? Strictly numeric, missing segments are zero, and anything we
// cannot parse must never read as "update available".

import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewerVersion } from "../src/lib/update.ts";

test("newer patch, minor and major compare true", () => {
  assert.equal(isNewerVersion("0.35.1", "0.35.0"), true);
  assert.equal(isNewerVersion("0.36.0", "0.35.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
});

test("equal or older compares false", () => {
  assert.equal(isNewerVersion("0.35.0", "0.35.0"), false);
  assert.equal(isNewerVersion("0.34.9", "0.35.0"), false);
});

test("missing segments count as zero", () => {
  assert.equal(isNewerVersion("0.36", "0.35.9"), true);
  assert.equal(isNewerVersion("0.35", "0.35.0"), false);
});

test("prerelease, empty and garbage tags never claim an update", () => {
  assert.equal(isNewerVersion("0.36.0-beta.1", "0.35.0"), false);
  assert.equal(isNewerVersion("", "0.35.0"), false);
  assert.equal(isNewerVersion("next", "0.35.0"), false);
});
