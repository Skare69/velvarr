// The natural-language search map: a validated draft (src/lib/prose-draft.ts)
// becomes a browse URL patch plus notes. No IO of its own — every provider
// read goes through the injected ProseLookups, so the rules stay testable
// with fakes and the server wires the real adapters
// (src/server/prose-search.ts). Code writes every note message; the model
// never writes UI text.

import {
  mergedSourceRestricted,
  planStreams,
  tpdbFilmographyRuns,
  MAX_BROWSE_ENTITIES,
  type BrowseTab,
  type PerformerMode,
} from "./browse-entities.ts";
import { BROWSE_KEYS } from "./browse-url.ts";
import {
  CATALOG_YEAR_MAX,
  CATALOG_YEAR_MIN,
  normalizeFacetName as nf,
  type BrowseEntity,
  type CatalogProvider,
  type CatalogTagSelection,
} from "./contracts.ts";
import type { Cited, ProseDateOperation, ProseDraft } from "./prose-draft.ts";
import type { MissedTag } from "./prose-repair.ts";
import {
  browseSortIsDirectional,
  browseSortsFor,
  SORT_LABELS,
  type SortKey,
} from "./sorts.ts";

export type ProseNoteCode =
  | "not_in_text"
  | "not_a_filter"
  | "unclear"
  | "no_matching_tag"
  | "no_exact_match"
  | "ambiguous_name"
  | "cap_reached"
  | "lookup_failed"
  | "provider_not_configured"
  | "read_as"
  | "left_out"
  | "cannot_combine"
  | "not_available";

/** `read` (read_as notes only): the member's words and what they became, so
 * the UI can group one phrase's readings without parsing the message. */
export type ProseNote = {
  code: ProseNoteCode;
  message: string;
  read?: { from: string; to: string };
};

/** POST /api/browse/prose 200 body. `params` is a useParamsSetter patch
 * (null deletes a key), or null when nothing applies. */
export type ProseSearchResult = {
  params: Record<string, string | null> | null;
  notes: ProseNote[];
};

/** One performer or studio row from a provider's name search. */
export type ProseNameRow = { id: string; name: string; aliases: string[] };

/** Every provider read the map makes. A thrown error is a failed lookup;
 * its message names the cause and appears in the note. */
export type ProseLookups = {
  /** Whether the provider has credentials (stored or environment). */
  configured(provider: CatalogProvider): boolean;
  /** Provider tag rows for one word (the tag pickers' lookup). */
  searchTags(
    provider: CatalogProvider,
    word: string,
  ): Promise<{ id: string; name: string }[]>;
  /** The first result page of a name search, deleted records excluded. */
  searchNames(
    provider: CatalogProvider,
    kind: "performer" | "studio",
    name: string,
  ): Promise<ProseNameRow[]>;
  /** The other provider's id for one record, decided only from links the
   * providers publish; undefined when there is no link. */
  counterpart(
    kind: "performer" | "studio",
    provider: CatalogProvider,
    id: string,
  ): Promise<string | undefined>;
};

/** Browse filters at most this many include tags and, separately, this many
 * exclude tags (storage's parseTagSelections cap). */
const MAX_PROSE_TAGS = 25;
/** Longest tag or entity label a browse selection may carry. */
const LABEL_MAX = 120;

