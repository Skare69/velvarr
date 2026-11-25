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
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { rmTempDir, testTempDir } from "./setup.ts";

test(
  "setup.mjs creates .env.local with owner-only permissions",
  { skip: process.platform === "win32" && "POSIX modes only" },
  (t) => {
    const root = testTempDir("velvarr-setup-");
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

for (const contents of ["", "# existing configuration\n"]) {
  test(`setup refuses an existing ${contents ? "nonempty" : "empty"} env file`, (t) => {
    const root = testTempDir("velvarr-setup-");
    t.after(() => rmTempDir(root));
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts/setup.mjs");
    copyFileSync(path.resolve("scripts/setup.mjs"), script);
    const target = path.join(root, ".env.local");
    writeFileSync(target, contents, { mode: 0o640 });
    const mode = statSync(target).mode;
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing to overwrite/);
    assert.equal(readFileSync(target, "utf8"), contents);
    assert.equal(statSync(target).mode, mode);
  });
}

test(
  "setup refuses a symlink env file",
  { skip: process.platform === "win32" },
  (t) => {
    const root = testTempDir("velvarr-setup-");
    t.after(() => rmTempDir(root));
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts/setup.mjs");
    copyFileSync(path.resolve("scripts/setup.mjs"), script);
    const referent = path.join(root, "original.env");
    writeFileSync(referent, "# existing configuration\n", { mode: 0o640 });
    const mode = statSync(referent).mode;
    symlinkSync(referent, path.join(root, ".env.local"));
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing to overwrite/);
    assert.equal(readFileSync(referent, "utf8"), "# existing configuration\n");
    assert.equal(statSync(referent).mode, mode);
  },
);

test(
  "setup does not change the mode of a replacement after creation",
  { skip: process.platform === "win32" },
  (t) => {
    const root = testTempDir("velvarr-setup-");
    t.after(() => rmTempDir(root));
    mkdirSync(path.join(root, "scripts"));
    const script = path.join(root, "scripts/setup.mjs");
    copyFileSync(path.resolve("scripts/setup.mjs"), script);
    const preload = path.join(root, "replace-env.cjs");
    writeFileSync(
      preload,
      `
    const fs = require("node:fs");
    const write = fs.writeFileSync;
    fs.writeFileSync = function (file, ...args) {
      const result = write.call(this, file, ...args);
      if (String(file).endsWith(".env.local")) {
        fs.renameSync(file, String(file) + ".created");
        write.call(this, file, "# replacement configuration\\n", { mode: 0o640 });
        fs.chmodSync(file, 0o640);
      }
      return result;
    };
    require("node:module").syncBuiltinESMExports();
  `,
    );
    const run = spawnSync(process.execPath, ["--require", preload, script], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const target = path.join(root, ".env.local");
    assert.equal(readFileSync(target, "utf8"), "# replacement configuration\n");
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(statSync(target + ".created").mode & 0o777, 0o600);
    const created = readFileSync(target + ".created", "utf8");
    const secretKey = /^VELVARR_SECRET_KEY=(.*)$/m.exec(created)?.[1];
    const setupSecret = /^VELVARR_SETUP_SECRET=(.*)$/m.exec(created)?.[1];
    assert.ok(
      secretKey && /^[a-f0-9]{64}$/.test(secretKey),
      "secret key format stays unchanged",
    );
    assert.ok(
      setupSecret && /^[A-Za-z0-9_-]{43}$/.test(setupSecret),
      "setup secret format stays unchanged",
    );
    assert.ok(
      !run.stdout.includes(secretKey) && !run.stderr.includes(secretKey),
      "secret key stays private",
    );
    assert.ok(
      !run.stdout.includes(setupSecret) && !run.stderr.includes(setupSecret),
      "setup secret stays private",
    );
    assert.match(created, /^VELVARR_ORIGIN=http:\/\/127\.0\.0\.1:6699$/m);
  },
);
