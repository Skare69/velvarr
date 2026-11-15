// Natural-language search chat client: the admin-configured
// OpenAI-compatible chat server turns member text into a ProseDraft. One
// request, no retry. The member's text, the API key and the reply are never
// logged, stored, or put into an error message.

import {
  isProseChatModel,
  type Account,
  type IntegrationConfig,
  type ProseSearchStatus,
} from "../lib/contracts.ts";
import {
  PROSE_DRAFT_SCHEMA,
  parseProseDraft,
  proseSystemMessage,
  type ProseDraft,
} from "../lib/prose-draft.ts";
import { AppError, validateBaseUrl } from "./http.ts";

type Providers = IntegrationConfig["providers"];

export type ProseChatConfiguration = {
  enabled: boolean;
  /** Stored URL after validateBaseUrl, or "" when unset or invalid now. */
  url: string;
  /** Stored model when isProseChatModel, else "". */
  model: string;
  keyStored: boolean;
  /** enabled, and the URL and the model both validate. */
  configured: boolean;
  /** Only when enabled and a stored value does not validate now. */
  error?: string;
};

const CHAT_TIMEOUT_MS = 30_000;
const REPLY_LIMIT = 256 * 1024;
const ERROR_BODY_LIMIT = 2 * 1024;
/** The connection check never sends member data. */
const CHECK_TEXT = "Vixen scenes from 2019 with Riley Reid, newest first";

/** The effective configuration from the stored settings. Never throws: a
 * stored value that no longer validates (for example plain HTTP after
 * VELVARR_ALLOW_HTTP was removed) reads as not configured, with the cause. */
export function proseChatConfiguration(
  providers?: Providers,
): ProseChatConfiguration {
  const enabled = providers?.proseChatEnabled === true;
  const errors: string[] = [];
  let url = "";
  if (providers?.proseChatUrl) {
    try {
      url = validateBaseUrl(providers.proseChatUrl);
    } catch (err) {
      errors.push(
        err instanceof AppError
          ? err.message
          : "The stored chat server address is not valid.",
      );
    }
  }
  const storedModel = providers?.proseChatModel;
  const model = isProseChatModel(storedModel) ? storedModel : "";
  if (storedModel !== undefined && model === "")
    errors.push("The stored chat model name is not valid.");
  return {
    enabled,
    url,
    model,
    keyStored: Boolean(providers?.proseChatApiKey),
    configured: enabled && url !== "" && model !== "",
    ...(enabled && errors.length > 0 ? { error: errors.join(" ") } : {}),
  };
}

/** not_configured wins over not_granted; admins never need the grant. */
export function proseSearchStatus(
  account: Account,
  providers?: Providers,
): ProseSearchStatus {
  if (!proseChatConfiguration(providers).configured) return "not_configured";
  if (account.role !== "admin" && !account.proseSearch) return "not_granted";
  return "ready";
}

/** Today on the server clock, local time, as YYYY-MM-DD: the model resolves
 * relative dates ("last year") against it. */
export function serverToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const failed = (message: string) =>
  new AppError(502, "prose_search_failed", message);
const badReply = (message: string) =>
  new AppError(502, "prose_search_bad_reply", message);

/** The parts of an OpenAI-compatible reply this client reads. Every field
 * is unknown until a typeof check proves it. */
type ChatChoice = {
  finish_reason?: unknown;
  message?: { refusal?: unknown; content?: unknown } | null;
};

/** Reads at most `limit` bytes; `complete` is false when the body is longer
 * (the rest is cancelled, never buffered). A read failure cancels and
 * rethrows. */
async function readUpTo(
  res: Response,
  limit: number,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), complete: true };
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Releasing the connection is best-effort: the stream can already be dead.
  const release = () => reader.cancel().catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(chunks, total), complete: true };
      const room = limit - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        await release();
        return { bytes: Buffer.concat(chunks, limit), complete: false };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await release();
    throw err;
  }
}

/** The server's own words for a failed check: JSON `error.message` (or a
 * string `error`) first, else the text; control characters removed, at most
 * 200 characters. "" when nothing readable came back. */
