// Two-stage test selection for Stryker's command runner.
// Dry run (no __STRYKER_ACTIVE_MUTANT__): the full scoped suite, the same
// command this script replaces. Mutant run: stage 1 runs only the test files
// whose import closure contains the mutated file, one node --test process per
// file in the order below (the same per-file process isolation that
// `node --test` already gives), stopping at the first failure. A map miss or
// a stage-1 survivor falls back to the full list: slower, never wrong.
// Linux-only: stage 1 resolves the active mutant with POSIX grep.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The scoped suites that kill mutants in the mutate set, in the order the old
// one-shot command ran them. Keep the order: it decides which suite hits a
// hang first, so a timeout verdict stays a timeout verdict. A new pure-logic
// test file must be added here.
const FILES = [
  "tests/status.test.ts",
  "tests/tags.test.ts",
  "tests/tag-wait.test.ts",
  "tests/related.test.ts",
  "tests/browse.test.ts",
  "tests/browse-items.test.ts",
  "tests/providers.test.ts",
  "tests/api.test.ts",
  "tests/approvals.test.ts",
  "tests/decisions.test.ts",
  "tests/names.test.ts",
  "tests/update.test.ts",
  "tests/browse-url.test.ts",
  "tests/person.test.ts",
  "tests/api-get.test.ts",
  "tests/sorts.test.ts",
  "tests/ollama.test.ts",
  "tests/judgment.test.ts",
  "tests/discovery.test.ts",
];

const NODE_ARGS = [
  "--experimental-strip-types",
  "--import",
  "./tests/setup.ts",
  "--test",
  "--test-concurrency=1",
];

// The mutate-set roots; grep looks for the active mutant's id here.
const SEARCH_DIRS = ["src/lib", "src/server", "src/app"];

const ACTIVE_MUTANT_ENV = "__STRYKER_ACTIVE_MUTANT__";

// Stryker may signal this wrapper on a mutant timeout; pass the signal on so
// no test process outlives the mutant run.
function run(files: string[]): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const child: ChildProcess = spawn("node", [...NODE_ARGS, ...files], {
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }
  child.on("error", () => resolve(1));
  child.on("exit", (code, signal) => resolve(signal === null ? (code ?? 1) : 143));
  return promise;
}

// Relative specifiers only; a missed edge just widens the fallback.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']+)["']/g;

function importsOf(file: string): string[] {
  let code: string;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const specs: string[] = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

// Resolve a relative specifier to an existing file, trying common extensions.
// Type-only imports map too: running an extra suite never flips a verdict
// against the full-list run, it only costs time.
function resolveImport(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec);
  const candidates = [
    base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : null,
    base,
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      /\.(ts|tsx)$/.test(candidate) &&
      existsSync(candidate)
    ) {
      return candidate.split("\\").join("/");
    }
  }
  return null;
}

// Map every module each scoped suite reaches (directly or through its import
// closure) to that suite. Built from FILES in order, so each value list keeps
// the full-list order.
export function buildImportMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const testFile of FILES) {
    const seen = new Set<string>([testFile]);
    const queue: string[] = [testFile];
    while (queue.length > 0) {
      const file = queue.shift();
      if (file === undefined) break;
      for (const spec of importsOf(file)) {
        const resolved = resolveImport(file, spec);
        if (resolved === null || seen.has(resolved)) continue;
        seen.add(resolved);
        if (!resolved.includes(".test.")) queue.push(resolved);
        const list = map.get(resolved) ?? [];
        if (!list.includes(testFile)) list.push(testFile);
        map.set(resolved, list);
      }
    }
  }
  return map;
}

// The instrumenter wraps every mutant in `stryMutAct_9fa48("<id>")`; the id
// identifies the mutated file.
export function findMutatedFile(id: string): string {
  // The env value is untrusted input; a miss degrades to "run everything".
  if (!/^\d+$/.test(id)) return "";
  const res = spawnSync(
    "grep",
    ["-rlE", `stryMutAct_[0-9a-f]+\\("${id}"\\)`, ...SEARCH_DIRS],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || res.stdout === null) return "";
  const line = res.stdout.split("\n").find((entry) => entry.trim() !== "");
  return line === undefined ? "" : line.trim().replace(/^\.\//, "");
}

async function mutantRun(mutantId: string): Promise<never> {
  const mutated = findMutatedFile(mutantId);
  const stageOne = mutated === "" ? [] : (buildImportMap().get(mutated) ?? []);
  if (stageOne.length > 0) {
    console.error(
      `[mutant-run] stage 1: ${stageOne.length} file(s) for ${mutated}`,
    );
    for (const file of stageOne) {
      const code = await run([file]);
      if (code !== 0) process.exit(code);
    }
  }
  console.error("[mutant-run] stage 2: full suite");
  process.exit(await run(FILES));
}

export async function main(): Promise<void> {
  const mutantId = process.env[ACTIVE_MUTANT_ENV];
  if (mutantId === undefined) {
    // Dry run: exactly the command this script replaces.
    process.exit(await run(FILES));
  }
  await mutantRun(mutantId);
}

if (import.meta.main) await main();
