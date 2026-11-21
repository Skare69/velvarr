// Synthetic HTTPS fetch interception only. No Discord request reaches the network.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import "./setup.ts";
import {
  checkDiscordConnection,
  notifyRequestEvent,
} from "../src/server/notify.ts";
import {
  bootstrap,
  closeStorage,
  getConfig,
  isInitialized,
  saveConfig,
} from "../src/server/storage.ts";
import type { IntegrationConfig } from "../src/lib/contracts.ts";

const WEBHOOK =
  "https://discord.com/api/webhooks/1234567890/synthetic-notify-token";
const STORED =
  "https://discordapp.com/api/webhooks/1234567890/synthetic-stored-token";
const EVENT = {
  kind: "acquired" as const,
  media: { provider: "tpdb", kind: "movie", id: "fixture-id" },
  title: "Private Scene Title",
};
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalUrl = process.env.VELVARR_DISCORD_WEBHOOK_URL;
const originalDetail = process.env.VELVARR_DISCORD_DETAIL;
const originalSecretKey = process.env.VELVARR_SECRET_KEY;
const calls: { url: string; init: RequestInit }[] = [];
const logs: string[] = [];
let handler: (init: RequestInit) => Promise<Response>;
const config: IntegrationConfig = {
  jellyfin: {
    url: "http://127.0.0.1:8096",
    externalUrl: "https://media.example.org",
    apiKey: "synthetic-jellyfin-key",
    serverId: "0123456789abcdef0123456789abcdef",
    libraryIds: [],
  },
};
beforeEach(() => {
  calls.length = 0;
  logs.length = 0;
  delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  delete process.env.VELVARR_DISCORD_DETAIL;
  // Synthetic encryption material for this isolated test database only.
  process.env.VELVARR_SECRET_KEY = "33".repeat(32);
  if (isInitialized()) saveConfig(config);
  else
    bootstrap(
      config,
      {
        id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        name: "Synthetic Owner",
        isDisabled: false,
        enableRemoteAccess: true,
        enableMediaPlayback: true,
        isAdministrator: true,
      },
      "synthetic-owner-token",
    );
  assert.deepEqual(getConfig(), config);
  console.warn = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  handler = async () => new Response(null, { status: 204 });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    assert.ok(
      [WEBHOOK, STORED].includes(url),
      "Unexpected destination must never reach a real network",
    );
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    calls.push({ url, init });
    return handler(init);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  if (originalUrl === undefined) delete process.env.VELVARR_DISCORD_WEBHOOK_URL;
  else process.env.VELVARR_DISCORD_WEBHOOK_URL = originalUrl;
  if (originalDetail === undefined) delete process.env.VELVARR_DISCORD_DETAIL;
  else process.env.VELVARR_DISCORD_DETAIL = originalDetail;
  assert.ok(!logs.join(" ").includes("synthetic-"));
  assert.ok(!logs.join(" ").includes("https://"));
});
after(() => {
  closeStorage();
  if (originalSecretKey === undefined) delete process.env.VELVARR_SECRET_KEY;
  else process.env.VELVARR_SECRET_KEY = originalSecretKey;
});

function body(index = 0) {
  const call = calls[index];
  assert.ok(call, `Expected captured call at index ${index}`);
  return JSON.parse(String(call.init.body));
}

test("absent config is silent and bad local URLs never fetch", async () => {
  await notifyRequestEvent(EVENT);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, []);
  for (const raw of [
    "http://127.0.0.1/api/webhooks/123/token",
    WEBHOOK + "/extra",
    "https://evil.example/api/webhooks/123/token",
  ]) {
    process.env.VELVARR_DISCORD_WEBHOOK_URL = raw;
    await notifyRequestEvent(EVENT);
    const result = await checkDiscordConnection();
    assert.equal(result.error?.code, "invalid_config");
    assert.ok(!JSON.stringify(result).includes(raw));
  }
  assert.equal(calls.length, 0);
});

test("identity-only notification preserves both event contracts", async () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
  for (const kind of ["acquired", "available"] as const)
    await notifyRequestEvent({ ...EVENT, kind });
  assert.equal(calls.length, 2);
  const firstCall = calls[0];
  assert.ok(firstCall, "Expected the first notification request");
  assert.equal(firstCall.init.method, "POST");
  assert.deepEqual(body(), {
    content: "Velvarr acquired: movie tpdb/fixture-id",
  });
  assert.deepEqual(body(1), {
    content: "Velvarr available: movie tpdb/fixture-id",
  });
});

