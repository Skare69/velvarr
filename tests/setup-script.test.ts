// setup.mjs must create .env.local owner-only from the first write: the file
// holds VELVARR_SECRET_KEY, so a default-mode write leaves a window where any
// local user can read it, and a swallowed chmod failure leaves it readable.
// POSIX file modes don't exist on win32, so the check runs only where they do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTempDir } from "./setup.ts";

test(
  "setup.mjs creates .env.local with owner-only permissions",
  { skip: process.platform === "win32" && "POSIX modes only" },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "velvarr-setup-"));
    t.after(() => rmTempDir(root));
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(
      path.resolve("scripts/setup.mjs"),
      path.join(root, "scripts/setup.mjs"),
    );
    // Preload: no-op fs.chmodSync, so the asserted mode is the one the file
    // was CREATED with, not one a later chmod imposed.
    const preload = path.join(root, "no-chmod.cjs");
    writeFileSync(
      preload,
      [
        "const fs = require('node:fs');",
        "fs.chmodSync = () => {};",
        "require('node:module').syncBuiltinESMExports();",
      ].join("\n"),
    );
    const run = spawnSync(
      process.execPath,
      ["--require", preload, path.join(root, "scripts/setup.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const mode = statSync(path.join(root, ".env.local")).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(run.stderr.includes("could not restrict"), false);
  },
);
