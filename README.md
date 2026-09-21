# Velvarr

Standalone adult-media discovery and request app for a homelab stack: browse movies, scenes, performers, and studios from **TPDB** and **StashDB**; request them through **Whisparr** (Eros) with administrator approval; check per-user availability in **Jellyfin** and watch through a credential-free link.

## Status and evidence

Internal planning documents are maintained locally and are not published in the repository tree.

Runnable standalone application, deployed in the operator's homelab. Implemented and verified against real services (the installed Jellyfin 12.0.0, a live Whisparr 3.5 Eros instance, and authenticated TPDB/StashDB accounts), with a green test suite (223 node:test cases) and a CI pipeline including container smoke checks.

Proven end to end against the real stack (2026-09-12):

- **The full acquisition journey for both kinds.** An authorized TPDB movie and a StashDB scene each travelled provider detail → request → approval → Whisparr add → grab → import → exact Jellyfin match → `available` with a working, credential-free watch link. Stored identities stayed source-clean (`tpdbId`/`stashId` as UUIDs, `tmdbId: 0`, no cross-provider redirect).
- **The installed homelab Jellyfin.** Setup, per-user login, granted-library browsing, artwork proxy, availability, and watch links are verified against the real server, not a fixture.
- **Honest failure behavior.** A real Jellyfin outage produced `502 upstream_unavailable` and recovered without operator action; a deliberately wrong Whisparr key reports "Whisparr rejected the stored credentials" instead of signing the admin out; a scene with no indexer coverage stays truthfully in `monitoring`.

Not yet done, stated so nobody assumes otherwise:

- **M4 hardening** (systematic availability/privacy/recovery hazard coverage) and the **M6 formal cutover** checklist are open, even though the app already runs on the homelab NAS.
- **No removal has been executed against a real system.** The removal ladder is proven against loopback fixtures only and ships disabled.
- **Container behavior is verified in CI**, because the workstation has no container runtime; the NAS runs the image built there.
- **Neither provider publishes usage terms** covering third-party apps, artwork re-serving, caching, or rate limits. Nothing is cached; this remains an open operator question.

## What it does

Discovery is provider-backed: TPDB and StashDB catalogs for movies, scenes, performers, and studios, each with the filters and sort orders that provider actually supports (see the measured limits below), plus global search across both providers. Results are never merged across providers, and cross-provider identity is performer-level only, via explicit provider URLs. Discover shelves surface recent releases, bounded to titles released on or before today (UTC) and excluding records without a release date.

Movie and scene cards preload request and per-user library status after page load for the current bounded result set: 24 cards per catalog page by default, 12 per discovery carousel, and 6 per global-search media category. Two background checks run at a time; leaving the page cancels queued work and aborts active card reads. Hover or keyboard focus can check an unready card immediately, while preloaded cards offer their action without another status check.

Users file durable requests for movies and scenes. Administrators and moderators approve or decline; an account can also carry an auto-approve grant. Approval attaches shared acquisition work — one record per media identity per Whisparr instance — and a single worker dispatches it: every attempt is persisted before any network call, uncertain outcomes (timeout, 5xx, network error) are reconciled by exact identity before any second submission, and observations (monitoring, downloading, imported) are recorded. A crash or restart leaves recoverable evidence, never a lost or duplicated add.

Imported Jellyfin accounts see only the libraries an administrator granted them, with per-user availability and a credential-free watch link; links are invalidated when the underlying item is removed. An optional notifier posts to a private Discord webhook, identity-only by default. An operator-gated removal ladder lets granted accounts request removals; an approver with an elevated role and the removal grant chooses an explicit level, and every attempt lands in an insert-only audit log. The destructive path is off unless the operator flag and a per-account grant are both present.

In short:

- Provider-backed catalogs (TPDB, StashDB) for movies, scenes, performers, studios, with per-provider filters and sorting
- Global search across both providers
- Durable requests with administrator approval and an optional per-account auto-approve grant
- Shared acquisition worker with crash-safe attempt records and identity reconciliation
- Per-user Jellyfin availability with credential-free watch links
- Optional private Discord notifier (identity-only by default)
- Operator-gated removal ladder with approver-chosen levels and an insert-only audit log

### Measured provider limits

These are observed upstream behaviors, not design choices; the UI states them where they bite:

