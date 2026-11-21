# Testing

Use Node 24.21 or later and the pinned Bun version from `package.json`.

## Standard checks

```sh
bun install --frozen-lockfile
bun run format:check
bun run check
bun run test
bun run build
```

`bun run test` runs every `tests/*.test.ts` unit/API test once, including both
settings tabs. `bun run test:ui` runs every `tests/ui/*.spec.mjs` browser test
once. CI runs these two suites; there is no separate connection-only test or
coverage rerun. The suites check different layers: application logic and API
behavior versus interactions with the rendered UI.

## Artwork property review

Run the random-seed review without a change to the sample counts:

```sh
FC_RUNS=20000 bun run test
```

The artwork URL property keeps all 11 assertions per sample.
After each successful sample, it moves that sample's index file outside the active store.
Later samples still check a fresh URL, one upstream fetch, one index entry, and its allocated bytes.
The process temporary directory retains these files until the existing exit cleanup runs.
Other API fixtures keep their index entries. Production store sweeps do not change.

Before this change, one diagnostic run at each scale measured these phases:

| Phase (ms) | 2,000 samples | 20,000 samples |
| --- | ---: | ---: |
| URL generation and normalization | 60.512 | 867.056 |
| Index writes without sweeps | 267.653 | 3018.770 |
| Store sweeps | 18413.971 | 1937137.254 |
| Directory and store checks | 40796.549 | 4242488.595 |
| Other work | 6163.056 | 72297.432 |
| Property total | 65701.741 | 6255809.107 |

Directory and store checks took 67.8% of the 20,000-sample run.
The anonymous profiler ran the whole API test file and counted 220,000 assertions.
Both diagnostic runs passed all 210 API tests. These single samples include profiler overhead.

After the fixture change, the full command passed all 1,285 tests in 87,007.152094 ms.
The artwork property took 48,068.785452 ms, below the 1,200,000 ms limit.
The command used one 3,600-second tool deadline and reported no failures or cancellations.
The earlier VELV-255 run took 6,630,338.916801 ms for this property and 6,675 seconds for the suite.
These are single validation results, not repeated benchmarks.

## Mutation test temporary data

```sh
bun run test:mutation
bun run test:mutation:delta
```

The full command tests all configured mutation files. The delta command tests
eligible files that changed since the last release tag.

Each run creates one unique temporary parent outside the repository. It contains
the Stryker sandbox and test data. Each test process creates its own subtree.
Suites that pin a database directory use `testTempDir(prefix)` inside that subtree.
Separate processes do not share SQLite paths.

The TAP runner uses `SIGTERM` after a test failure. The test process exits with
143, and its exit hook removes its subtree. The run owner removes its entire
parent at exit, including data from children that cannot execute their hooks.
Cleanup removes only data that the current run or process creates. It does not
scan for stale directories or remove data from other runs.

An external `SIGKILL` of the run owner prevents its exit hook. Automatic cleanup
cannot cover that case. Existing leaked directories also remain untouched.

The pagination regression in `tests/api.test.ts` retains its 50,000-row fixture
and all assertions. Its database and SQLite WAL can each reach about 32 MB,
or about 64 MB together. SQLite retains allocated pages after the fixture deletes
its rows.

The 10,000-follow fixture in `tests/discovery.test.ts` inserts its 9,999 extra
rows in one explicit transaction. A separate `DatabaseSync` connection uses
SQLite's default durability settings. Without a transaction, each insert requires
its own durable commit. This fixture caused the delta gate's initial run to
exceed five minutes on the Linux worker. The transaction keeps all rows,
assertions, and durability settings.

Both mutation commands keep the clear-text and progress reporters. They also
write a JSON report to the OS temporary directory as
`velvarr-mutation-<pid>.json`. The console prints the full path. The report remains
outside the temporary sandbox, so the run's exit cleanup does not remove it.

