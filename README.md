# Velvarr

[![CI](https://github.com/skare69/velvarr/actions/workflows/ci.yml/badge.svg)](https://github.com/skare69/velvarr/actions/workflows/ci.yml)

**Velvarr** is a free and open source discovery and request app for adult media. Browse movies, scenes, performers, and studios from [TPDB](https://theporndb.net) and [StashDB](https://stashdb.org), request them into **[Whisparr](https://whisparr.com)** (Eros) with administrator approval, and watch in **[Jellyfin](https://jellyfin.org)** through a credential-free link.

## Features

- **Provider-backed catalogs** — movies (TPDB), scenes (TPDB + StashDB), performers, and studios, each with the filters and sort orders that provider actually supports
- **One Browse surface** — TPDB movies and StashDB scenes in a single grid with title search, tag include/exclude, studio, performer, year, and date filters; every constraint rides in the URL
- **Global search** across both providers, plus unified **Studios** and **Genres** rails; results are never merged across providers and cross-provider identity comes only from links the providers publish — never name matching
- **Durable requests** with administrator or moderator approval and an optional per-account auto-approve grant
- **Crash-safe acquisition worker** — every attempt is persisted before any network call and reconciled by exact identity after a restart; never a lost or duplicated add
- **Per-user Jellyfin availability** and credential-free watch links
- **Personal preferences** — per-account hidden tags and Discover shelf ordering
- **Similar titles** on movies and scenes (shared published tags) and **Often appears with** on performers (co-appearance)
- **Optional Discord notifier** posting to a private webhook, identity-only by default
- **Optional removal ladder** (ships disabled) with approver-chosen levels and an insert-only audit log
- **Optional AI-assisted matching** via [TypeSafe](https://typesafe.ai) — a near-miss Jellyfin title is flagged "ambiguous — administrator review", never auto-`available`; without a key, matching is exact

## Getting started

**Docker** (recommended):

```sh
docker compose up -d   # pulls ghcr.io/skare69/velvarr
```

To upgrade, bump the image tag in `compose.yaml`, then `docker compose pull && docker compose up -d`.

**From source** (Node 24.21+, Bun 1.3.14+):

```sh
bun install
bun run setup   # writes .env.local with fresh secrets; never overwrites existing credentials
bun run dev     # http://127.0.0.1:6699
```

## Configuration

`bun run setup` generates the required secrets. **Back up `VELVARR_SECRET_KEY`**: losing it makes the stored database and every backup unreadable.

| Variable                     | Required         | Meaning                                                                             |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `VELVARR_SECRET_KEY`         | yes              | 64 hex chars; decrypts credentials stored in the database. Restores need the key from backup time. |
| `VELVARR_SETUP_SECRET`       | until bootstrap  | ≥ 32 characters; gates the one-time owner setup.                                     |
| `VELVARR_ORIGIN`             | no               | Pin the public origin (e.g. behind a reverse proxy); mutations from other origins are refused. Unset, CSRF safety comes from the `HttpOnly` + `SameSite=Strict` session cookie alone. |
| `VELVARR_DATA_DIR`           | no               | Data directory; default `./data`, `/data` in the container.                          |
| `VELVARR_ALLOW_HTTP`         | no               | `1` allows plain HTTP for private/Docker-network addresses on the LAN.               |
| `VELVARR_ENABLE_REMOVAL`     | no               | `1` enables the removal ladder instance-wide; per-account grants are still required. |
| `VELVARR_DISCORD_WEBHOOK_URL`| no               | Private Discord webhook for notifications; https only.                               |
| `VELVARR_DISCORD_DETAIL`     | no               | `1` includes titles in notifications; off by default, messages stay identity-only.   |
| `TYPESAFE_API_KEY`           | no               | Enables AI-assisted Jellyfin matching; a key saved in Settings → Metadata providers takes precedence. |

## Backup and recovery

```sh
bun run backup /backups/velvarr.sqlite   # consistent online snapshot; refuses to overwrite
```

To restore: start from a **fresh** data directory, copy the snapshot in as `velvarr.sqlite`, and start with the **same `VELVARR_SECRET_KEY`** as when the backup was taken. The key is never stored in the backup.

## Repository layout

| Branch / remote         | Contents                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `main`                  | Clean standalone product; no inherited Seerr application         |
| `legacy/seerr-whisparr` | Seerr integration snapshot; reference only                       |
| `upstream`              | [seerr-team/seerr](https://github.com/seerr-team/seerr); not a merge source |

No LICENSE file yet — that choice belongs to the operator.
