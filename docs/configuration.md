# Configuration

Put the variables in `.env.local`.

| Variable                      | Required        | Meaning |
| ----------------------------- | --------------- | ------- |
| `VELVARR_SECRET_KEY`          | yes             | 64 hex characters. Decrypts the credentials in the database. A restore needs the key from the time of the backup. |
| `VELVARR_SETUP_SECRET`        | until bootstrap | 32 characters or more. Gates the one-time owner setup. |
| `VELVARR_ORIGIN`              | no              | The public origin, for example behind a reverse proxy. Velvarr refuses changes from other origins. An `https:` origin marks the session cookie `Secure`. On plain HTTP, only a loopback address needs no flag; a private IP, a `.local` name, or a dotless name needs `VELVARR_ALLOW_HTTP=1`. |
| `VELVARR_DATA_DIR`            | no              | Data directory. Default `./data`, and `/data` in the container. |
| `VELVARR_ALLOW_HTTP`          | no              | `1` allows plain HTTP to private and Docker-network addresses. |
| `VELVARR_TRUSTED_PROXY`       | no              | `1` marks the nearest reverse proxy as one that appends to `X-Forwarded-For` (nginx `proxy_add_x_forwarded_for`). The setup attempt limiter then keys on the last header entry, the client address the proxy vouched for, so a spoofed-header flood can no longer deny setup. Without it, every setup attempt keys on one shared limiter bucket, whatever headers it sends: a flood stays bounded but can deny setup attempts for up to one five-minute window. |
| `VELVARR_DISCORD_WEBHOOK_URL` | no              | Fallback Discord webhook URL. A saved webhook wins. See [Discord notifications](#discord-notifications). |
| `VELVARR_DISCORD_DETAIL`      | no              | Fallback for Include titles. `1` adds titles. A saved switch value wins, including Off. Default messages contain only identities. |
| `VELVARR_WHISPARR_LIBRARY_LIMIT_MIB` | no      | Maximum size in MiB of the Whisparr library list (`/api/v3/movie`), as decoded JSON. A whole number from 2 to 256. Default 32, about 5,000 titles. Increase it for a larger library. An invalid value stops the Whisparr path lookups with `bad_whisparr_config`. |
| `TPDB_API_TOKEN`              | no              | TPDB token for calls made without a token saved in Settings. A saved token wins. |
| `STASHDB_API_KEY`             | no              | StashDB key for calls made without a key saved in Settings. A saved key wins. |
| `TPDB_BASE_URL`               | no              | TPDB API root override. Default `https://api.theporndb.net`. |
| `STASHDB_BASE_URL`            | no              | StashDB API root override. Default `https://stashdb.org`. |
| `TYPESAFE_BASE_URL`           | no              | TypeSafe cloud API root override. Unset uses the TypeSafe default. |
| `TYPESAFE_DEFAULT_MODEL`      | no              | TypeSafe decision model override. Unset uses the TypeSafe default. |
| `TYPESAFE_API_KEY`            | no              | TypeSafe key for Smarter library matching. A key saved in Settings wins. Tag suggestions need a key saved in Settings. |
| `VELVARR_JUDGMENT_PROVIDER`   | no              | `typesafe` (default), `ollama`, or `none` to disable this card's AI calls. A choice saved in Settings wins. Tag suggestions need a saved TypeSafe key or a saved Ollama choice in Settings. |
| `OLLAMA_BASE_URL`             | no              | Ollama API root. Default `http://localhost:11434`. |
| `OLLAMA_MODEL`                | no              | Ollama decision model. Default `nimble`. |
| `VELVARR_UPDATE_CHECK`        | no              | `0` disables the release check. Otherwise, the server asks `api.github.com` at most once an hour after a success and at most once a minute while it fails (a 403/429 `retry-after` or `x-ratelimit-reset` extends the wait); while a check fails, the last known answer stays up. |

Unless `VELVARR_ORIGIN` is `https:`, the cookie is `Secure` only when the proxy sends `X-Forwarded-Proto: https` or the request URL is https. On each change request, a supplied `Sec-Fetch-Site` header must say `same-origin`, and a request that sends a body or a `Content-Type` header must send `application/json`.

When `VELVARR_ORIGIN` is not set and a change request has no `Sec-Fetch-Site` header, the request must send an `Origin` header that names the host that receives the request (`Host` or `X-Forwarded-Host`). A request with neither header fails with `origin_missing`, as it does when `VELVARR_ORIGIN` is set. Browsers on plain-HTTP LAN addresses send no `Sec-Fetch-Site` header, but current browsers send `Origin` on each change request. This rule stops other apps on the same host from changing data, for example to sign you out.

A reverse proxy that rewrites the `Host` header (the nginx `proxy_pass` default) makes each change request fail with `origin_mismatch`. Forward the host that the browsers use. Set `proxy_set_header Host $host;` in the proxy location, or send an `X-Forwarded-Host` header. With the original host forwarded, changes work without a Velvarr setting.

Alternatively, set `VELVARR_ORIGIN` to the origin that you browse. On plain HTTP, Velvarr accepts that pin only for a loopback address without a flag, or for a private IP, a `.local` name, or a dotless name with `VELVARR_ALLOW_HTTP=1`. A dotted name such as `velvarr.lan` fails with `unsafe_origin`.

Browsers send a cookie to all ports of a host. Thus another app on the same host can set a second `velvarr_session` cookie. For authentication, Velvarr rejects requests with more than one `velvarr_session` cookie. Sign out revokes all session values from the cookie header. If Velvarr asks you to sign in again after each sign-in, clear the cookies for the host in your browser.

Each failed sign-in writes one log line: `[auth] failed sign-in attempt: account="<name>" ip="<address>"`. The log never contains the password. The address is the first `X-Forwarded-For` entry, or `unknown`. A client can set this header. Trust the address only when your proxy replaces the header.

After 5 wrong passwords for one name in 5 minutes, Velvarr refuses new sign-ins for that name until the 5 minutes end. A browser that signed in correctly before has a known-device cookie (`velvarr_device`, valid for 30 days, sent only to `/api/login`). That browser has its own limit of 5 wrong passwords, so wrong passwords from other clients do not block it. Open sessions continue to work.

## Discord notifications

Open Settings → Connections → Discord as an administrator. Save changes without a restart.
Velvarr encrypts the saved webhook in its database. The URL field never shows a saved or environment webhook.
After a save, the field stays blank. A blank field preserves the current webhook.

Include titles defaults to Off, so notifications contain only identities.
Each field uses its own saved value before its environment fallback:

- The webhook uses the saved URL, then `VELVARR_DISCORD_WEBHOOK_URL`.
- Include titles uses the saved switch value, then `VELVARR_DISCORD_DETAIL`. Only `1` enables titles through the environment.
- A saved Off overrides `VELVARR_DISCORD_DETAIL=1`. You can save the switch without a saved webhook.

Clear stored credential requires confirmation. It removes only the saved webhook, so the environment webhook applies if present.
It does not change Include titles.
Use environment settings clears both saved overrides after confirmation. Each field then uses its environment fallback.

Other integration saves preserve these choices, even when a Jellyfin connection check delays a save.

Check connection checks the typed URL, or the effective webhook if the field is blank.
It saves no draft changes. Checks use only GET requests to Discord and never post visible channel messages.
Save, clear, and environment reset also check the effective connection.
A failed check never clears the webhook.

Use an HTTPS URL on `discord.com` or `discordapp.com`.
The path must match `/api/webhooks/{numeric-id}/{token}`, with an optional final slash.
The token accepts only letters, digits, dots, underscores, and hyphens.
The URL must not exceed 2048 characters.
Velvarr rejects user info, non-default ports, query strings, fragments, and extra path segments.
Plain HTTP and loopback URLs do not qualify, even with `VELVARR_ALLOW_HTTP=1`.
Discord requests disable redirects and use a five-second timeout.
