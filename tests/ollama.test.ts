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
  judgmentConfigured,
  tagSuggestionsAllowed,
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

// --- VELV-6 survivor killers ---

const JUDGMENT_ENV_KEYS = [
  "VELVARR_JUDGMENT_PROVIDER",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
] as const;

async function withEnv(
  env: Partial<Record<(typeof JUDGMENT_ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<void> | void,
) {
  const original = new Map(JUDGMENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of original) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("judgmentConfiguration reports which settings an administrator stored", () => {
  assert.equal(judgmentConfiguration().stored, false);
  assert.equal(
    judgmentConfiguration({ judgmentProvider: "ollama" }).stored,
    true,
  );
  assert.equal(
    judgmentConfiguration({ judgmentProvider: "typesafe" }).stored,
    true,
  );
  assert.equal(
    judgmentConfiguration({ ollamaUrl: "http://127.0.0.1:11434" }).stored,
    true,
  );
  assert.equal(judgmentConfiguration({ ollamaModel: "m" }).stored, true);
});

test("an invalid environment provider and URL degrade with a combined error", () => {
  const keys = [
    "VELVARR_JUDGMENT_PROVIDER",
    "OLLAMA_BASE_URL",
    "TYPESAFE_API_KEY",
  ] as const;
  const before = keys.map((k) => process.env[k]);
  try {
    process.env.VELVARR_JUDGMENT_PROVIDER = "bogus";
    process.env.OLLAMA_BASE_URL = "not a url";
    process.env.TYPESAFE_API_KEY = "k";
    const settings = judgmentConfiguration();
    assert.equal(settings.configured, false);
    // Both degradation reasons are present, joined by a single space.
    assert.equal(
      settings.error,
      'VELVARR_JUDGMENT_PROVIDER has an invalid value "bogus"; ' +
        'judgment features stay disabled until it is "typesafe" or "ollama". ' +
        "A valid integration base URL is required.",
    );
  } finally {
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});

test("environment values are trimmed before use", async () => {
  await withEnv({ VELVARR_JUDGMENT_PROVIDER: " ollama " }, () => {
    const settings = judgmentConfiguration();
    assert.equal(settings.provider, "ollama");
    assert.equal(settings.error, undefined);
  });
  await withEnv({ OLLAMA_MODEL: " nimble:4b " }, () => {
    assert.equal(judgmentConfiguration().model, "nimble:4b");
  });
  await withEnv({ OLLAMA_BASE_URL: " http://localhost:11434 " }, () => {
    const settings = judgmentConfiguration();
    assert.equal(settings.url, "http://localhost:11434");
    assert.equal(settings.error, undefined);
  });
  // No URL at all falls back to the local default.
  await withEnv({ OLLAMA_BASE_URL: undefined }, () => {
    assert.equal(judgmentConfiguration().url, "http://localhost:11434");
  });
});

test("tag suggestions stay gated on a stored backend, never an environment one", async () => {
  assert.equal(tagSuggestionsAllowed(), false);
  assert.equal(tagSuggestionsAllowed({}), false);
  assert.equal(tagSuggestionsAllowed({ typesafeApiKey: "   " }), false);
  assert.equal(tagSuggestionsAllowed({ typesafeApiKey: "k" }), true);
  await withEnv({ VELVARR_JUDGMENT_PROVIDER: "ollama" }, () => {
    assert.equal(judgmentConfigured(undefined), true);
    assert.equal(tagSuggestionsAllowed(undefined), false);
  });
});

test("capability checks reflect the effective backend only", async () => {
  await withEnv({ TYPESAFE_API_KEY: undefined }, () => {
    assert.equal(judgmentConfigured(undefined), false);
  });
  assert.equal(judgmentConfigured(local), true);
  // A whitespace-only key is unconfigured, stored or from the environment.
  assert.equal(
    judgmentConfiguration({ typesafeApiKey: "   " }).configured,
    false,
  );
  await withEnv({ TYPESAFE_API_KEY: "   " }, () => {
    assert.equal(judgmentConfiguration().configured, false);
  });
});

test("a degraded configuration never advertises a backend", async () => {
  await withEnv(
    { VELVARR_JUDGMENT_PROVIDER: "bogus", TYPESAFE_API_KEY: "k" },
    () => {
      assert.equal(judgmentConfigured(undefined), false);
    },
  );
});

test("connection checks name an unconfigured backend exactly", async () => {
  await withEnv(
    { TYPESAFE_API_KEY: undefined, VELVARR_JUDGMENT_PROVIDER: undefined },
    async () => {
      assert.deepEqual(await checkJudgmentConnection(undefined), {
        provider: judgmentConfiguration().provider,
        connected: false,
        error: "No TypeSafe API key is configured.",
      });
    },
  );
});

test("a malformed probe answer reports the provider-specific decision error", async () => {
  let asked = "";
  await withFetch(
    async (_, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.questions.ready.type, "noul");
      assert.equal(
        payload.questions.ready.instructions,
        "Does the state say the service is running?",
      );
      asked = payload.state;
      return response({ ready: { type: "noul", noul: "yes" } });
    },
    async () => {
      const result = await checkJudgmentConnection(local);
      assert.equal(result.connected, false);
      assert.match(result.error ?? "", /did not return a well-formed decision/);
      assert.match(result.error ?? "", /0\.35/);
      assert.equal(asked, "The service is running.");
    },
  );
});

test("a probe transport failure reports the catch-branch copy", async () => {
  await withFetch(
    async () => {
      throw new Error("connection refused");
    },
    async () => {
      const result = await checkJudgmentConnection(local);
      assert.equal(result.connected, false);
      assert.match(result.error ?? "", /could not answer a decision/);
    },
  );
});

test("cloud probes report the TypeSafe copies on both failure branches", async () => {
  await withEnv({ TYPESAFE_API_KEY: "k" }, async () => {
    const malformed = async (ready: unknown) => {
      await withFetch(
        async () => response({ ready }),
        async () => {
          const result = await checkJudgmentConnection(undefined);
          assert.equal(result.connected, false);
          assert.equal(
            result.error,
            "TypeSafe did not return a well-formed decision. Check its API key and connection.",
          );
        },
      );
    };
    // A null answer must take the malformed branch, not blow up into the
    // transport catch; a non-number answer is malformed all the same.
    await malformed(null);
    await malformed("yes");
    await withFetch(
      async () => {
        throw new Error("typesafe down");
      },
      async () => {
        const result = await checkJudgmentConnection(undefined);
        assert.equal(result.connected, false);
        assert.equal(
          result.error,
          "TypeSafe could not answer a decision. Check its API key and connection.",
        );
      },
    );
  });
});

test("the year policy stays in code and never spends a call", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return response({ sameWork: { type: "noul", noul: 0.9 } });
    },
    async () => {
      assert.equal(
        await sameWork(
          { title: "YearPolicyA", year: 2020 },
          { title: "YearPolicyB", year: 2021 },
          local,
        ),
        false,
      );
      assert.equal(calls, 0, "contradicting years never reach the model");

      assert.equal(
        await sameWork(
          { title: "YearPolicyC" },
          { title: "YearPolicyD", year: 2021 },
          local,
        ),
        true,
      );
      assert.equal(calls, 1, "a missing year on one side still asks");

      assert.equal(
        await sameWork(
          { title: "YearPolicyE", year: 2020 },
          { title: "YearPolicyF", year: 2020 },
          local,
        ),
        true,
      );
      assert.equal(calls, 2, "equal years still ask");

      assert.equal(
        await sameWork(
          { title: "YearPolicyG" },
          { title: "YearPolicyH" },
          local,
        ),
        true,
      );
      assert.equal(calls, 3);

      // A missing year on the candidate side asks just the same.
      assert.equal(
        await sameWork(
          { title: "YearPolicyI", year: 2021 },
          { title: "YearPolicyJ" },
          local,
        ),
        true,
      );
      assert.equal(calls, 4, "a missing candidate year still asks");
    },
  );
});

