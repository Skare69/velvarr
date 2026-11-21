import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const configUrl = new URL("../stryker.config.mjs", import.meta.url).href;
const suiteSource = `
  import { mkdtempSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  const suiteFile = join(mkdtempSync(join(tmpdir(), "suite-")), "leftover");
  const dataFile = join(
    mkdtempSync(join(process.env.VELVARR_DATA_DIR, "database-")),
    "leftover.sqlite",
  );
  writeFileSync(suiteFile, "suite data");
  writeFileSync(dataFile, "database data");
  writeFileSync(1, JSON.stringify({ suiteFile, dataFile }));
  process.exit(Number(process.argv[1]));
`;
const ownerSource = `
  import { spawnSync } from "node:child_process";
  import { mkdirSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  // Import the runtime-selected config in this owner, not the test process.
  const config = (await import(process.argv[1])).default;
  const sandbox = config.tempDirName;
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, "leftover"), "sandbox data");
  const suite = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", process.argv[2], process.argv[3]],
    { encoding: "utf8", env: process.env },
  );
  if (suite.error) throw suite.error;
  if (suite.signal) throw new Error("Suite received " + suite.signal);
  const files = JSON.parse(suite.stdout);
  process.send({ ...files, sandbox });
  for await (const chunk of process.stdin) {}
  process.exit(suite.status ?? 1);
`;

type RunFiles = {
  suiteFile: string;
  dataFile: string;
  sandbox: string;
};

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "velvarr-mutation-run-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const inheritedData = join(base, "inherited-data");
  mkdirSync(inheritedData);
  const inheritedFile = join(inheritedData, "keep");
  writeFileSync(inheritedFile, "inherited data");
  return { base, inheritedData, inheritedFile };
}

function startOwner(base: string, inheritedData: string, status: number) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      ownerSource,
      configUrl,
      suiteSource,
      String(status),
    ],
    {
      env: { ...process.env, TMPDIR: base, VELVARR_DATA_DIR: inheritedData },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout!.resume();
  const done = once(child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stderr,
  }));
  const ready = Promise.race([
    once(child, "message").then(([files]) => files as RunFiles),
    done.then((result) => {
      throw new Error(`Owner exited before its report: ${result.stderr}`);
    }),
  ]);
  return { ready, done, finish: () => child.stdin!.end() };
}

function assertRemoved(files: RunFiles) {
  assert.equal(
    existsSync(files.suiteFile),
    false,
    "suite data must not remain",
  );
  assert.equal(
    existsSync(files.dataFile),
    false,
    "database data must not remain",
  );
  assert.equal(existsSync(files.sandbox), false, "sandbox must not remain");
  assert.equal(
    existsSync(dirname(files.sandbox)),
    false,
    "the owned run parent must not remain",
  );
}

for (const status of [0, 17]) {
  test(`run exit ${status} removes suite data without child teardown`, async (t) => {
    const { base, inheritedData, inheritedFile } = fixture(t);
    const owner = startOwner(base, inheritedData, status);
    let files: RunFiles;
    try {
      files = await owner.ready;
      assert.equal(readFileSync(files.suiteFile, "utf8"), "suite data");
      assert.equal(readFileSync(files.dataFile, "utf8"), "database data");
    } finally {
      owner.finish();
      await owner.done;
    }
    const result = await owner.done;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, status, result.stderr);
    assertRemoved(files);
    assert.equal(readFileSync(inheritedFile, "utf8"), "inherited data");
  });
}

test("one run exit preserves a live peer's distinct parent and files", async (t) => {
  const { base, inheritedData, inheritedFile } = fixture(t);
  const first = startOwner(base, inheritedData, 0);
  const second = startOwner(base, inheritedData, 0);
  try {
    const [firstFiles, secondFiles] = await Promise.all([
      first.ready,
      second.ready,
    ]);
    assert.notEqual(dirname(firstFiles.sandbox), dirname(secondFiles.sandbox));
    first.finish();
    const result = await first.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assertRemoved(firstFiles);
    assert.equal(readFileSync(secondFiles.suiteFile, "utf8"), "suite data");
    assert.equal(readFileSync(secondFiles.dataFile, "utf8"), "database data");
    assert.equal(
      readFileSync(join(secondFiles.sandbox, "leftover"), "utf8"),
      "sandbox data",
    );
    second.finish();
    const peerResult = await second.done;
    assert.equal(peerResult.code, 0, peerResult.stderr);
    assert.equal(peerResult.signal, null, peerResult.stderr);
    assertRemoved(secondFiles);
    assert.equal(readFileSync(inheritedFile, "utf8"), "inherited data");
  } finally {
    first.finish();
    second.finish();
    await Promise.all([first.done, second.done]);
  }
});

for (const lookup of ["TMPDIR", "TEMP"]) {
  test(`delta JSON report survives owner exit with ${lookup} lookup`, (t) => {
    const { base } = fixture(t);
    const metadata = join(base, "report-path.json");
    const reportOwner = `
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      import { writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      os.tmpdir = () => process.env[process.argv[3]];
      syncBuiltinESMExports();
      // Install the platform lookup before the config selects its directories.
      const config = (await import(pathToFileURL(process.argv[1]).href)).default;
      writeFileSync(config.jsonReporter.fileName, '{"fixture":"retained"}');
      writeFileSync(process.argv[2], JSON.stringify({
        report: config.jsonReporter.fileName,
        sandbox: config.tempDirName,
      }));
    `;
    const wrapperOwner = `
      import cp from "node:child_process";
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      const spawnSync = cp.spawnSync;
      os.tmpdir = () => process.env[process.argv[3]];
      cp.spawnSync = (command, args, options) => {
        if (command === "git") {
          if (args[0] === "describe") return { status: 0, stdout: "v0.44.0\\n" };
          if (args[0] === "diff") return { status: 0, stdout: "src/lib/discord-settings.ts\\n" };
        }
        if (command === "stryker") return spawnSync(process.execPath, [
          "--input-type=module", "--eval", ${JSON.stringify(reportOwner)},
          args[1], process.argv[2], process.argv[3],
        ], { env: options.env, encoding: "utf8" });
        throw new Error("Unexpected fixture command: " + command);
      };
      syncBuiltinESMExports();
      // Install process fixtures before the wrapper imports its config.
      await import(process.argv[1]);
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        wrapperOwner,
        new URL("../scripts/mutation-delta.mjs", import.meta.url).href,
        metadata,
        lookup,
      ],
      {
        env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base },
        encoding: "utf8",
      },
    );
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const { report, sandbox } = JSON.parse(readFileSync(metadata, "utf8"));
    assert.equal(existsSync(dirname(sandbox)), false, "owner cleanup must run");
    assert.equal(
      existsSync(report),
      true,
      "JSON report must survive owner exit",
    );
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
      fixture: "retained",
    });
  });
}
