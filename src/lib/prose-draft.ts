// The natural-language search draft: what the chat model must return, and
// the untrusted-input boundary that checks it. Pure, no IO: the server's
// chat client (src/server/prose-chat.ts) sends PROSE_DRAFT_SCHEMA and
// proseSystemMessage, and parseProseDraft validates the reply before the
// map (src/lib/prose-map.ts) checks every value against provider data.

import { SORT_KEYS, type SortKey } from "./sorts.ts";

/** Longest member text the route accepts (and the field allows). */
export const PROSE_TEXT_MAX = 300;

/** Every list in the draft holds at most this many items. */
export const PROSE_LIST_CAP = 10;

/** One drafted value plus `source`: the exact words of the member's text it
 * comes from. Code drops a value whose source is not in the text. */
export type Cited<T> = { value: T; source: string };

export type ProseDateOperation = "<" | "<=" | "=" | ">=" | ">";

export type ProseDraft = {
  /** Movies only, scenes only, or both named; null when the text names
   * neither. */
  type: Cited<"movie" | "scene" | "all"> | null;
  /** Words the text asks to find in titles (browse `q`). */
  titleWords: Cited<string> | null;
  /** Tag terms; the terms AND together, the alternatives of one term OR. */
  include: { alternatives: Cited<string>[] }[];
  exclude: Cited<string>[];
  /** `all` for "and", `any` for "or". */
  performers: { mode: "all" | "any"; names: Cited<string>[] };
  /** `withChildren` is present when the text asks for child studios. */
  studios: { names: Cited<string>[]; withChildren: { source: string } | null };
  /** Present when the text asks for performers the member follows. */
  followedPerformers: { source: string } | null;
  /** One year has from === to. */
  year: { from: number; to: number; source: string } | null;
  date: { operation: ProseDateOperation; date: string; source: string } | null;
  sort: {
    key: SortKey;
    direction: "asc" | "desc" | null;
    source: string;
  } | null;
  /** The parts of the text the model cannot map to a filter. */
  skipped: { text: string; reason: "not_a_filter" | "unclear" }[];
};

const PROSE_TYPES = ["movie", "scene", "all"] as const;
const PERFORMER_MODES = ["all", "any"] as const;
const DATE_OPERATIONS: readonly ProseDateOperation[] = [
  "<",
  "<=",
  "=",
  ">=",
  ">",
];
const DIRECTIONS = ["asc", "desc"] as const;
const SKIP_REASONS = ["not_a_filter", "unclear"] as const;

// Schema builders. Each call returns a fresh object, so a repeated shape is
// written once here but inlined in the output: OpenAI strict mode, Ollama and
// LM Studio grammars all accept it without $ref/$defs.
type Schema = Record<string, unknown>;

const stringSchema = (): Schema => ({ type: "string" });

function enumSchema(values: readonly string[]): Schema {
  return { type: "string", enum: [...values] };
}

/** Strict mode: no extra keys, and every key is required (optional values
 * are nullable instead). */
