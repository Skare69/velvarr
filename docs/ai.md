# AI matching and natural-language search

## AI matching with Ollama

Use Ollama 0.35 or later with a decision model such as `nimble` or `tev1`. Chat models do not support the `/v1/systemone` endpoint.

```sh
ollama pull nimble
```

1. Open **Settings → Metadata providers → AI-assisted matching**, click **Edit**, and select **Ollama**.
2. Enter a reachable Ollama URL and the model name from `ollama list`, then **Save**. Saving checks the connection and shows **Connected** or **Connection failed** with details.
3. Use **Check connection** to test again.

Ollama can run on the same machine or a hosted server reachable from Velvarr. Example URLs:

- Velvarr runs natively on the same machine: `http://localhost:11434`.
- Velvarr runs in Docker Desktop: `http://host.docker.internal:11434`, and set `VELVARR_ALLOW_HTTP=1`.
- Ollama runs on a different host: use its private address. See the [Ollama network guide](https://docs.ollama.com/faq#how-do-i-configure-ollama-server).

Ollama never falls back to the paid TypeSafe service. If the connection fails, matching stays exact. You can also use the `VELVARR_JUDGMENT_PROVIDER`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL` variables. **Use environment settings** clears the stored provider selection, URL, and model. Environment-only Ollama supports title review and related-title ranking; tag suggestions send member search terms, so they start only after the Ollama choice is saved in Settings. Test some real title variants before you select a model.

Select **Standard matching (no AI)** and **Save** to disable AI calls even when TypeSafe credentials or Ollama settings are present. The settings are preserved for later reuse. TypeSafe configuration also checks its connection after saving.

**Rollback:** The stored `none` choice requires a build that supports it. Before rolling back to v0.40.0 or earlier, select **Use environment settings**, confirm `VELVARR_JUDGMENT_PROVIDER` is `typesafe` or `ollama` (or unset), and back up the configuration. Older builds do not recognize `none`; do not assume AI stays disabled after a rollback.

## Natural-language search

Members can describe a search in plain words on Browse, for example "Vixen scenes from 2019, newest first". Velvarr sends the text to an OpenAI-compatible chat server, and the server writes a draft of the filters. Velvarr checks each tag, performer, and studio against TPDB and StashDB, applies the filters that match, and lists each part that it did not apply, with the reason. The search replaces the current filters. The browser **Back** button restores them.

1. Open **Settings → Metadata providers → Natural-language search**, click **Edit**, and select **On**.
2. Enter the server URL, the model name, and an API key if the server needs one, then click **Save**. Saving checks the connection and shows **Connected** or **Connection failed** with the cause.
3. Use **Check connection** to test again.

The server must support the Chat Completions API with a `json_schema` response format. Example URLs:

- OpenAI: `https://api.openai.com/v1`.
- Ollama on the same machine: `http://localhost:11434/v1`.
- LM Studio on the same machine: `http://localhost:1234/v1`.

Plain HTTP works for loopback addresses. For a private address or `host.docker.internal`, set `VELVARR_ALLOW_HTTP=1`.

Administrators can always use natural-language search. Other accounts need the grant: open **Users**, edit the account, and under **Natural-language search**, select **Can describe searches in plain words**. A grant change signs that account out.

- Member search text goes to the server that you set. A hosted server can be a third party.
- Hosted models can refuse adult text. The search then fails with a message that says so. A local model, for example in Ollama or LM Studio, has no hosted content filter.
- This switch is separate from AI-assisted matching. **Standard matching (no AI)** does not turn off natural-language search.
- The stored API key stays bound to the origin of the server URL. When you move the URL to a different origin, enter the key again.
- Velvarr never shows the stored API key. When the server repeats the key in an error message, the connection check shows `[redacted]` in its place. This also applies to each part of the key with 8 or more characters. A search reply that repeats the key fails with an error.
- **Off** keeps the URL, the model, and the key for later use.
