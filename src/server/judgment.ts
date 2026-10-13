import { createHash } from "node:crypto";
import type { IntegrationConfig, JudgmentProvider } from "../lib/contracts.ts";
import { isJudgmentProvider, isOllamaModel } from "../lib/contracts.ts";
import { AppError, validateBaseUrl } from "./http.ts";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

/** Typed judgments over one question each, in the shape the TypeSafe docs
 * call "select instead of generate": the model answers a bounded question,
 * the code keeps every policy decision. Used where exact string equality is
 * the wrong tool, and where a wrong answer must never upgrade a verdict:
 * the same-work caller turns a yes into 'ambiguous for administrator
 * review', never into 'available'. */
const SAME_WORK_P = 0.7;

/** Calibration 2026-09-21 (jev-1.13.0, 19 labeled pairs): performer-aware
 * state fixes both performer errors of the blind prompt (0.44 FN -> 0.90,
 * 0.90 FP -> 0.12) while sequels and word-sharing distractors stay below
 * 0.2; the studio-prefix variant needs the 0.7 gate (0.73). */
const SAME_WORK_INSTRUCTIONS =
  "Do these two catalog records name the same work — the same movie or scene, " +
  "possibly under different punctuation, an alternate subtitle, or a transliterated spelling? " +
  "The requested record carries the performer's name; a candidate title that contains that " +
  "performer's name strengthens the case that both name the same scene. A candidate whose " +
  "title contains a DIFFERENT performer's name is a different work. A studio, network, or " +
  "site name prefixed before the title does not make it a different work. Answer no for " +
  "remakes, sequels, different works, or unrelated titles.";

export type WorkIdentity = {
  title: string;
  /** The performer's name — the field exact matching was blind to. */
  performer?: string;
  year?: number;
};

type JudgmentOptions = IntegrationConfig["providers"];

/** Effective, non-secret settings for the administrator UI and each caller.
 * Never throws: an invalid operator environment degrades to disabled
 * judgment features plus an `error` the admin card can show, so the
 * settings read and every PATCH response keep working. */
export function judgmentConfiguration(options?: JudgmentOptions): {
  provider: JudgmentProvider;
  /** Validated outbound URL — userinfo, query, and fragments stripped; ""
   * when validation failed (see `error`). */
  url: string;
  model: string;
  configured: boolean;
  stored: boolean;
  /** Degradation reason; absent when the effective settings are valid. */
  error?: string;
} {
  const stored = options;
  const providerRaw =
    (stored?.judgmentProvider ??
      process.env.VELVARR_JUDGMENT_PROVIDER?.trim()) ||
    "typesafe";
  const provider = isJudgmentProvider(providerRaw) ? providerRaw : "typesafe";
  const errors: string[] = [];
  if (provider !== providerRaw) {
    errors.push(
      `VELVARR_JUDGMENT_PROVIDER has an invalid value ${JSON.stringify(providerRaw)}; judgment features stay disabled until it is "typesafe" or "ollama".`,
    );
  }
  const rawUrl =
    (stored?.ollamaUrl ?? process.env.OLLAMA_BASE_URL?.trim()) || "";
  let url = "";
  if (rawUrl === "") {
    url = validateBaseUrl("http://localhost:11434");
  } else {
    try {
      url = validateBaseUrl(rawUrl);
    } catch (err) {
      errors.push(
        err instanceof AppError
          ? err.message
          : "The Ollama URL is not a valid integration base URL.",
      );
    }
  }
  const rawModel =
    stored?.ollamaModel ?? process.env.OLLAMA_MODEL?.trim() ?? "";
  let model = "nimble";
  if (rawModel !== "") {
    if (isOllamaModel(rawModel)) {
      model = rawModel;
    } else {
      errors.push(
        `The Ollama model name ${JSON.stringify(rawModel)} is invalid; falling back to ${model}.`,
      );
    }
  }
  const keyPresent = Boolean(
    stored?.typesafeApiKey?.trim() || process.env.TYPESAFE_API_KEY?.trim(),
  );
  const valid = errors.length === 0;
  return {
    provider,
    url,
    model,
    configured: valid && (provider === "ollama" || keyPresent),
    stored:
      stored?.judgmentProvider !== undefined ||
      stored?.ollamaUrl !== undefined ||
      stored?.ollamaModel !== undefined,
    ...(errors.length > 0 ? { error: errors.join(" ") } : {}),
  };
}