- StashDB has no movie entity at all; movies are TPDB-only. Scenes exist in both catalogs; results are never merged across providers.
- Cross-provider identity is performer-level only, via explicit provider URLs. There is no reliable scene-level cross-link, so an unlinked performer shows an explicit reason rather than a fabricated filmography.
- TPDB unfiltered and title-only-filtered listings report a fake `total: 10000` cap. A count is shown only when it is genuinely real; filtered queries do return real counts.
- TPDB sort offers relevance, release recency, and duration only — no trending or popularity order. StashDB scenes additionally offer title, date, duration, trending, popularity, created, and updated; trending and popularity are StashDB's own ordering.
- StashDB scene filters have no year criterion (date plus a modifier only, with no BETWEEN). TPDB has year and an exact-duration filter but no tag-exclusion parameter; StashDB supports include, include-all, and exclude.
- A StashDB studio may be a parent whose scenes live under child studios (Brazzers: 48 children, 0 direct scenes versus 14,658 with children), so including a parent is an explicit choice.
- TPDB `date_operation` accepts only the operator strings `<=`, `>=`, `<`, `>`, `=`; every word form is rejected upstream.

## Run it locally

Requires Node 24.21.0+ and Bun 1.3.14.

```sh
bun install
bun run setup    # writes .env.local with fresh secrets; never overwrites existing credentials
bun run dev      # http://127.0.0.1:6699
```

Production: `docker compose up -d` pulls the release image `ghcr.io/skare69/velvarr` (see compose.yaml; to build from source, uncomment `build: .`). The image runs the Next standalone server (`node server.js`), which is the supported path for this build's `output: "standalone"`; image build, readiness, non-root, restart, and no-secrets checks run in CI. `bun run build` then `bun run start` is a local preview only; Next prints a warning that `next start` is not the standalone entry point. Checks: `bun run check` (TypeScript strict), `bun run test` (node:test).

Releases: every milestone bumps `package.json` and the `compose.yaml` image tag, lands on `main`, and is tagged `vX.Y.Z`. Publication is opt-in — `gh workflow run ci.yml --ref vX.Y.Z -f publish=true` runs the gates and container checks first, then pushes `X.Y.Z`, `vX.Y.Z`, and `latest` to GHCR. Pulling a specific tag is the supported upgrade path; `docker compose pull && docker compose up -d` after bumping the tag in compose.yaml.

## Environment variables

`bun run setup` writes `VELVARR_SECRET_KEY` and `VELVARR_SETUP_SECRET` to the git-ignored `.env.local` (plus an optional `VELVARR_ORIGIN`). The container reads them from the environment at runtime only; no credential enters the image as a build argument, copied file, or layer.

### Generating the secrets

`bun run setup` generates both secrets and writes them to `.env.local`; it never overwrites an existing file. To write `.env.local` by hand (for example directly on the NAS host), generate the values first:

```sh
# VELVARR_SECRET_KEY — exactly 64 hex chars (32-byte AES-256 key)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
openssl rand -hex 32        # equivalent, if you prefer openssl

# VELVARR_SETUP_SECRET — at least 32 characters
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
openssl rand -base64 32
```

Back up `VELVARR_SECRET_KEY` (password manager, encrypted notes): losing it makes the stored database and every backup unreadable.

