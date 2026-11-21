# AI matching and natural-language search

## Smarter library matching

The **Smarter library matching** card compares requested titles with differently named titles in your Jellyfin library.
AI flags possible matches for administrator review only.
AI never marks a title as available.
When both titles have known years, different years prevent a match.
AI also sorts similar titles on detail pages and suggests up to three real provider tags for search terms.

Titles and catalog details go to the selected AI service for matching and similar-title sorting.
Tag suggestions also send member search terms after you save the TypeSafe key or Ollama choice in Settings.
Environment-only settings permit title review and similar-title sorting, but not tag suggestions.
Hosted TypeSafe is a third party.
A local Ollama server keeps this data on your network.
A remote Ollama server receives the data at the URL you set.

Select **Exact names only** to match only exact names, without calls to an AI service.
Natural-language search has its own card.
**Exact names only** does not turn it off.

## AI matching with Ollama

Use Ollama 0.35 or later with a decision model such as `nimble` or `tev1`. Chat models do not support the `/v1/systemone` endpoint.

```sh
ollama pull nimble
```

1. Open **Settings → AI → Smarter library matching**.
   Click **Edit**.
   Select **Ollama**.
2. Enter a reachable Ollama URL and the model name from `ollama list`, then **Save**. Saving checks the connection and shows **Connected** or **Connection failed** with details.
3. Use **Check connection** to test again.

Ollama can run on the same machine or a hosted server reachable from Velvarr. Example URLs:

- Velvarr runs natively on the same machine: `http://localhost:11434`.
- Velvarr runs in Docker Desktop: `http://host.docker.internal:11434`, and set `VELVARR_ALLOW_HTTP=1`.
- Ollama runs on a different host: use its private address. See the [Ollama network guide](https://docs.ollama.com/faq#how-do-i-configure-ollama-server).

Ollama never uses the paid TypeSafe service as a fallback.
If the connection fails, matching stays exact.
You can also use the `VELVARR_JUDGMENT_PROVIDER`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL` variables.
**Use environment settings** asks for confirmation and then clears the stored provider selection, URL, and model.
The confirmed reset keeps provider credentials and takes the AI selection from the environment.

Environment-only Ollama supports title review and similar-title sorting.
Tag suggestions send member search terms, so they start only after you save the Ollama choice in Settings.
Test some real title variants before you select a model.

Select **Exact names only**.
Select **Save** to disable this card's AI calls even when TypeSafe credentials or Ollama settings are present.
Velvarr preserves the settings for later reuse.
A blank TypeSafe key preserves the configured credential.
TypeSafe configuration also checks its connection after a save.
A failed check does not erase the successful save notice.

**Rollback:** The stored `none` choice requires a build that supports it. Before rolling back to v0.40.0 or earlier, select **Use environment settings**, confirm `VELVARR_JUDGMENT_PROVIDER` is `typesafe` or `ollama` (or unset), and back up the configuration. Older builds do not recognize `none`; do not assume AI stays disabled after a rollback.

## Natural-language search

Members can describe a search in plain words on Browse, for example "Vixen scenes from 2019, newest first". Velvarr sends the text to an OpenAI-compatible chat server, and the server writes a draft of the filters. Velvarr checks each tag, performer, and studio against TPDB and StashDB, applies the filters that match, and lists each part that it did not apply, with the reason. The search replaces the current filters. The browser **Back** button restores them.

1. Open **Settings → AI → Natural-language search**, click **Edit**, and select **On**.
2. Enter the server URL, the model name, and an API key if the server needs one, then click **Save**. Saving checks the connection and shows **Connected** or **Connection failed** with the cause. The saved check reads the server's model information only: **Connected** means that the server accepted the key and serves this model. On Anthropic, the check reads the model entry itself, so an alias such as `claude-sonnet-4-5` passes. On other servers, a model without a tag matches the listed `name:latest` entry, so `llama3.2` passes when the server lists `llama3.2:latest`. It cannot prove that the model returns valid filter drafts. A member search reports that.
3. Use **Check connection** to test again.

While you edit, the card lists the model names that the server reports for the typed URL; a list that fails to load leaves the field free text. The check before Save is free: Velvarr reads the server's model information and confirms your model, and sends no chat request, so no tokens are billed.

Except for the Anthropic URL, the server must support the Chat Completions API with a `json_schema` response format. Example URLs:

- Anthropic: `https://api.anthropic.com/v1`.
- OpenAI: `https://api.openai.com/v1`.
- Ollama on the same machine: `http://localhost:11434/v1`.
- LM Studio on the same machine: `http://localhost:1234/v1`.

For the Anthropic URL, Velvarr uses the native Anthropic Messages API, not the Chat Completions API. The Anthropic OpenAI compatibility layer does not support prompt caching. Velvarr marks the search instructions for the 5-minute Anthropic prompt cache. Repeated searches within 5 minutes then read the instructions from the cache, at lower input cost and with less delay. The results do not change. Each model has a minimum prompt length for the cache. A shorter prompt runs without the cache and gives no error.

Plain HTTP works for loopback addresses. For a private address or `host.docker.internal`, set `VELVARR_ALLOW_HTTP=1`.

Administrators can always use natural-language search. Other accounts need the grant: open **Users**, edit the account, and under **Natural-language search**, select **Can describe searches in plain words**. A grant change signs that account out.

- Member search text goes to the server that you set. A hosted server can be a third party.
- Hosted models can refuse adult text. The search then fails with a message that says so. A local model, for example in Ollama or LM Studio, has no hosted content filter.
- Natural-language search has its own card, separate from **Smarter library matching**.
  **Exact names only** does not turn it off.
- The stored API key stays bound to the origin of the server URL. When you move the URL to a different origin, enter the key again.
- Velvarr never shows the stored API key. When the server repeats the key in an error message, the connection check shows `[redacted]` in its place. This also applies to each part of the key with 8 or more characters. A search reply that repeats the key fails with an error.
- **Off** disables natural-language searches and keeps the URL, the model, and the key for later use.
- **Clear stored credential** asks for confirmation before it deletes the key; requests then go without a key. Saving or confirming the clear checks the saved connection when the server stays configured.
