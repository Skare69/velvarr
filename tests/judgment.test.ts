import assert from "node:assert/strict";
import test from "node:test";
import { candidatesMayMatch } from "../src/server/jellyfin.ts";
import {
  resetSameWorkBreaker,
  sameWork,
  suggestTags,
} from "../src/server/judgment.ts";

/** The judgment must be inert without a key: sameWork answers false and no
 * network call is possible. Runs first, before any test sets a key. */
test("sameWork without TYPESAFE_API_KEY is false without any call", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("no network call may happen without a key");
  };
  try {
    assert.equal(
      await sameWork({ title: "Up", year: 2009 }, { title: "Up", year: 2009 }),
      false,
    );
    assert.equal(calls, 0, "the no-key path must not reach the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const dto = (Name: string, ProductionYear?: number) => ({
  Name,
  ProductionYear,
});
const candidate = (Name: string, ProductionYear?: number) => ({
  dto: dto(Name, ProductionYear),
  paths: [],
  providerValues: [],
});
const hints = (title: string, year?: number) => ({
  provider: "tpdb" as const,
  kind: "movie" as const,
  id: "11111111-1111-4111-8111-111111111111",
  title,
  year,
});
const never = () => {
  throw new Error("judgment must not be called");
};

test("exact title/year agreement needs no judgment", async () => {
  const candidates = [candidate("Up", 2009), candidate("Other Film", 2015)];
  assert.equal(
    await candidatesMayMatch(candidates, hints("up", 2009), never),
    true,
  );
});

test("a near-miss is decided by the judgment, with the right state", async () => {
  const candidates = [
    candidate("Unrelated Documentary", 2018),
    candidate("Bond: No Time to Die", 2021),
  ];
  const calls: Array<
    [{ title: string; year?: number }, { title: string; year?: number }]
  > = [];
  assert.equal(
    await candidatesMayMatch(
      candidates,
      hints("No Time to Die", 2021),
      async (a, b) => {
        calls.push([a, b]);
        return true;
      },
    ),
    true,
  );
  // The prefilter skipped the documentary; only the shared-word candidate
  // reached the judgment, and the requested/candidate roles are correct.
  assert.deepEqual(
    calls.map(([a, b]) => [a.title, b.title]),
    [["No Time to Die", "Bond: No Time to Die"]],
  );
});

test("a judged no stays a no, exactly as before", async () => {
  const candidates = [candidate("No Time to Die Rising", 2021)];
  assert.equal(
    await candidatesMayMatch(
      candidates,
      hints("No Time to Die", 2021),
      async () => false,
    ),
    false,
  );
});

test("nothing in common never reaches the judgment", async () => {
  const candidates = [candidate("Completely Different Thing", 2019)];
  assert.equal(
    await candidatesMayMatch(candidates, hints("No Time to Die", 2021), never),
    false,
  );
});

test("the judgment is capped, so a bloated library cannot run away", async () => {
  const candidates = Array.from({ length: 60 }, (_, i) =>
    candidate(`No Time to Die cut ${i}`, 2021),
  );
  let calls = 0;
  assert.equal(
    await candidatesMayMatch(
      candidates,
      hints("No Time to Die", 2021),
      async () => {
        calls++;
        return false;
      },
    ),
    false,
  );
  assert.ok(calls <= 20, `expected at most 20 judgments, saw ${calls}`);
});

test(
  "the cap is judged concurrently, not one after another",
  // A sequential loop deadlocks on the pool-full gate below, so the test's
  // own timeout is the failure mode — no measured duration.
  { timeout: 2000 },
  async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate(`No Time to Die cut ${i}`, 2021),
    );
    let calls = 0;
    let inFlight = 0;
    let peak = 0;
    // Every judgment waits until a full pool is in flight, so overlap —
    // not a timer — is the awaited condition.
    const { promise, resolve } = Promise.withResolvers<void>();
    assert.equal(
      await candidatesMayMatch(
        candidates,
        hints("No Time to Die", 2021),
        async () => {
          calls++;
          inFlight++;
          peak = Math.max(peak, inFlight);
          if (inFlight === 5) resolve();
          await promise;
          inFlight--;
          return false;
        },
      ),
      false,
    );
    assert.equal(calls, 20, "every near-miss within the cap is judged");
    assert.equal(
      peak,
      5,
      `judgments must overlap, peak concurrency was ${peak}`,
    );
  },
);