let cached: { identity: string; client: TypeSafeClient } | null = null;

/** Both servers speak System One; provider selection never falls back to cloud. */
function judgmentBackend(options?: JudgmentOptions) {
  const settings = judgmentConfiguration(options);
  if (!settings.configured || settings.error !== undefined) return null;
  const local = settings.provider === "ollama";
  const key = local
    ? "ollama"
    : options?.typesafeApiKey?.trim() || process.env.TYPESAFE_API_KEY!.trim();
  const url = local ? settings.url : process.env.TYPESAFE_BASE_URL?.trim();
  const model = local
    ? settings.model
    : process.env.TYPESAFE_DEFAULT_MODEL?.trim();
  const identity = createHash("sha256")
    .update(JSON.stringify([settings.provider, url, model, key]))
    .digest("hex");
  if (cached?.identity !== identity) {
    cached = {
      identity,
      client: new TypeSafeClient({
        apiKey: key,
        ...(url ? { baseURL: url } : {}),
        ...(model ? { defaultModel: model } : {}),
        timeout: local ? 30000 : 8000,
        ...(local
          ? {
              retry: { maxRetries: 0 },
              // The SDK requires a placeholder key; local Ollama receives no credential.
              fetch: (input, init) => {
                const headers = new Headers(init?.headers);
                headers.delete("authorization");
                return globalThis.fetch(input, {
                  ...init,
                  headers,
                  redirect: "error",
                });
              },
            }
          : {}),
      }),
    };
  }
  return { ...cached, provider: settings.provider };
}

/** Capability checks degrade to disabled when an operator supplied invalid settings. */
export function judgmentConfigured(options?: JudgmentOptions): boolean {
  return judgmentBackend(options) !== null;
}

/** Probe the configured model with one bounded decision, without catalog data. */
export async function checkJudgmentConnection(options?: JudgmentOptions) {
  const settings = judgmentConfiguration(options);
  if (settings.error !== undefined)
    return {
      provider: settings.provider,
      connected: false,
      error: settings.error,
    };
  if (!settings.configured)
    return {
      provider: settings.provider,
      connected: false,
      error: "No TypeSafe API key is configured.",
    };
  try {
    const backend = judgmentBackend(options)!;
    const res = await backend.client.systemOne({
      state: "The service is running.",
      questions: { ready: noul("Does the state say the service is running?") },
    });
    const answer: unknown = res.answers.ready;
    const ready =
      answer !== null && typeof answer === "object" && "noul" in answer
        ? answer.noul
        : undefined;
    if (typeof ready !== "number" || !Number.isFinite(ready)) {
      return {
        provider: settings.provider,
        connected: false,
        error:
          settings.provider === "ollama"
            ? "Ollama did not return a well-formed decision. Check its URL, model, and support for /v1/systemone (Ollama 0.35 or later)."
            : "TypeSafe did not return a well-formed decision. Check its API key and connection.",
      };
    }
    return { provider: settings.provider, connected: true };
  } catch {
    return {
      provider: settings.provider,
      connected: false,
      error:
        settings.provider === "ollama"
          ? "Ollama could not answer a decision. Check its URL, model, and support for /v1/systemone (Ollama 0.35 or later)."
          : "TypeSafe could not answer a decision. Check its API key and connection.",
    };
  }
}

// Answered same-work judgments: the answer depends only on the two
// identities, and availability re-asks the same near-miss pairs on every
// check. Failures are never stored, so an outage cannot pin a "no".
// ponytail: in-memory, 2,000-pair FIFO cap; persist only if restarts make the
// re-asking cost visible.
const SAME_WORK_MEMO_MAX = 2000;
const sameWorkMemo = new Map<string, boolean>();

// After a failed call, judgment calls are skipped for this window: an
// outage must not re-run the candidate cap on every availability check.
// Only calls are gated — answers are never stored on failure, and the memo
// is read before the gate, so an answered pair keeps answering.
const SAME_WORK_BREAKER_MS = 15_000;
const sameWorkDownUntil = new Map<string, number>();

