import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mutation testing over the pure decision logic: the src/lib modules plus the
 * pure parts of src/server (planBrowseSides/mergeStreams in browse.ts via
 * in-file disable markers, related.ts whole). Effect-heavy adapters stay out.
 * The command runner runs a hand-picked list of the suites that kill
 * mutants in the mutate set (not all of `bun run test`), so a mutant only
 * survives when that list cannot catch it.
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
      "node --experimental-strip-types --import ./tests/setup.ts --test --test-concurrency=1 tests/status.test.ts tests/tags.test.ts tests/related.test.ts tests/browse.test.ts tests/browse-items.test.ts tests/providers.test.ts tests/api.test.ts tests/approvals.test.ts tests/decisions.test.ts tests/names.test.ts tests/update.test.ts tests/browse-url.test.ts tests/person.test.ts tests/api-get.test.ts tests/sorts.test.ts",
  },
  // The command runner only reports an exit code, so per-test coverage is
  // impossible; Stryker runs every mutant against the whole scoped command.
  coverageAnalysis: "off",
  // One mutant run = the scoped suite (net ~7.4 s on the Linux worker).
  // Stryker's per-run budget is timeoutFactor × net + timeoutMS (default
  // factor 1.5: about 1.5 × 7.4 s + 60 s here); timeoutMS is the fixed
  // slack on top of the measured net time, never the sole kill clock.
  timeoutMS: 60000,
  concurrency: 8,
  mutate: [
    "src/lib/**/*.ts",
    "src/server/browse.ts",
    "src/server/related.ts",
    "src/server/update.ts",
  ],
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
  // run: ~22 min at 1478 tested (2026-10-12, Linux worker, concurrency 8).
  reporters: ["clear-text", "progress"],
  // stryker.log (cwd) captures the run including worker deaths, but its
  // per-mutant detail covers killed mutants only — the survived diffs are
  // console-only, so capture stdout when hunting survivors.
  fileLogLevel: "trace",
  // break is the measured clean-run score (85.29, 2026-10-12, after
  // src/server/update.ts joined the mutate set) floored to
  // one decimal; a regression below it fails the run, and the margin is
  // under two mutants.
  // status.ts is fully killed: the badge and acquisition-line tests pin
  // every branch, and the sorts suite pins the capability table.
  // Accepted survivors: sorts.ts's defensive `?.`/`?? []` chains, which
  // no typed provider/kind input can reach, the error-message copy
  // strings in related.ts, the
  // REQUESTS_CHANGED event name,
  // empty-array shape defaults asserted nowhere, the fetch-param conditionals
  // and sort comparators in browse.ts/contracts.ts/related.ts that the
  // provider fixtures assert only loosely — vocabulary, shape and ordering,
  // not dedupe/merge logic — lib/update.ts's four outcome-equivalent mutants
  // (guard some-vs-every, loop-bound and comparison rewrites that cannot flip
  // a returned boolean), src/server/update.ts's payload-guard chain (a
  // non-string tag_name/html_url or an || → && rewrite dies in the same
  // caught TypeError and the two error-message copy strings never surface),
  // and api-get.ts's FIFO-cap edges (has/clear/eviction
  // conditionals asserted only loosely by the queue-order tests).
  thresholds: { high: 85, low: 75, break: 85.2 },
};

export default config;
