// Grounded tag repair for natural-language search (docs/specs/
// prose-tag-repair.md). Pure: the server supplies the provider tag search and
// the chat call. A phrase the map could not anchor to a tag (no match, or
// only free text) gets candidates from real provider tags, the model may
// pick among them, and only real candidates are ever applied.

import type { CatalogProvider } from "./contracts.ts";
import type { Cited, ProseDraft } from "./prose-draft.ts";

/** At most this many missed phrases go to one repair request. */
export const REPAIR_PHRASES_MAX = 6;
/** At most this many candidate tag names per phrase. */
export const REPAIR_CANDIDATES_MAX = 25;
/** At most this many picks per phrase are applied. */
export const REPAIR_PICKS_MAX = 3;

/** One include alternative or exclude word that no tag anchors: it matched
 * nothing (`no_match`, not applied) or applied only as free text
 * (`free_text`, which Browse checks locally page by page). */
export type MissedTag = {
  field: "include" | "exclude";
  /** include: the term index; exclude: the word index. */
  term: number;
  /** include: the alternative index; exclude: always 0. */
  alt: number;
  value: string;
  source: string;
  kind: "no_match" | "free_text";
};

/** A real tag name and the catalogs that publish it. */
export type RepairCandidate = { name: string; catalogs: CatalogProvider[] };
export type RepairItem = { phrase: string; candidates: RepairCandidate[] };
export type RepairPicks = Map<string, string[]>;

const STOP_WORDS: Record<string, true> = Object.fromEntries(
  [
    "and",
    "are",
    "but",
    "for",
    "from",
    "get",
    "gets",
    "getting",
    "has",
    "her",
    "him",
    "his",
    "lot",
    "lots",
    "many",
    "more",
    "not",
    "one",
    "some",
    "the",
    "their",
    "them",
    "they",
    "very",
    "who",
    "with",
    "without",
  ].map((w) => [w, true]),
);

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The words of a phrase worth a tag search: 3+ letters, no stop words. */
export function candidateWords(phrase: string): string[] {
  const words = fold(phrase)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && STOP_WORDS[w] !== true);
  return [...new Set(words)];
}

/** Real tag names for one phrase, ranked: more matched phrase words first,
 * then shorter names, then alphabetical. One entry per folded name, with
 * every catalog that publishes it. */
export function rankCandidates(
  phrase: string,
  rows: { name: string; provider: CatalogProvider }[],
): RepairCandidate[] {
  const words = candidateWords(phrase);
  const byFold = new Map<string, RepairCandidate>();
  for (const row of rows) {
    const key = fold(row.name);
    if (key === "") continue;
    const hit = byFold.get(key);
    if (hit === undefined)
      byFold.set(key, { name: row.name.trim(), catalogs: [row.provider] });
    else if (!hit.catalogs.includes(row.provider))
      hit.catalogs.push(row.provider);
  }
  const score = (name: string) =>
    words.filter((w) => fold(name).includes(w)).length;
  return [...byFold.values()]
    .sort(
      (a, b) =>
        score(b.name) - score(a.name) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )
    .slice(0, REPAIR_CANDIDATES_MAX);
}

/** The fixed repair instructions: no member data and no ids. The request
 * text, phrases and candidates travel in the user message. */
export function proseRepairSystemMessage(): string {
  return [
    "You match phrases from a search request to the tags of two adult video catalogs, TPDB and StashDB. Answer only with JSON that matches the given schema.",
    "",
    "You get the whole request and, for each phrase taken from it, a list of candidate tags, each with the catalogs that have it. Read each phrase in the context of the whole request, then pick the tags that mean the same as the phrase there, or the closest broader tag. The two catalogs often name the same thing differently: when the best tag exists in only one catalog, also pick the matching tag of the other catalog if the list has one.",
    'Never pick a tag that the rest of the request contradicts: when the request is about men together, skip tags about women or about a man with a woman ("Older Man / Younger Woman" does not fit "old men" there; "Older Man" alone does). Never pick a tag that adds an act, setting or number of people the phrase does not say.',
    "Pick at most 3 tags per phrase, and only tags from that phrase's own list, spelled exactly as listed. Pick none when no candidate fits; a missing tag is better than a wrong one.",
    'Return one entry per phrase: "phrase" copies the phrase exactly, "tags" holds the picks (an empty list for none).',
  ].join("\n");
}

