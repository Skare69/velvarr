<p align="center">
  <img alt="Velvarr banner" src=".github/assets/banner.jpg" width="100%"/>
</p>

<h1 align="center">Velvarr – The discovery and request app for adult media</h1>

<p align="center">
  <a href="https://github.com/Skare69/velvarr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/skare69/velvarr/actions/workflows/ci.yml/badge.svg"/></a>
  <a href="https://bun.sh"><img alt="Package manager: Bun" src="https://img.shields.io/badge/package%20manager-Bun-000000?logo=bun&logoColor=white"/></a>
  <a href="https://nodejs.org"><img alt="Runtime: Node.js 24" src="https://img.shields.io/badge/runtime-Node.js%2024-339933?logo=node.js&logoColor=white"/></a>
  <a href="https://nextjs.org"><img alt="Next.js version" src="https://img.shields.io/github/package-json/dependency-version/Skare69/velvarr/next?label=Next.js&logo=nextdotjs&logoColor=white&color=000000"/></a>
  <a href="https://react.dev"><img alt="React version" src="https://img.shields.io/github/package-json/dependency-version/Skare69/velvarr/react?label=React&logo=react&logoColor=white&color=61dafb"/></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript version" src="https://img.shields.io/github/package-json/dependency-version/Skare69/velvarr/dev/typescript?label=TypeScript&logo=typescript&logoColor=white&color=3178c6"/></a>
  <a href="https://github.com/Skare69/velvarr/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/Skare69/velvarr?logo=github"/></a>
</p>
<p align="center">
  <a href="https://github.com/ottr-ai/ottr"><img src="https://raw.githubusercontent.com/ottr-ai/ottr/main/.github/assets/built-with-ottr.png" alt="Built with Ottr"></a>
</p>

---

