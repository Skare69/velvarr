import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
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

function runBackup(dataDir: string, destination: string) {
  return spawnSync(process.execPath, [BACKUP_SCRIPT, destination], {
    env: {
      ...process.env,
      VELVARR_DATA_DIR: dataDir,
      VELVARR_SECRET_KEY: "11".repeat(32),
    },
    encoding: "utf8",
  });
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

      const second = runBackup(dataDir, destination);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /Refusing to overwrite/);
      assert.equal(statSync(destination).mode & 0o777, 0o600);
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
