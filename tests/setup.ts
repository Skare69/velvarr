// Preloaded via `node --import` by the `test` script and the Stryker
// commandRunner: every test file runs against a throwaway data dir unless it
// pins its own (api, acquisition, storage do), so no code path can fall back
// to the repo's ./data default — in the primary checkout that is the
// operator's real database, which a test run would open, WAL and migrate.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

// Every test process gets its own throwaway dir: an exported VELVARR_DATA_DIR
// only picks the parent of that dir, never the dir itself, so concurrent test
// processes (Stryker workers, node --test file processes) can never share one
// SQLite file and fail on each other's locks. Only a dir this file created is
// removed at exit, so the exported dir may point at real data untouched.
const base = process.env.VELVARR_DATA_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const created = mkdtempSync(join(base, "velvarr-test-"));
process.env.VELVARR_DATA_DIR = created;

// Tests never read the operator's ambient provider credentials: the suites
// set their own tokens through withEnv, and a key mirror computed outside a
// withEnv window (discovery.test.ts's read-through test) must agree with the
// key the build computed inside it. Ambient TPDB/STASHDB env on a worker box
// flipped the mirror's configured-ness and failed the cache-key assertions.
delete process.env.TPDB_API_TOKEN;
delete process.env.STASHDB_API_KEY;
delete process.env.TPDB_BASE_URL;
delete process.env.STASHDB_BASE_URL;

// ponytail: maxRetries/retryDelay rides out Windows AV/indexer lock grace;
// a removal that still fails is reported, never hidden.
export function rmTempDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    console.error(`failed to remove temp dir ${dir}: ${String(error)}`);
  }
}

// Suite hooks close storage first. The exit hook also covers TAP bailouts.
process.on("exit", () => rmTempDir(created));
process.once("SIGTERM", () => process.exit(143));

// Keep suite data under the process subtree even when a suite changes its env.
export function testTempDir(prefix: string): string {
  return mkdtempSync(join(created, prefix));
}

// --- property-based fuzzing tier (fast-check) ---
// Gate tier (default): fixed seed 42, 200 runs per property, inside the
// normal test command — every run and every mutant sees the same inputs.
// Deep tier: FC_RUNS=<n> switches to a random seed for reviews; a failure
// there is a finding card (seed + replay path + shrunk input), not a red
// gate. numRuns must be a safe integer >= 1: NaN would run zero iterations.
const runs = Number(process.env.FC_RUNS ?? 200);
if (!Number.isSafeInteger(runs) || runs < 1) {
  throw new Error(`bad FC_RUNS: ${process.env.FC_RUNS}`);
}
fc.configureGlobal({
  numRuns: runs,
  seed: process.env.FC_RUNS === undefined ? 42 : undefined,
});