async function serverMessage(res: Response): Promise<string> {
  let text: string;
  try {
    text = new TextDecoder().decode(
      (await readUpTo(res, ERROR_BODY_LIMIT)).bytes,
    );
  } catch {
    return "";
  }
  try {
    const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
    const message =
      typeof error === "string"
        ? error
        : (error as { message?: unknown } | null | undefined)?.message;
    if (typeof message === "string") text = message;
  } catch {
    // Not JSON: the plain text is the message.
  }
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The chat reply envelope → a validated draft, or a named error. */
function draftFromReply(bytes: Uint8Array): ProseDraft {
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badReply("The chat server's reply is not JSON.");
  }
  const choices = (reply as { choices?: unknown } | null)?.choices;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (typeof choice !== "object" || choice === null)
    throw badReply("The chat server's reply holds no answer.");
  const { finish_reason: finishReason, message } = choice as ChatChoice;
  const refusal = message?.refusal;
  if (
    (typeof refusal === "string" && refusal.trim() !== "") ||
    finishReason === "content_filter"
  ) {
    throw new AppError(
      502,
      "prose_search_refused",
      "The chat model refused this search. Hosted models can refuse adult text; a local model avoids this.",
    );
  }
  if (finishReason === "length")
    throw badReply("The chat model's reply was cut off.");
  const content = message?.content;
  if (typeof content !== "string")
    throw badReply("The chat model's reply holds no text.");
  let draft: unknown;
  try {
    draft = JSON.parse(content);
  } catch {
    throw badReply("The chat model's reply is not JSON.");
  }
  const parsed = parseProseDraft(draft);
  if (!parsed.ok)
    throw badReply("The chat model's reply does not match the filter format.");
  return parsed.draft;
}

/** One chat request for a configured server. `quoteServer` adds the server's
 * error text to an HTTP failure: only the connection check sets it, because
 * an error body can echo the member's text. */
async function postDraft(
  config: ProseChatConfiguration,
  apiKey: string | undefined,
  text: string,
  today: string,
  quoteServer: boolean,
): Promise<ProseDraft> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const signal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  // The deadline covers the whole exchange, body read included.
  const unreachable = () =>
    signal.aborted
      ? failed("The chat server did not answer within 30 seconds.")
      : failed("The chat server could not be reached.");
  let res: Response;
  try {
    res = await fetch(`${config.url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: proseSystemMessage(today) },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: 1000,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "browse_filters",
            strict: true,
            schema: PROSE_DRAFT_SCHEMA,
          },
        },
      }),
      redirect: "error",
      signal,
    });
  } catch {
    throw unreachable();
  }
  if (!res.ok) {
    let detail = "";
    if (quoteServer) detail = await serverMessage(res);
    else await res.body?.cancel().catch(() => undefined); // best-effort release
    throw failed(
      `The chat server answered HTTP ${res.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  let body: { bytes: Uint8Array; complete: boolean };
  try {
    body = await readUpTo(res, REPLY_LIMIT);
  } catch {
    throw unreachable();
  }
  if (!body.complete)
    throw badReply("The chat server's reply is larger than 256 KiB.");
  return draftFromReply(body.bytes);
}

/** Sends the member's text to the configured chat server and returns the
 * validated draft. Throws AppError 503 prose_search_not_configured, or 502
 * prose_search_failed / prose_search_refused / prose_search_bad_reply. */
export async function requestProseDraft(
  providers: Providers,
  text: string,
  today: string,
): Promise<ProseDraft> {
  const config = proseChatConfiguration(providers);
  if (!config.configured) {
    throw new AppError(
      503,
      "prose_search_not_configured",
      "Natural-language search is off or not set up.",
    );
  }
  return postDraft(config, providers?.proseChatApiKey, text, today, false);
}

/** The admin connection check with the stored values and a fixed sample
 * text: connected only when the server returns a valid draft. */
export async function checkProseChat(
  providers?: Providers,
): Promise<{ connected: true } | { connected: false; error: string }> {
  const config = proseChatConfiguration(providers);
  if (!config.configured)
    return {
      connected: false,
      error: "Natural-language search is off or not set up.",
    };
  try {
    await postDraft(
      config,
      providers?.proseChatApiKey,
      CHECK_TEXT,
      serverToday(),
      true,
    );
    return { connected: true };
  } catch (err) {
    if (err instanceof AppError)
      return { connected: false, error: err.message };
    throw err;
  }
}