const PROVIDERS: readonly CatalogProvider[] = ["tpdb", "stashdb"];
const PROVIDER_LABEL: Record<CatalogProvider, string> = {
  tpdb: "TPDB",
  stashdb: "StashDB",
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Draft field order: notes sort by (field, item, sub-index, emission). */
const FIELD = {
  type: 0,
  titleWords: 1,
  include: 2,
  exclude: 3,
  performers: 4,
  studios: 5,
  followedPerformers: 6,
  year: 7,
  date: 8,
  sort: 9,
  skipped: 10,
} as const;

type NoteKey = readonly [field: number, item: number, sub: number];

const TYPE_DISPLAY: Record<"movie" | "scene" | "all", string> = {
  movie: "movies",
  scene: "scenes",
  all: "movies and scenes",
};

const DATE_WORDS: Record<ProseDateOperation, string> = {
  "<": "before",
  "<=": "on or before",
  "=": "on",
  ">=": "on or after",
  ">": "after",
};

// The same release-date order under each tab's own key: Scenes offers
// `date`, Movies and All offer `recency`.
const SORT_TWIN: Partial<Record<SortKey, SortKey>> = {
  recency: "date",
  date: "recency",
};

type TagRow = { id: string; name: string };
type TagOutcome =
  | { provider: CatalogProvider; rows: TagRow[] }
  | { provider: CatalogProvider; error: string };
type IncludeTerm = CatalogTagSelection | CatalogTagSelection[];
/** One applied performer or studio entry plus the name its notes show. */
type AppliedEntity = { entry: BrowseEntity; label: string };

type Notes = {
  add(key: NoteKey, code: ProseNoteCode, message: string): ProseNote;
  readAs(key: NoteKey, from: string, to: string): void;
  sorted(): ProseNote[];
};

function noteCollector(): Notes {
  const pending: { key: NoteKey; seq: number; note: ProseNote }[] = [];
  const push = (key: NoteKey, note: ProseNote) => {
    pending.push({ key, seq: pending.length, note });
    return note;
  };
  return {
    add: (key, code, message) => push(key, { code, message }),
    readAs(key, from, to) {
      push(key, {
        code: "read_as",
        message: `Read '${from}' as ${to}`,
        read: { from, to },
      });
    },
    sorted() {
      return [...pending]
        .sort(
          (a, b) =>
            a.key[0] - b.key[0] ||
            a.key[1] - b.key[1] ||
            a.key[2] - b.key[2] ||
            a.seq - b.seq,
        )
        .map((p) => p.note);
    },
  };
}

/** Per-call state: lookup caches and per-provider memory, so one request
 * never repeats a lookup, never retries a failed provider and names each
 * provider-level problem once per lookup kind (tags, names, links). */
type MapContext = {
  prose: string;
  lookups: ProseLookups;
  notes: Notes;
  tagRows: Map<string, TagRow[]>;
  tagUnconfigured: Set<CatalogProvider>;
  tagFailed: Set<CatalogProvider>;
  nameRows: Map<string, ProseNameRow[]>;
  nameUnconfigured: Set<CatalogProvider>;
  nameFailed: Set<CatalogProvider>;
  linkUnconfigured: Set<CatalogProvider>;
  linkFailures: Map<CatalogProvider, { note: ProseNote; names: string[] }>;
  /** Include/exclude values no tag anchors (the repair's input). */
  missed: MissedTag[];
  /** Folded names the repair picked from real tags: one that exists on only
   * one provider anchors there instead of becoming free text. */
  picked: ReadonlySet<string>;
};

function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the source words appear in the member's text. */
function cited(ctx: MapContext, source: string): boolean {
  const f = fold(source);
  return f !== "" && ctx.prose.includes(f);
}

function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setId(e: BrowseEntity, provider: CatalogProvider, id: string): void {
  if (provider === "tpdb") e.tpdb = id;
  else e.stashdb = id;
}

/** The browse parser's calendar rule (server isIsoDate), kept local so this
 * module stays free of server imports. */
function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return (
    utc.getUTCFullYear() === y &&
    utc.getUTCMonth() === m - 1 &&
    utc.getUTCDate() === d
  );
}

function notInText(ctx: MapContext, key: NoteKey, value: string): void {
  ctx.notes.add(
    key,
    "not_in_text",
    `Not applied: ${value} (not found in your text)`,
  );
}

