import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mutation testing over the pure decision logic: the src/lib modules plus the
 * pure parts of src/server (planBrowseSides/mergeStreams in browse.ts via
 * in-file disable markers, related.ts whole, judgment.ts and discovery.ts
 * whole — their effect glue is covered by the faked-fetch suites below or
 * carries in-file disable markers). Effect-heavy adapters stay out.
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
      "node --experimental-strip-types --import ./tests/setup.ts --test --test-concurrency=1 tests/status.test.ts tests/tags.test.ts tests/related.test.ts tests/browse.test.ts tests/browse-items.test.ts tests/providers.test.ts tests/api.test.ts tests/approvals.test.ts tests/decisions.test.ts tests/names.test.ts tests/update.test.ts tests/browse-url.test.ts tests/person.test.ts tests/api-get.test.ts tests/sorts.test.ts tests/ollama.test.ts tests/judgment.test.ts tests/discovery.test.ts",
  },
  // The command runner only reports an exit code, so per-test coverage is
  // impossible; Stryker runs every mutant against the whole scoped command.
  coverageAnalysis: "off",
  // One mutant run = the scoped suite (net ~13.1 s on the Linux worker).
  // Stryker's per-run budget is timeoutFactor × net + timeoutMS (default
  // factor 1.5: about 1.5 × 13.1 s + 60 s here); timeoutMS is the fixed
  // slack on top of the measured net time, never the sole kill clock.
  timeoutMS: 60000,
  concurrency: 8,
  mutate: [
    "src/lib/**/*.ts",
    "src/server/browse.ts",
    "src/server/related.ts",
    "src/server/update.ts",
    "src/server/judgment.ts",
    "src/server/discovery.ts",
    // admission.ts via in-file disable markers: only the per-account
    // rate-budget section is under mutation — the session-cache and
    // requireSession glue carries disable markers like the effect adapters.
    // The globstar dodges the "[...path]" segment on purpose: as a glob it
    // is a character class (one char from {.,p,a,t,h}), and Stryker's
    // matcher rejects the backslash-escaped literal, so the raw or escaped
    // name matches no file at all.
    "src/app/api/**/admission.ts",
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
  // run: ~56 min at 2027 tested (2026-10-16, Linux worker, concurrency 8).
  reporters: ["clear-text", "progress"],
  // stryker.log (cwd) captures the run including worker deaths, but its
  // per-mutant detail covers killed mutants only — the survived diffs are
  // console-only, so capture stdout when hunting survivors.
  fileLogLevel: "trace",
  // break stays at the floor set when the score was measured at 88.23
  // (2026-10-15, when judgment.ts and discovery.ts joined the mutate set
  // and the ollama, judgment, related and discovery suites joined this
  // command). It is deliberately not re-floored to each new measurement:
  // the score drifts between runs (one exact-millisecond
  // boundary mutant can flip either way), and a re-floored break would
  // fail clean runs on that drift — which is how the 88.2 gate went red
  // at v0.38.1. Current measured clean-run score: 88.92 (1890 killed,
  // 4 timeout, 236 survived, 2078 tested, 2026-10-18, Linux worker,
  // concurrency 8; first run with admission.ts's rate-budget section in
  // the set, +51 mutants, 47 of them killed); a regression below break
  // fails the run.
  // A 0-survivor (100.00) result means a broken environment, not a perfect
  // one: the accepted survivors below are the floor of a healthy run. A
  // vacuous 100.00 was once produced by all 8 workers sharing one exported
  // VELVARR_DATA_DIR and failing on its locks; tests/setup.ts now gives
  // every test process its own dir.
  // status.ts and browse-includes.ts are fully killed: the badge and
  // acquisition-line tests pin every status branch, the sorts suite pins
  // the capability table, and tests/browse.test.ts pins the include
  // criteria, the soft-ceiling predicate and the ceiling outcome directly.
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
  // api-get.ts's failure-path cache drop (the catch-path delete of a
  // stale snapshot on a failed same-path reload) and its always-true
  // eviction-guard branch (`oldest !== undefined`: the map is non-empty
  // on that path),
  // and in the newest files: judgment.ts's client-cache rebuild
  // (a same-config rebuild is externally identical), the per-backend
  // failure-gate cap and its `<=` boundary (the cap needs 2000 distinct
  // backends; the boundary needs an exact-millisecond hit), the redundant
  // error-guard re-routes that any caller already funnels (judgmentBackend's
  // `|| settings.error` after `!configured`, suggestTags's and
  // rankRelatedTitles's null-backend guards behind their own catches, the
  // rank answer-shape conjuncts that all converge on the same voided
  // rerank), the wire-invisible `? "ollama"` key placeholder and local
  // fetch `init?.headers` (the SDK always passes init), the sameWork catch
  // re-routes (the faked-fetch suite answers false on this path either way),
  // the URL/env trims that validateBaseUrl and the WHATWG URL parser
  // normalize anyway, and discovery.ts's shelf literals that providers.ts
  // normalizes plus the TTL `<` boundary (exact-equality unreachable),
  // and in admission.ts's rate-budget section: the two 429 "Too many
  // requests" message copies (errorShape pins status and code, never the
  // copy), and two outcome-equivalent `rateBuckets.delete(key)` removals —
  // the scan guard only evicts a bucket refilled to full, and a kept full
  // bucket charges exactly like the fresh one eviction would hand over
  // (the re-insert delete only refreshes FIFO order among full buckets,
  // which no observable charge can tell apart).
  thresholds: { high: 85, low: 75, break: 88.2 },
};

export default config;
