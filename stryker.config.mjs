import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tap.testFiles is generated, not hand-picked: every tests/*.test.ts joins
// the gate unless this exclusion set names it. The named suites are the
// effect-heavy ones (sqlite storage, the service worker, the provider
// adapters, notification delivery, the setup script, the shelf error
// boundary, the whisparr large-library fixture). Their production code sits
// outside the mutate set, so running them adds dry-run time and catches
// nothing. A new pure-logic suite needs no config edit.
const tapExcludedSuites = new Set([
  "storage.test.ts",
  "sw.test.ts",
  "whisparr-large-library.test.ts",
  "integrations.test.ts",
  "notify.test.ts",
  "setup-script.test.ts",
  "shelf-error.test.ts",
]);

const tapTestFiles = readdirSync(new URL("./tests", import.meta.url))
  .filter((name) => name.endsWith(".test.ts") && !tapExcludedSuites.has(name))
  .sort()
  .map((name) => `tests/${name}`);

/**
 * Mutation testing over the pure decision logic: the src/lib modules plus the
 * pure parts of src/server (planBrowseSides/mergeStreams in browse.ts via
 * in-file disable markers, related.ts whole, judgment.ts and discovery.ts
 * whole — their effect glue is covered by the faked-fetch suites below or
 * carries in-file disable markers). Effect-heavy adapters stay out.
 * The tap runner runs each suite of the hand-picked list below in its own
 * node process (not all of `bun run test`), perTest coverage narrows every
 * mutant to the suites that executed its line, and forceBail stops a suite
 * at its first failing test — so a mutant survives only when its covering
 * suites cannot catch it, and NoCoverage reports the rest.
 * The sandbox lives outside the repo on purpose: a mutant that wipes cwd or
 * writes into it must never touch a real checkout.
 * @type {import('@stryker-mutator/api/core').StrykerOptions}
 */
const config = {
  packageManager: "npm",
  testRunner: "tap",
  // Per-test coverage with the tap runner means per test FILE: each suite in
  // tap.testFiles runs as the main module of its own node process, its
  // coverage lands in one pid-keyed stryker-output dump on process exit, and
  // Stryker runs a mutant only against the files that executed its line. The
  // suite list is generated above, so a new pure-logic suite joins the gate
  // without a config edit.
  // The invocation must NOT wrap the file in `node --test`: that spawns
  // grandchild processes, so the hook's pid-keyed coverage dump never
  // reaches the runner (every mutant came back NoCoverage when tried).
  // Standalone execution needs --test-reporter=tap (piped standalone
  // node:test emits the spec reporter otherwise, which the TAP parser
  // cannot read, so every kill was miscategorized as an error when tried).
  coverageAnalysis: "perTest",
  tap: {
    testFiles: tapTestFiles,
    nodeArgs: [
      "--experimental-strip-types",
      "--import",
      "./tests/setup.ts",
      "--test-reporter=tap",
      "-r",
      "{{hookFile}}",
      "{{testFile}}",
    ],
    forceBail: true,
  },
  // The tap dry run nets 26.3 s on the Linux worker with the first 19
  // suites (5.4 s of it process overhead); judgment-editor and
  // provider-settings add two ~0.15 s suites. Stryker's per-run budget is
  // timeoutFactor × net + timeoutMS (default factor 1.5); a per-mutant
  // selection of one to a few suites stays far inside it. timeoutMS is the
  // fixed slack on top of the measured net time, never the sole kill clock.
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
  // No `incremental` here: a stale cache once replayed statuses from an
  // older run (one replay reported decisions.ts at 0% that the current
  // suites kill completely), and a full run keeps scores comparable across
  // runner changes. Measured on this commit (2026-11-04, Linux worker,
  // concurrency 8): the old full-list command 142.8 min wall, static
  // per-file import-closure selection 49.6 min, the tap runner 15.9 min for
  // the same 3417 mutants (2177 tested; 1962 killed + 5 timeout detected,
  // 181 survived + 29 NoCoverage undetected). Against the full-list run the
  // killed set is identical; one admission.ts mutant flipped Killed →
  // Timeout (both detected), 30 mutants flipped Survived → NoCoverage (see
  // below), and discovery.ts's dropped-sort mutant flipped the other way —
  // its kill rides a same-millisecond Date.now() tie in
  // tests/discovery.test.ts whose random-uuid row ids make the order a coin
  // flip, so either verdict is a fair sample.
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
  // at v0.38.1. Measured clean-run score 88.92 (1890 killed,
  // 4 timeout, 236 survived, 2078 tested, 2026-10-18, Linux worker,
  // concurrency 8; first run with admission.ts's rate-budget section in
  // the set, +51 mutants, 47 of them killed); a regression below break
  // fails the run. On 2026-11-04 the measured clean-run scores on this
  // commit were 90.31 (old full-list command) and 90.35 (tap runner) —
  // later test commits killed more mutants, so the floor moved up.
  // A 0-survivor result — or every mutant reading NoCoverage — means a
  // broken environment, not a perfect one: the accepted survivors below are
  // the floor of a healthy run. A
  // vacuous 100.00 was once produced by all 8 workers sharing one exported
  // VELVARR_DATA_DIR and failing on its locks; tests/setup.ts now gives
  // every test process its own dir.
  // With perTest coverage, mutants that no test executes report as
  // NoCoverage instead of Survived; both count as undetected, so the score
  // is unaffected (on the 2026-11-04 related.ts + browse.ts benchmark
  // scopes, 16 of 752 mutants flipped that way).
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
  // which no observable charge can tell apart),
  // and, from the suites this gate auto-wired (2026-11-13): links.ts's and
  // performer-merge.ts's linkKey inner-"www." host strips (a "www." label
  // never occurs mid-host in provider links, so leading-only and anywhere
  // stripping strip the same hosts) and the uniform linkKey case flips (a
  // whole-string case fold keeps every pair's equality, so dedupe outcomes
  // cannot change), and credential-card.ts's pristine-state identity
  // return in dropDraftResult (the reset branch spreads the same values,
  // so the branch choice is invisible in the resulting state).
  thresholds: { high: 85, low: 75, break: 88.2 },
};

export default config;