The delta wrapper restores `TMPDIR`, `TEMP`, and `TMP` for the Stryker process.
Windows selects its temporary directory from `TEMP` or `TMP`, not `TMPDIR`.
The lifecycle regression runs the real wrapper with each platform's lookup rule.
It checks that the JSON report survives both owner exits.
Before the fix, its `TEMP` case failed with
`AssertionError [ERR_ASSERTION]: JSON report must survive owner exit`.

### Delta gate repair over v0.44.0

The failed release check reported
`ERROR DryRunExecutor Initial test run timed out!`. Its trace stopped in
`tests/discovery.test.ts`, before any mutant ran.

A standalone diagnostic run passed all ten discovery tests. The 10,000-follow
fixture alone took 149,637 ms. After the transaction repair, the same fixture
passed in 179 ms within the focused check. These are single diagnostic samples,
not a repeatable benchmark.

The focused command passed all 152 tests:

```sh
node --experimental-strip-types --import ./tests/setup.ts --test \
  tests/discovery.test.ts tests/browse.test.ts tests/discord-settings.test.ts
```

The full checks passed `format`, `check`, all 1,280 tests, and `build`.
The build reported five warnings in unchanged instrumentation and storage code.

The final delta run over `v0.44.0` completed in 27 minutes 24 seconds.
Its initial run passed all 42 TAP suites in 41 seconds.
These times are single diagnostic samples, not a benchmark.
The run kept all 2,818 generated mutants.
It reported 1,011 Killed, 2 Timeout, 101 Survived, 25 NoCoverage, and 1,679 Ignored.
The mutation score was 88.94%. The covered-code score was 90.93%.
The existing full-gate `break: 88.2` and delta report-only `break: null` policies stay unchanged.
The JSON report is `/tmp/velvarr-mutation-18209.json`.
The changed-line inventory is `/tmp/velv-254-final-changed-mutants.json.txt`.

Changed lines had 75 Killed, 4 Survived, 1 NoCoverage, and 53 Ignored mutants.
The table records every undetected changed-line mutant and the regression for #421.
All six ledger entries refer to `src/lib/discord-settings.ts`.
The type-only change in `src/lib/contracts.ts` has no changed-line executable mutant.

| ID | Final full-run status | Source lines | Replacement | Assessment |
| --- | --- | --- | --- | --- |
| #410 | Survived | 20 | `/^https:\/\/(?:discord\.com\|discordapp\.com)(?::443)?\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?/i` | Equivalent. The strict pathname regex and raw-path equality still reject every added suffix outside the original grammar. See the suffix analysis below. |
| #421 | Killed | 28–29 | `/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname) \|\| url.pathname === raw.slice(raw.indexOf("/api/"))` | Not equivalent. The `official exact webhook endpoints only` regression rejects `https://discord.com/api/Webhooks/123/synthetic-token`. The mutant accepts it through equality. |
| #422 | Survived | 28 | `/\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/` | Equivalent. The raw regex permits no path prefix before `/api/`. Equality rejects normalization. Tokens `.` and `..` remove required path segments. |
| #423 | Survived | 28 | `/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?/` | Equivalent. The raw regex permits no extra suffix. Equality rejects normalization. Tokens `.` and `..` leave no required token to match. |
| #429 | Survived | 29 | `true` | Equivalent. The raw grammar excludes escapes, backslashes, whitespace, queries, and fragments. Only `.` and `..` normalize the path. The pathname regex rejects both. |
| #433 | NoCoverage | 32–34 | `{}` | Equivalent. The bounded raw grammar supplies an absolute HTTPS URL, a fixed valid host, optional port 443, and an ASCII path. `new URL(raw)` cannot throw. |

For #410, equality compares the whole raw path with `url.pathname`.
Query and fragment suffixes fail equality, even when they contain no text.
Percent escapes either remain in the pathname and fail its regex, or change the path and fail equality.
Dot-segment removal and backslash conversion fail equality.
Extra path segments fail the pathname regex.
The CR/LF guard rejects both characters before URL parsing.
Tab removal, other stripped whitespace, and Unicode encoding fail equality.
Suffixes that merely extend the token or add its optional slash already satisfy the original grammar.
Thus, removal of the raw end anchor cannot change the result.

