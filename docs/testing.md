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

## Settings browser regressions

The same Playwright suite covers **Connections** and **Metadata providers**.
`tests/ui/connections.spec.mjs` covers connections and cross-tab behavior;
`tests/ui/metadata-providers.spec.mjs` covers the credential and AI editors. Both
reuse the same isolated fixture and test harness, and both run in the existing
CI gate.

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
modules. Connections uses the new draft and card-lifecycle modules. Metadata
providers reuses its existing credential and AI modules from `main`.

| Source | Role | Direct unit tests |
| --- | --- | --- |
| [`src/lib/settings-service.ts`](../src/lib/settings-service.ts) | Shared status wording, failure type, and settings operation queue | `tests/settings-service.test.ts` |
| [`src/lib/connection-settings.ts`](../src/lib/connection-settings.ts) | Jellyfin/Whisparr draft initialization, change detection, field validation, and service-only save patches | `tests/connection-settings.test.ts` |
| [`src/lib/connection-card.ts`](../src/lib/connection-card.ts) | Jellyfin/Whisparr editor lifecycle, busy state, save/removal flow, and connection checks | `tests/connection-card.test.ts` |
| [`src/lib/provider-settings.ts`](../src/lib/provider-settings.ts) | TPDB/StashDB status and credential save/check/clear decisions | `tests/provider-settings.test.ts` |
| [`src/lib/credential-card.ts`](../src/lib/credential-card.ts) | TPDB/StashDB editor state, save flow, and editor markup | `tests/provider-card.test.ts` |
| [`src/lib/judgment-editor.ts`](../src/lib/judgment-editor.ts) | AI provider drafts, normalization, save/check outcomes, and available actions | `tests/judgment-editor.test.ts` |

[`src/components/settings-service.tsx`](../src/components/settings-service.tsx)
supplies both tabs with the same heading/actions layout, status indicator,
editor focus return, configuration loading/saving, save feedback, check buttons,
confirmation dialogs, and the settings-wide save/check queue. Both tabs also use
the same card, status, editor, and dropdown styles in `src/app/globals.css`.
The browser suites exercise these shared components through each tab.

The UI composition follows the same structure for each tab:

- [`src/components/connection-settings.tsx`](../src/components/connection-settings.tsx)
  owns the Jellyfin and Whisparr cards.
- [`src/components/metadata-settings.tsx`](../src/components/metadata-settings.tsx)
  owns the TPDB, StashDB, and AI-assisted matching cards.
- [`src/components/settings.tsx`](../src/components/settings.tsx) owns tab
  navigation and creates one shared operation queue for both tab components.
  Both stay mounted when switching tabs so drafts and check results survive.

Service-specific rules remain in the library modules above: Connections validates
URLs and Whisparr delivery/mappings; metadata credentials support confirmed
clearing with environment fallback; the AI editor supports backend selection and
Ollama fields. The operator guides for [Connections](connections.md) and
[Metadata providers](metadata-providers.md) describe these behaviors.

## Test files and their scope

| File | Scope | Purpose |
| --- | --- | --- |
| `tests/ui/connections.spec.mjs` | Connections and cross-tab behavior | 21 browser cases for Jellyfin/Whisparr editors, dropdown spacing, and shared settings behavior |
| `tests/ui/metadata-providers.spec.mjs` | Metadata providers and cross-tab parity | 20 browser cases for TPDB, StashDB, TypeSafe, Ollama, and matching card/status/action layout across both tabs |
| `tests/ui/settings-fixture.mjs` | Shared by both tabs | Starts the real production UI with isolated synthetic service responses; not a test suite |
| `tests/ui/settings-harness.mjs` | Shared by both tabs | Resets state, supplies browser helpers, and checks page errors; not a test suite |
| `tests/connection-settings.test.ts` | Connections settings rules | Unit tests for connection drafts, patches, and validation |
| `tests/connection-card.test.ts` | Connections card lifecycle | Edit/Cancel, unchanged and invalid saves, persistence/probe ordering, failed saves and checks, permission failures, busy guards, and confirmed removal |
| `tests/api.test.ts` | Both tabs and other application APIs | Server authorization, validation, persistence, and preservation of unrelated settings |
| `tests/provider-settings.test.ts` | Metadata settings rules | Credential save/check/clear decisions and status handling |
| `tests/settings-service.test.ts` | Shared settings rules | Common status labels, same-tick save/probe ordering, and recovery after failures |
| `tests/provider-card.test.ts` | Metadata credential card lifecycle | TPDB/StashDB editor state, save flow, credential clearing, failed and forbidden saves, and editor markup |
| `tests/judgment-editor.test.ts`, `tests/ollama.test.ts`, `tests/integrations.test.ts` | Metadata providers and integrations | AI editor behavior, Ollama, upstream error classification, and integration requests |

