# Discord notification settings

## Goal

Add a Discord card under Settings → Connections. Administrators can change notification settings without a container restart.

Commit type: `feat(settings)`.

## Assumptions

- The title switch saves its own override, even without a stored webhook. A saved `false` overrides `VELVARR_DISCORD_DETAIL=1`.
- The webhook and title switch use separate environment fallbacks.
- Clear stored credential removes only the stored webhook. Use environment settings removes both stored overrides.
- Discord stays on the Connections tab. This task adds no tab.
- Secret handling requires human review before release under AGENTS.md section 2.

## Behavior

- The card uses the existing Settings service components, actions, status chip, icons, and confirmation dialog.
- A configured card starts closed with Edit. A missing webhook opens the editor.
- The editor has a labelled `type="url"` field and an Include titles switch with On or Off text.
- The field never displays the stored or environment webhook. A blank field preserves the current webhook.
- Save stores only fields that change. Cancel clears the draft and restores the effective title setting.
- The webhook comes from storage first, then `VELVARR_DISCORD_WEBHOOK_URL`.
- Include titles comes from storage first, then `VELVARR_DISCORD_DETAIL === "1"`, then false.
- The card shows From environment when the environment supplies a configured webhook.
- Clear stored credential stays in its own destructive row and requires confirmation.
- Use environment settings requires confirmation when it removes stored overrides.
- Save, clear, and environment reset verify the effective connection after the write.
- Check connection tests the typed webhook when present. Otherwise, it tests the effective webhook. A draft check stores nothing.
- Connection checks use GET. They never post channel messages. A failed check never clears a credential automatically.
- Notifications retain the acquired and available events, identity-only default, title limit, timeout, and best-effort delivery.
- Each notification resolves the current stored settings. A save needs no restart.

## Boundaries and errors

- Accept only HTTPS webhook URLs on `discord.com` or `discordapp.com`.
- Reject user info, non-default ports, query strings, fragments, and extra path segments.
- An absent webhook reports Not configured without an error. A configured invalid webhook reports a connection error.
- The full path must match `/api/webhooks/{numeric-id}/{token}`, with an optional final slash.
- Tokens use letters, digits, dot, underscore, or hyphen. The maximum URL length is 2048 characters.
- Production accepts no HTTP loopback exception. Tests intercept fetch for synthetic HTTPS Discord URLs.
- Both webhook requests disable redirects and use a five-second timeout.
- A check validates webhook info and returns only a sanitized status. It never returns Discord's response body.
- HTTP failures, network failures, timeouts, malformed responses, and invalid configuration return named errors without the URL or token.
- Existing admin admission, origin checks, CSRF checks, and request limits apply unchanged.
- The scheme and host accept mixed case. The path stays case-sensitive. The default HTTPS port `443` is valid.
- A Discord-only save needs no Jellyfin or Whisparr probe.
- Every existing integration save path preserves Discord settings.

## Contracts

The optional additive config field is:

```ts
discord?: { webhookUrl?: string; includeTitles?: boolean };
```

The existing encrypted config blob holds this field. No schema rewrite or new table is necessary. Old config blobs remain valid.

`src/lib/discord-settings.ts` exports:

```ts
parseDiscordWebhook(raw: string): URL | null;
resolveDiscordSettings(stored?: IntegrationConfig["discord"]): {
  webhookUrl: string;
  includeTitles: boolean;
};
discordConfiguration(stored?: IntegrationConfig["discord"]): DiscordSettingsInfo;
```

This module also exports these shared wire types:

```ts
type DiscordSettingsInfo = {
  configured: boolean;
  source: "stored" | "environment";
  includeTitles: boolean;
  includeTitlesSource: "stored" | "environment";
  stored: boolean;
};
type DiscordCheck = {
  configured: boolean;
  error?: { code: string; message: string };
};
```

`GET /api/admin/integrations` adds `discord: DiscordSettingsInfo`. PATCH responses add the same field. Neither response contains a webhook.

`PATCH /api/admin/integrations` adds:

- `discordWebhookUrl`: omitted preserves it, a non-empty string replaces it, and `""` removes its stored override.
- `discordIncludeTitles`: omitted preserves it, a boolean replaces it, and `null` removes its stored override.

`GET /api/admin/discord` checks the effective webhook and returns `DiscordCheck`.

`POST /api/admin/discord/test` accepts `{ webhookUrl?: string }`. A blank or omitted value checks the effective webhook. The response is `DiscordCheck`.

`src/server/notify.ts` exports `checkDiscordConnection(stored?: IntegrationConfig["discord"], override?: string): Promise<DiscordCheck>`. Its caller supplies the saved Discord config.

## Acceptance checks

- Tests prove independent precedence for the webhook and switch, including stored false over environment true.
- A storage test opens a config without Discord, saves the additive field, closes storage, and reads it again.
- The storage test checks that the database does not contain the plaintext webhook or token.
- API tests prove admin-only access, origin protection, validation, redaction, clear, reset, and preservation through other service saves.
- Fetch fixtures prove GET-only checks, no redirects, sanitized failures, no draft persistence, and current-settings notification delivery.
- A seeded property checks the URL acceptance boundary.
- Browser checks prove Edit, Save, Cancel, field validation, both switch states, connection checks, clear cancellation, clear confirmation, and environment reset.
- Desktop and phone screenshots show the actual Settings card and confirmation dialog. A fresh agent checks the screenshots without code context.
- Run `bun run format`, `bun run check`, `bun run test`, and `bun run build` before the commit.
- Mutation testing does not run on this work card.

## Non-goals

No new events, channels, queues, retries, notification previews, test messages, providers, dependencies, or environment changes.
