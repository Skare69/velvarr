// Ollama boundary tests: provider isolation, decision payloads, cache identity,
// bounded choices, configuration persistence, and conservative outage behavior.
import assert from "node:assert/strict";
import test from "node:test";
import {
  sameWork,
  resetSameWorkBreaker,
  suggestTags,
  rankRelatedTitles,
  judgmentConfiguration,
  checkJudgmentConnection,
} from "../src/server/judgment.ts";
import { nextProviderCredentials } from "../src/app/api/[...path]/routes/admin.ts";
import { validateBaseUrl } from "../src/server/http.ts";
import type { IntegrationConfig } from "../src/lib/contracts.ts";

type Providers = NonNullable<IntegrationConfig["providers"]>;
const local: Providers = {
  judgmentProvider: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "nimble",
};
const requested = { title: "No Time to Die", year: 2021 };
const candidate = { title: "Bond: No Time to Die", year: 2021 };
const response = (answers: unknown) =>
  new Response(JSON.stringify({ model: "nimble", answers }), {
    headers: { "content-type": "application/json" },
  });

async function withFetch(handler: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  resetSameWorkBreaker();
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    resetSameWorkBreaker();
  }
}

test("Ollama uses System One with no cloud credential, preserving the same-work prompt", async () => {
  let calls = 0;
  await withFetch(
    async (input, init) => {
      calls++;
      assert.equal(String(input), "http://localhost:11434/v1/systemone");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.redirect, "error");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, "nimble");
      assert.deepEqual(payload.state, { requested, candidate });
      assert.equal(payload.questions.sameWork.type, "noul");
      assert.match(
        payload.questions.sameWork.instructions,
        /Answer no for remakes, sequels/,
      );
      return response({ sameWork: { type: "noul", noul: 0.92 } });
    },
    async () => {
      assert.equal(
        await sameWork(requested, candidate, {
          ...local,
          typesafeApiKey: "a-cloud-key-that-must-stay-local",
        }),
        true,
      );
      assert.equal(calls, 1);
    },
  );
});

test("changing the local model or endpoint does not reuse another backend's match", async () => {
  let calls = 0;
  const a = { title: "Cache namespace probe" },
    b = { title: "Cache namespace probe variant" };
  await withFetch(
    async () => {
      calls++;
      return response({
        sameWork: { type: "noul", noul: calls === 1 ? 0.99 : 0.1 },
      });
    },
    async () => {
      assert.equal(await sameWork(a, b, local), true);
      assert.equal(await sameWork(a, b, local), true);
      assert.equal(calls, 1);
      assert.equal(
        await sameWork(a, b, { ...local, ollamaModel: "tev1:4b" }),
        false,
      );
      assert.equal(
        await sameWork(a, b, { ...local, ollamaUrl: "http://127.0.0.1:11434" }),
        false,
      );
      assert.equal(calls, 3);
    },
  );
});

test("Ollama outages do not invoke TypeSafe or cache an unanswered no", async () => {
  let calls = 0;
  const a = { title: "Outage probe" },
    b = { title: "Outage probe alternate" };
  await withFetch(
    async (input) => {
      assert.match(String(input), /localhost/);
      calls++;
      if (calls === 1) throw new Error("local model down");
      return response({ sameWork: { type: "noul", noul: 0.9 } });
    },
    async () => {
      const settings = { ...local, typesafeApiKey: "must-not-use-cloud" };
      assert.equal(await sameWork(a, b, settings), false);
      assert.equal(await sameWork(a, b, settings), false);
      assert.equal(calls, 1, "the outage cooldown prevents repeated calls");
      resetSameWorkBreaker();
      assert.equal(await sameWork(a, b, settings), true);
      assert.equal(calls, 2);
    },
  );
});

test("a local outage does not suppress a different model, endpoint, or cloud backend", async () => {
  const a = { title: "Backend cooldown probe" };
  const b = { title: "Backend cooldown probe variant" };
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) throw new Error("one local model is unavailable");
      return response({ sameWork: { type: "noul", noul: 0.95 } });
    },
    async () => {
      assert.equal(await sameWork(a, b, local), false);
      assert.equal(await sameWork(a, b, local), false);
      assert.equal(calls, 1);
      assert.equal(
        await sameWork(a, b, { ...local, ollamaModel: "tev1" }),
        true,
      );
      assert.equal(
        await sameWork(a, b, { ...local, ollamaUrl: "http://127.0.0.1:11434" }),
        true,
      );
      assert.equal(
        await sameWork(a, b, {
          judgmentProvider: "typesafe",
          typesafeApiKey: "fixture-cloud-key",
        }),
        true,
      );
      assert.equal(calls, 4, "only the failed backend is in cooldown");
    },
  );
});

