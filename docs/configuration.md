# Configuration

Put the variables in `.env.local`.

| Variable                      | Required        | Meaning |
| ----------------------------- | --------------- | ------- |
| `VELVARR_SECRET_KEY`          | yes             | 64 hex characters. Decrypts the credentials in the database. A restore needs the key from the time of the backup. |
| `VELVARR_SETUP_SECRET`        | until bootstrap | 32 characters or more. Gates the one-time owner setup. |
| `VELVARR_ORIGIN`              | no              | The public origin, for example behind a reverse proxy. Velvarr refuses changes from other origins. An `https:` origin marks the session cookie `Secure`. On plain HTTP, only a loopback address needs no flag; a private IP, a `.local` name, or a dotless name needs `VELVARR_ALLOW_HTTP=1`. |
| `VELVARR_DATA_DIR`            | no              | Data directory. Default `./data`, and `/data` in the container. |
| `VELVARR_ALLOW_HTTP`          | no              | `1` allows plain HTTP to private and Docker-network addresses. |
| `VELVARR_DISCORD_WEBHOOK_URL` | no              | Private Discord webhook (https only). |
| `VELVARR_DISCORD_DETAIL`      | no              | `1` adds titles to notifications. By default, messages contain only identities. |
| `VELVARR_WHISPARR_LIBRARY_LIMIT_MIB` | no      | Maximum size in MiB of the Whisparr library list (`/api/v3/movie`), as decoded JSON. A whole number from 2 to 256. Default 32, about 5,000 titles. Increase it for a larger library. An invalid value stops the Whisparr path lookups with `bad_whisparr_config`. |
| `TPDB_API_TOKEN`              | no              | TPDB token for calls made without a token saved in Settings. A saved token wins. |
| `STASHDB_API_KEY`             | no              | StashDB key for calls made without a key saved in Settings. A saved key wins. |
| `TPDB_BASE_URL`               | no              | TPDB API root override. Default `https://api.theporndb.net`. |
| `STASHDB_BASE_URL`            | no              | StashDB API root override. Default `https://stashdb.org`. |
| `TYPESAFE_BASE_URL`           | no              | TypeSafe cloud API root override. Unset uses the TypeSafe default. |
| `TYPESAFE_DEFAULT_MODEL`      | no              | TypeSafe decision model override. Unset uses the TypeSafe default. |
| `TYPESAFE_API_KEY`            | no              | TypeSafe key for AI-assisted matching. A key saved in Settings wins. Tag suggestions need a key saved in Settings. |
| `VELVARR_JUDGMENT_PROVIDER`   | no              | `typesafe` (default), `ollama`, or `none` to disable AI. A choice saved in Settings wins. Tag suggestions need a choice saved in Settings. |
| `OLLAMA_BASE_URL`             | no              | Ollama API root. Default `http://localhost:11434`. |
| `OLLAMA_MODEL`                | no              | Ollama decision model. Default `nimble`. |
| `VELVARR_UPDATE_CHECK`        | no              | `0` disables the release check. Otherwise, the server asks `api.github.com` at most once an hour after a success and at most once a minute while it fails (a 403/429 `retry-after` or `x-ratelimit-reset` extends the wait); while a check fails, the last known answer stays up. |

Unless `VELVARR_ORIGIN` is `https:`, the cookie is `Secure` only when the proxy sends `X-Forwarded-Proto: https` or the request URL is https. On each change request, a supplied `Sec-Fetch-Site` header must say `same-origin`, and a request that sends a body or a `Content-Type` header must send `application/json`.

When `VELVARR_ORIGIN` is not set and a change request has no `Sec-Fetch-Site` header, the request must send an `Origin` header that names the host that receives the request (`Host` or `X-Forwarded-Host`). A request with neither header fails with `origin_missing`, as it does when `VELVARR_ORIGIN` is set. Browsers on plain-HTTP LAN addresses send no `Sec-Fetch-Site` header, but current browsers send `Origin` on each change request. This rule stops other apps on the same host from changing data, for example to sign you out.

A reverse proxy that rewrites the `Host` header (the nginx `proxy_pass` default) makes each change request fail with `origin_mismatch`. Forward the host that the browsers use. Set `proxy_set_header Host $host;` in the proxy location, or send an `X-Forwarded-Host` header. With the original host forwarded, changes work without a Velvarr setting.

Alternatively, set `VELVARR_ORIGIN` to the origin that you browse. On plain HTTP, Velvarr accepts that pin only for a loopback address without a flag, or for a private IP, a `.local` name, or a dotless name with `VELVARR_ALLOW_HTTP=1`. A dotted name such as `velvarr.lan` fails with `unsafe_origin`.

Browsers send a cookie to all ports of a host. Thus another app on the same host can set a second `velvarr_session` cookie. When a request has more than one `velvarr_session` cookie, Velvarr uses none of them and asks you to sign in. If Velvarr asks you to sign in again after each sign-in, clear the cookies for the host in your browser.

Each failed sign-in writes one log line: `[auth] failed sign-in attempt: account="<name>" ip="<address>"`. The log never contains the password. The address is the first `X-Forwarded-For` entry, or `unknown`. A client can set this header. Trust the address only when your proxy replaces the header.

After 5 wrong passwords for one name in 5 minutes, Velvarr refuses new sign-ins for that name until the 5 minutes end. A browser that signed in correctly before has a known-device cookie (`velvarr_device`, valid for 30 days, sent only to `/api/login`). That browser has its own limit of 5 wrong passwords, so wrong passwords from other clients do not block it. Open sessions continue to work.