function notConfigured(
  ctx: MapContext,
  noted: Set<CatalogProvider>,
  provider: CatalogProvider,
  key: NoteKey,
): void {
  if (noted.has(provider)) return;
  noted.add(provider);
  ctx.notes.add(
    key,
    "provider_not_configured",
    `${PROVIDER_LABEL[provider]} is not configured, so it was not searched`,
  );
}

async function searchTagsOnce(
  ctx: MapContext,
  provider: CatalogProvider,
  word: string,
): Promise<TagOutcome> {
  const cacheKey = `${provider}\u0000${nf(word)}`;
  const cached = ctx.tagRows.get(cacheKey);
  if (cached !== undefined) return { provider, rows: cached };
  try {
    // TPDB tag rows without a UUID can never travel as a browse selection.
    const rows = (await ctx.lookups.searchTags(provider, word)).filter(
      (r) => provider !== "tpdb" || UUID_RE.test(r.id),
    );
    ctx.tagRows.set(cacheKey, rows);
    return { provider, rows };
  } catch (err) {
    return { provider, error: errorMessage(err) };
  }
}

/** One tag word: anchored when both providers publish the exact label,
 * free text when some published tag contains it, else a note. */
async function resolveTag(
  ctx: MapContext,
  value: string,
  key: NoteKey,
  source: string,
): Promise<CatalogTagSelection | undefined> {
  const label = nf(value);
  if (value.length > LABEL_MAX || label === "") {
    ctx.notes.add(
      key,
      "no_matching_tag",
      `Not applied: ${value} (no matching tag)`,
    );
    return undefined;
  }
  const searched: CatalogProvider[] = [];
  for (const provider of PROVIDERS) {
    if (!ctx.lookups.configured(provider)) {
      notConfigured(ctx, ctx.tagUnconfigured, provider, key);
    } else if (!ctx.tagFailed.has(provider)) {
      searched.push(provider);
    }
  }
  const outcomes = await Promise.all(
    searched.map((provider) => searchTagsOnce(ctx, provider, value)),
  );
  const found = new Map<CatalogProvider, TagRow[]>();
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      ctx.tagFailed.add(outcome.provider);
      ctx.notes.add(
        key,
        "lookup_failed",
        `${PROVIDER_LABEL[outcome.provider]} search failed: ${outcome.error}`,
      );
    } else {
      found.set(outcome.provider, outcome.rows);
    }
  }
  const exact = (provider: CatalogProvider) =>
    found.get(provider)?.find((r) => nf(r.name) === label);
  const tpdbRow = exact("tpdb");
  const stashdbRow = exact("stashdb");
  const tpdbName = tpdbRow?.name.trim() ?? "";
  if (
    tpdbRow !== undefined &&
    stashdbRow !== undefined &&
    tpdbName.length >= 1 &&
    tpdbName.length <= LABEL_MAX
  ) {
    return {
      name: tpdbName,
      tpdb: tpdbRow.id.toLowerCase(),
      stashdb: stashdbRow.id.toLowerCase(),
    };
  }
  // A repair pick is a real tag name: anchored on the provider that has it,
  // so that provider filters natively (the other side treats it as absent,
  // which an OR group of per-provider picks covers).
  if (ctx.picked.has(label)) {
    if (tpdbRow !== undefined)
      return { name: tpdbRow.name.trim(), tpdb: tpdbRow.id.toLowerCase() };
    if (stashdbRow !== undefined)
      return {
        name: stashdbRow.name.trim(),
        stashdb: stashdbRow.id.toLowerCase(),
      };
  }
  const miss = (kind: MissedTag["kind"]) => {
    if (key[0] !== FIELD.include && key[0] !== FIELD.exclude) return;
    ctx.missed.push({
      field: key[0] === FIELD.include ? "include" : "exclude",
      term: key[1],
      alt: key[2],
      value,
      source,
      kind,
    });
  };
  for (const rows of found.values()) {
    if (rows.some((r) => nf(r.name).includes(label))) {
      // Applied, but only as free text that Browse checks page by page:
      // still a repair candidate.
      miss("free_text");
      return { name: value.trim() };
    }
  }
  if (found.size === 0) {
    ctx.notes.add(
      key,
      "lookup_failed",
      `Not applied: ${value} (tag search failed)`,
    );
  } else {
    ctx.notes.add(
      key,
      "no_matching_tag",
      `Not applied: ${value} (no matching tag)`,
    );
    miss("no_match");
  }
  return undefined;
}

