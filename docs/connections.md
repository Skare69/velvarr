# Connection settings

Administrators manage Jellyfin and Whisparr in **Settings → Connections**.
Each service uses the same compact cards and status indicators as **Metadata
providers**. See the [metadata providers guide](metadata-providers.md) for those
credentials and AI settings.

## Edit a connection

1. Choose **Edit** on Jellyfin or Whisparr.
2. Update that service's fields. Leave a configured API key blank to keep it.
3. Choose **Save**, or **Cancel** to discard the draft.

Each card saves independently. Saving one service preserves the other service's
settings and unsaved draft. A failed save keeps the editor and draft available
for correction or retry. If nothing changed, Save reports that without sending
an update.

**Check connection** tests saved settings. An edited connection shows **Unsaved
changes** until it is saved or cancelled, and checking is disabled for that draft.
Successful saves run a fresh check. A connection failure appears separately from
the successful save notice, so you can distinguish a saved change from a service
that cannot be reached. Connection checks remain available when configuration
loading fails; editing resumes after a successful retry.

## Jellyfin

- **Jellyfin URL** is the address Velvarr uses to reach the server.
- **Jellyfin external URL** is the address the browser uses for playback.
- **Jellyfin API key** authenticates Velvarr's connection.

Moving to another server origin requires its API key again. The configured
Jellyfin server identity and library grants stay unchanged; this editor does not
switch to a different Jellyfin server.

## Whisparr

Whisparr's editor contains its URL and API key, delivery controls, root folder,
quality profile, search-on-add choice, and path mappings. Moving to a different
server origin requires its API key again.

The connection check supplies available root folders and named quality
profiles. Saved choices remain available even when they are absent from the
latest response. Manual fields are available when no choices are known.

Delivery can be paused while keeping existing delivery settings. Each path
mapping needs both a Whisparr prefix and a Jellyfin prefix; wholly blank rows are
ignored when saving.

**Remove connection** asks for confirmation before removing the saved Whisparr
URL, credential, delivery settings, and path mappings. Choose **Keep connection**
to return to the editor without changing anything.