/** Test hook: clears the failure gate (same pattern as resetSweepCache). */
export function resetSameWorkBreaker(): void {
  sameWorkDownUntil.clear();
}

/** P(same work) between the requested record and a library candidate. The
 * year policy stays in code: two records with contradicting years are never
 * the same work, and no call is spent asking. */
export async function sameWork(
  a: WorkIdentity,
  b: WorkIdentity,
  options?: JudgmentOptions,
): Promise<boolean> {
  let backend: ReturnType<typeof judgmentBackend>;
  try {
    backend = judgmentBackend(options);
  } catch {
    return false;
  }
  if (!backend) return false;
  const ts = backend.client;
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) {
    return false;
  }
  const memoKey = JSON.stringify([backend.identity, a, b]);
  const known = sameWorkMemo.get(memoKey);
  if (known !== undefined) return known;
  if (Date.now() < (sameWorkDownUntil.get(backend.identity) ?? 0)) return false;
  try {
    const res = await ts.systemOne(
      {
        state: { requested: a, candidate: b },
        questions: {
          sameWork: noul(SAME_WORK_INSTRUCTIONS, {
            true: "Both records name the same work.",
            false: "These are different works.",
          }),
        },
      },
      // One attempt: local inference retains its 30 s allowance; cloud
      // calls stay short because the widen step sits on the availability path.
      // The SDK's default retries (2 attempts, Retry-After up to 60 s)
      // serialized a TypeSafe outage into minutes across the candidate cap.
      {
        timeout: backend.provider === "ollama" ? 30000 : 2000,
        retry: { maxRetries: 0 },
      },
    );
    const same = res.answers.sameWork.noul >= SAME_WORK_P;
    if (sameWorkMemo.size >= SAME_WORK_MEMO_MAX) {
      sameWorkMemo.delete(sameWorkMemo.keys().next().value!);
    }
    sameWorkMemo.set(memoKey, same);
    return same;
  } catch {
    // An outage or a malformed answer degrades to exact matching, never
    // to a guess — and trips the short call gate above.
    // A failed model or endpoint must not suppress another backend.
    if (sameWorkDownUntil.size >= SAME_WORK_MEMO_MAX) {
      sameWorkDownUntil.delete(sameWorkDownUntil.keys().next().value!);
    }
    sameWorkDownUntil.set(backend.identity, Date.now() + SAME_WORK_BREAKER_MS);
    return false;
  }
}

/** Select only real provider tags; transport failures abort the whole local reduction. */
async function chooseTags(
  backend: NonNullable<ReturnType<typeof judgmentBackend>>,
  term: string,
  tags: { id: string; name: string }[],
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const ts = backend.client;
  const res = await ts.systemOne(
    {
      state: { term, tags: tags.map((t) => t.name) },
      questions: {
        pick: choice(
          "The user typed a plain-language term into a catalog tag filter. " +
            "Which single tag from the list best matches what they are looking for? " +
            "If no tag reasonably matches, choose none.",
          Object.fromEntries([
            ...tags.map((t) => [t.name, null]),
            ["none", "No tag in the list reasonably matches the term."],
          ]),
        ),
      },
    },
    { signal },
  );
  if (backend.provider === "ollama" && res.answers.pick.choice === "none")
    return [];
  const ranked = Object.entries(
    res.answers.pick.probabilities as Record<string, number>,
  )
    .filter(([name]) => name !== "none" && tags.some((t) => t.name === name))
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([name]) => tags.find((t) => t.name === name)!);
  return ranked;
}