test("a failed judgment call answers false without throwing", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      throw new Error("ollama down");
    },
    async () => {
      assert.equal(
        await sameWork(requested, { title: "FailureProbe" }, local),
        false,
      );
      assert.equal(calls, 1, "the failure reached the model exactly once");
    },
  );
});

test("an answer exactly at the gate counts as the same work", async () => {
  await withFetch(
    async () => response({ sameWork: { type: "noul", noul: 0.7 } }),
    async () => {
      assert.equal(
        await sameWork(
          { title: "GateBoundaryA" },
          { title: "GateBoundaryB" },
          local,
        ),
        true,
      );
    },
  );
});

test(
  "the same-work memo evicts its oldest pair at the cap",
  { timeout: 30000 },
  async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return response({ sameWork: { type: "noul", noul: 0.9 } });
      },
      async () => {
        const requested = { title: "MemoEvictSeed" };
        for (let i = 0; i < 2001; i++) {
          await sameWork(requested, { title: `MemoEvict${i}` }, local);
        }
        const afterFill = calls;
        // The oldest entry was evicted: the i=0 pair is asked again.
        await sameWork(requested, { title: "MemoEvict0" }, local);
        assert.equal(calls, afterFill + 1, "the oldest pair was evicted");
        // The newest pair is still memoized.
        await sameWork(requested, { title: "MemoEvict1999" }, local);
        assert.equal(calls, afterFill + 1, "the newest pair stays memoized");
      },
    );
  },
);

