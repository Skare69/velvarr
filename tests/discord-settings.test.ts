import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fc from "fast-check";
import "./setup.ts";
import {
  discordConfiguration,
  parseDiscordWebhook,
  resolveDiscordSettings,
} from "../src/lib/discord-settings.ts";

const webhook = "https://discord.com/api/webhooks/123/synthetic-token";
const originalUrl = process.env.VELVARR_DISCORD_WEBHOOK_URL;
const originalDetail = process.env.VELVARR_DISCORD_DETAIL;
afterEach(() => {
  if (originalUrl === undefined) delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  else process.env.VELVARR_DISCORD_WEBHOOK_URL = originalUrl;
  if (originalDetail === undefined) delete process.env.VELVARR_DISCORD_DETAIL;
  else process.env.VELVARR_DISCORD_DETAIL = originalDetail;
});

test("official exact webhook endpoints only", () => {
  for (const host of ["discord.com", "discordapp.com"]) {
    assert.ok(
      parseDiscordWebhook(
        `https://${host}/api/webhooks/123/synthetic._-token/`,
      ),
    );
    assert.ok(
      parseDiscordWebhook(
        `https://${host}:443/api/webhooks/123/synthetic._-token/`,
      ),
    );
    assert.ok(
      parseDiscordWebhook(
        `HTTPS://${host.toUpperCase()}/api/webhooks/123/Synthetic`,
      ),
    );
    assert.equal(
      parseDiscordWebhook(`https://${host}/API/webhooks/123/Synthetic`),
      null,
    );
  }
  for (const raw of [
    "http://127.0.0.1/api/webhooks/123/token",
    "https://discord.com/api/Webhooks/123/synthetic-token",
    "https://discord.com/api/WEBHOOKS/123/synthetic-token",
    webhook + "/extra",
    webhook + "?x=1",
    webhook + "#fragment",
    webhook + "?",
    webhook + "#",
    webhook.replace("123", "abc"),
    webhook.replace("discord.com", "discord.com.evil.test"),
    webhook.replace("discord.com", "user@discord.com"),
    webhook.replace("discord.com", "discord.com:444"),
    webhook.replace("/123/", "/1/../123/"),
    webhook.replace("synthetic", "%73ynthetic"),
    " " + webhook,
    webhook + "\n",
    webhook + "a".repeat(2048),
  ])
    assert.equal(parseDiscordWebhook(raw), null, raw);
  const prefix = "https://discord.com/api/webhooks/1/";
  assert.ok(parseDiscordWebhook(prefix + "a".repeat(2048 - prefix.length)));
});

test("webhook tokens reject URL dot segments but retain other dot tokens", () => {
  const prefix = "https://discord.com/api/webhooks/123/";
  for (const token of [".", ".."]) {
    assert.equal(parseDiscordWebhook(prefix + token), null);
    assert.equal(parseDiscordWebhook(prefix + token + "/"), null);
  }
  for (const token of ["...", ".synthetic", "synthetic."]) {
    const raw = prefix + token;
    assert.equal(parseDiscordWebhook(raw)?.href, raw);
  }
});

test("an empty stored webhook disables only the webhook environment fallback", () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = webhook;
  process.env.VELVARR_DISCORD_DETAIL = "1";
  assert.deepEqual(resolveDiscordSettings({ webhookUrl: "" }), {
    webhookUrl: "",
    includeTitles: true,
  });
  assert.deepEqual(discordConfiguration({ webhookUrl: "" }), {
    configured: false,
    source: "stored",
    includeTitles: true,
    includeTitlesSource: "environment",
    stored: true,
  });
  delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  delete process.env.VELVARR_DISCORD_DETAIL;
  assert.deepEqual(resolveDiscordSettings(), {
    webhookUrl: "",
    includeTitles: false,
  });
});

test("old config and independent stored overrides remain secret-free", () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = webhook;
  process.env.VELVARR_DISCORD_DETAIL = "1";
  assert.deepEqual(resolveDiscordSettings(), {
    webhookUrl: webhook,
    includeTitles: true,
  });
  assert.deepEqual(resolveDiscordSettings({ includeTitles: false }), {
    webhookUrl: webhook,
    includeTitles: false,
  });
  const summary = discordConfiguration({ includeTitles: false });
  assert.deepEqual(summary, {
    configured: true,
    source: "environment",
    includeTitles: false,
    includeTitlesSource: "stored",
    stored: true,
  });
  assert.ok(!JSON.stringify(summary).includes(webhook));
  delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  assert.equal(discordConfiguration().configured, false);
});

test("URL acceptance agrees with the strict raw boundary", () => {
  const valid = fc
    .tuple(
      fc.constantFrom("discord.com", "discordapp.com"),
      fc.integer({ min: 0 }),
      fc.array(fc.constantFrom(..."abcXYZ019._-"), {
        minLength: 1,
        maxLength: 80,
      }),
      fc.boolean(),
    )
    .map(
      ([host, id, token, slash]) =>
        `https://${host}/api/webhooks/${id}/${token.join("")}${slash ? "/" : ""}`,
    );
  fc.assert(
    fc.property(fc.oneof(fc.string(), valid), (raw) => {
      const expected =
        raw.length <= 2048 &&
        /^https:\/\/(discord\.com|discordapp\.com)(?::443)?\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/i.test(
          raw,
        ) &&
        /\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/.test(raw) &&
        !/[\r\n]/.test(raw) &&
        !/\/\.{1,2}\/?$/.test(raw);
      assert.equal(parseDiscordWebhook(raw) !== null, expected);
    }),
  );
});

test("each stored field overrides only its own environment field", () => {
  fc.assert(
    fc.property(
      fc.option(fc.boolean(), { nil: undefined }),
      fc.boolean(),
      fc.boolean(),
      (savedTitle, envTitle, savedUrl) => {
        process.env.VELVARR_DISCORD_WEBHOOK_URL = webhook;
        process.env.VELVARR_DISCORD_DETAIL = envTitle ? "1" : "0";
        const stored = {
          includeTitles: savedTitle,
          ...(savedUrl ? { webhookUrl: webhook + "-stored" } : {}),
        };
        const resolved = resolveDiscordSettings(stored);
        assert.equal(resolved.includeTitles, savedTitle ?? envTitle);
        assert.equal(
          resolved.webhookUrl,
          savedUrl ? webhook + "-stored" : webhook,
        );
        const info = discordConfiguration(stored);
        assert.equal(info.source, savedUrl ? "stored" : "environment");
        assert.equal(
          info.includeTitlesSource,
          savedTitle === undefined ? "environment" : "stored",
        );
        assert.ok(!JSON.stringify(info).includes("synthetic-token"));
      },
    ),
  );
});
