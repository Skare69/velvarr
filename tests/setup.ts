// Preloaded via `node --import` by the `test` script and the Stryker
// commandRunner: every test file runs against a throwaway data dir unless it
// pins its own (api, acquisition, storage do), so no code path can fall back
// to the repo's ./data default — in the primary checkout that is the
// operator's real database, which a test run would open, WAL and migrate.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VELVARR_DATA_DIR ??= mkdtempSync(join(tmpdir(), "velvarr-test-"));
