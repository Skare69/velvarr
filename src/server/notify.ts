import type { IntegrationConfig } from "../lib/contracts.ts";
import {
  parseDiscordWebhook,
  resolveDiscordSettings,
  type DiscordCheck,
} from "../lib/discord-settings.ts";
import { getConfig } from "./storage.ts";

// Opt-in Discord webhook notifier for durable request transitions.
// Reads its destination on every call, stays completely silent when unset,
// and never throws into the caller: a notification failure must never roll
// back a request or acquisition, so everything here is best-effort.

// ponytail: one bounded POST per event, no queue or coalescing — events fire
// per durable transition (low volume) and the SQLite record is the source of
// truth; add a rate limiter only if Discord 429s actually show up.
const TIMEOUT_MS = 5_000;

/** Small local record describing one durable transition. Plain strings so
 * callers can pass a MediaReference-shaped value directly. */
export type RequestNotification = {
  kind: "acquired" | "available";
  media: { provider: string; kind: string; id: string };
  title?: string;
};

/** Fire one bounded webhook POST. Resolves without effect when the
 * destination is unset; refuses (with a URL-less warning) when it is not an
 * https Discord webhook; never rejects or lets a failure reach the caller.
 * The destination URL is never logged. */
export async function notifyRequestEvent(
  event: RequestNotification,
): Promise<void> {
  try {
    const { webhookUrl: raw, includeTitles: detail } = resolveDiscordSettings(
      getConfig()?.discord,
    );
    if (!raw) return;
    const url = parseDiscordWebhook(raw);
    if (!url) {
      console.warn(
        "[notify] Invalid Discord webhook configuration; notification skipped",
      );
      return;
    }
    // Titles and artwork are opt-in: identity-only by default.
    const message = `Velvarr ${event.kind}: ${event.media.kind} ${event.media.provider}/${event.media.id}`;
    const body = detail
      ? {
          embeds: [
            {
              // Discord caps embed titles at 256 characters and rejects the
              // whole embed with 400 Invalid Form Body above it.
              ...(event.title ? { title: event.title.slice(0, 256) } : {}),
              description: message,
            },
          ],
        }
      : { content: message };
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer(); // drain so the socket is released
    if (!res.ok)
      console.warn(`[notify] discord webhook responded ${res.status}; skipped`);
  } catch {
    // Best-effort by contract: timeouts and network errors are swallowed.
    // Deliberately no logging here — fetch errors would risk echoing the URL.
  }
}

/** GET validates the webhook without a visible channel message. */
export async function checkDiscordConnection(
  stored?: IntegrationConfig["discord"],
  override?: string,
): Promise<DiscordCheck> {
  const raw = override || resolveDiscordSettings(stored).webhookUrl;
  const failure = (code: string, message: string): DiscordCheck => ({
    configured: !!raw,
    error: { code, message },
  });
  if (!raw) return { configured: false };
  const url = parseDiscordWebhook(raw);
  if (!url)
    return failure("invalid_config", "The Discord webhook URL is invalid.");
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        "discord_http_error",
        `Discord returned HTTP ${response.status}.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      return failure(
        "discord_invalid_response",
        "Discord returned invalid webhook information.",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        return failure(
          "discord_invalid_response",
          "Discord returned invalid webhook information.",
        );
      }
      chunks.push(value);
    }
    let info: unknown;
    try {
      info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return failure(
        "discord_invalid_response",
        "Discord returned invalid webhook information.",
      );
    }
    if (
      !info ||
      typeof info !== "object" ||
      !("id" in info) ||
      info.id !== url.pathname.split("/")[3] ||
      !("type" in info) ||
      info.type !== 1 ||
      !("channel_id" in info) ||
      typeof info.channel_id !== "string" ||
      !/^[0-9]+$/.test(info.channel_id)
    )
      return failure(
        "discord_invalid_response",
        "Discord returned invalid webhook information.",
      );
    return { configured: true };
  } catch (error) {
    const timeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return timeout
      ? failure("discord_timeout", "The Discord connection timed out.")
      : failure("discord_unreachable", "The Discord connection failed.");
  }
}
