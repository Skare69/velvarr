// Natural-language search chat client: Anthropic hosts use the native
// Messages API with a prompt-cache breakpoint on the system block; every
// other host keeps the OpenAI-compatible Chat Completions request.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProseChat,
  requestProseDraft,
  requestTagRepair,
  type ProseCheckResult,
} from "../src/server/prose-chat.ts";
import { proseSystemMessage, type ProseDraft } from "../src/lib/prose-draft.ts";
import {
  proseRepairSystemMessage,
  type RepairItem,
} from "../src/lib/prose-repair.ts";
import { AppError } from "../src/server/http.ts";
import { wireJson } from "./fixture.ts";
import type { IntegrationConfig } from "../src/lib/contracts.ts";

type Providers = NonNullable<IntegrationConfig["providers"]>;
/** The request body fields these tests read; JSON.parse proves nothing, so
 * each test asserts the values it needs. */
type SentBody = {
  model?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  system?: { text?: unknown }[];
  messages?: unknown;
  output_config?: { format?: { type?: unknown } };
  response_format?: { type?: unknown };
};
type Sent = { url: string; headers: Headers; body: SentBody };

const key = "sk-ant-test-0123456789";
const anthropic: Providers = {
  proseChatEnabled: true,
  proseChatUrl: "https://api.anthropic.com/v1",
  proseChatModel: "claude-sonnet-4-5",
  proseChatApiKey: key,
};
const openai: Providers = {
  ...anthropic,
  proseChatUrl: "https://api.openai.com/v1",
  proseChatModel: "gpt-4o-mini",
};
const ollama: Providers = {
  ...anthropic,
  proseChatUrl: "https://ollama.local/v1",
  proseChatModel: "llama3.2",
};
const today = "2026-11-20";
const text = "velvet quokka marathon";
const draft: ProseDraft = {
  type: null,
  titleWords: { value: "velvet quokka", source: "velvet quokka" },
  include: [],
  exclude: [],
  performers: { mode: "all", names: [] },
  studios: { names: [], withChildren: null },
  followedPerformers: null,
  year: null,
  date: null,
  sort: null,
  skipped: [{ text: "marathon", reason: "not_a_filter" }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const messagesReply = (content: unknown[], stopReason = "end_turn"): Response =>
  json({
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    },
  });

const answer = (value: unknown): Response =>
  messagesReply([
    { type: "thinking", thinking: "The member names title words." },
    { type: "text", text: JSON.stringify(value) },
  ]);

async function withFetch(handler: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** Runs `run` with a fetch stub that records each request and answers with
 * `reply(callIndex)`. Returns the recorded requests. */
async function recording(
  reply: (call: number) => Response,
  run: () => Promise<void>,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  await withFetch(async (input, init) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: wireJson(init) as SentBody,
    });
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    return reply(sent.length - 1);
  }, run);
  return sent;
}

/** Runs `run` with a fetch stub that records each GET request and answers
 * with `reply(url)`. Returns the recorded requests. */
async function recordingGet(
  reply: (url: string) => Response,
  run: () => Promise<void>,
): Promise<{ url: string; headers: Headers }[]> {
  const sent: { url: string; headers: Headers }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    assert.equal(init?.redirect, "error");
    return reply(sent[sent.length - 1]!.url);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

/** Anthropic's list names dated ids and fits 20 rows on the default first
 * page. None of them is the Messages alias. */
const anthropicListPage = () =>
  json({
    data: Array.from({ length: 20 }, (_, i) => ({
      type: "model",
      id: `claude-model-${String(i).padStart(2, "0")}-20250101`,
    })),
    has_more: true,
    last_id: "claude-model-19-20250101",
  });

const anthropicModelFound = (id: string) =>
  json({ data: { type: "model", id, display_name: "Claude" } });

test("an Anthropic URL sends one native Messages request with a cached system block", async () => {
  let result: ProseDraft | undefined;
  const sent = await recording(
    () => answer(draft),
    async () => {
      result = await requestProseDraft(anthropic, text, today);
    },
  );
  assert.equal(sent.length, 1);
  const { url, headers, body } = sent[0]!;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers.get("x-api-key"), key);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.has("authorization"), false);
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.max_tokens, 1000);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.system, [
    {
      type: "text",
      text: proseSystemMessage(today),
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.deepEqual(body.messages, [{ role: "user", content: text }]);
  assert.equal(body.output_config?.format?.type, "json_schema");
  assert.equal("response_format" in body, false);
  // The thinking block is ignored; only the text block is the answer.
  assert.deepEqual(result, draft);
});

test("the member text stays after the cache breakpoint, never inside the cached block", async () => {
  const otherText = "amber pangolin festival";
  const sent = await recording(
    () => answer(draft),
    async () => {
      await requestProseDraft(anthropic, text, today);
      await requestProseDraft(anthropic, otherText, today);
    },
  );
  // Two different searches on one day share the same cached prefix.
  assert.deepEqual(sent[0]!.body.system, sent[1]!.body.system);
  for (const [i, member] of [text, otherText].entries()) {
    const cached = sent[i]!.body.system?.[0]?.text;
    assert.equal(typeof cached, "string");
    assert.equal(String(cached).includes(member), false);
    assert.deepEqual(sent[i]!.body.messages, [
      { role: "user", content: member },
    ]);
  }
});

