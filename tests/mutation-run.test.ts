import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
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

function runDeltaSecurity(
  t: TestContext,
  { status = 0, symlink = false, failWrite = false } = {},
) {
  const { base, inheritedFile } = fixture(t);
  const metadata = join(base, "security.json");
  const loaded = join(base, "loaded.json");
  const sentinel = join(base, "sentinel");
  writeFileSync(sentinel, "sentinel data");
  const configOwner = `
    import { writeFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    // The child loads the runtime-selected generated config.
    const config = (await import(pathToFileURL(process.argv[1]).href)).default;
    writeFileSync(process.argv[2], JSON.stringify({
      mutate: config.mutate,
      break: config.thresholds.break,
    }));
    process.exit(Number(process.argv[3]));
  `;
  const wrapperOwner = `
    import cp from "node:child_process";
    import fs from "node:fs";
    import os from "node:os";
    import { dirname, join } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const [wrapper, base, metadata, loaded, status, symlink, failWrite] = process.argv.slice(1);
    const spawnSync = cp.spawnSync;
    const writeFileSync = fs.writeFileSync;
    const mkdtempSync = fs.mkdtempSync;
    const legacyPath = join(base, "velvarr-stryker-delta-" + process.pid + ".mjs");
    const peer = join(base, "velvarr-stryker-delta-peer");
    fs.mkdirSync(peer);
    writeFileSync(join(peer, "keep"), "peer data");
    if (symlink === "true") fs.symlinkSync(join(base, "sentinel"), legacyPath);
    process.umask(0);
    os.tmpdir = () => base;
    const observation = { legacyPath, peer, owned: [], called: false };
    const save = () => writeFileSync(metadata, JSON.stringify(observation));
    save();
    fs.mkdtempSync = (prefix, ...args) => {
      const directory = mkdtempSync(prefix, ...args);
      if (String(prefix).startsWith(join(base, "velvarr-stryker-delta-"))) {
        observation.owned.push(directory);
        save();
      }
      return directory;
    };
    fs.writeFileSync = (file, ...args) => {
      if (failWrite === "true" && (
        String(file).endsWith("/delta.mjs") ||
        String(file).endsWith("\\\\delta.mjs") ||
        String(file) === legacyPath
      )) throw new Error("fixture config write denied");
      return writeFileSync(file, ...args);
    };
    cp.spawnSync = (command, args, options) => {
      if (command === "git") {
        if (args[0] === "describe") return { status: 0, stdout: "v0.44.0\\n" };
        if (args[0] === "diff") return { status: 0, stdout: "src/lib/discord-settings.ts\\n" };
      }
      if (command !== "stryker") throw new Error("Unexpected fixture command: " + command);
      observation.called = true;
      observation.config = args[1];
      observation.directoryMode = fs.statSync(dirname(args[1])).mode & 0o777;
      observation.fileMode = fs.statSync(args[1]).mode & 0o777;
      save();
      return spawnSync(process.execPath, [
        "--input-type=module", "--eval", ${JSON.stringify(configOwner)},
        args[1], loaded, status,
      ], { env: options.env, stdio: "inherit" });
    };
    syncBuiltinESMExports();
    // Install the fixtures before the wrapper imports its config.
    await import(wrapper);
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      wrapperOwner,
      new URL("../scripts/mutation-delta.mjs", import.meta.url).href,
      base,
      metadata,
      loaded,
      String(status),
      String(symlink),
      String(failWrite),
    ],
    {
      env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base },
      encoding: "utf8",
    },
  );
  const observation = JSON.parse(readFileSync(metadata, "utf8")) as {
    legacyPath: string;
    peer: string;
    owned: string[];
    called: boolean;
    config?: string;
    directoryMode?: number;
    fileMode?: number;
  };
  return { result, observation, sentinel, inheritedFile, loaded };
}

for (const status of [0, 17]) {
  test(`delta config stays private and cleans its directory after status ${status}`, (t) => {
    const { result, observation, inheritedFile, loaded } = runDeltaSecurity(t, {
      status,
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, status, result.stderr);
    assert.equal(observation.called, true);
    assert.deepEqual(JSON.parse(readFileSync(loaded, "utf8")), {
      mutate: ["src/lib/discord-settings.ts"],
      break: null,
    });
    assert.equal(observation.owned.length, 1);
    const directory = observation.owned[0];
    assert.ok(directory);
    assert.ok(observation.config);
    assert.equal(dirname(observation.config), directory);
    if (process.platform !== "win32") {
      assert.equal(observation.directoryMode! & 0o077, 0);
      assert.equal(observation.fileMode, 0o600);
    }
    assert.equal(existsSync(directory), false);
    assert.equal(
      readFileSync(join(observation.peer, "keep"), "utf8"),
      "peer data",
    );
    assert.equal(readFileSync(inheritedFile, "utf8"), "inherited data");
  });
}

test(
  "delta config preserves a planted legacy symlink and its sentinel",
  { skip: process.platform === "win32" },
  (t) => {
    const { result, observation, sentinel } = runDeltaSecurity(t, {
      symlink: true,
    });
    assert.equal(
      readFileSync(sentinel, "utf8"),
      "sentinel data",
      "the generated config must not overwrite the symlink target",
    );
    assert.equal(lstatSync(observation.legacyPath).isSymbolicLink(), true);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(observation.peer, "keep"), "utf8"),
      "peer data",
    );
  },
);

test("delta config write failure cleans only its owned directory", (t) => {
  const { result, observation, inheritedFile, sentinel, loaded } =
    runDeltaSecurity(t, { failWrite: true });
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture config write denied/);
  assert.equal(observation.called, false);
  assert.equal(existsSync(loaded), false);
  assert.equal(observation.owned.length, 1);
  const directory = observation.owned[0];
  assert.ok(directory);
  assert.equal(existsSync(directory), false);
  assert.equal(
    readFileSync(join(observation.peer, "keep"), "utf8"),
    "peer data",
  );
  assert.equal(readFileSync(inheritedFile, "utf8"), "inherited data");
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel data");
});