/** A cited tag word under its list's cap, resolved, with its read_as note. */
async function appliedTag(
  ctx: MapContext,
  word: Cited<string>,
  key: NoteKey,
  appliedSoFar: number,
): Promise<CatalogTagSelection | undefined> {
  if (!cited(ctx, word.source)) {
    notInText(ctx, key, word.value);
    return undefined;
  }
  if (appliedSoFar >= MAX_PROSE_TAGS) {
    ctx.notes.add(
      key,
      "cap_reached",
      `Not applied: ${word.value} (Browse filters at most ${MAX_PROSE_TAGS} tags)`,
    );
    return undefined;
  }
  const selection = await resolveTag(ctx, word.value, key, word.source);
  if (selection !== undefined && nf(selection.name) !== nf(word.source)) {
    ctx.notes.readAs(key, word.source, selection.name);
  }
  return selection;
}

/** Include terms AND together; one term's matched alternatives form an
 * "or" group. Duplicates drop silently, the way the browse parser would
 * consolidate them. */
async function resolveInclude(
  ctx: MapContext,
  terms: ProseDraft["include"],
): Promise<IncludeTerm[]> {
  const out: IncludeTerm[] = [];
  const plainLabels = new Set<string>();
  const groupKeys = new Set<string>();
  let applied = 0;
  for (const [ti, term] of terms.entries()) {
    const matched: CatalogTagSelection[] = [];
    const labels = new Set<string>();
    for (const [ai, alt] of term.alternatives.entries()) {
      const selection = await appliedTag(
        ctx,
        alt,
        [FIELD.include, ti, ai],
        applied + matched.length,
      );
      if (selection === undefined) continue;
      const label = nf(selection.name);
      if (labels.has(label)) continue;
      labels.add(label);
      matched.push(selection);
    }
    const [first] = matched;
    if (matched.length === 1 && first !== undefined) {
      const label = nf(first.name);
      if (plainLabels.has(label)) continue;
      plainLabels.add(label);
      out.push(first);
      applied += 1;
    } else if (matched.length > 1) {
      const groupKey = JSON.stringify([...labels].sort());
      if (groupKeys.has(groupKey)) continue;
      groupKeys.add(groupKey);
      out.push(matched);
      applied += matched.length;
    }
  }
  return out;
}

async function resolveExclude(
  ctx: MapContext,
  words: ProseDraft["exclude"],
): Promise<CatalogTagSelection[]> {
  const out: CatalogTagSelection[] = [];
  const labels = new Set<string>();
  for (const [ei, word] of words.entries()) {
    const selection = await appliedTag(
      ctx,
      word,
      [FIELD.exclude, ei, 0],
      out.length,
    );
    if (selection === undefined || labels.has(nf(selection.name))) continue;
    labels.add(nf(selection.name));
    out.push(selection);
  }
  return out;
}

/** The one record of one provider whose name or alias equals the drafted
 * name. This is name selection within a single provider's search results,
 * never cross-provider identity: the other provider's id comes only from
 * the links the providers publish (linkedId). */
