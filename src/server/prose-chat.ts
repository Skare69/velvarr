// Natural-language search chat client: the admin-configured chat server
// (OpenAI-compatible, or Anthropic's native Messages API on
// api.anthropic.com) turns member text into a ProseDraft. One request,
// retried once only when the server refuses the `temperature` field. The
// member's text, the API key and the reply are never logged, stored, or put
// into an error message.

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
import {
  parseProseRepair,
  PROSE_REPAIR_SCHEMA,
  proseRepairSystemMessage,
  proseRepairUserMessage,
  type RepairItem,
  type RepairPicks,
} from "../lib/prose-repair.ts";
import { redactSecret, secretSpans } from "../lib/redact.ts";
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

/** The parts of an Anthropic Messages reply this client reads. Every field
 * is unknown until a typeof check proves it. */
type AnthropicReply = { content?: unknown; stop_reason?: unknown };

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
 * string `error`) first, else the text; control characters removed, the
 * stored key redacted, at most 200 characters. "" when nothing readable
 * came back. */
async function serverMessage(
  res: Response,
  apiKey: string | undefined,
): Promise<string> {
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
  // A server can repeat the key header in its error text. The key goes
  // before the cut, so the cut never leaves a piece of it behind.
  return redactSecret(
    text
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    apiKey,
  ).slice(0, 200);
}

/** Every string value of a draft. */
function draftStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(draftStrings);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(draftStrings);
  return [];
}

/** Whether a draft holds a span of the key that the member's text does not
 * hold. The model never receives the key (it travels only in a request
 * header), so such a span comes from a server that writes the header back
 * into its reply. A span that the member typed is their text. */
function draftRepeatsKey(
  draft: ProseDraft,
  text: string,
  apiKey: string,
): boolean {
  // A stored key has no white space, so no span crosses a line break.
  const values = draftStrings(draft).join("\n");
  return secretSpans(values, apiKey).some(
    ([start, end]) => !text.includes(values.slice(start, end)),
  );
}

/** What a reply envelope says about the model's answer. */
type ModelReply = { refused: boolean; cutOff: boolean; text: unknown };

/** An OpenAI-compatible envelope → the model's reply. */
function openAiReply(reply: unknown): ModelReply {
  const choices = (reply as { choices?: unknown } | null)?.choices;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (typeof choice !== "object" || choice === null)
    throw badReply("The chat server's reply holds no answer.");
  const { finish_reason: finishReason, message } = choice as ChatChoice;
  const refusal = message?.refusal;
  return {
    refused:
      (typeof refusal === "string" && refusal.trim() !== "") ||
      finishReason === "content_filter",
    cutOff: finishReason === "length",
    text: message?.content,
  };
}

/** An Anthropic Messages envelope → the model's reply: its text blocks
 * joined. Thinking and other blocks are not the answer. */
function anthropicReply(reply: unknown): ModelReply {
  const content = (reply as AnthropicReply | null)?.content;
  if (!Array.isArray(content))
    throw badReply("The chat server's reply holds no answer.");
  const stopReason = (reply as AnthropicReply).stop_reason;
  const texts = content.flatMap((block: unknown) => {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
    return type === "text" && typeof text === "string" ? [text] : [];
  });
  return {
    refused: stopReason === "refusal",
    cutOff: stopReason === "max_tokens",
    text: texts.length > 0 ? texts.join("") : undefined,
  };
}

/** The chat reply envelope → the model's JSON answer, or a named error. */
function answerFromReply(bytes: Uint8Array, anthropic: boolean): unknown {
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badReply("The chat server's reply is not JSON.");
  }
  const { refused, cutOff, text } = anthropic
    ? anthropicReply(reply)
    : openAiReply(reply);
  if (refused) {
    throw new AppError(
      502,
      "prose_search_refused",
      "The chat model refused this search. Hosted models can refuse adult text; a local model avoids this.",
    );
  }
  if (cutOff) throw badReply("The chat model's reply was cut off.");
  if (typeof text !== "string")
    throw badReply("The chat model's reply holds no text.");
  try {
    return JSON.parse(text);
  } catch {
    throw badReply("The chat model's reply is not JSON.");
  }
}

/** The model's JSON answer → a validated draft, or a named error. */
function draftFromAnswer(answer: unknown): ProseDraft {
  const parsed = parseProseDraft(answer);
  if (!parsed.ok)
    throw badReply("The chat model's reply does not match the filter format.");
  return parsed.draft;
}

type ChatMessages = { system: string; user: string };
type ChatSchema = { name: string; schema: Record<string, unknown> };

const ANTHROPIC_HOST = "api.anthropic.com";
// 2023-06-01 still accepts `temperature`; 2026-10-21 removes it on every
// model, which would make the temperature retry below pointless.
const ANTHROPIC_VERSION = "2023-06-01";