Unit tests are organized at two levels for both tabs. `connection-settings.test.ts`
and `provider-settings.test.ts` test settings rules. `connection-card.test.ts` and
`provider-card.test.ts` drive the real card lifecycle and save flow used by the UI;
the provider suite also renders its credential editor markup. The AI card has
its own lifecycle suite in `judgment-editor.test.ts`. Browser tests cover the
actual rendered cards, focus, controls, and layout for both tabs.

## Coverage map for both settings tabs

| Covered behavior | Automated regression coverage |
| --- | --- |
| Independent Jellyfin and Whisparr drafts, blank-key preservation, normalization, and validation | `tests/connection-settings.test.ts`; settings browser suite |
| Whisparr-only saves, preservation of Jellyfin/provider settings, failed validation, and removal | `tests/api.test.ts`; settings browser suite |
| Session, administrator, origin, and malformed-field guards on connection-only requests | `tests/api.test.ts` |
| Shared headings, button/status placement, unique IDs, live regions, sibling forms, and focus entry/return | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| Save failures retain drafts; feedback stays beside Save/Cancel; successful saves remain distinct from failed probes | `tests/connection-card.test.ts`, `tests/provider-card.test.ts`, `tests/judgment-editor.test.ts`; both browser suites |
| Status cards remain mounted during loading, failure, retry, and saves | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| Settings-wide save/probe ordering, drafts surviving tab switches, and recovery after failure | `tests/settings-service.test.ts`; both settings browser suites |
| Existing provider error classification, AI normalization, and saved probe results survive the shared-component refactor | `tests/integrations.test.ts`, `tests/judgment-editor.test.ts`, `tests/provider-card.test.ts`; settings browser suite |
| First-time/manual Whisparr delivery settings, stale saved choices, path-mapping limits, and removal confirmation | Pure/API regressions; `tests/ui/connections.spec.mjs` |
| Both picker arrows retain their inset and text padding; editors fit mobile widths | `tests/ui/connections.spec.mjs`, `tests/ui/metadata-providers.spec.mjs` |
| TPDB and StashDB independent saves, blank-key behavior, peer drafts, failed saves/probes, and credential source | `tests/provider-card.test.ts`, `tests/provider-settings.test.ts`; `tests/ui/metadata-providers.spec.mjs` |
| Credential-clear confirmations and environment fallback for TPDB, StashDB, and TypeSafe | Provider/API regressions; `tests/ui/metadata-providers.spec.mjs` |
| Standard/no-AI selection, TypeSafe key preservation, Ollama validation, and confirmed AI environment reset | `tests/judgment-editor.test.ts`, `tests/ollama.test.ts`; `tests/ui/metadata-providers.spec.mjs` |
| Metadata loading/retry, pending checks, permission messages, focus, headings, forms, and mobile layout | `tests/ui/metadata-providers.spec.mjs` |

The integration suite also verifies that Jellyfin, Whisparr, and metadata status
checks convert only allowlisted upstream failures into connection feedback.
Local URL/configuration, storage/decryption, and unexpected errors keep their
original error boundary. Browser assertions measure failed-save feedback beside
Save/Cancel and before destructive actions in both tabs, and verify that changing
AI fields clears an obsolete save error. Opening the AI editor or starting a new
save clears previous success feedback without dropping the saved diagnosis.

The browser fixture checks user interactions and request boundaries. It does not
substitute for server-side authorization/persistence tests or live Jellyfin,
Whisparr, and metadata-provider connectivity checks.