const CATALOG_LABEL: Record<CatalogProvider, string> = {
  tpdb: "TPDB",
  stashdb: "StashDB",
};

/** The user message: the member's whole request (pass 1 already sent the
 * same text) and the phrases with their candidates, as JSON. */
export function proseRepairUserMessage(
  request: string,
  items: RepairItem[],
): string {
  return JSON.stringify({
    request,
    phrases: items.map((i) => ({
      phrase: i.phrase,
      candidates: i.candidates.map((c) => ({
        tag: c.name,
        catalogs: c.catalogs.map((p) => CATALOG_LABEL[p]),
      })),
    })),
  });
}

/** Strict json_schema for the repair reply (no caps: Anthropic rejects
 * maxItems; parseProseRepair enforces them). */
export const PROSE_REPAIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phrase: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["phrase", "tags"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

/** Reads an untrusted repair reply. Unknown phrases and names that are not
 * that phrase's candidates are dropped; a pick takes the candidate's own
 * spelling; at most REPAIR_PICKS_MAX per phrase. Never throws. */
export function parseProseRepair(
  input: unknown,
  items: RepairItem[],
): RepairPicks {
  const out: RepairPicks = new Map();
  const offered = new Map(items.map((i) => [fold(i.phrase), i]));
  const picks =
    typeof input === "object" && input !== null && "picks" in input
      ? (input as { picks: unknown }).picks
      : null;
  if (!Array.isArray(picks)) return out;
  for (const entry of picks) {
    if (typeof entry !== "object" || entry === null) continue;
    const { phrase, tags } = entry as { phrase?: unknown; tags?: unknown };
    if (typeof phrase !== "string" || !Array.isArray(tags)) continue;
    const item = offered.get(fold(phrase));
    if (item === undefined) continue;
    const real = new Map(item.candidates.map((c) => [fold(c.name), c.name]));
    const chosen = out.get(item.phrase) ?? [];
    for (const tag of tags) {
      if (typeof tag !== "string") continue;
      const name = real.get(fold(tag));
      if (name === undefined || chosen.includes(name)) continue;
      if (chosen.length >= REPAIR_PICKS_MAX) break;
      chosen.push(name);
    }
    if (chosen.length > 0) out.set(item.phrase, chosen);
  }
  return out;
}

/** The draft with each missed value replaced by its picks: an include
 * alternative becomes the picks as alternatives of the same term (OR), an
 * exclude word becomes the picks as separate exclude words. Every pick keeps
 * the missed value's source, so the map's citing and read-as notes hold. */
export function applyTagRepair(
  draft: ProseDraft,
  missed: MissedTag[],
  picks: RepairPicks,
): ProseDraft {
  const pickFor = (m: MissedTag) => picks.get(m.value);
  const cited = (m: MissedTag, names: string[]): Cited<string>[] =>
    names.map((value) => ({ value, source: m.source }));
  const include = draft.include.map((term, ti) => ({
    alternatives: term.alternatives.flatMap((alt, ai) => {
      const m = missed.find(
        (x) => x.field === "include" && x.term === ti && x.alt === ai,
      );
      const names = m && pickFor(m);
      return m && names ? cited(m, names) : [alt];
    }),
  }));
  const exclude = draft.exclude.flatMap((word, ei) => {
    const m = missed.find((x) => x.field === "exclude" && x.term === ei);
    const names = m && pickFor(m);
    return m && names ? cited(m, names) : [word];
  });
  return { ...draft, include, exclude };
}