/** Suggest up to three real tags. Local reductions share one 30-second budget. */
export async function suggestTags(
  term: string,
  tags: { id: string; name: string }[],
  options?: JudgmentOptions,
): Promise<{ id: string; name: string }[]> {
  if (tags.length === 0) return [];
  try {
    const backend = judgmentBackend(options);
    if (!backend) return [];
    const local = backend.provider === "ollama";
    const signal = local ? AbortSignal.timeout(30000) : undefined;
    // Local choice questions allow 26 options, including none. Every batch
    // uses the same rubric; a final choice ranks the surviving real tags.
    let candidates = tags;
    while (local && candidates.length > 25) {
      const selected: typeof tags = [];
      for (let start = 0; start < candidates.length; start += 25) {
        selected.push(
          ...(await chooseTags(
            backend,
            term,
            candidates.slice(start, start + 25),
            signal,
          )),
        );
      }
      candidates = selected;
      if (candidates.length === 0) return [];
    }
    return await chooseTags(backend, term, candidates, signal);
  } catch {
    return [];
  }
}

/** One side of a related-titles rerank: provider-published catalog metadata
 * only — title, tag names, studio name, release year. Never provider ids,
 * urls, account data, or preferences: the Jev request must stay a pure
 * metadata comparison between catalog records. */
export type RankableTitle = {
  title: string;
  tags?: string[];
  studio?: string;
  year?: number;
};

/** Rerank rubric: three ordered levels, indexed 0..2. Comparable across the
 * shortlist because every candidate answers the same question. */
const RANK_LEVELS = [
  "Shares nothing with the source — no theme, subject, or series in common.",
  "Loosely related — only minor context in common; not a natural recommendation next to the source.",
  "Strongly related — same series, subject, or core theme; a natural recommendation next to the source.",
] as const;

/** Reranks an already-safe related-titles shortlist by how strongly each
 * candidate's metadata relates to the seed. ONE request: one narrow Score
 * question per candidate, each referencing only that candidate's slot in the
 * state. Returns the same candidate objects reordered — a permutation, no
 * item added, dropped, or invented — or null when there is no key, the
 * shortlist is not a bounded rerank (0/1 items or more than 12), or any
 * answer is missing, malformed, or out of range; the caller keeps its
 * deterministic tag ordering in every null case. No confidence threshold:
 * the model only reorders candidates code has already vetted. */
export async function rankRelatedTitles<T extends RankableTitle>(
  seed: RankableTitle,
  candidates: T[],
  options?: JudgmentOptions,
): Promise<T[] | null> {
  if (candidates.length <= 1 || candidates.length > 12) return null;
  try {
    const backend = judgmentBackend(options);
    if (!backend) return null;
    const ts = backend.client;
    const res = await ts.systemOne({
      state: {
        source: seed,
        candidates: candidates.map((c) => ({
          title: c.title,
          ...(c.tags !== undefined ? { tags: c.tags } : {}),
          ...(c.studio !== undefined ? { studio: c.studio } : {}),
          ...(c.year !== undefined ? { year: c.year } : {}),
        })),
      },
      questions: Object.fromEntries(
        candidates.map((_, i) => [
          `c${i}`,
          score(
            `How related is the catalog title \`candidates[${i}]\` to \`source\`? ` +
              "Judge only from the metadata in the state (titles, tags, studios, years). " +
              "This orders a related-titles rail: a metadata comparison, never a " +
              "preference — popularity, explicitness, or anything about a viewer or " +
              "account must not move the score.",
            RANK_LEVELS,
          ),
        ]),
      ),
    });
    const answers = res.answers as Record<string, unknown>;
    const scored: { item: T; order: number; value: number }[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const answer = answers[`c${i}`];
      const value =
        typeof answer === "object" &&
        answer !== null &&
        "type" in answer &&
        answer.type === "score" &&
        "score" in answer
          ? answer.score
          : undefined;
      // One incomplete or malformed answer voids the whole rerank: the
      // deterministic tag ordering is never mixed with a partial one.
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > RANK_LEVELS.length - 1
      ) {
        return null;
      }
      scored.push({ item: candidates[i]!, order: i, value });
    }
    return scored
      .sort((a, b) => b.value - a.value || a.order - b.order)
      .map((e) => e.item);
  } catch {
    // Outage or unusable response: the original ordering stands.
    return null;
  }
}

// ponytail: every call costs one API round trip; the same-work call sits on
// the availability path but only fires for near-miss candidates that the
// exact matcher already missed. If that ever gets busy, cache
// (requestedId, candidateId) -> noul in SQLite and (term) -> suggestions
// until the tag list changes.