test(
  "local inference retains its allowance beyond the cloud timeout",
  { timeout: 6000 },
  async () => {
    await withFetch(
      async (_, init) => {
        // Local models can take longer than the cloud availability budget.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2200);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
        return response({ sameWork: { type: "noul", noul: 0.95 } });
      },
      async () => {
        assert.equal(
          await sameWork(
            { title: "Local inference allowance" },
            { title: "Local inference allowance variant" },
            local,
          ),
          true,
        );
      },
    );
  },
);

test("contradicting years and malformed local answers preserve conservative matching", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return response({ sameWork: { type: "noul", noul: "yes" } });
    },
    async () => {
      assert.equal(
        await sameWork(
          { title: "Year probe", year: 2021 },
          { title: "Year probe variant", year: 2022 },
          local,
        ),
        false,
      );
      assert.equal(calls, 0);
      assert.equal(
        await sameWork(
          { title: "Malformed probe" },
          { title: "Malformed probe variant" },
          local,
        ),
        false,
      );
      assert.equal(calls, 1);
    },
  );
});

test("local tag suggestions reduce oversized lists through bounded real choices", async () => {
  const tags = Array.from({ length: 63 }, (_, i) => ({
    id: `tag-${i}`,
    name: `Tag ${i}`,
  }));
  let calls = 0;
  await withFetch(
    async (_, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      const names = Object.keys(payload.questions.pick.criteria).filter(
        (n) => n !== "none",
      );
      assert.ok(names.length <= 25);
      const chosen = names.includes("Tag 62") ? "Tag 62" : names[0];
      return response({
        pick: {
          type: "choice",
          choice: chosen,
          confidence: 0.9,
          probabilities: Object.fromEntries(
            names.map((n, i) => [n, n === chosen ? 0.9 : 0.01 / (i + 1)]),
          ),
        },
      });
    },
    async () => {
      const result = await suggestTags("the last tag", tags, local);
      assert.equal(result[0]?.id, "tag-62");
      assert.ok(result.every((t) => tags.includes(t)));
      assert.equal(calls, 4);
    },
  );
});

test("an Ollama none decision produces no invented tag suggestions", async () => {
  await withFetch(
    async () =>
      response({
        pick: {
          type: "choice",
          choice: "none",
          confidence: 0.99,
          probabilities: { none: 0.99, Existing: 0.01 },
        },
      }),
    async () => {
      assert.deepEqual(
        await suggestTags(
          "unrelated",
          [{ id: "known", name: "Existing" }],
          local,
        ),
        [],
      );
    },
  );
});

test("local ranking reorders the same shortlist and refuses incomplete answers", async () => {
  const entries = [{ title: "First" }, { title: "Second" }];
  let calls = 0;
  await withFetch(
    async (_, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(payload.questions), ["c0", "c1"]);
      assert.ok(
        Object.values(payload.questions).every(
          (q) => (q as { type: string }).type === "score",
        ),
      );
      return response(
        calls === 1
          ? {
              c0: { type: "score", score: 0.1 },
              c1: { type: "score", score: 1.9 },
            }
          : { c0: { type: "score", score: 0.1 } },
      );
    },
    async () => {
      assert.deepEqual(
        await rankRelatedTitles({ title: "Seed" }, entries, local),
        [entries[1], entries[0]],
      );
      assert.equal(
        await rankRelatedTitles({ title: "Seed" }, entries, local),
        null,
      );
    },
  );
});

test("connection verification uses a harmless decision and reports unsupported servers", async () => {
  let calls = 0;
  await withFetch(
    async (_, init) => {
      calls++;
      assert.equal(
        JSON.parse(String(init?.body)).state,
        "The service is running.",
      );
      return calls === 1
        ? response({ ready: { type: "noul", noul: 0.99 } })
        : new Response("not found", { status: 404 });
    },
    async () => {
      assert.deepEqual(await checkJudgmentConnection(local), {
        provider: "ollama",
        connected: true,
      });
      const result = await checkJudgmentConnection(local);
      assert.equal(result.connected, false);
      assert.match(result.error ?? "", /Ollama 0.35/);
      assert.equal(calls, 2);
    },
  );
});