For #429, scheme and host case normalization do not change the path.
Path case does not normalize, and the pathname regex requires lowercase `/api/webhooks/`.
All other permitted token characters retain their path spelling.
Thus, every pathname that passes the regex already equals the raw path.

The five equivalence decisions use source analysis.
A replay of #421 failed with `not ok 1 - official exact webhook endpoints only`.
The failure showed the mixed-case URL instead of the expected `null`.
The pristine parser passed all six Discord tests.
The final full delta run reports #421 as Killed by that regression.

The repair adds no credential or production access. All webhook data uses
synthetic fixtures, so the tests need no live secret.

## Settings browser regressions

The Playwright suite covers Connections, Metadata providers, and AI.
`tests/ui/connections.spec.mjs` covers Jellyfin, Whisparr, and shared behavior.
`tests/ui/metadata-providers.spec.mjs` covers provider credentials and AI.
`tests/ui/discord.spec.mjs` covers the Discord card, independent overrides,
draft checks, confirmation dialogs, and phone layout. All suites use the
same isolated fixture and test harness.

Build the production application before running these tests:

```sh
bunx playwright install chromium
bun run build
bun run test:ui
```

On Linux, use `bunx playwright install --with-deps chromium` to install the
browser's system dependencies as well. CI runs these browser tests after the
production build, before container validation.

The test server uses temporary storage, generated secrets, and synthetic service
responses. It serves the actual production UI on loopback ports 16740 and 16741,
cleans up its temporary data on shutdown, and never edits the operator's
configuration. Run tests serially because the fixture state is shared.

To use an installed Chrome locally instead of downloading Chromium, set
`PLAYWRIGHT_CHANNEL=chrome` when running `bun run test:ui`. Failed runs leave a
screenshot and trace in the ignored `test-results/` directory.

## Settings source modules

The tabs share UI behavior while keeping their service-specific rules in separate
modules. Connections uses its draft and card-lifecycle modules. Metadata
providers uses its credential and AI modules.

| Source | Role | Direct unit tests |
| --- | --- | --- |
| [`src/lib/settings-service.ts`](../src/lib/settings-service.ts) | Shared status wording, failure type, and settings operation queue | `tests/settings-service.test.ts` |
| [`src/lib/connection-settings.ts`](../src/lib/connection-settings.ts) | Jellyfin/Whisparr draft initialization, change detection, field validation, and service-only save patches | `tests/connection-settings.test.ts` |
| [`src/lib/discord-settings.ts`](../src/lib/discord-settings.ts) | Discord URL validation, independent environment fallback, and secret-free status | `tests/discord-settings.test.ts` |
| [`src/lib/connection-card.ts`](../src/lib/connection-card.ts) | Jellyfin/Whisparr editor lifecycle, busy state, save/removal flow, and separate draft/saved connection checks | `tests/connection-card.test.ts` |
| [`src/lib/provider-settings.ts`](../src/lib/provider-settings.ts) | TPDB/StashDB status and credential save/check/clear decisions | `tests/provider-settings.test.ts` |
| [`src/lib/credential-card.ts`](../src/lib/credential-card.ts) | TPDB/StashDB editor state, draft checks, rejected-key decisions, save flow, and editor markup | `tests/provider-card.test.ts` |
| [`src/lib/judgment-editor.ts`](../src/lib/judgment-editor.ts) | AI provider drafts, normalization, save/check outcomes, and available actions | `tests/judgment-editor.test.ts` |

[`src/components/settings-service.tsx`](../src/components/settings-service.tsx)
supplies all three tabs with the same heading/actions layout, status indicator,
editor focus return, configuration reads and saves, save feedback, check buttons,
confirmation dialogs, and the queue for saves and the checks after a save.
Checks on load and manual checks bypass that queue and do not disable other cards.
All three tabs use the same card, status, editor, and dropdown styles in
`src/app/globals.css`. The browser suites exercise these shared components through
each tab.