test("empty tag lists and unconfigured backends never call the model", async () => {
  await withFetch(
    async () => {
      throw new Error("must not call the model");
    },
    async () => {
      assert.deepEqual(await suggestTags("term", [], local), []);
    },
  );
  await withEnv(
    { TYPESAFE_API_KEY: undefined, VELVARR_JUDGMENT_PROVIDER: undefined },
    async () => {
      assert.deepEqual(await suggestTags("term", [{ id: "t", name: "T" }]), []);
    },
  );
});

test("a 25-tag list needs exactly one bounded choice request", async () => {
  let calls = 0;
  const tags = Array.from({ length: 25 }, (_, i) => ({
    id: `t${i}`,
    name: `tag${i}`,
  }));
  await withFetch(
    async (_, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      const names: string[] = payload.state.tags;
      assert.match(payload.questions.pick.instructions, /plain-language term/);
      assert.match(payload.questions.pick.instructions, /choose none\./);
      assert.ok(
        JSON.stringify(payload).includes(
          "No tag in the list reasonably matches the term.",
        ),
      );
      assert.ok(
        init?.signal instanceof AbortSignal,
        "local calls carry the abort budget",
      );
      return response({
        pick: {
          type: "choice",
          choice: names[0],
          probabilities: Object.fromEntries(
            names.map((n, i) => [n, (names.length - i) / names.length]),
          ),
        },
      });
    },
    async () => {
      const result = await suggestTags("term", tags, local);
      assert.equal(calls, 1, "25 tags fit one choice request without batching");
      assert.equal(result.length, 3);
    },
  );
});

test("26 tags batch 25-plus-1 and combine the chosen real tags", async () => {
  const calls: { tags: string[]; type: string }[] = [];
  const tags = Array.from({ length: 26 }, (_, i) => ({
    id: `t${i}`,
    name: `tag${i}`,
  }));
  await withFetch(
    async (_, init) => {
      const payload = JSON.parse(String(init?.body));
      const names: string[] = payload.state.tags;
      calls.push({ tags: names, type: payload.questions.pick.type });
      return response({
        pick: {
          type: "choice",
          choice: names[0],
          probabilities: Object.fromEntries(
            names.map((n, i) => [n, (names.length - i) / names.length]),
          ),
        },
      });
    },
    async () => {
      const result = await suggestTags("term", tags, local);
      assert.deepEqual(
        calls.map((c) => c.tags.length),
        [25, 1, 4],
      );
      assert.ok(calls.every((c) => c.type === "choice"));
      // Every batch chooses its strongest tag; the final pick ranks the
      // survivors by probability: tag0, tag1, tag2.
      assert.deepEqual(
        result.map((t) => t.name),
        ["tag0", "tag1", "tag2"],
      );
    },
  );
});