test("a yes at the end of the pool still wins", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    candidate(`No Time to Die cut ${i}`, 2021),
  );
  let calls = 0;
  assert.equal(
    await candidatesMayMatch(
      candidates,
      hints("No Time to Die", 2021),
      async (_a, b) => {
        calls++;
        return b.title === "No Time to Die cut 19";
      },
    ),
    true,
  );
  assert.ok(calls <= 20, `expected at most 20 judgments, saw ${calls}`);
});

test("a real near-miss is judged even when 25 stop-word siblings crowd the pool", async () => {
  // Release-review repro: 25 "Into the Night NN" items share only the stop
  // word "the" with the ask, yet the old first-20 loop spent the whole
  // judgment cap on them in SortName order, so the naming variant at the
  // end of the alphabet was never judged and the verdict read missing.
  const candidates = Array.from({ length: 25 }, (_, i) =>
    candidate(`Into the Night ${String(i + 1).padStart(2, "0")}`, 2020),
  );
  candidates.push(candidate("Brazzers: The Office Affair", 2021));
  const calls: Array<[string, string]> = [];
  assert.equal(
    await candidatesMayMatch(
      candidates,
      hints("The Office Affair", 2021),
      async (a, b) => {
        calls.push([a.title, b.title]);
        return true;
      },
    ),
    true,
  );
  assert.deepEqual(calls, [
    ["The Office Affair", "Brazzers: The Office Affair"],
  ]);
});

test("a pool sharing only stop words never reaches the judgment", async () => {
  const candidates = [
    candidate("Into the Night", 2020),
    candidate("Her and the City", 2019),
  ];
  assert.equal(
    await candidatesMayMatch(candidates, hints("The Office Affair"), never),
    false,
  );
});

test("candidatesMayMatch feeds the performer into the judgment", async () => {
  const candidates = [candidate("Sunset Blvd with Maddie Wren", 2024)];
  let seen: { title: string; performer?: string; year?: number } | null = null;
  const result = await candidatesMayMatch(
    candidates,
    { ...hints("Sunset Blvd", 2024), performer: "Maddie Wren" },
    async (a) => {
      seen = a;
      return true;
    },
  );
  assert.equal(result, true);
  assert.deepEqual(seen, {
    title: "Sunset Blvd",
    performer: "Maddie Wren",
    year: 2024,
  });
});