The UI composition follows the same structure for each tab:

- [`src/components/connection-settings.tsx`](../src/components/connection-settings.tsx)
  owns the Jellyfin and Whisparr cards and renders the Discord card from `discord-settings.tsx`.
- [`src/components/metadata-settings.tsx`](../src/components/metadata-settings.tsx)
  owns the TPDB and StashDB cards.
- [`src/components/ai-settings.tsx`](../src/components/ai-settings.tsx)
  owns the Smarter library matching and natural-language search cards.
- [`src/components/settings.tsx`](../src/components/settings.tsx) owns tab
  navigation and creates one shared operation queue for the three tab components.
  All three stay mounted when switching tabs so drafts and check results survive.

Service-specific rules remain in the library modules above: Connections validates
URLs and Whisparr delivery/mappings; metadata credentials support confirmed
clearing with environment fallback; the AI editor supports backend selection and
Ollama fields. The operator guides for [Connections](connections.md),
[Metadata providers](metadata-providers.md), and [AI](ai.md) describe these
behaviors.

## Test files and their scope

| File | Scope | Purpose |
| --- | --- | --- |
| `tests/ui/connections.spec.mjs` | Connections and cross-tab behavior | Browser cases for Jellyfin/Whisparr editors, draft probes, inline validation, dropdown spacing, and shared settings behavior |
| `tests/ui/metadata-providers.spec.mjs` | Metadata providers and cross-tab parity | Browser cases for TPDB, StashDB, TypeSafe, Ollama, draft probes, stored-key rejection, natural-language search settings, and matching card/status/action layout across the settings tabs |
| `tests/ui/discord.spec.mjs` | Discord settings | Browser cases for hidden webhook fields, independent title overrides, draft checks, late results, confirmed resets, and phone layout |
| `tests/ui/settings-fixture.mjs` | Shared by all three tabs | Starts the real production UI with isolated synthetic service responses; not a test suite |
| `tests/ui/settings-harness.mjs` | Shared by all three tabs | Resets state, supplies browser helpers, and checks page errors; not a test suite |
| `tests/connection-settings.test.ts` | Connections settings rules | Unit tests for connection drafts, patches, and validation |
| `tests/connection-card.test.ts` | Connections card lifecycle | Edit/Cancel, unchanged and invalid saves, persistence/probe ordering, failed saves and checks, permission failures, busy guards, and confirmed removal |
| `tests/api.test.ts` | All settings tabs and other application APIs | Server authorization, validation, persistence, and preservation of unrelated settings |
| `tests/provider-settings.test.ts` | Metadata settings rules | Credential save/check/clear decisions and status handling |
| `tests/settings-service.test.ts` | Shared settings rules | Common status labels, same-tick saves and checks after a save, and recovery after failures |
| `tests/provider-card.test.ts` | Metadata credential card lifecycle | TPDB/StashDB editor state, save flow, credential clearing, failed and forbidden saves, and editor markup |
| `tests/judgment-editor.test.ts`, `tests/ollama.test.ts`, `tests/integrations.test.ts` | AI editor and integrations | AI editor behavior, Ollama, upstream error classification, and integration requests |

Unit tests are organized at two levels for all three tabs. `connection-settings.test.ts`
and `provider-settings.test.ts` test settings rules. `connection-card.test.ts` and
`provider-card.test.ts` drive the real card lifecycle and save flow used by the UI;
the provider suite also renders its credential editor markup. The AI-assisted
matching card has its own lifecycle suite in `judgment-editor.test.ts`; the
natural-language search card's browser cases live in
`tests/ui/metadata-providers.spec.mjs`, and its draft logic has
`tests/prose-draft.test.ts` and `tests/prose-map.test.ts`. Browser tests cover the
actual rendered cards, focus, controls, and layout for all three tabs.

## Coverage map for the three settings tabs

