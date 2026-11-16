# Install

Docker is the recommended way to run Velvarr. It uses [`compose.yaml`](../compose.yaml) and the image `ghcr.io/skare69/velvarr`.

## Docker Compose

1. Get the compose file.
2. Create `.env.local` with the operator secrets. Without it, you cannot create the owner account.
3. Start the container and open http://127.0.0.1:6699.

**Linux and macOS:**

```sh
mkdir velvarr && cd velvarr
curl -fsSLO https://raw.githubusercontent.com/Skare69/velvarr/main/compose.yaml
touch .env.local && chmod 600 .env.local   # owner-only: the file holds the database key
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

**Health:** the container health check reads `/api/status`. If the container is `unhealthy`, `/api/status` failed: Velvarr cannot open `/data`, or the database file is not a Velvarr database or was written by a newer version. Run `docker compose logs velvarr` to see the cause.

## Phone access

Velvarr is an installable app, but the install prompt needs HTTPS. [Tailscale](https://tailscale.com) gives you HTTPS with little work:

1. In the Tailscale admin console, enable MagicDNS and HTTPS certificates.
2. On the Velvarr machine, run `tailscale serve --bg 6699`.
3. On the phone, open `https://<machine>.<tailnet>.ts.net` and select **Add to home screen**.

- If `VELVARR_ORIGIN` holds a different address, phone sign-in fails with `origin_mismatch`. Set it to the ts.net address or remove it. Only one origin can be set.
- The service worker caches only build assets, never `/api` or live data. It registers only on HTTPS or loopback, and never in development builds.

Every variable is in [configuration.md](configuration.md).