test("the final pick keeps only real tags in probability order and honors none", async () => {
  const tags = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    name: `t${i}`,
  }));
  const pick = (choice: string) => async () =>
    response({
      pick: {
        type: "choice",
        choice,
        probabilities: {
          t0: 0.9,
          t1: 0.8,
          t2: 0.7,
          t3: 0.6,
          t4: 0.5,
          unknown: 0.99,
        },
      },
    });
  await withFetch(pick("t2"), async () => {
    assert.deepEqual(
      (await suggestTags("term", tags, local)).map((t) => t.name),
      ["t0", "t1", "t2"],
    );
  });
  await withFetch(pick("none"), async () => {
    assert.deepEqual(await suggestTags("term", tags, local), []);
  });
});

test("the cloud backend trims its environment settings and carries the credential", async () => {
  let url = "";
  let auth: string | null = "";
  let model = "";
  const tags = [
    { id: "t0", name: "t0" },
    { id: "t1", name: "t1" },
  ];
  await withEnv(
    {
      TYPESAFE_API_KEY: " k ",
      TYPESAFE_BASE_URL: " http://127.0.0.1:9 ",
      TYPESAFE_DEFAULT_MODEL: " m ",
    },
    async () => {
      await withFetch(
        async (input, init) => {
          url = String(input);
          auth = new Headers(init?.headers).get("authorization");
          model = JSON.parse(String(init?.body)).model;
          return response({
            pick: {
              type: "choice",
              choice: "t0",
              probabilities: { t0: 0.9, t1: 0.8 },
            },
          });
        },
        async () => {
          assert.deepEqual(
            (await suggestTags("term", tags, undefined)).map((t) => t.name),
            ["t0", "t1"],
          );
          // The environment-only cloud backend advertises capability, and a
          // stored padded key trims before it becomes the credential.
          assert.equal(judgmentConfigured(undefined), true);
          assert.deepEqual(
            (await suggestTags("term", tags, { typesafeApiKey: " k " })).map(
              (t) => t.name,
            ),
            ["t0", "t1"],
          );
          assert.equal(auth, "Bearer k");
        },
      );
    },
  );
  assert.equal(url, "http://127.0.0.1:9/v1/systemone");
  assert.equal(auth, "Bearer k");
  assert.equal(model, "m");
});

test("a cloud pick of none still reduces by probability order", async () => {
  const tags = [
    { id: "t0", name: "t0" },
    { id: "t1", name: "t1" },
  ];
  await withEnv({ TYPESAFE_API_KEY: "k" }, async () => {
    await withFetch(
      async () =>
        response({
          pick: {
            type: "choice",
            choice: "none",
            probabilities: { t0: 0.9, t1: 0.8 },
          },
        }),
      async () => {
        assert.deepEqual(
          (await suggestTags("term", tags, undefined)).map((t) => t.name),
          ["t0", "t1"],
        );
      },
    );
  });
});

test("a 50-tag list batches as two 25-tag choice requests", async () => {
  const sizes: number[] = [];
  const tags = Array.from({ length: 50 }, (_, i) => ({
    id: `t${i}`,
    name: `tag${i}`,
  }));
  await withFetch(
    async (_, init) => {
      const names: string[] = JSON.parse(String(init?.body)).state.tags;
      sizes.push(names.length);
      return response({
        pick: {
          type: "choice",
          choice: names[0],
          probabilities: Object.fromEntries(
            names.map((n, i) => [n, (names.length - i) / names.length]),
          ),
        },
      });
    },
    async () => {
      const result = await suggestTags("term", tags, local);
      // Each 25-tag batch feeds its top-3 into the final pick: 3 + 3 = 6.
      assert.deepEqual(sizes, [25, 25, 6]);
      assert.equal(result.length, 3);
    },
  );
});