function objectSchema(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function nullableSchema(schema: Schema): Schema {
  return { anyOf: [{ type: "null" }, schema] };
}

// No maxItems, minimum or maximum: Anthropic's structured outputs reject them
// (HTTP 400). parseProseDraft enforces PROSE_LIST_CAP and the mapper the year
// range, so the server still holds every limit. minItems 1 is accepted.
function listSchema(items: Schema, minItems = 0): Schema {
  return { type: "array", items, ...(minItems > 0 ? { minItems } : {}) };
}

function citedSchema(value: Schema = stringSchema()): Schema {
  return objectSchema({ value, source: stringSchema() });
}

const sourceSchema = (): Schema => objectSchema({ source: stringSchema() });

const yearSchema = (): Schema => ({ type: "integer" });

/** The strict json_schema the chat request sends; its shape is ProseDraft. */
export const PROSE_DRAFT_SCHEMA: Record<string, unknown> = objectSchema({
  type: nullableSchema(citedSchema(enumSchema(PROSE_TYPES))),
  titleWords: nullableSchema(citedSchema()),
  include: listSchema(
    objectSchema({ alternatives: listSchema(citedSchema(), 1) }),
  ),
  exclude: listSchema(citedSchema()),
  performers: objectSchema({
    mode: enumSchema(PERFORMER_MODES),
    names: listSchema(citedSchema()),
  }),
  studios: objectSchema({
    names: listSchema(citedSchema()),
    withChildren: nullableSchema(sourceSchema()),
  }),
  followedPerformers: nullableSchema(sourceSchema()),
  year: nullableSchema(
    objectSchema({
      from: yearSchema(),
      to: yearSchema(),
      source: stringSchema(),
    }),
  ),
  date: nullableSchema(
    objectSchema({
      operation: enumSchema(DATE_OPERATIONS),
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      source: stringSchema(),
    }),
  ),
  sort: nullableSchema(
    objectSchema({
      key: enumSchema(SORT_KEYS),
      direction: nullableSchema(enumSchema(DIRECTIONS)),
      source: stringSchema(),
    }),
  ),
  skipped: listSchema(
    objectSchema({ text: stringSchema(), reason: enumSchema(SKIP_REASONS) }),
  ),
});

/** The fixed system message. It holds only instructions and today's date:
 * never member data, ids, the current page, or provider vocabulary. */
export function proseSystemMessage(today: string): string {
  return [
    "You turn a request for adult movies and scenes into browse filters. Answer only with JSON that matches the given schema.",
    "",
    "Rules:",
    "- Extract only what the request asks for. Never add a filter that the request does not ask for.",
    '- Every value has a "source": copy the exact words of the request that the value comes from, character for character. Do not translate, correct or reword the source.',
    '- When you normalize a value, the source still holds the words of the request. For example, a year range from "the 2010s" has the source "the 2010s".',
    "- Use null for a field that the request does not mention, and an empty list for a list that the request does not mention.",
    "",
    "Fields:",
    '- type: "movie" when the request asks only for movies, "scene" when it asks only for scenes, "all" when it asks for both movies and scenes. null when it names neither.',
    '- titleWords: words that the request wants to find in titles, for example the words after "titled" or "called".',
    '- include: short tag words that every result must have, such as looks, acts, settings or themes (for example "blonde", "lesbian", "outdoors"). Each item is one term, and every term must match. When the request joins words with "or", put them into one term as its alternatives.',
    '- Write each include and exclude value the way an adult catalog names its tags, not in the words of the request: a short, usual tag form (for example "old men" is "older man", "assfucked" is "anal", "young guy" is "twink"). When one concept has several usual tag names, give up to 3 of them as alternatives of one term. The source still copies the words of the request.',
    '- exclude: content words that no result may have, for example the words after "without", "no" or "not".',
    '- performers.names: performer names. performers.mode: "all" when the names are joined with "and" (every result has all of them), "any" when they are joined with "or" (a result has at least one).',
    "- studios.names: studio, site or network names. studios.withChildren: set when the request asks to include the child studios or sub-sites of the named studios.",
    '- followedPerformers: set when the request asks for performers that the member follows, for example "my performers" or "performers I follow".',
    '- year: one release year or a range of release years. One year has from equal to to. A decade is a range: "the 2010s" is 2010 to 2019, "the 90s" is 1990 to 1999.',
    '- date: a release date limit with an operation (<, <=, =, >=, >) and a date in YYYY-MM-DD form. Use it for a limit that is not a whole year or range of years, for example "before March 2020" is < 2020-03-01, "before 2015" is < 2015-01-01, "after 2018" is > 2018-12-31, "since 2020" is >= 2020-01-01.',
    "- A whole year or a range of whole years always goes into year, never into date.",
    "- sort: the order of the results. Set direction only when the request gives one, else null. The keys:",
    '  - recency: release date. Newest first is desc, oldest first is asc. "recent", "latest", "new" and "newest first" mean recency desc.',
    "  - date: the same release date order as recency. Use recency.",
    "  - duration: running time. Longest first is desc, shortest first is asc.",
    "  - title: alphabetical order of titles. A to Z is asc, Z to A is desc.",
    "  - trending: what is trending now.",
    "  - popularity: most popular first.",
    "  - created: recently added to the catalog.",
    "  - updated: recently updated in the catalog.",
    "  - relevance: best match. Its direction is always null.",
    '- skipped: each part of the request that you cannot put into a field. Copy its exact words into text. Use the reason "not_a_filter" for things that browse cannot filter, such as ratings, a length limit ("over 30 minutes"), video quality or price. Use "unclear" when you cannot tell what the words mean.',
    "",
    'Resolve relative dates and years ("this year", "last year", "last month", "the past 30 days") with today\'s date.',
    `Today's date is ${today}.`,
  ].join("\n");
}

// parseProseDraft: the reply is untrusted. Each reader throws DraftShapeError
// with a path; the entry point turns it into { ok: false, reason }.
class DraftShapeError extends Error {}

function fail(path: string, problem: string): never {
  throw new DraftShapeError(`${path}: ${problem}`);
}

function readObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "expected an object");
  for (const key of keys)
    if (!Object.hasOwn(value, key)) fail(path, `missing key "${key}"`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(path, `unexpected key "${key.slice(0, 40)}"`);
  return value as Record<string, unknown>;
}

