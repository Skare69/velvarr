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

test("a gap of more than one version compares true", () => {
  // Several releases between build and latest must still read as an update:
  // v0.39.3 showed no chip while v0.41.0 was the latest release.
  assert.equal(isNewerVersion("0.41.0", "0.39.3"), true);
  assert.equal(isNewerVersion("0.40.0", "0.38.5"), true);
  assert.equal(isNewerVersion("1.0.0", "0.39.99"), true);
  assert.equal(isNewerVersion("0.100.0", "0.99.0"), true);
  // The mirror direction stays false.
  assert.equal(isNewerVersion("0.39.3", "0.41.0"), false);
});

test("prerelease, empty and garbage tags never claim an update", () => {
  assert.equal(isNewerVersion("0.36.0-beta.1", "0.35.0"), false);
  assert.equal(isNewerVersion("", "0.35.0"), false);
  assert.equal(isNewerVersion("next", "0.35.0"), false);
  // Number() would parse these as integers; only a strict numeric shape
  // keeps the "unparsable compares false" contract true.
  assert.equal(isNewerVersion("1.", "0.35.0"), false);
  assert.equal(isNewerVersion("0x1", "0.35.0"), false);
  assert.equal(isNewerVersion(" 1", "0.35.0"), false);
});