test("stored settings beat environment defaults and credential edits preserve the local choice", () => {
  const keys = [
    "VELVARR_JUDGMENT_PROVIDER",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
  ] as const;
  const before = keys.map((k) => process.env[k]);
  try {
    process.env.VELVARR_JUDGMENT_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.OLLAMA_MODEL = "tev1:4b";
    assert.equal(judgmentConfiguration().provider, "ollama");
    assert.equal(judgmentConfiguration(local).model, "nimble");
    const patched = nextProviderCredentials(
      { ...local, tpdbApiToken: "existing-token" },
      { stashdbApiKey: "new-key" },
    );
    assert.equal(patched?.judgmentProvider, "ollama");
    assert.equal(patched?.tpdbApiToken, "existing-token");
    const cleared = nextProviderCredentials(patched, {
      judgmentProvider: "",
      ollamaUrl: "",
      ollamaModel: "",
    });
    assert.equal(judgmentConfiguration(cleared).model, "tev1:4b");
    assert.equal(cleared?.tpdbApiToken, "existing-token");
  } finally {
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});

test("invalid provider and endpoint inputs cannot be saved", () => {
  assert.throws(() =>
    nextProviderCredentials(local, { judgmentProvider: "unknown" }),
  );
  assert.throws(() =>
    nextProviderCredentials(local, {
      ollamaUrl: "http://user:password@localhost:11434",
    }),
  );
  assert.throws(() =>
    nextProviderCredentials(local, { ollamaModel: "model\nname" }),
  );
  assert.throws(() =>
    nextProviderCredentials(local, { ollamaUrl: "http://public.example/" }),
  );
});

test("Docker Desktop's host endpoint follows the existing private HTTP opt-in", () => {
  const before = process.env.VELVARR_ALLOW_HTTP;
  try {
    delete process.env.VELVARR_ALLOW_HTTP;
    assert.throws(() => validateBaseUrl("http://host.docker.internal:11434"));
    process.env.VELVARR_ALLOW_HTTP = "1";
    assert.equal(
      validateBaseUrl("http://host.docker.internal:11434"),
      "http://host.docker.internal:11434",
    );
    assert.throws(() =>
      validateBaseUrl("http://host.docker.internal.example:11434"),
    );
  } finally {
    if (before === undefined) delete process.env.VELVARR_ALLOW_HTTP;
    else process.env.VELVARR_ALLOW_HTTP = before;
  }
});

test("a failed local tag batch aborts reduction without repeated inference", async () => {
  let calls = 0;
  const tags = Array.from({ length: 70 }, (_, i) => ({
    id: `tag-${i}`,
    name: `Tag ${i}`,
  }));
  await withFetch(
    async () => {
      calls++;
      throw new Error("model unavailable");
    },
    async () => {
      assert.deepEqual(await suggestTags("anything", tags, local), []);
      assert.equal(calls, 1);
    },
  );
});

test("an invalid environment provider degrades instead of throwing", () => {
  const keys = ["VELVARR_JUDGMENT_PROVIDER", "TYPESAFE_API_KEY"] as const;
  const before = keys.map((k) => process.env[k]);
  try {
    process.env.VELVARR_JUDGMENT_PROVIDER = "Ollama";
    delete process.env.TYPESAFE_API_KEY;
    const config = judgmentConfiguration();
    assert.equal(config.provider, "typesafe");
    assert.equal(config.configured, false);
    assert.match(config.error ?? "", /invalid value "Ollama"/);
    // A stored selection overrides the broken environment and clears the error.
    assert.equal(judgmentConfiguration(local).provider, "ollama");
    assert.equal(judgmentConfiguration(local).error, undefined);
  } finally {
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});

test("an invalid environment model falls back to the default", () => {
  const before = process.env.OLLAMA_MODEL;
  try {
    process.env.OLLAMA_MODEL = "bad model";
    // No stored model: the environment value is the effective one.
    const envOnly = {
      judgmentProvider: "ollama",
      ollamaUrl: "http://localhost:11434",
    } as Providers;
    const config = judgmentConfiguration(envOnly);
    assert.equal(config.model, "nimble");
    assert.match(config.error ?? "", /model name "bad model" is invalid/);
  } finally {
    if (before === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = before;
  }
});

test("the effective Ollama URL is validated and never raw", () => {
  const keys = ["OLLAMA_BASE_URL", "VELVARR_JUDGMENT_PROVIDER"] as const;
  const before = keys.map((k) => process.env[k]);
  try {
    process.env.VELVARR_JUDGMENT_PROVIDER = "ollama";
    // Userinfo and query parts must not survive into any admin response.
    process.env.OLLAMA_BASE_URL =
      "http://user:password@127.0.0.1:11434/?token=s3cret";
    const config = judgmentConfiguration();
    assert.equal(config.url, "");
    assert.match(config.error ?? "", /valid integration base URL/);
    const wire = JSON.stringify(config);
    assert.equal(wire.includes("user:password"), false);
    assert.equal(wire.includes("s3cret"), false);
    // A URL the validator rejects for plain HTTP reports the opt-in message.
    delete process.env.VELVARR_ALLOW_HTTP;
    const beforeAllow = process.env.VELVARR_ALLOW_HTTP;
    process.env.OLLAMA_BASE_URL = "http://host.docker.internal:11434";
    const rejected = judgmentConfiguration();
    assert.equal(rejected.url, "");
    assert.match(rejected.error ?? "", /VELVARR_ALLOW_HTTP=1/);
    assert.equal(beforeAllow, undefined);
    // A clean URL comes back validated (normalized), never as written.
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/";
    assert.equal(judgmentConfiguration().url, "http://127.0.0.1:11434");
    assert.equal(judgmentConfiguration().error, undefined);
  } finally {
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});

test("connection verification reports URL rejection and malformed answers", async () => {
  const before = process.env.VELVARR_ALLOW_HTTP;
  try {
    // A URL validateBaseUrl refuses: the check reports its message, no call.
    delete process.env.VELVARR_ALLOW_HTTP;
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return response({ ready: { type: "noul", noul: 0.99 } });
      },
      async () => {
        const refused = await checkJudgmentConnection({
          ...local,
          ollamaUrl: "http://host.docker.internal:11434",
        });
        assert.equal(refused.connected, false);
        assert.match(refused.error ?? "", /VELVARR_ALLOW_HTTP=1/);
        assert.equal(calls, 0);
      },
    );
    // Any 2xx reply without a numeric answers.ready.noul is not "connected".
    for (const malformed of [{}, { ready: {} }, { ready: { noul: "0.9" } }]) {
      await withFetch(
        async () => response(malformed),
        async () => {
          const result = await checkJudgmentConnection(local);
          assert.equal(result.connected, false);
          assert.match(result.error ?? "", /well-formed/);
        },
      );
    }
  } finally {
    if (before === undefined) delete process.env.VELVARR_ALLOW_HTTP;
    else process.env.VELVARR_ALLOW_HTTP = before;
  }
});

test("one 30 s budget covers every local tag batch: one abort ends the reduction", async () => {
  const tags = Array.from({ length: 70 }, (_, i) => ({
    id: `tag-${i}`,
    name: `Tag ${i}`,
  }));
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  // Test-only patch: the real timeout starts the 30 s budget; the test needs
  // to count budgets and abort one on demand.
  const patchable = AbortSignal as unknown as {
    timeout: (milliseconds: number) => AbortSignal;
  };
  let budgets = 0;
  patchable.timeout = () => {
    budgets++;
    return controller.signal;
  };
  let calls = 0;
  try {
    await withFetch(
      async (_, init) => {
        calls++;
        if (calls === 2) {
          controller.abort();
          throw new Error("aborted mid-reduction");
        }
        const names = JSON.parse(String(init?.body)).state.tags;
        return response({
          pick: {
            type: "choice",
            choice: names[0],
            confidence: 0.9,
            probabilities: Object.fromEntries(
              names.map((n: string, i: number) => [n, i === 0 ? 0.9 : 0.01]),
            ),
          },
        });
      },
      async () => {
        assert.deepEqual(await suggestTags("anything", tags, local), []);
        assert.equal(calls, 2, "the abort ended the whole reduction");
        assert.equal(budgets, 1, "every batch shares one 30 s budget");
      },
    );
  } finally {
    patchable.timeout = originalTimeout;
  }
});