test("sameWork asks the model and applies the probability gate", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const reply = (noul: number) =>
    new Response(
      JSON.stringify({
        answers: { sameWork: { type: "noul", noul } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  let bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return reply(0.93);
  };
  try {
    assert.equal(
      await sameWork(
        { title: "No Time to Die", year: 2021 },
        { title: "Bond: No Time to Die", year: 2021 },
      ),
      true,
    );
    // The model sees both records with their years; the question id is not
    // part of the payload's meaning, but the noul question is there.
    const payload = bodies[0] as {
      state: unknown;
      questions: Record<string, { type: string }>;
    };
    assert.deepEqual(payload.state, {
      requested: { title: "No Time to Die", year: 2021 },
      candidate: { title: "Bond: No Time to Die", year: 2021 },
    });
    assert.equal(payload.questions.sameWork?.type, "noul");

    // Below the gate: a maybe is not a yes.
    globalThis.fetch = async () => reply(0.5);
    assert.equal(
      await sameWork({ title: "No Time to Die" }, { title: "No Time 2 Die" }),
      false,
    );

    // An outage degrades to false, never to a guess.
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    assert.equal(
      await sameWork({ title: "Up" }, { title: "Up (2009)" }),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("an outage gates calls for a short window but is never pinned as a no", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let calls = 0;
  let down = true;
  globalThis.fetch = async () => {
    calls++;
    if (down) throw new Error("down");
    return new Response(
      JSON.stringify({ answers: { sameWork: { type: "noul", noul: 0.93 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const requested = { title: "Heat", year: 1995 };
  const candidate = { title: "Heat (Director's Cut)", year: 1995 };
  try {
    resetSameWorkBreaker();
    // The outage answers false but must not pin that "no" for the pair.
    assert.equal(await sameWork(requested, candidate), false);
    const afterOutage = calls;
    // The failure gate now skips calls for a short window: an outage must
    // not re-run the candidate cap on every availability check.
    assert.equal(await sameWork(requested, candidate), false);
    assert.equal(calls, afterOutage, "a failure gates calls for a window");
    // Once the window lapses (cleared here), the pair is asked again: the
    // outage was never stored as an answer.
    resetSameWorkBreaker();
    down = false;
    assert.equal(await sameWork(requested, candidate), true);
    assert.ok(calls > afterOutage, "the pair is asked again after the gate");
    const afterAnswer = calls;
    assert.equal(await sameWork(requested, candidate), true);
    assert.equal(calls, afterAnswer, "an answered pair is not asked again");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
    resetSameWorkBreaker();
  }
});

test(
  "a hanging endpoint is cut off after one attempt and trips the gate",
  // The SDK's internal per-attempt timeout is the real timer under test —
  // fake timers cannot reach into it — so the failure mode is the test's
  // own 6 s timeout, not a guessed sleep.
  { timeout: 6000 },
  async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (_url, init) => {
      calls++;
      // Never settles on its own — the endpoint hangs — but honors the
      // abort signal exactly like real fetch: the SDK's per-attempt
      // timeout works through that signal.
      const { promise, reject } = Promise.withResolvers<never>();
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }
      return promise;
    };
    // A pair no earlier test answered: the memo must not answer for it.
    const requested = { title: "Solaris", year: 1972 };
    const candidate = { title: "Solaris (Remastered)", year: 1972 };
    try {
      resetSameWorkBreaker();
      const t0 = Date.now();
      assert.equal(await sameWork(requested, candidate), false);
      const elapsed = Date.now() - t0;
      assert.ok(
        elapsed < 5000,
        `the per-attempt timeout must cut the call short, took ${elapsed} ms`,
      );
      assert.equal(calls, 1, "a hanging judgment must not be retried");
      // The gate trips: the next call makes no HTTP request at all.
      assert.equal(await sameWork(requested, candidate), false);
      assert.equal(calls, 1, "a failure gates the next call");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TYPESAFE_API_KEY;
      resetSameWorkBreaker();
    }
  },
);

test("contradicting years are refused in code, without a call", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("no call may be spent on a year mismatch");
  };
  try {
    assert.equal(
      await sameWork({ title: "Up", year: 2009 }, { title: "Up", year: 2021 }),
      false,
    );
    assert.equal(calls, 0, "contradicting years are refused before any call");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
  }
});

test("a stored admin-UI key works with no environment key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  resetSameWorkBreaker();
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return new Response(
      JSON.stringify({ answers: { sameWork: { type: "noul", noul: 0.93 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    assert.equal(
      await sameWork(
        { title: "Sunset Blvd", performer: "Maddie Wren", year: 2024 },
        { title: "Sunset Blvd with Maddie Wren", year: 2024 },
        "ts_stored_key",
      ),
      true,
    );
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("suggestTags offers the top three real tags and drops none and junk", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        answers: {
          pick: {
            type: "choice",
            choice: "Group",
            confidence: 0.9,
            probabilities: {
              Group: 0.55,
              "Made-up tag": 0.3,
              none: 0.1,
              Massage: 0.04,
              Fitness: 0.01,
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const tags = [
      { id: "g", name: "Group" },
      { id: "m", name: "Massage" },
      { id: "f", name: "Fitness" },
    ];
    // "Made-up tag" is not among the offered names, so it can never come
    // back; the none hatch is dropped; the top three real tags survive.
    assert.deepEqual(await suggestTags("threesome", tags, "ts_key"), [
      { id: "g", name: "Group" },
      { id: "m", name: "Massage" },
      { id: "f", name: "Fitness" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("suggestTags without a key or with an empty list offers nothing", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("no call may happen without a key");
  };
  try {
    assert.deepEqual(
      await suggestTags("threesome", [{ id: "g", name: "Group" }]),
      [],
    );
    assert.deepEqual(await suggestTags("threesome", [], "ts_key"), []);
    assert.equal(calls, 0, "neither the no-key nor the empty-list path calls");
  } finally {
    globalThis.fetch = realFetch;
  }
});
