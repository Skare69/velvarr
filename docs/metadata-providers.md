# Metadata provider settings

Administrators manage TPDB, StashDB, and AI-assisted matching in **Settings →
Metadata providers**. These cards share the layout, status indicators, and edit
controls used by [Connections](connections.md).

## TPDB and StashDB credentials

TPDB uses an **API token** for movie metadata; StashDB uses an **API key** for
scene metadata. Each card has its own editor and connection check.

1. Choose **Edit** and enter a replacement credential.
2. Choose **Save** to store it and check the saved credential.
3. Choose **Cancel** to discard the draft and retain the saved diagnosis.

Saving one card preserves drafts in the other cards. Stored credentials are
encrypted and take precedence over environment values. A blank edit preserves
an existing credential, with Save disabled until a replacement is entered. If
nothing is configured, a blank Save keeps the editor open and identifies the
missing field.

A replacement draft shows **Unsaved changes**. **Check connection** in the
editor tests that draft without saving; a blank field uses the saved credential
or environment fallback. Its result clears on a field change or Cancel and never
changes the saved diagnosis or deletes a key. A failed save retains the draft;
a failed saved check after a successful save appears separately from its notice.
Connected closed cards show **Edit**; a failed saved check offers a retry.

Status checks remain available when configuration loading fails, while editing
waits for a successful retry. Missing credentials show **Not configured**, an
open input, and a link to obtain a key. **From environment** identifies an
environment credential. Links from Discover open and focus the appropriate
provider card on this tab.

If a saved-credential check proves a stored TPDB or StashDB key was rejected as
unauthorized, Velvarr deletes that stored override and checks its environment
fallback. Automatic deletion requires a fingerprint from that saved-key check
that still matches the current stored key. If another tab replaced it, the
replacement remains saved and the card asks for another check. A rejection
without a fingerprint cannot delete anything. An environment key, a rejected
draft, an outage, a permission error,
or another inconclusive failure never triggers this deletion.

## Clear a stored credential

Choose **Clear stored credential** on a TPDB or StashDB card, or while editing
the TypeSafe key in the AI card. The
confirmation's **Keep credential** button leaves the saved value and draft
unchanged. **Clear credential** removes the stored override and uses the
corresponding environment value, if present:

- TPDB: `TPDB_API_TOKEN`
- StashDB: `STASHDB_API_KEY`
- TypeSafe: `TYPESAFE_API_KEY`

Clearing a TPDB or StashDB credential runs a fresh check of that fallback.
Environment credentials are not deleted by these controls. For the TypeSafe key
inside the AI card, use **Check connection** afterwards when a backend remains
configured.

## AI-assisted matching

Choose **Edit** and use the three provider buttons to select the desired mode:

- **Standard matching (no AI)** disables AI calls while preserving credentials
  and Ollama settings for later reuse.
- **TypeSafe** uses its API key. A blank key preserves the configured credential.
  AI Save still persists the selected mode and checks that saved configuration.
- **Ollama** requires a reachable URL and decision model. Only the selected
  backend's fields are shown.

Save checks configured TypeSafe or Ollama settings after they are persisted. A
failed check does not erase the successful save notice, and Edit/Cancel retains
the saved connection result. Standard matching and unconfigured backends do not
run an AI connection probe.

**Use environment settings** asks for confirmation before clearing the stored AI
provider, Ollama URL, and model overrides. **Keep AI settings** preserves the
current draft. The confirmed reset preserves provider credentials and takes the
AI selection from the environment; check that effective connection afterwards.

See [AI matching with Ollama](../README.md#ai-matching-with-ollama) for installation,
networking, tag-suggestion rules, and rollback guidance. AI suggestions continue
to require administrator review.
