import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { rmTempDir, testTempDir } from "./setup.ts";

const BACKUP_SCRIPT = fileURLToPath(
  new URL("../scripts/backup.mjs", import.meta.url),
);
const NOT_POSIX = process.platform === "win32";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmTempDir(dir);
});

function tempDir(): string {
  const dir = testTempDir("velvarr-backup-");
  tempDirs.push(dir);
  return dir;
}

function runBackup(
  dataDir: string,
  destination: string,
  preload?: string,
  fixtureRoot = tempDir(),
) {
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  const script = join(fixtureRoot, "scripts", "backup.mjs");
  copyFileSync(BACKUP_SCRIPT, script);
  return spawnSync(
    process.execPath,
    [...(preload ? ["--require", preload] : []), script, destination],
    {
      env: {
        ...process.env,
        VELVARR_DATA_DIR: dataDir,
        VELVARR_SECRET_KEY: "11".repeat(32),
      },
      encoding: "utf8",
    },
  );
}

/** Runs fn with umask 022, which the spawned backup script inherits. */
function withUmask022(fn: () => void): void {
  const previous = process.umask(0o022);
  try {
    fn();
  } finally {
    process.umask(previous);
  }
}

test(
  "backup is owner-only under umask 022 and never overwrites",
  { skip: NOT_POSIX },
  () => {
    const dataDir = tempDir();
    const source = new DatabaseSync(join(dataDir, "velvarr.sqlite"));
    source.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
    source.close();
    const destination = join(tempDir(), "backup.sqlite");

    withUmask022(() => {
      const first = runBackup(dataDir, destination);
      assert.equal(first.status, 0, `backup script failed: ${first.stderr}`);
      assert.equal(statSync(destination).mode & 0o777, 0o600);
      const copy = new DatabaseSync(destination, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT v FROM t")
            .all()
            .map((row) => row.v),
          ["row"],
        );
      } finally {
        copy.close();
      }
      const bytes = readFileSync(destination);

      const second = runBackup(dataDir, destination);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /Refusing to overwrite/);
      assert.equal(statSync(destination).mode & 0o777, 0o600);
      assert.deepEqual(readFileSync(destination), bytes);
    });
  },
);

test("a failed VACUUM INTO leaves no placeholder backup", () => {
  const dataDir = tempDir();
  writeFileSync(
    join(dataDir, "velvarr.sqlite"),
    "not a sqlite database ".repeat(64),
  );
  const destination = join(tempDir(), "backup.sqlite");

  const res = runBackup(dataDir, destination);
  assert.notEqual(res.status, 0, "backup of a corrupt source must fail");
  assert.equal(existsSync(destination), false);
});

for (const contents of ["", "existing backup"]) {
  test(`backup refuses an existing ${contents ? "nonempty" : "empty"} target`, () => {
    const destination = join(tempDir(), "backup.sqlite");
    writeFileSync(destination, contents, { mode: 0o640 });
    const mode = statSync(destination).mode;
    const result = runBackup(tempDir(), destination);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.equal(readFileSync(destination, "utf8"), contents);
    assert.equal(statSync(destination).mode, mode);
  });
}

test("backup refuses a symlink target", { skip: NOT_POSIX }, () => {
  const root = tempDir();
  const referent = join(root, "original.sqlite");
  writeFileSync(referent, "existing backup", { mode: 0o640 });
  const mode = statSync(referent).mode;
  const destination = join(root, "backup.sqlite");
  symlinkSync(referent, destination);
  const result = runBackup(tempDir(), destination);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(readFileSync(referent, "utf8"), "existing backup");
  assert.equal(statSync(referent).mode, mode);
});

test("backup fails for a missing source without creating either file", () => {
  const dataDir = tempDir();
  const destination = join(tempDir(), "backup.sqlite");
  const result = runBackup(dataDir, destination);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Velvarr database at/);
  assert.equal(existsSync(join(dataDir, "velvarr.sqlite")), false);
  assert.equal(existsSync(destination), false);
});

test("backup accepts an optional env file that disappears before its read", () => {
  const root = tempDir();
  writeFileSync(join(root, ".env.local"), "# no credentials\n");
  const preload = join(root, "env-race.cjs");
  writeFileSync(
    preload,
    `
    const fs = require("node:fs");
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (String(file).endsWith(".env.local")) {
        throw Object.assign(new Error("fixture env disappeared"), { code: "ENOENT" });
      }
      return read.call(this, file, ...args);
    };
    require("node:module").syncBuiltinESMExports();
  `,
  );
  const dataDir = tempDir();
  const source = new DatabaseSync(join(dataDir, "velvarr.sqlite"));
  source.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
  source.close();
  const destination = join(tempDir(), "backup.sqlite");
  const result = runBackup(dataDir, destination, preload, root);
  assert.equal(result.status, 0, result.stderr);
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(copy.prepare("SELECT v FROM t").get()?.v, "row");
  } finally {
    copy.close();
  }
});

test("backup reports optional env read errors other than ENOENT", () => {
  const root = tempDir();
  mkdirSync(join(root, ".env.local"));
  const destination = join(tempDir(), "backup.sqlite");
  const result = runBackup(tempDir(), destination, undefined, root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EISDIR|EPERM|EACCES/);
  assert.equal(existsSync(destination), false);
});