async function exactNameRow(
  ctx: MapContext,
  kind: "performer" | "studio",
  provider: CatalogProvider,
  value: string,
  key: NoteKey,
): Promise<ProseNameRow | undefined> {
  if (!ctx.lookups.configured(provider)) {
    notConfigured(ctx, ctx.nameUnconfigured, provider, key);
    return undefined;
  }
  if (ctx.nameFailed.has(provider)) return undefined;
  const label = nf(value);
  const byId = new Map<string, ProseNameRow>();
  if (label !== "") {
    const cacheKey = `${provider}\u0000${kind}\u0000${label}`;
    let rows = ctx.nameRows.get(cacheKey);
    if (rows === undefined) {
      try {
        rows = await ctx.lookups.searchNames(provider, kind, value);
      } catch (err) {
        ctx.nameFailed.add(provider);
        ctx.notes.add(
          key,
          "lookup_failed",
          `${PROVIDER_LABEL[provider]} search failed: ${errorMessage(err)}`,
        );
        return undefined;
      }
      ctx.nameRows.set(cacheKey, rows);
    }
    for (const row of rows) {
      const id = row.id.toLowerCase();
      if (
        !byId.has(id) &&
        (nf(row.name) === label || row.aliases.some((a) => nf(a) === label))
      ) {
        byId.set(id, row);
      }
    }
  }
  const matches = [...byId.values()];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    ctx.notes.add(
      key,
      "no_exact_match",
      `Not applied: ${value} (no exact match)`,
    );
  } else {
    ctx.notes.add(
      key,
      "ambiguous_name",
      `Not applied: ${value} (more than one record has this name)`,
    );
  }
  return undefined;
}

/** The other provider's id from the published links. A failed lookup keeps
 * the entry with its one id; every failed name joins one note per provider. */
async function linkedId(
  ctx: MapContext,
  kind: "performer" | "studio",
  provider: CatalogProvider,
  id: string,
  label: string,
  key: NoteKey,
): Promise<string | undefined> {
  const other: CatalogProvider = provider === "tpdb" ? "stashdb" : "tpdb";
  if (!ctx.lookups.configured(other)) {
    notConfigured(ctx, ctx.linkUnconfigured, other, key);
    return undefined;
  }
  try {
    const linked = await ctx.lookups.counterpart(kind, provider, id);
    return linked ? linked.toLowerCase() : undefined;
  } catch {
    const failure: { note: ProseNote; names: string[] } = ctx.linkFailures.get(
      other,
    ) ?? {
      note: ctx.notes.add(key, "lookup_failed", ""),
      names: [],
    };
    failure.names.push(label);
    failure.note.message = `${PROVIDER_LABEL[other]} link lookup failed for ${humanList(failure.names)}`;
    ctx.linkFailures.set(other, failure);
    return undefined;
  }
}

/** Performer or studio names in draft order, at most MAX_BROWSE_ENTITIES
 * applied; no lookup runs past the cap. */
async function resolveNames(
  ctx: MapContext,
  kind: "performer" | "studio",
  names: Cited<string>[],
  field: number,
  provider: CatalogProvider,
): Promise<AppliedEntity[]> {
  const other: CatalogProvider = provider === "tpdb" ? "stashdb" : "tpdb";
  const applied: AppliedEntity[] = [];
  const ownIds = new Set<string>();
  const otherIds = new Set<string>();
  for (const [i, n] of names.entries()) {
    const key: NoteKey = [field, i, 0];
    if (!cited(ctx, n.source)) {
      notInText(ctx, key, n.value);
      continue;
    }
    if (applied.length >= MAX_BROWSE_ENTITIES) {
      ctx.notes.add(
        key,
        "cap_reached",
        `Not applied: ${n.value} (Browse filters at most ${MAX_BROWSE_ENTITIES} ${kind}s)`,
      );
      continue;
    }
    const row = await exactNameRow(ctx, kind, provider, n.value, key);
    if (row === undefined) continue;
    const id = row.id.toLowerCase();
    if (ownIds.has(id)) continue;
    ownIds.add(id);
    const name = row.name.trim();
    const entry: BrowseEntity =
      name.length >= 1 && name.length <= LABEL_MAX ? { name } : {};
    setId(entry, provider, id);
    const label = entry.name ?? n.value;
    if (nf(row.name) !== nf(n.source)) {
      ctx.notes.readAs(key, n.source, name);
    }
    const linked = await linkedId(ctx, kind, provider, row.id, label, key);
    if (linked !== undefined && !otherIds.has(linked)) {
      otherIds.add(linked);
      setId(entry, other, linked);
    }
    applied.push({ entry, label });
  }
  return applied;
}

