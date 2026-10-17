// Preloaded via `node --import` by the `test` script and the Stryker
// commandRunner: every test file runs against a throwaway data dir unless it
// pins its own (api, acquisition, storage do), so no code path can fall back
// to the repo's ./data default — in the primary checkout that is the
// operator's real database, which a test run would open, WAL and migrate.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test process gets its own throwaway dir: an exported VELVARR_DATA_DIR
// only picks the parent of that dir, never the dir itself, so concurrent test
// processes (Stryker workers, node --test file processes) can never share one
// SQLite file and fail on each other's locks. Only a dir this file created is
// removed at exit, so the exported dir may point at real data untouched.
const base = process.env.VELVARR_DATA_DIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const created = mkdtempSync(join(base, "velvarr-test-"));
process.env.VELVARR_DATA_DIR = created;

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

// Test files that pin their own data dir (api, acquisition, storage) remove it
// in their own after() hooks, storage closed first; this covers the fallback.
process.on("exit", () => rmTempDir(created));
