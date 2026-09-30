import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mutation testing over the pure decision logic: the src/lib modules plus the
 * pure parts of src/server (planBrowseSides/mergeStreams in browse.ts via
 * in-file disable markers, related.ts whole). Effect-heavy adapters stay out.
 * The command runner reuses the exact test command from `bun run test`, so a
 * mutant only survives when the real suite cannot catch it.
 * The sandbox lives outside the repo on purpose: a mutant that wipes cwd or
 * writes into it must never touch a real checkout.
 * @type {import('@stryker-mutator/api/core').StrykerOptions}
 */
const config = {
  packageManager: "npm",
  testRunner: "command",
  // Scoped to the suites that kill mutants in the mutate set (a new
  // pure-logic test file must be added here); files run serially inside one
  // mutant run so 8 workers × 2 node processes stay off the Windows loopback
  // red zone — ≥12 concurrent test-file suites drop loopback connections
  // (measured: 5–27 flaky failures at default fan-out, green at ≤4 suites).
  commandRunner: {
    command:
      "node --experimental-strip-types --test --test-concurrency=1 tests/status.test.ts tests/tags.test.ts tests/related.test.ts tests/browse.test.ts tests/providers.test.ts tests/api.test.ts tests/removal.test.ts tests/approvals.test.ts tests/decisions.test.ts tests/names.test.ts",
  },
  // The command runner only reports an exit code, so per-test coverage is
  // impossible; Stryker runs every mutant against the whole scoped command.
  coverageAnalysis: "off",
  // One mutant run = the scoped suite (~17 s serial): the default 5 s
  // per-run timeout kills every run with the clock (counted as detected =
  // fake 100% score).
  timeoutMS: 60000,
  concurrency: 8,
  mutate: ["src/lib/**/*.ts", "src/server/browse.ts", "src/server/related.ts"],
  // TypeScript 7 (typescript-go) dropped the JS config API Stryker's tsconfig
  // preprocessor needs. Pointing at a nonexistent file skips its rewrite,
  // which only fixes extends/references paths for monorepo sandboxes — this
  // tsconfig has none, and nothing in the sandbox runs tsc. Revisit when
  // Stryker gains a TS7-compatible preprocessor.
  tsconfigFile: "tsconfig.sandbox-unused.json",
  tempDirName: join(tmpdir(), "velvarr-stryker"),
  // No `incremental` here: with the command runner a stale cache replayed
  // statuses from an older command (one replay reported decisions.ts at 0%
  // that the current suite kills completely). The honest cost is the full
  // run: 978 mutants × ~19 s scoped ÷ 8 workers ≈ 36 min.
  reporters: ["clear-text", "progress"],
  // stryker.log (cwd) captures the full run including worker deaths; the
  // console progress lines survive on stdout.
  fileLogLevel: "trace",
  // break is the measured clean-run score (79.96), floored; a regression
  // below it fails the run. Accepted survivors: display-copy strings, the
  // REQUESTS_CHANGED event name, and empty-array shape defaults asserted
  // nowhere — vocabulary and shape, not decision logic.
  thresholds: { high: 85, low: 75, break: 79 },
};

export default config;