type ReplaceKey = Exclude<(typeof BROWSE_KEYS)[number], "perPage" | "type">;

function jsonOrNull(list: readonly unknown[]): string | null {
  return list.length > 0 ? JSON.stringify(list) : null;
}

/**
 * Maps a validated draft to a browse patch that replaces every filter, plus
 * notes in draft order for everything that did not apply as written.
 * `missed`, when given, collects the include/exclude values that matched no
 * tag, for the grounded repair (prose-repair.ts).
 */
export async function mapProseDraft(
  input: { prose: string; tab: BrowseTab; draft: ProseDraft },
  lookups: ProseLookups,
  missed: MissedTag[] = [],
  picked: ReadonlySet<string> = new Set(),
): Promise<ProseSearchResult> {
  const { draft, tab } = input;
  const notes = noteCollector();
  const ctx: MapContext = {
    prose: fold(input.prose),
    lookups,
    notes,
    tagRows: new Map(),
    tagUnconfigured: new Set(),
    tagFailed: new Set(),
    nameRows: new Map(),
    nameUnconfigured: new Set(),
    nameFailed: new Set(),
    linkUnconfigured: new Set(),
    linkFailures: new Map(),
    missed,
    picked: new Set([...picked].map((n) => nf(n))),
  };
  const blocked = (key: NoteKey, value: string) =>
    notes.add(
      key,
      "cannot_combine",
      `Not applied: ${value} (cannot combine with the TPDB performer filter)`,
    );

  let resultTab: BrowseTab = tab;
  if (draft.type !== null) {
    if (cited(ctx, draft.type.source)) resultTab = draft.type.value;
    else notInText(ctx, [FIELD.type, 0, 0], TYPE_DISPLAY[draft.type.value]);
  }
  const tabChanged = resultTab !== tab;

  // Lookups run in draft order: tags, then performers, then studios.
  const include = await resolveInclude(ctx, draft.include);
  const exclude = await resolveExclude(ctx, draft.exclude);
  const lookupProvider: CatalogProvider =
    resultTab === "movie" ? "tpdb" : "stashdb";
  const performers = await resolveNames(
    ctx,
    "performer",
    draft.performers.names,
    FIELD.performers,
    lookupProvider,
  );
  const performerMode: PerformerMode =
    performers.length >= 2 && draft.performers.mode === "any" ? "any" : "all";
  // Movies with a performer runs the TPDB filmography, which refuses every
  // other narrowing filter except tags.
  const filmography = resultTab === "movie" && performers.length > 0;

  let studios: AppliedEntity[] = [];
  if (filmography) {
    for (const [i, n] of draft.studios.names.entries()) {
      const key: NoteKey = [FIELD.studios, i, 0];
      if (cited(ctx, n.source)) blocked(key, n.value);
      else notInText(ctx, key, n.value);
    }
  } else {
    studios = await resolveNames(
      ctx,
      "studio",
      draft.studios.names,
      FIELD.studios,
      lookupProvider,
    );
  }

  let studioMode: "exact" | "withChildren" = "exact";
  const children = draft.studios.withChildren;
  if (children !== null) {
    const key: NoteKey = [FIELD.studios, draft.studios.names.length, 0];
    const unavailable = (reason: string) =>
      notes.add(
        key,
        "not_available",
        `Not applied: ${children.source} (${reason})`,
      );
    if (!cited(ctx, children.source)) notInText(ctx, key, children.source);
    else if (studios.length === 0) unavailable("child studios need a studio");
    else if (resultTab === "movie") {
      unavailable("child studios apply to StashDB scenes only");
    } else {
      studioMode = "withChildren";
      const hadTpdb = studios.filter((s) => s.entry.tpdb !== undefined);
      for (const s of hadTpdb) delete s.entry.tpdb;
      if (resultTab === "all" && hadTpdb.length > 0) {
        notes.add(
          key,
          "left_out",
          `Left out the TPDB ids of ${humanList(hadTpdb.map((s) => s.label))}: child studios apply to StashDB scenes only`,
        );
      }
    }
  }

  let performerStarred = false;
  const followed = draft.followedPerformers;
  if (followed !== null) {
    const key: NoteKey = [FIELD.followedPerformers, 0, 0];
    if (!cited(ctx, followed.source)) notInText(ctx, key, followed.source);
    else if (resultTab === "movie") {
      notes.add(
        key,
        "not_available",
        `Not applied: ${followed.source} (followed performers apply to scenes only)`,
      );
    } else if (performers.length > 0) {
      notes.add(
        key,
        "cannot_combine",
        `Not applied: ${followed.source} (cannot combine with a named performer)`,
      );
    } else {
      performerStarred = true;
    }
  }

  let year: { lo: number; hi: number } | undefined;
  if (draft.year !== null) {
    const { from, to, source } = draft.year;
    const key: NoteKey = [FIELD.year, 0, 0];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const display = lo === hi ? String(lo) : `${lo}–${hi}`;
    if (!cited(ctx, source)) notInText(ctx, key, display);
    else if (filmography) blocked(key, display);
    else if (lo < CATALOG_YEAR_MIN || hi > CATALOG_YEAR_MAX) {
      notes.add(
        key,
        "not_available",
        `Not applied: ${source} (years run from ${CATALOG_YEAR_MIN} to ${CATALOG_YEAR_MAX})`,
      );
    } else {
      year = { lo, hi };
      // "the 2010s" names neither bound, "2019" names its one bound.
      if ([lo, hi].some((n) => !new RegExp(`\\b${n}\\b`).test(source))) {
        notes.readAs(key, source, display);
      }
    }
  }

  let date: { date: string; operation: ProseDateOperation } | undefined;
  if (draft.date !== null) {
    const { operation, source } = draft.date;
    const key: NoteKey = [FIELD.date, 0, 0];
    const display = `${DATE_WORDS[operation]} ${draft.date.date}`;
    if (!cited(ctx, source)) notInText(ctx, key, display);
    else if (filmography) blocked(key, display);
    else if (year !== undefined) {
      notes.add(
        key,
        "cannot_combine",
        `Not applied: ${display} (cannot combine with a year)`,
      );
    } else if (!isCalendarDate(draft.date.date)) {
      notes.add(
        key,
        "not_available",
        `Not applied: ${source} (not a real calendar date)`,
      );
    } else {
      date = { date: draft.date.date, operation };
      if (!source.includes(draft.date.date)) {
        notes.readAs(key, source, display);
      }
    }
  }

  let q: string | undefined;
  if (draft.titleWords !== null) {
    const { value, source } = draft.titleWords;
    const key: NoteKey = [FIELD.titleWords, 0, 0];
    if (!cited(ctx, source)) notInText(ctx, key, value);
    else if (value.trim() !== "") {
      if (filmography) blocked(key, value);
      else q = value.trim();
    }
  }

  let sort: SortKey | undefined;
  const sortKey: NoteKey = [FIELD.sort, 0, 0];
  const sortLabel = draft.sort !== null ? SORT_LABELS[draft.sort.key] : "";
  const sortUnavailable = () =>
    notes.add(
      sortKey,
      "not_available",
      `Not applied: ${sortLabel} (this order is not available here)`,
    );
  if (draft.sort !== null) {
    const offered = browseSortsFor(resultTab);
    const twin = SORT_TWIN[draft.sort.key];
    const key =
      !offered.includes(draft.sort.key) &&
      twin !== undefined &&
      offered.includes(twin)
        ? twin
        : draft.sort.key;
    if (!cited(ctx, draft.sort.source)) notInText(ctx, sortKey, sortLabel);
    else if (filmography) blocked(sortKey, sortLabel);
    else if (!offered.includes(key)) sortUnavailable();
    else sort = key;
  }

  // All: a TPDB filmography would refuse the year, date, sort, title words
  // or TPDB studio, so the performers drop their TPDB ids and run on
  // StashDB (every All entry carries its StashDB id).
  if (
    resultTab === "all" &&
    tpdbFilmographyRuns(
      "all",
      performers.map((p) => p.entry),
      performerMode,
    )
  ) {
    const filters: string[] = [];
    if (year !== undefined) filters.push("a year");
    if (date !== undefined) filters.push("a date");
    if (sort !== undefined) filters.push("a sort");
    if (q !== undefined) filters.push("title words");
    if (studios.some((s) => s.entry.tpdb !== undefined)) {
      filters.push("a TPDB studio");
    }
    if (filters.length > 0) {
      const hadTpdb = performers.filter((p) => p.entry.tpdb !== undefined);
      for (const p of hadTpdb) delete p.entry.tpdb;
      notes.add(
        [FIELD.performers, draft.performers.names.length, 0],
        "left_out",
        `Left out the TPDB ids of ${humanList(hadTpdb.map((p) => p.label))}: the TPDB performer filter cannot combine with ${humanList(filters)}`,
      );
    }
  }

  const performerEntries = performers.map((p) => p.entry);
  const studioEntries = studios.map((s) => s.entry);
  if (
    sort !== undefined &&
    mergedSourceRestricted(
      planStreams(
        resultTab,
        performerEntries,
        studioEntries,
        performerMode,
        studioMode,
        performerStarred,
      ),
      sort,
    )
  ) {
    sortUnavailable();
    sort = undefined;
  }
  const direction =
    sort !== undefined &&
    draft.sort !== null &&
    draft.sort.direction !== null &&
    browseSortIsDirectional(resultTab, sort)
      ? draft.sort.direction
      : null;

  for (const [i, s] of draft.skipped.entries()) {
    if (!cited(ctx, s.text)) continue;
    notes.add(
      [FIELD.skipped, i, 0],
      s.reason,
      s.reason === "not_a_filter"
        ? `Not applied: ${s.text} (not a browse filter)`
        : `Not applied: ${s.text} (unclear)`,
    );
  }

  const anyApplied =
    tabChanged ||
    q !== undefined ||
    include.length > 0 ||
    exclude.length > 0 ||
    performers.length > 0 ||
    studios.length > 0 ||
    performerStarred ||
    studioMode === "withChildren" ||
    year !== undefined ||
    date !== undefined ||
    sort !== undefined;
  if (!anyApplied) return { params: null, notes: notes.sorted() };

  // The patch replaces every filter: each browse key is set or deleted.
  const replace: Record<ReplaceKey, string | null> = {
    q: q ?? null,
    include: jsonOrNull(include),
    exclude: jsonOrNull(exclude),
    studios: jsonOrNull(studioEntries),
    studioTpdb: null,
    studioStashdb: null,
    performers: jsonOrNull(performerEntries),
    performerMode: performerMode === "any" ? "any" : null,
    performerTpdb: null,
    performerStashdb: null,
    performerStarred: performerStarred ? "1" : null,
    studioMode: studioMode === "withChildren" ? "withChildren" : null,
    year: year !== undefined ? String(year.lo) : null,
    yearTo: year !== undefined && year.hi !== year.lo ? String(year.hi) : null,
    date: date?.date ?? null,
    date_operation: date?.operation ?? null,
    dateTo: null,
    sort: sort ?? null,
    direction,
  };
  return {
    params: {
      ...replace,
      name: null,
      ...(tabChanged ? { type: resultTab === "all" ? null : resultTab } : {}),
    },
    notes: notes.sorted(),
  };
}
