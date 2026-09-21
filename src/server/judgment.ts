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

// Built once per key value; no key anywhere disables every judgment
// outright, which is the default deployment. The stored admin-UI key wins
// over the environment, same precedence as the provider credentials.
let cached: { key: string; client: TypeSafeClient } | null = null;

function typeSafe(stored: string | undefined): TypeSafeClient | null {
  const key = stored?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (key === "") return null;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new TypeSafeClient({ apiKey: key, timeout: 8000 }),
    };
  }
  return cached.client;
}

/** P(same work) between the requested record and a library candidate. The
 * year policy stays in code: two records with contradicting years are never
 * the same work, and no call is spent asking. */
export async function sameWork(
  a: WorkIdentity,
  b: WorkIdentity,
  storedKey?: string,
): Promise<boolean> {
  const ts = typeSafe(storedKey);
  if (!ts) return false;
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) {
    return false;
  }
  try {
    const res = await ts.systemOne({
      state: { requested: a, candidate: b },
      questions: {
        sameWork: noul(SAME_WORK_INSTRUCTIONS, {
          true: "Both records name the same work.",
          false: "These are different works.",
        }),
      },
    });
    return res.answers.sameWork.noul >= SAME_WORK_P;
  } catch {
    // An outage or a malformed answer degrades to exact matching, never
    // to a guess.
    return false;
  }
}

/** Top tag suggestions for a plain-language term, chosen among the
 * provider's real tag names — the model only ever selects from the list it
 * was handed, so a suggestion is always a real, addable tag. The none-hatch
 * and every probability below the top three are dropped here. */
export async function suggestTags(
  term: string,
  tags: { id: string; name: string }[],
  storedKey?: string,
): Promise<{ id: string; name: string }[]> {
  const ts = typeSafe(storedKey);
  if (!ts || tags.length === 0) return [];
  try {
    const res = await ts.systemOne({
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
    });
    const ranked = Object.entries(
      res.answers.pick.probabilities as Record<string, number>,
    )
      .filter(([name]) => name !== "none" && tags.some((t) => t.name === name))
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([name]) => tags.find((t) => t.name === name)!);
    return ranked;
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
  storedKey?: string,
): Promise<T[] | null> {
  const ts = typeSafe(storedKey);
  if (!ts || candidates.length <= 1 || candidates.length > 12) return null;
  try {
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