/** The OpenAI-compatible `/chat/completions` body. */
function openAiBody(
  model: string,
  messages: ChatMessages,
  schema: ChatSchema,
  withTemperature: boolean,
) {
  return {
    model,
    messages: [
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ],
    ...(withTemperature ? { temperature: 0 } : {}),
    max_tokens: 1000,
    response_format: {
      type: "json_schema",
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    },
  };
}

/** The Anthropic `/messages` body. Anthropic's OpenAI compatibility layer
 * ignores prompt caching, so its host gets the native API: a cache_control
 * breakpoint on the system prompt caches that stable prefix (the member's
 * text comes after it) for the default 5 minutes. A prompt shorter than the
 * model's minimum cacheable length is just not cached, with no error. */
function anthropicBody(
  model: string,
  messages: ChatMessages,
  schema: ChatSchema,
  withTemperature: boolean,
) {
  return {
    model,
    max_tokens: 1000,
    system: [
      {
        type: "text",
        text: messages.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: messages.user }],
    ...(withTemperature ? { temperature: 0 } : {}),
    output_config: { format: { type: "json_schema", schema: schema.schema } },
  };
}

/** One chat request for a configured server: a system and a user message,
 * answered under a strict json_schema. Returns the model's JSON answer. An
 * HTTP failure never quotes the server: an error body can echo the member's
 * text. */
async function postChat(
  config: Pick<ProseChatConfiguration, "url" | "model">,
  apiKey: string | undefined,
  messages: ChatMessages,
  schema: ChatSchema,
): Promise<unknown> {
  // Anthropic's own API gets its native dialect. The URL was validated when
  // it was stored, so it parses.
  const anthropic = new URL(config.url).hostname === ANTHROPIC_HOST;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (anthropic) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const path = anthropic ? "/messages" : "/chat/completions";
  const body = anthropic ? anthropicBody : openAiBody;
  const signal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  // The deadline covers the whole exchange, body read included.
  const unreachable = () =>
    signal.aborted
      ? failed("The chat server did not answer within 30 seconds.")
      : failed("The chat server could not be reached.");
  const send = (withTemperature: boolean) =>
    fetch(`${config.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        body(config.model, messages, schema, withTemperature),
      ),
      redirect: "error",
      signal,
    });
  let res: Response;
  try {
    res = await send(true);
  } catch {
    throw unreachable();
  }
  // temperature 0 keeps the filters repeatable where a model allows it;
  // newer models (Anthropic's among them) refuse the field with a 400 that
  // names it, and then the same request goes once more without it.
  let detail = "";
  if (!res.ok) detail = await serverMessage(res, apiKey);
  if (res.status === 400 && /temperature/i.test(detail)) {
    try {
      res = await send(false);
    } catch {
      throw unreachable();
    }
    detail = res.ok ? "" : await serverMessage(res, apiKey);
  }
  if (!res.ok) throw failed(`The chat server answered HTTP ${res.status}.`);
  let reply: { bytes: Uint8Array; complete: boolean };
  try {
    reply = await readUpTo(res, REPLY_LIMIT);
  } catch {
    throw unreachable();
  }
  if (!reply.complete)
    throw badReply("The chat server's reply is larger than 256 KiB.");
  return answerFromReply(reply.bytes, anthropic);
}

async function postDraft(
  config: Pick<ProseChatConfiguration, "url" | "model">,
  apiKey: string | undefined,
  text: string,
  today: string,
): Promise<ProseDraft> {
  const draft = draftFromAnswer(
    await postChat(
      config,
      apiKey,
      { system: proseSystemMessage(today), user: text },
      { name: "browse_filters", schema: PROSE_DRAFT_SCHEMA },
    ),
  );
  // Draft values reach notes, the URL and provider searches, so a reply that
  // repeats the key is refused whole: no part of it reaches anyone.
  if (apiKey && draftRepeatsKey(draft, text, apiKey))
    throw badReply("The chat server's reply repeats the stored API key.");
  return draft;
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
  return postDraft(config, providers?.proseChatApiKey, text, today);
}

/** The grounded repair (docs/specs/prose-tag-repair.md): one more chat
 * request with the missed phrases and their real candidate tags. Returns
 * only picks that are candidates (parseProseRepair). Throws the same
 * AppErrors as requestProseDraft; the caller keeps pass 1 on a throw. */
export async function requestTagRepair(
  providers: Providers,
  request: string,
  items: RepairItem[],
): Promise<RepairPicks> {
  const config = proseChatConfiguration(providers);
  if (!config.configured) {
    throw new AppError(
      503,
      "prose_search_not_configured",
      "Natural-language search is off or not set up.",
    );
  }
  const answer = await postChat(
    config,
    providers?.proseChatApiKey,
    {
      system: proseRepairSystemMessage(),
      user: proseRepairUserMessage(request, items),
    },
    { name: "tag_picks", schema: PROSE_REPAIR_SCHEMA },
  );
  return parseProseRepair(answer, items);
}

export type ProseCheckResult =
  { connected: true } | { connected: false; error: string };

/** The headers the model-list and model-lookup GETs send: one key serves
 * one host, so it travels in both header styles. */
function proseKeyHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  return headers;
}

/** A connection check that costs nothing: it proves the server answers and
 * accepts the key, and that it serves the model. On Anthropic it reads the
 * model itself (`GET {url}/models/{model}`): the list names dated ids, not
 * the aliases the Messages API accepts, and one page holds only 20 rows.
 * Every other host reads `GET {url}/models`; a model without a tag also
 * matches the `name:latest` entry Ollama lists for it. No chat request is
 * sent, so no tokens are billed. Its ceiling: it cannot prove the model
 * returns valid filters; a member search reports that. */
async function checkModelListed(
  url: string,
  model: string,
  apiKey: string | undefined,
): Promise<ProseCheckResult> {
  if (new URL(url).hostname === ANTHROPIC_HOST) {
    const signal = AbortSignal.timeout(MODELS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${url}/models/${encodeURIComponent(model)}`, {
        method: "GET",
        headers: proseKeyHeaders(apiKey),
        redirect: "error",
        signal,
      });
    } catch {
      return {
        connected: false,
        error: signal.aborted
          ? "The server did not answer within 15 seconds."
          : "The server could not be reached.",
      };
    }
    if (res.ok) return { connected: true };
    if (res.status === 404)
      return {
        connected: false,
        error: `The server does not list the model "${model}".`,
      };
    const detail = await serverMessage(res, apiKey);
    return {
      connected: false,
      error: `The server answered HTTP ${res.status}${detail ? `: ${detail}` : "."}`,
    };
  }
  const { models, error } = await listProseModels(url, apiKey);
  if (error !== undefined) return { connected: false, error };
  if (models.includes(model)) return { connected: true };
  if (!model.includes(":") && models.includes(`${model}:latest`))
    return { connected: true };
  return {
    connected: false,
    error:
      models.length === 0
        ? "The server lists no models, so the model cannot be confirmed."
        : `The server does not list the model "${model}".`,
  };
}