test("title mode caps title at 256 and omits absent titles", async () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
  process.env.VELVARR_DISCORD_DETAIL = "1";
  await notifyRequestEvent({ ...EVENT, title: "x".repeat(300) });
  await notifyRequestEvent({ ...EVENT, title: undefined });
  assert.deepEqual(body(), {
    embeds: [
      {
        title: "x".repeat(256),
        description: "Velvarr acquired: movie tpdb/fixture-id",
      },
    ],
  });
  assert.deepEqual(body(1), {
    embeds: [{ description: "Velvarr acquired: movie tpdb/fixture-id" }],
  });
});

test("each event reads the current save and false overrides environment true", async () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
  process.env.VELVARR_DISCORD_DETAIL = "1";
  await notifyRequestEvent(EVENT);
  saveConfig({
    ...config,
    discord: { webhookUrl: STORED, includeTitles: false },
  });
  await notifyRequestEvent(EVENT);
  saveConfig({ ...config, discord: { includeTitles: false } });
  await notifyRequestEvent(EVENT);
  assert.deepEqual(
    calls.map((call) => call.url),
    [WEBHOOK, STORED, WEBHOOK],
  );
  assert.equal(body().embeds[0].title, EVENT.title);
  assert.equal(body(1).content, "Velvarr acquired: movie tpdb/fixture-id");
  assert.ok(!("embeds" in body(2)));
});

test("GET checks saved, draft and fallback without persistence or visible messages", async () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
  handler = async () =>
    Response.json({
      id: "1234567890",
      type: 1,
      channel_id: "999",
      token: "synthetic-response-secret",
    });
  const saved = { webhookUrl: STORED, includeTitles: false };
  const before = getConfig();
  assert.deepEqual(await checkDiscordConnection(saved), { configured: true });
  assert.deepEqual(await checkDiscordConnection(saved, WEBHOOK), {
    configured: true,
  });
  assert.deepEqual(await checkDiscordConnection(undefined, ""), {
    configured: true,
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [STORED, WEBHOOK, WEBHOOK],
  );
  assert.ok(
    calls.every(
      (call) => call.init.method === "GET" && call.init.body === undefined,
    ),
  );
  assert.deepEqual(getConfig(), before);
});

test("checks reject missing config, HTTP failures, malformed and oversized webhook info", async () => {
  assert.deepEqual(await checkDiscordConnection(), { configured: false });
  for (const response of [
    new Response("synthetic-response-secret", { status: 401 }),
    new Response("not JSON"),
    Response.json({ id: "wrong", type: 1, channel_id: "999" }),
    Response.json({ id: "1234567890", type: 2, channel_id: "999" }),
    Response.json({ id: "1234567890", type: 1 }),
    new Response("x".repeat(65_537)),
  ]) {
    handler = async () => response;
    const result = await checkDiscordConnection(undefined, WEBHOOK);
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes("synthetic"));
    assert.ok(!JSON.stringify(result).includes(WEBHOOK));
  }
});

test("HTTP and URL-containing network errors cannot escape notifier or check status", async () => {
  process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
  handler = async () => new Response("private upstream body", { status: 500 });
  await notifyRequestEvent(EVENT);
  assert.equal(
    (await checkDiscordConnection()).error?.code,
    "discord_http_error",
  );
  handler = async () => {
    throw new Error(`Failed to fetch ${WEBHOOK}`);
  };
  await notifyRequestEvent(EVENT);
  assert.deepEqual(await checkDiscordConnection(), {
    configured: true,
    error: {
      code: "discord_unreachable",
      message: "The Discord connection failed.",
    },
  });
});

test(
  "five-second abort bounds notification and check requests",
  { timeout: 15_000 },
  async () => {
    process.env.VELVARR_DISCORD_WEBHOOK_URL = WEBHOOK;
    handler = async (init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
      return promise;
    };
    const start = Date.now();
    // Native AbortSignal.timeout uses an unref timer outside node:test fake timers.
    // Keep the process alive while this one integration test awaits its real abort.
    const keepAlive = setTimeout(() => {}, 14_000);
    let result;
    try {
      [, result] = await Promise.all([
        notifyRequestEvent(EVENT),
        checkDiscordConnection(),
      ]);
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(result.error?.code, "discord_timeout");
    assert.ok(Date.now() - start >= 4_500);
    assert.equal(calls.length, 2);
  },
);
