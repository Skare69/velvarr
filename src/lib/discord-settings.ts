import type { IntegrationConfig } from "./contracts.ts";

export type DiscordSettingsInfo = {
  configured: boolean;
  source: "stored" | "environment";
  includeTitles: boolean;
  includeTitlesSource: "stored" | "environment";
  stored: boolean;
};

export type DiscordCheck = {
  configured: boolean;
  error?: { code: string; message: string };
};

export function parseDiscordWebhook(raw: string): URL | null {
  // Check the raw path too: URL normalization must not accept dot segments or escapes.
  if (
    raw.length > 2048 ||
    !/^https:\/\/(?:discord\.com|discordapp\.com)(?::443)?\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/i.test(
      raw,
    ) ||
    /[\r\n]/.test(raw)
  )
    return null;
  try {
    const url = new URL(raw);
    return /^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname) &&
      url.pathname === raw.slice(raw.indexOf("/api/"))
      ? url
      : null;
  } catch {
    return null;
  }
}

export function resolveDiscordSettings(stored?: IntegrationConfig["discord"]): {
  webhookUrl: string;
  includeTitles: boolean;
} {
  return {
    webhookUrl:
      stored?.webhookUrl ?? process.env.VELVARR_DISCORD_WEBHOOK_URL ?? "",
    includeTitles:
      stored?.includeTitles ?? process.env.VELVARR_DISCORD_DETAIL === "1",
  };
}

export function discordConfiguration(
  stored?: IntegrationConfig["discord"],
): DiscordSettingsInfo {
  const effective = resolveDiscordSettings(stored);
  return {
    configured: !!effective.webhookUrl,
    source: stored?.webhookUrl !== undefined ? "stored" : "environment",
    includeTitles: effective.includeTitles,
    includeTitlesSource:
      stored?.includeTitles !== undefined ? "stored" : "environment",
    stored:
      stored?.webhookUrl !== undefined || stored?.includeTitles !== undefined,
  };
}
