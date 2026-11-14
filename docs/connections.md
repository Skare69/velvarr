# Connection settings

Administrators manage Jellyfin and Whisparr in **Settings → Connections**.
Each service uses the same compact cards and status indicators as **Metadata
providers**. See the [metadata providers guide](metadata-providers.md) for those
credentials and AI settings.

## Edit a connection

1. Choose **Edit** on Jellyfin or Whisparr.
2. Update that service's fields. Leave a configured API key blank to keep it.
3. Choose **Save**, or **Cancel** to discard the draft.

Each card saves independently. When both editors are open, Jellyfin has the
primary Save action; Whisparr becomes primary after Jellyfin closes. Saving one service preserves the other service's
settings and unsaved draft. A failed save keeps the editor and draft available
for correction or retry. If nothing changed, Save reports that without sending
an update.

**Check connection** in an open editor tests the values on screen without
saving them. A blank API key uses the saved credential. The draft's result
appears below the actions and clears when the draft changes or closes. Late
responses for an older draft are ignored. The
status beside the title still describes the saved connection; an edited draft
shows **Unsaved changes** until it is saved or cancelled.

Successful saves run a fresh check of persisted settings. A connection failure
appears separately from the successful save notice. Connected closed cards show
**Edit**; a failed saved check also offers **Check connection** to retry. Checks
remain available when configuration loading fails, while editing waits for a
successful configuration retry. Field validation appears beside the invalid
control; server save errors appear beside Save and Cancel.

When Whisparr is not configured, its editor stays open for setup. Add a URL and
API key before saving; Cancel becomes available after the connection is saved.

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