/** The admin connection check with the stored values (free, see above). */
export async function checkProseChat(
  providers?: Providers,
): Promise<ProseCheckResult> {
  const config = proseChatConfiguration(providers);
  if (!config.configured)
    return {
      connected: false,
      error: "Natural-language search is off or not set up.",
    };
  return checkModelListed(config.url, config.model, providers?.proseChatApiKey);
}

/** The editor's check with the typed values: the same free check as the
 * saved one, and nothing is stored. */
export async function testProseChat(draft: {
  url: string;
  model: string;
  apiKey: string | undefined;
}): Promise<ProseCheckResult> {
  return checkModelListed(draft.url, draft.model, draft.apiKey);
}

const MODELS_TIMEOUT_MS = 15_000;
const MODELS_LIMIT = 1024 * 1024;
const MODELS_MAX = 500;

/** The server's model ids from `GET {url}/models`, for the editor's
 * suggestions. OpenAI, Ollama and Anthropic all answer `{ data: [{ id }] }`;
 * Anthropic reads its key from `x-api-key`, so the same key goes there too
 * (one key, one host). Any failure is a plain message beside an empty list:
 * the model field stays free text. */
export async function listProseModels(
  url: string,
  apiKey: string | undefined,
): Promise<{ models: string[]; error?: string }> {
  const headers = proseKeyHeaders(apiKey);
  const signal = AbortSignal.timeout(MODELS_TIMEOUT_MS);
  const unreachable = () => ({
    models: [],
    error: signal.aborted
      ? "The server did not answer within 15 seconds."
      : "The server could not be reached.",
  });
  let res: Response;
  try {
    res = await fetch(`${url}/models`, { headers, redirect: "error", signal });
  } catch {
    return unreachable();
  }
  if (!res.ok) {
    const detail = await serverMessage(res, apiKey);
    return {
      models: [],
      error: `The server answered HTTP ${res.status}${detail ? `: ${detail}` : "."}`,
    };
  }
  let body: { bytes: Uint8Array; complete: boolean };
  try {
    body = await readUpTo(res, MODELS_LIMIT);
  } catch {
    return unreachable();
  }
  if (!body.complete)
    return { models: [], error: "The model list is larger than 1 MiB." };
  let data: unknown;
  try {
    data = (
      JSON.parse(new TextDecoder().decode(body.bytes)) as {
        data?: unknown;
      } | null
    )?.data;
  } catch {
    data = undefined;
  }
  if (!Array.isArray(data))
    return { models: [], error: "The server's model list has no data array." };
  const ids = new Set<string>();
  for (const row of data) {
    const id = (row as { id?: unknown } | null)?.id;
    if (isProseChatModel(id) && (!apiKey || !id.includes(apiKey))) ids.add(id);
  }
  return {
    models: [...ids].sort((a, b) => a.localeCompare(b)).slice(0, MODELS_MAX),
  };
}