function readText(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (value.length > PROSE_TEXT_MAX)
    fail(path, `longer than ${PROSE_TEXT_MAX} characters`);
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T))
    fail(path, `expected one of ${allowed.join(", ")}`);
  return value as T;
}

function readInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    fail(path, "expected an integer");
  return value;
}

function readNullable<T>(
  value: unknown,
  read: (value: unknown) => T,
): T | null {
  return value === null ? null : read(value);
}

function readList<T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
  minItems = 0,
): T[] {
  if (!Array.isArray(value)) fail(path, "expected a list");
  if (value.length < minItems || value.length > PROSE_LIST_CAP)
    fail(path, `expected ${minItems} to ${PROSE_LIST_CAP} items`);
  return value.map((item, i) => read(item, `${path}[${i}]`));
}

function readCited<T>(
  value: unknown,
  path: string,
  readValue: (value: unknown, path: string) => T,
): Cited<T> {
  const o = readObject(value, path, ["value", "source"]);
  return {
    value: readValue(o.value, `${path}.value`),
    source: readText(o.source, `${path}.source`),
  };
}

const readCitedText = (value: unknown, path: string): Cited<string> =>
  readCited(value, path, readText);

function readSource(value: unknown, path: string): { source: string } {
  const o = readObject(value, path, ["source"]);
  return { source: readText(o.source, `${path}.source`) };
}

const DRAFT_KEYS: readonly (keyof ProseDraft)[] = [
  "type",
  "titleWords",
  "include",
  "exclude",
  "performers",
  "studios",
  "followedPerformers",
  "year",
  "date",
  "sort",
  "skipped",
];

function readDraft(input: unknown): ProseDraft {
  const o = readObject(input, "draft", DRAFT_KEYS);
  const performers = readObject(o.performers, "performers", ["mode", "names"]);
  const studios = readObject(o.studios, "studios", ["names", "withChildren"]);
  return {
    type: readNullable(o.type, (v) =>
      readCited(v, "type", (s, p) => readEnum(s, p, PROSE_TYPES)),
    ),
    titleWords: readNullable(o.titleWords, (v) =>
      readCitedText(v, "titleWords"),
    ),
    include: readList(o.include, "include", (item, path) => {
      const term = readObject(item, path, ["alternatives"]);
      return {
        alternatives: readList(
          term.alternatives,
          `${path}.alternatives`,
          readCitedText,
          1,
        ),
      };
    }),
    exclude: readList(o.exclude, "exclude", readCitedText),
    performers: {
      mode: readEnum(performers.mode, "performers.mode", PERFORMER_MODES),
      names: readList(performers.names, "performers.names", readCitedText),
    },
    studios: {
      names: readList(studios.names, "studios.names", readCitedText),
      withChildren: readNullable(studios.withChildren, (v) =>
        readSource(v, "studios.withChildren"),
      ),
    },
    followedPerformers: readNullable(o.followedPerformers, (v) =>
      readSource(v, "followedPerformers"),
    ),
    year: readNullable(o.year, (v) => {
      const year = readObject(v, "year", ["from", "to", "source"]);
      return {
        from: readInteger(year.from, "year.from"),
        to: readInteger(year.to, "year.to"),
        source: readText(year.source, "year.source"),
      };
    }),
    date: readNullable(o.date, (v) => {
      const date = readObject(v, "date", ["operation", "date", "source"]);
      return {
        operation: readEnum(date.operation, "date.operation", DATE_OPERATIONS),
        date: readText(date.date, "date.date"),
        source: readText(date.source, "date.source"),
      };
    }),
    sort: readNullable(o.sort, (v) => {
      const sort = readObject(v, "sort", ["key", "direction", "source"]);
      return {
        key: readEnum(sort.key, "sort.key", SORT_KEYS),
        direction: readNullable(sort.direction, (d) =>
          readEnum(d, "sort.direction", DIRECTIONS),
        ),
        source: readText(sort.source, "sort.source"),
      };
    }),
    skipped: readList(o.skipped, "skipped", (item, path) => {
      const skip = readObject(item, path, ["text", "reason"]);
      return {
        text: readText(skip.text, `${path}.text`),
        reason: readEnum(skip.reason, `${path}.reason`, SKIP_REASONS),
      };
    }),
  };
}

/** Validates an untrusted chat reply against the ProseDraft shape: exact key
 * sets, types, enums, list caps and string lengths. Value ranges, date
 * formats and citations are the map's checks. Returns a fresh object that
 * holds only the known fields; never throws for bad input. */
export function parseProseDraft(
  input: unknown,
): { ok: true; draft: ProseDraft } | { ok: false; reason: string } {
  try {
    return { ok: true, draft: readDraft(input) };
  } catch (err) {
    if (err instanceof DraftShapeError)
      return { ok: false, reason: err.message };
    throw err;
  }
}
