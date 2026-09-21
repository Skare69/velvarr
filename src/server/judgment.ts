import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

/** One typed judgment over one question, in the Shape the TypeSafe docs call
 * "select instead of generate": the model answers a bounded yes/no, the code
 * keeps every policy decision. Used where exact string equality is the wrong
 * tool — two records can name one work with different punctuation, a
 * subtitle, or a transliteration — and where a wrong answer must never
 * upgrade a verdict: the only caller turns a yes into 'ambiguous for
 * administrator review', never into 'available'. */

const SAME_WORK_P = 0.8;

// Built once per key value; a missing key disables every judgment outright,
// which is the default deployment: the feature is opt-in via TYPESAFE_API_KEY.
let cached: { key: string; client: TypeSafeClient } | null = null;

function typeSafe(): TypeSafeClient | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
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
  a: { title: string; year?: number },
  b: { title: string; year?: number },
): Promise<boolean> {
  const ts = typeSafe();
  if (!ts) return false;
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) {
    return false;
  }
  try {
    const res = await ts.systemOne({
      state: { requested: a, candidate: b },
      questions: {
        sameWork: noul(
          "Do these two catalog records name the same work — the same movie or scene, possibly under different punctuation, an alternate subtitle, or a transliterated spelling? Answer no for remakes, different works, or unrelated titles.",
          {
            true: "Both records name the same work.",
            false: "These are different works.",
          },
        ),
      },
    });
    return res.answers.sameWork.noul >= SAME_WORK_P;
  } catch {
    // An outage or a malformed answer degrades to exact matching, never
    // to a guess.
    return false;
  }
}

// ponytail: every yes costs one API call; if availability checks ever get
// busy enough to matter, cache (requestedId, candidateId) -> noul in SQLite.
