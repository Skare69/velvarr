# Mutation test temporary data

## Behavior

Each Stryker run creates one unique temporary parent outside the repository. The parent contains its sandbox and all temporary test data.

The run sets `TMPDIR` and `VELVARR_DATA_DIR` for its test processes. Each process creates a separate subtree. Each suite creates its pinned data directories inside that subtree.

The test process removes its subtree at exit. When the TAP runner sends `SIGTERM`, the process exits through that cleanup hook.

The Stryker process removes its run parent at exit. This includes data from children that cannot execute their hooks.

The full and delta commands use the same cleanup behavior. The delta launcher keeps its original temporary base for its scratch configuration and child invocation.

## Boundaries and errors

- Cleanup removes only directories that the current process creates. It never scans for old directories from other runs.
- Concurrent runs use different parents. Cleanup of one run does not alter another run.
- Child failures preserve a nonzero exit status. Cleanup failures remain errors.
- Each test process retains a separate SQLite database.
- An external `SIGKILL` of the run owner prevents its exit hook. This change does not claim cleanup after that signal.
- Existing leaked directories remain untouched. The operator or tracker owns their removal.

## API database size

The pagination regression in `tests/api.test.ts` seeds 50,000 requests. The database and its WAL can each reach about 32 MB. SQLite retains allocated pages after the test deletes its rows.

Keep the fixture volume and its assertions. The fix changes temporary data ownership, not pagination coverage or production SQLite settings.

## Acceptance checks

1. Run lifecycle regressions against the previous code. Observe an assertion failure on data ownership or retained temporary data.
2. Confirm cleanup after a child exits without teardown.
3. Confirm test data cleanup through the `SIGTERM` handler.
4. Confirm cleanup of one run leaves a concurrent run unchanged.
5. Run `bun run format`, `bun run check`, `bun run test`, and `bun run build`.
6. Compare `ls -d /tmp/velvarr-api-test-* 2>/dev/null | wc -l` before and after `bun run test:mutation:delta`. The count must not increase.
7. Exercise real TAP bailouts with the API suite. Confirm the run parent disappears at exit.

## Non-goals

- No changes to application behavior, production configuration, authentication, or credentials.
- No global cleanup command or stale-directory sweep.
- No reduction in fixture size, mutation files, assertions, or score thresholds.
- No new dependencies.