| Covered behavior | Automated regression coverage |
| --- | --- |
| Draft tests use POST without saving, clear obsolete results on edits/Cancel, ignore late verdicts, and preserve the saved diagnosis | Connection/provider card unit tests; both settings browser suites; `tests/api.test.ts` |
| Proven stored provider-key rejection clears only the matching override; a replaced key or a rejection without a fingerprint never clears, and config refreshes cannot replay an old rejection | `tests/provider-card.test.ts`; `tests/ui/metadata-providers.spec.mjs`; API regressions |
| Inline field errors have accessible descriptions and clear on correction | `tests/connection-settings.test.ts`; `tests/ui/connections.spec.mjs` |
| Independent Jellyfin and Whisparr drafts, blank-key preservation, normalization, and validation | `tests/connection-settings.test.ts`; settings browser suite |
| Whisparr-only saves, preservation of Jellyfin/provider settings, failed validation, and removal | `tests/api.test.ts`; settings browser suite |
| Session, administrator, origin, and malformed-field guards on connection-only requests | `tests/api.test.ts` |
| Shared headings, button/status placement, unique IDs, live regions, sibling forms, one primary connection Save, deep-link focus, and editor focus entry/return | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| Save failures retain drafts; feedback stays beside Save/Cancel; successful saves remain distinct from failed probes | `tests/connection-card.test.ts`, `tests/provider-card.test.ts`, `tests/judgment-editor.test.ts`; both browser suites |
| Status cards remain mounted during loading, failure, retry, and saves | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| Saves and the checks after a save use one queue, drafts survive tab switches, and failures release the queue | `tests/settings-service.test.ts`; both settings browser suites |
| All four probes on load start in parallel, and a pending Jellyfin probe leaves TPDB Edit available | `tests/ui/connections.spec.mjs` |
| Existing provider error classification, AI normalization, and saved probe results survive the shared-component refactor | `tests/integrations.test.ts`, `tests/judgment-editor.test.ts`, `tests/provider-card.test.ts`; settings browser suite |
| First-time/manual Whisparr delivery settings, stale saved choices, path-mapping limits, and removal confirmation | Pure/API regressions; `tests/ui/connections.spec.mjs` |
| Both picker arrows retain their inset and text padding; editors fit mobile widths | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| TPDB and StashDB independent saves, blank-key behavior, peer drafts, failed saves/probes, and credential source | `tests/provider-card.test.ts`, `tests/provider-settings.test.ts`; `tests/ui/metadata-providers.spec.mjs` |
| Credential-clear confirmations and environment fallback for TPDB, StashDB, and TypeSafe | Provider/API regressions; `tests/ui/metadata-providers.spec.mjs` |
| Standard/no-AI selection, TypeSafe key preservation, Ollama validation, and confirmed AI environment reset | `tests/judgment-editor.test.ts`, `tests/ollama.test.ts`; `tests/ui/metadata-providers.spec.mjs` |
| Natural-language search On/Off, server/model validation, key preservation and confirmed clearing (post-save probing, disabled search, pending writes, and failed saves/checks), deep links, and operation ordering across tabs | `tests/api.test.ts`; `tests/ui/metadata-providers.spec.mjs` |
| Metadata loading/retry, pending checks, permission messages, focus, headings, forms, and mobile layout | `tests/ui/metadata-providers.spec.mjs` |

The integration suite also verifies that Jellyfin, Whisparr, and metadata status
checks convert only allowlisted upstream failures into connection feedback.
Local URL/configuration, storage/decryption, and unexpected errors keep their
original error boundary. Browser assertions measure failed-save feedback beside
Save/Cancel and before destructive actions in all three tabs, and verify that changing
AI fields clears an obsolete save error. Opening the AI editor or starting a new
save clears previous success feedback without dropping the saved diagnosis.

The browser fixture checks user interactions and request boundaries. It does not
substitute for server-side authorization/persistence tests or live Jellyfin,
Whisparr, and metadata-provider connectivity checks.