test("batches that all answer none end the reduction without a final call", async () => {
  let calls = 0;
  const tags = Array.from({ length: 26 }, (_, i) => ({
    id: `t${i}`,
    name: `tag${i}`,
  }));
  await withFetch(
    async () => {
      calls++;
      return response({
        pick: { type: "choice", choice: "none", probabilities: {} },
      });
    },
    async () => {
      assert.deepEqual(await suggestTags("term", tags, local), []);
      assert.equal(calls, 2, "the emptied reduction never asks a final pick");
    },
  );
});

test("ranking bounds refuse to call the model", async () => {
  const seed = { title: "Seed" };
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      throw new Error("must not call the model");
    },
    async () => {
      assert.equal(
        await rankRelatedTitles(seed, [{ title: "only" }], local),
        null,
      );
      assert.equal(
        await rankRelatedTitles(
          seed,
          Array.from({ length: 13 }, (_, i) => ({ title: `c${i}` })),
          local,
        ),
        null,
      );
      assert.equal(calls, 0, "out-of-bounds shortlists never reach the model");
    },
  );
});

test("the ranking cap of twelve sends one score question per candidate", async () => {
  let calls = 0;
  const candidates = Array.from({ length: 12 }, (_, i) => ({ title: `c${i}` }));
  await withFetch(
    async (_, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.state.candidates.length, 12);
      const questions = Object.values<Record<string, unknown>>(
        payload.questions,
      );
      assert.equal(questions.length, 12);
      assert.ok(questions.every((q) => q.type === "score"));
      assert.match(
        String(questions[0]!.instructions),
        /How related is the catalog title `candidates\[0\]` to `source`/,
      );
      assert.ok(
        questions.every((q) =>
          String(q.instructions).includes("never a preference"),
        ),
      );
      return response(
        Object.fromEntries(
          candidates.map((_, i) => [`c${i}`, { type: "score", score: 1 }]),
        ),
      );
    },
    async () => {
      const result = await rankRelatedTitles(
        { title: "Seed" },
        candidates,
        local,
      );
      assert.equal(calls, 1);
      assert.equal(result?.length, 12);
    },
  );
});

test("one malformed score answer voids the whole rerank", async () => {
  const seed = { title: "Seed" };
  const candidates = [{ title: "c0" }, { title: "c1" }];
  const expectVoid = (answers: unknown) =>
    withFetch(
      async () => response(answers),
      async () => {
        assert.equal(await rankRelatedTitles(seed, candidates, local), null);
      },
    );
  await expectVoid({ c0: { score: 1 }, c1: { type: "score", score: 1 } });
  await expectVoid({ c0: { type: "score" }, c1: { type: "score", score: 1 } });
  await expectVoid({
    c0: { type: "score", score: "high" },
    c1: { type: "score", score: 1 },
  });
  await expectVoid({
    c0: { type: "score", score: -0.5 },
    c1: { type: "score", score: 1 },
  });
  await expectVoid({
    c0: { type: "score", score: 3 },
    c1: { type: "score", score: 1 },
  });
  // A score value riding a non-score answer type is still malformed: only
  // score-typed answers count, whatever numeric payload they carry.
  await expectVoid({
    c0: { type: "noul", noul: 1, score: 1 },
    c1: { type: "score", score: 1 },
  });
});

test("ranking orders by score with the original order breaking ties", async () => {
  const candidates = [{ title: "c0" }, { title: "c1" }, { title: "c2" }];
  await withFetch(
    async () =>
      response({
        c0: { type: "score", score: 0 },
        c1: { type: "score", score: 2 },
        c2: { type: "score", score: 2 },
      }),
    async () => {
      const result = await rankRelatedTitles(
        { title: "Seed" },
        candidates,
        local,
      );
      assert.deepEqual(
        result?.map((c) => c.title),
        ["c1", "c2", "c0"],
      );
    },
  );
  // The same tie with the tied pair leading: original order holds.
  await withFetch(
    async () =>
      response({
        c0: { type: "score", score: 2 },
        c1: { type: "score", score: 2 },
        c2: { type: "score", score: 0 },
      }),
    async () => {
      const result = await rankRelatedTitles(
        { title: "Seed" },
        candidates,
        local,
      );
      assert.deepEqual(
        result?.map((c) => c.title),
        ["c0", "c1", "c2"],
      );
    },
  );
});