| Variable                     | Required         | Meaning                                                                                                                                                                                      |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VELVARR_SECRET_KEY`         | yes              | Exactly 64 hex characters (see [Generating the secrets](#generating-the-secrets)). Decrypts credentials stored in the database; losing it loses the stored data and every backup. Restores require the key from backup time. |
| `VELVARR_SETUP_SECRET`       | until bootstrap  | At least 32 characters (see [Generating the secrets](#generating-the-secrets)); gates the one-time owner setup.                                                                              |
| `VELVARR_ORIGIN`             | no               | Pin the public origin (e.g. behind a fixed reverse proxy). When set, mutations from a different `Origin` are refused. Unset (default), CSRF safety comes from the `HttpOnly` + `SameSite=Strict` session cookie alone, and the deployment needs no knowledge of its own address — same as Jellyfin/Seerr. |
| `VELVARR_DATA_DIR`           | no               | Data directory; default `./data`, `/data` in the container.                                                                                                                                   |
| `VELVARR_ALLOW_HTTP`         | no               | `1` allows plain HTTP on the LAN: private or Docker-network addresses as the Jellyfin/Whisparr base URL, and (with `VELVARR_ORIGIN` set) a plain-HTTP origin. Loopback is always allowed. |
| `VELVARR_ENABLE_REMOVAL`     | no               | `1` enables the removal ladder instance-wide. Off by default, and even when on, creating or approving removals additionally requires a per-account removal grant set by an administrator.      |
| `VELVARR_DISCORD_WEBHOOK_URL`| no               | Discord webhook for notifications; unset disables the notifier entirely. Only https `discord.com`/`discordapp.com` webhook URLs are accepted (plain http only for loopback, which is how the test fixture works), and the URL is never logged or embedded in errors. |
| `VELVARR_DISCORD_DETAIL`     | no               | `1` includes titles in notifications. Off by default: messages carry only the event kind and the media identity (provider/kind/external id), never titles or artwork.                          |
| `TYPESAFE_API_KEY`           | no               | [TypeSafe](https://typesafe.ai) API key enabling AI-assisted library matching. Without it (default), a Jellyfin item matches a requested record only by provider id, exact path, or exact normalized title. With it, a near-miss title (variant spelling, punctuation, subtitle) is judged "same work?" by the TypeSafe model — a confident yes only produces the **ambiguous — administrator review** verdict, never `available`. An outage or a missing key degrades to the exact matcher. |

## Backup and recovery

Take a consistent online backup:

```sh
bun run backup /backups/velvarr-2026-09-11.sqlite
```

The script snapshots the live database with SQLite `VACUUM INTO` (WAL included, so the copy is consistent while the app runs), verifies the snapshot with `PRAGMA quick_check`, refuses to overwrite an existing destination, and never stores or prints key material. It warns loudly if `VELVARR_SECRET_KEY` is not in the environment or `.env.local`, because a backup taken without knowing the key is unrecoverable.

To restore:

1. Start from a **fresh** data directory or volume. Never restore over a live data directory; there is deliberately no restore-overwrite command.
2. Copy the snapshot into that directory as `velvarr.sqlite` (`/data/velvarr.sqlite` in the container).
3. Start with the **same `VELVARR_SECRET_KEY`** as when the backup was taken. The key is never stored in the backup.

What then happens, each verified:

- **Wrong key:** startup fails with `secret_key_mismatch` — stored secrets cannot be decrypted with the configured key. The database is not modified; restoring again with the correct key works.
- **Failed migration:** each schema version runs inside its own transaction; a failure rolls that version back and startup refuses the database. The database stays at its previous version with all data intact — it is never half-migrated. Foreign or future databases (newer `user_version`) are refused without being touched.
- **Startup reconciliation:** a restored (or restarted) deployment does not blindly re-send anything. In-flight submissions flip from `submitting` to `uncertain`, every claim from the previous process dies, and the worker then reconciles by exact identity before any second submission: found means the real observation is recorded with no POST; provably absent means one fresh attempt; an unknown check (outage) means recheck later. In-flight removal attempts reconcile the same way — re-resolve by identity and compare the recorded facts before any retry.

## Cutover position

Velvarr is deployed **beside** the existing Seerr/Whisparr/Jellyfin stack: its own image (pulled from GHCR by compose), its own named volume (`velvarr-data`), and its own loopback port (`127.0.0.1:6699`). Nothing in this repository replaces, reconfigures, or touches the family's existing deployment. Changing the adult entry point is a deliberate operator decision, made by the operator, not performed or scheduled by this codebase.

Prerequisites that remain open before any cutover decision:

1. The authorized first Whisparr add (fixtures, root folder, quality profile nominated by the operator), without which acquisition-to-playback is unproven.
2. Proof against the installed homelab Jellyfin, not just the local lab instance.
3. The licence choice — there is no LICENSE file, and adding one is the operator's call.
4. The provider usage-terms question — nothing is cached until the operator decides what the providers' unpublished terms allow.

## Repository layout

| Reference               | Contents                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `main`                  | Clean standalone product root; no inherited Seerr application                       |
| `legacy/seerr-whisparr` | Seerr integration snapshot with squashed history; reference only                    |
| `upstream` remote       | [seerr-team/seerr](https://github.com/seerr-team/seerr); not a routine merge source |

A Seerr adaptation is possible, but its TMDB/movie/TV assumptions make the requested movie/scene/performer model an expensive fit. Velvarr has its own domain and storage.

## Local credentials

`.env*`, `config/`, `data/`, and `cache/` are ignored by Git. Old local Seerr configuration/database files must not become Velvarr's runtime data or enter an image. Keep secrets out of chat, commits, browser-exposed variables, and logs; the allowlist `.dockerignore` keeps secrets, Git history, and legacy/runtime state out of the build context.
