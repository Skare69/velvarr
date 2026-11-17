import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rmTempDir } from "./setup.ts";

const setupUrl = new URL("./setup.ts", import.meta.url).href;

function runFixture(parent: string, source: string) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import * as setup from ${JSON.stringify(setupUrl)};
        const processDir = process.env.VELVARR_DATA_DIR;
        ${source}
      `,
    ],
    {
      env: { ...process.env, TMPDIR: parent, VELVARR_DATA_DIR: parent },
      encoding: "utf8",
    },
  );
}

test("SIGTERM exits through cleanup and preserves parent and peer files", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "velvarr-temp-lifecycle-"));
  t.after(() => rmTempDir(parent));
  writeFileSync(join(parent, "keep.txt"), "parent");
  const peer = join(parent, "peer");
  mkdirSync(peer);
  writeFileSync(join(peer, "keep.txt"), "peer");

  // This fixture uses no new helper, so the previous code fails an assertion.
  const result = runFixture(
    parent,
    `
      const suiteDir = join(processDir, "pinned-suite");
      mkdirSync(suiteDir);
      writeFileSync(join(suiteDir, "velvarr.sqlite"), "fixture data");
      writeFileSync(1, JSON.stringify({ processDir, suiteDir }));
      process.emit("SIGTERM");
      process.exitCode = 0;
    `,
  );

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(
    result.status,
    143,
    `SIGTERM must exit with 143: ${result.stderr}`,
  );
  const report = JSON.parse(result.stdout) as {
    processDir: string;
    suiteDir: string;
  };
  assert.equal(dirname(report.processDir), parent);
  assert.equal(existsSync(report.processDir), false);
  assert.equal(existsSync(report.suiteDir), false);
  assert.equal(readFileSync(join(parent, "keep.txt"), "utf8"), "parent");
  assert.equal(readFileSync(join(peer, "keep.txt"), "utf8"), "peer");
});

test("suite directories use isolated SQLite paths through exit and SIGTERM", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "velvarr-temp-isolation-"));
  t.after(() => rmTempDir(parent));
  const reports = [0, 143].map((exitCode) => {
    const result = runFixture(
      parent,
      `
        import { DatabaseSync } from "node:sqlite";
        const first = setup.testTempDir("pinned-");
        process.env.VELVARR_DATA_DIR = first;
        const second = setup.testTempDir("pinned-");
        const paths = [first, second].map(dir => join(dir, "velvarr.sqlite"));
        for (const path of paths) {
          const db = new DatabaseSync(path);
          db.exec("CREATE TABLE owner (pid INTEGER)");
          db.prepare("INSERT INTO owner VALUES (?)").run(process.pid);
          const row = db.prepare("SELECT pid FROM owner").get();
          if (row.pid !== process.pid) throw new Error("shared SQLite database");
          db.close();
        }
        writeFileSync(1, JSON.stringify({ processDir, paths, pid: process.pid }));
        if (${exitCode} === 143) process.emit("SIGTERM");
      `,
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, exitCode, result.stderr);
    return JSON.parse(result.stdout) as {
      processDir: string;
      paths: string[];
      pid: number;
    };
  });

  assert.equal(new Set(reports.map((report) => report.pid)).size, 2);
  assert.equal(new Set(reports.map((report) => report.processDir)).size, 2);
  const paths = reports.flatMap((report) => report.paths);
  assert.equal(paths.length, 4);
  assert.equal(new Set(paths).size, 4);
  for (const report of reports) {
    assert.equal(dirname(report.processDir), parent);
    assert.equal(existsSync(report.processDir), false);
    for (const path of report.paths) {
      assert.equal(dirname(dirname(path)), report.processDir);
      assert.equal(existsSync(path), false);
    }
  }
  assert.equal(existsSync(parent), true);
});