test("a 400 that names temperature retries once without it", async () => {
  let result: ProseDraft | undefined;
  const sent = await recording(
    (call) =>
      call === 0
        ? json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "temperature is deprecated for this model",
              },
            },
            400,
          )
        : answer(draft),
    async () => {
      result = await requestProseDraft(anthropic, text, today);
    },
  );
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.body.temperature, 0);
  assert.equal("temperature" in sent[1]!.body, false);
  assert.equal(sent[1]!.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(sent[1]!.body.system, sent[0]!.body.system);
  assert.deepEqual(result, draft);
});

test("a refusal, a cut-off reply and a reply without text map to the named errors", async () => {
  const cases: [Response, string][] = [
    [messagesReply([], "refusal"), "prose_search_refused"],
    [
      messagesReply([{ type: "text", text: '{"type":null,' }], "max_tokens"),
      "prose_search_bad_reply",
    ],
    [
      messagesReply([{ type: "thinking", thinking: "No answer." }]),
      "prose_search_bad_reply",
    ],
  ];
  for (const [reply, code] of cases) {
    await recording(
      () => reply,
      async () => {
        await assert.rejects(
          requestProseDraft(anthropic, text, today),
          (err: unknown) => err instanceof AppError && err.code === code,
        );
      },
    );
  }
});

test("tag repair on an Anthropic URL also uses the cached native request", async () => {
  const items: RepairItem[] = [
    {
      phrase: "quokka",
      candidates: [
        { name: "Quokka Love", catalogs: ["tpdb"] },
        { name: "Marsupials", catalogs: ["stashdb"] },
      ],
    },
  ];
  let picks: Map<string, string[]> | undefined;
  const sent = await recording(
    () =>
      answer({
        picks: [{ phrase: "quokka", tags: ["quokka love", "Invented Tag"] }],
      }),
    async () => {
      picks = await requestTagRepair(anthropic, text, items);
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0]!.headers.has("authorization"), false);
  assert.deepEqual(sent[0]!.body.system, [
    {
      type: "text",
      text: proseRepairSystemMessage(),
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.deepEqual(picks, new Map([["quokka", ["Quokka Love"]]]));
});

test("a non-Anthropic URL keeps the Chat Completions request without cache_control", async () => {
  let result: ProseDraft | undefined;
  const sent = await recording(
    () =>
      json({
        choices: [
          {
            message: { content: JSON.stringify(draft) },
            finish_reason: "stop",
          },
        ],
      }),
    async () => {
      result = await requestProseDraft(openai, text, today);
    },
  );
  assert.equal(sent.length, 1);
  const { url, headers, body } = sent[0]!;
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(headers.get("authorization"), `Bearer ${key}`);
  assert.equal(headers.has("x-api-key"), false);
  assert.equal(headers.has("anthropic-version"), false);
  assert.equal(JSON.stringify(body).includes("cache_control"), false);
  assert.deepEqual(body.messages, [
    { role: "system", content: proseSystemMessage(today) },
    { role: "user", content: text },
  ]);
  assert.equal(body.response_format?.type, "json_schema");
  assert.deepEqual(result, draft);
});

test("the Anthropic check asks for the model itself, so the Messages alias connects", async () => {
  let result: ProseCheckResult | undefined;
  const sent = await recordingGet(
    (url) =>
      url === "https://api.anthropic.com/v1/models"
        ? anthropicListPage()
        : anthropicModelFound("claude-sonnet-4-5-20250929"),
    async () => {
      result = await checkProseChat(anthropic);
    },
  );
  assert.deepEqual(result, { connected: true });
  // The list names only dated ids, so the check reads the model directly;
  // Anthropic resolves the alias there.
  assert.deepEqual(
    sent.map((s) => s.url),
    ["https://api.anthropic.com/v1/models/claude-sonnet-4-5"],
  );
  assert.equal(sent[0]!.headers.get("x-api-key"), key);
  assert.equal(sent[0]!.headers.get("anthropic-version"), "2023-06-01");
});

test("the Anthropic check finds a model past the first list page", async () => {
  const page21: Providers = {
    ...anthropic,
    proseChatModel: "claude-model-20-20250101",
  };
  let result: ProseCheckResult | undefined;
  const sent = await recordingGet(
    (url) =>
      url === "https://api.anthropic.com/v1/models"
        ? anthropicListPage()
        : anthropicModelFound("claude-model-20-20250101"),
    async () => {
      result = await checkProseChat(page21);
    },
  );
  // The stored id is the 21st model: the default first page never names it.
  assert.deepEqual(result, { connected: true });
  assert.deepEqual(
    sent.map((s) => s.url),
    ["https://api.anthropic.com/v1/models/claude-model-20-20250101"],
  );
});

test("the Ollama check accepts the bare name when the server lists name:latest", async () => {
  let result: ProseCheckResult | undefined;
  const sent = await recordingGet(
    (url) => {
      assert.equal(url, "https://ollama.local/v1/models");
      return json({ data: [{ id: "llama3.2:latest" }, { id: "qwen2.5:7b" }] });
    },
    async () => {
      result = await checkProseChat(ollama);
    },
  );
  assert.deepEqual(result, { connected: true });
  assert.equal(sent.length, 1);
});

test("the Ollama check still refuses a bare name whose :latest tag is absent", async () => {
  let result: ProseCheckResult | undefined;
  await recordingGet(
    () => json({ data: [{ id: "llama3.2:7b" }] }),
    async () => {
      result = await checkProseChat(ollama);
    },
  );
  assert.deepEqual(result, {
    connected: false,
    error: 'The server does not list the model "llama3.2".',
  });
});