**Velvarr** is a free and open source discovery and request app for adult media. Browse movies, scenes, performers, and studios from [TPDB](https://theporndb.net) and [StashDB](https://stashdb.org), request them into **[Whisparr](https://whisparr.com)** (Eros) with administrator approval, and watch in **[Jellyfin](https://jellyfin.org)** through a credential-free link.

## Getting started

Docker is the recommended way to run Velvarr. It uses [`compose.yaml`](compose.yaml) and the image `ghcr.io/skare69/velvarr`.

1. Get the compose file.
2. Create `.env.local` with the operator secrets. Without it, you cannot create the owner account.
3. Start the container and open http://127.0.0.1:6699.

**Linux and macOS:**

```sh
mkdir velvarr && cd velvarr
curl -fsSLO https://raw.githubusercontent.com/Skare69/velvarr/main/compose.yaml
printf 'VELVARR_SECRET_KEY=%s\nVELVARR_SETUP_SECRET=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" > .env.local
docker compose up -d
```

**Windows (PowerShell):**

```powershell
mkdir velvarr; cd velvarr
Invoke-WebRequest https://raw.githubusercontent.com/Skare69/velvarr/main/compose.yaml -OutFile compose.yaml -UseBasicParsing
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$k = [byte[]]::new(32); $s = [byte[]]::new(32); $rng.GetBytes($k); $rng.GetBytes($s)
$key = -join ($k | ForEach-Object { $_.ToString('x2') })
$setup = [Convert]::ToBase64String($s).TrimEnd('=').Replace('+', '-').Replace('/', '_')
Set-Content .env.local "VELVARR_SECRET_KEY=$key`nVELVARR_SETUP_SECRET=$setup" -Encoding ascii
docker compose up -d
```

> [!IMPORTANT]
> Back up `VELVARR_SECRET_KEY`. If you lose it, you cannot read the database or any backup.

On the first visit, enter `VELVARR_SETUP_SECRET` as the setup secret to create the owner account.

**Upgrade:** set the new image tag in `compose.yaml`, then run `docker compose pull && docker compose up -d`.

**Health:** the container health check reads `/api/status`. If the container is `unhealthy`, Velvarr cannot open `/data`. Run `docker compose logs velvarr` to see the cause.

## Development

Requires Node 24.21+ and Bun 1.3.14+. The commands are the same on Linux, macOS, and Windows.

```sh
git clone https://github.com/Skare69/velvarr.git && cd velvarr
bun install
bun run setup   # writes .env.local with fresh secrets; never overwrites it
bun run dev     # http://127.0.0.1:6699
```

Checks before a commit:

```sh
bun run format && bun run check && bun run test && bun run build
```

## Features

- **Catalogs:** movies (TPDB), scenes (TPDB and StashDB), performers, and studios, with the filters and sort orders that each provider supports.
- **Browse:** one grid for TPDB movies and StashDB scenes, with search, tag include and exclude, studio, performer, and date filters. The URL holds every filter.
- **Search, Studios, and Genres** across both providers. Velvarr never merges results across providers. Cross-provider identity comes only from links that the providers publish.
- **Requests** with administrator or moderator approval, and an optional auto-approve grant for each account.
- **Crash-safe acquisition into Whisparr:** Velvarr records each attempt before the network call, so a restart never loses or duplicates an add.
- **Jellyfin availability** for each user, and watch links without credentials.
- **Performer follows** across both providers, with a Following view and a Discover rail.
- **Preferences:** hidden tags and Discover shelf order for each account.
- **Similar titles** for movies and scenes, and **Often appears with** for performers.
- **Update notice** when a newer GitHub release is available.
- **Optional:** Discord notifications, and AI-assisted title matching through [TypeSafe](https://typesafe.ai) or a local [Ollama](#local-ai-matching-with-ollama) decision model. AI only flags a near match for administrator review. It never marks a title as available.

## Configuration

Put the variables in `.env.local`.

| Variable                      | Required        | Meaning |
| ----------------------------- | --------------- | ------- |
| `VELVARR_SECRET_KEY`          | yes             | 64 hex characters. Decrypts the credentials in the database. A restore needs the key from the time of the backup. |
| `VELVARR_SETUP_SECRET`        | until bootstrap | 32 characters or more. Gates the one-time owner setup. |
| `VELVARR_ORIGIN`              | no              | The public origin, for example behind a reverse proxy. Velvarr refuses changes from other origins. An `https:` origin marks the session cookie `Secure`. |
| `VELVARR_DATA_DIR`            | no              | Data directory. Default `./data`, and `/data` in the container. |
| `VELVARR_ALLOW_HTTP`          | no              | `1` allows plain HTTP to private and Docker-network addresses. |
| `VELVARR_DISCORD_WEBHOOK_URL` | no              | Private Discord webhook (https only). |
| `VELVARR_DISCORD_DETAIL`      | no              | `1` adds titles to notifications. By default, messages contain only identities. |
| `TYPESAFE_API_KEY`            | no              | TypeSafe key for AI-assisted matching. A key saved in Settings wins. Tag suggestions need a key saved in Settings. |
| `VELVARR_JUDGMENT_PROVIDER`   | no              | `typesafe` (default) or `ollama`. A choice saved in Settings wins. Tag suggestions need a choice saved in Settings. |
| `OLLAMA_BASE_URL`             | no              | Ollama API root. Default `http://localhost:11434`. |
| `OLLAMA_MODEL`                | no              | Ollama decision model. Default `nimble`. |
| `VELVARR_UPDATE_CHECK`        | no              | `0` disables the release check. Otherwise, the server asks `api.github.com` at most once an hour. |

Unless `VELVARR_ORIGIN` is `https:`, the cookie is `Secure` only when the proxy sends `X-Forwarded-Proto: https` or the request URL is https. Each change request must also send `Sec-Fetch-Site: same-origin` and a JSON content type.

Each failed sign-in writes one log line: `[auth] failed sign-in attempt: account="<name>" ip="<address>"`. The log never contains the password. The address is the first `X-Forwarded-For` entry, or `unknown`. A client can set this header. Trust the address only when your proxy replaces the header.

## Phone access

Velvarr is an installable app, but the install prompt needs HTTPS. [Tailscale](https://tailscale.com) gives you HTTPS with little work:

1. In the Tailscale admin console, enable MagicDNS and HTTPS certificates.
2. On the Velvarr machine, run `tailscale serve --bg 6699`.
3. On the phone, open `https://<machine>.<tailnet>.ts.net` and select **Add to home screen**.

- If `VELVARR_ORIGIN` holds a different address, phone sign-in fails with `origin_mismatch`. Set it to the ts.net address or remove it. Only one origin can be set.
- The service worker caches only build assets, never `/api` or live data. It registers only on HTTPS or loopback, and never in development builds.

## Local AI matching with Ollama

Use Ollama 0.35 or later with a decision model such as `nimble` or `tev1`. Chat models do not support the `/v1/systemone` endpoint.

```sh
ollama pull nimble
```

1. Open **Settings → Metadata providers → AI-assisted matching** and select **Ollama (local)**.
2. Enter the Ollama URL and the model name from `ollama list`, then save.
3. Select **Test saved connection**.

Ollama URL:

- Velvarr runs natively on the same machine: `http://localhost:11434`.
- Velvarr runs in Docker Desktop: `http://host.docker.internal:11434`, and set `VELVARR_ALLOW_HTTP=1`.
- Ollama runs on a different host: use its private address. See the [Ollama network guide](https://docs.ollama.com/faq#how-do-i-configure-ollama-server).

Ollama never falls back to the paid TypeSafe service. If the connection fails, matching stays exact. You can also use the `VELVARR_JUDGMENT_PROVIDER`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL` variables. Test some real title variants before you select a model.

## Backup and recovery

```sh
bun run backup /backups/velvarr.sqlite   # consistent online snapshot; refuses to overwrite
```

To restore, copy the snapshot as `velvarr.sqlite` into a new, empty data directory. Start Velvarr with the same `VELVARR_SECRET_KEY` as at backup time. The backup does not contain the key.

## Repository layout

| Branch / remote         | Contents |
| ----------------------- | -------- |
| `main`                  | The standalone product, without Seerr application code |
| `legacy/seerr-whisparr` | Seerr integration snapshot, for reference only |
| `upstream`              | [seerr-team/seerr](https://github.com/seerr-team/seerr), not a merge source |

## License

Licensed under the [MIT License](LICENSE).
