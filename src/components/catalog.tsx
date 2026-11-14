"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import "./catalog.css";
import { isFreeText, TagPicker } from "./tag-picker.tsx";
import {
  api,
  detailParams,
  ErrorPanel,
  GridSkeleton,
  Icon,
  imgSrc,
  intOr,
  ItemImage,
  messageOf,
  MovieCard,
  OPEN_PREFERENCES,
  providerLabel,
  SceneCard,
  useApiGet,
  useGridColumns,
  wholeRows,
  useParamsSetter,
  useSession,
} from "./shared";
import type {
  BrowseEntity,
  BrowseNotice,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
} from "../lib/contracts";
import { CATALOG_YEAR_MAX, CATALOG_YEAR_MIN } from "../lib/contracts";
// Names for studio/tag filter ids live in lib/names, seeded at navigation
// time (details, picks, tiles) — URLs carry ids, chips still get labels.
import { filterName, seedName, seedPerformerPick } from "../lib/names";
// Detail views (payload types, DetailSections, RelatedTitles,
// CatalogDetailView) live in catalog-detail.tsx; the browse view hosts the
// detail overlay and reads its target from the URL.
// The missing-key line is the discover surface's shared component (same
// wording everywhere: a missing credential, never an outage).
import { NotConfiguredLine } from "./discover";
import { CatalogDetailView, detailTarget } from "./catalog-detail.tsx";
// Endless scroll appends pages through this dedupe-append (lib stays
// React-free so node --test can exercise it directly).
import { mergePageItems } from "../lib/browse-items.ts";
// Browse URL policy (per-type sorts, filter resets, count) lives in
// browse-url.ts — a pure React-free module pinned by tests. Its sort policy
// derives from the shared SORT_CAPABILITIES table (lib/sorts.ts), the same
// table the server's acceptance comes from.
import {
  browseFilterPatch,
  clearBrowseKeys,
  countActiveFilters,
  performerModePatch,
  performersPatch,
  starredPatch,
  studiosPatch,
  typePatch,
  yearRangePatch,
  type BrowseEntryState,
  type BrowseFilter,
} from "../lib/browse-url";
// The multi-entity browse semantics (source qualification, stream seeds,
// merged-source sort restriction) live beside the server's planner in
// browse-entities.ts; the client reads the same functions so its offers
// can never drift from what the server accepts.
import {
  MAX_BROWSE_ENTITIES,
  planStreams,
  tpdbFilmographyRuns,
  type PerformerMode,
} from "../lib/browse-entities";
// Sort capability is shared with the server: the options offered per tab,
// the labels and the direction rule all derive from src/lib/sorts.ts — one
// table answers what the client offers and what the server accepts.
import {
  BROWSE_MIXED_SORTS,
  browseSortIsDirectional,
  browseSortsFor,
  SORT_LABELS,
  type SortKey,
} from "../lib/sorts";

type CatalogSearchPage = {
  provider: CatalogProvider;
  kind: CatalogKind;
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
};

/* ---------- Small helpers ---------- */

/* ---------- Browse-context helpers ---------- */

const POSTER_GRID = "poster-grid";

/* ---------- Filter drawer (native <dialog>) ---------- */

/** Right-hand drawer on a native dialog: showModal gives Escape, a modal
 * backdrop and focus entry; the close event restores focus natively.
 * Backdrop clicks (target === dialog) and the header/footer buttons close.
 * Filters commit to the URL immediately — the drawer never buffers them. */
function FilterDrawer({
  open,
  onClose,
  count,
  onClear,
  children,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="cat-drawer"
      aria-label="Filters"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
    >
      <div className="cat-drawer-head">
        <h2 className="cat-drawer-title">
          Filters{count > 0 ? ` · ${count} active` : ""}
        </h2>
        <button
          type="button"
          className="btn"
          aria-label="Close filters"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="cat-drawer-body" tabIndex={-1}>
        {children}
      </div>
      <div className="cat-drawer-foot">
        <button
          type="button"
          className="btn"
          onClick={onClear}
          disabled={count === 0}
        >
          Clear all
        </button>
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => ref.current?.close()}
        >
          Close filters
        </button>
      </div>
    </dialog>
  );
}

function FiltersButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn"
      aria-haspopup="dialog"
      aria-label={count > 0 ? `Filters, ${count} active` : "Filters"}
      onClick={onClick}
    >
      <Icon name="filter" /> Filters
      {count > 0 && <span className="cat-count">{count}</span>}
    </button>
  );
}

/** Sort control offering only what the selected type genuinely supports;
 * direction appears only with an explicit sort that takes one — a
 * non-directional order (TPDB relevance) sends no direction, which the
 * server requires. */
function SortSelect({
  id,
  type,
  sort,
  direction,
  disabled,
  merged,
  onSort,
  onDirection,
}: {
  id: string;
  type: "all" | "movie" | "scene";
  sort: string;
  direction: string;
  /** TPDB filmography route rejects sort — disabled while a TPDB performer
   * filter is active. */
  disabled?: boolean;
  /** A source that pages 2+ merged upstream lists (2+ TPDB studio lists,
   * 2+ StashDB child-studio searches) only orders honestly by recency and
   * duration: the offers clamp to BROWSE_MIXED_SORTS, the same refusal the
   * server applies. */
  merged?: boolean;
  onSort: (v: string) => void;
  onDirection: (v: "asc" | "desc") => void;
}) {
  const sorts = browseSortsFor(type).filter(
    (s) => !merged || BROWSE_MIXED_SORTS.includes(s),
  );
  if (sorts.length === 0) return null;
  // Rule 39: up to five exclusive orders read at once as segments (equal
  // width, .segmented); a longer list keeps the select with its visible
  // label. Same values and URL keys either way.
  if (sorts.length + 1 <= 5) {
    return (
      <div>
        <span className="label" id={`${id}-label`}>
          Sort
        </span>
        <div className="flex gap-2">
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            className="segmented"
          >
            <button
              type="button"
              aria-pressed={sort === ""}
              disabled={disabled}
              onClick={() => onSort("")}
            >
              Provider default
            </button>
            {sorts.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                disabled={disabled}
                onClick={() => onSort(s)}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
          {sort !== "" && browseSortIsDirectional(type, sort as SortKey) && (
            <button
              type="button"
              className="btn shrink-0"
              aria-label={
                direction === "asc" ? "Sort ascending" : "Sort descending"
              }
              title={direction === "asc" ? "Sort ascending" : "Sort descending"}
              disabled={disabled}
              onClick={() => onDirection(direction === "asc" ? "desc" : "asc")}
            >
              <Icon name={direction === "asc" ? "sort-asc" : "sort-desc"} />
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <label className="label" htmlFor={id}>
        Sort
      </label>
      <div className="flex gap-2">
        <select
          id={id}
          className="input"
          value={sort}
          disabled={disabled}
          onChange={(e) => onSort(e.target.value)}
        >
          <option value="">Provider default</option>
          {sorts.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
        {sort !== "" && browseSortIsDirectional(type, sort as SortKey) && (
          <button
            type="button"
            className="btn shrink-0"
            aria-label={
              direction === "asc" ? "Sort ascending" : "Sort descending"
            }
            title={direction === "asc" ? "Sort ascending" : "Sort descending"}
            disabled={disabled}
            onClick={() => onDirection(direction === "asc" ? "desc" : "asc")}
          >
            <Icon name={direction === "asc" ? "sort-asc" : "sort-desc"} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Local input that resyncs when the URL value changes from the outside
 * (chip removal, provider switch, Back) without fighting the user's typing. */
export function useSyncedInput(value: string) {
  const [input, setInput] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setInput(value);
    }
  });
  const mark = useCallback((v: string) => {
    committed.current = v;
  }, []);
  return { input, setInput, mark };
}

function SearchBox({
  id,
  label,
  value,
  onCommit,
  placeholder = "Search titles…",
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { input, setInput, mark } = useSyncedInput(value);
  const commit = useCallback(
    (v: string) => {
      const t = v.trim();
      mark(t);
      onCommit(t);
    },
    [mark, onCommit],
  );
  useEffect(() => {
    if (input === value) return;
    const t = setTimeout(() => commit(input), 400);
    return () => clearTimeout(t);
  }, [input, value, commit]);
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-lead">
        <Icon name="search" />
        <input
          id={id}
          type="search"
          className="input"
          maxLength={200}
          placeholder={placeholder}
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(input);
          }}
        />
      </div>
    </div>
  );
}

/** The server accepts nothing but a 4-digit year inside the catalog band;
 * the range boxes never commit junk past this predicate. */
function isCatalogYear(v: string): boolean {
  return (
    /^\d{4}$/.test(v) &&
    Number(v) >= CATALOG_YEAR_MIN &&
    Number(v) <= CATALOG_YEAR_MAX
  );
}

/** One commit writes both year bounds: `from` is the native `year` key, an
 * empty `to` means one year, and clearing `from` clears the whole range —
 * a `yearTo` without a `year` would 400. */
function YearRange({
  fromId,
  toId,
  year,
  yearTo,
  disabled,
  onCommit,
}: {
  fromId: string;
  toId: string;
  year: string;
  yearTo: string;
  disabled?: boolean;
  onCommit: (year: string, yearTo: string) => void;
}) {
  const from = useSyncedInput(year);
  const to = useSyncedInput(yearTo);
  const commit = (fromRaw: string, toRaw: string) => {
    if (disabled) return;
    const f = fromRaw.trim();
    const t = f === "" ? "" : toRaw.trim();
    if (f !== "" && !isCatalogYear(f)) return;
    if (t !== "" && !isCatalogYear(t)) return;
    from.mark(f);
    to.mark(t);
    onCommit(f, t);
  };
  return (
    <div>
      <span className="label" id={`${fromId}-label`}>
        Year
      </span>
      <div className="flex items-center gap-2">
        <input
          id={fromId}
          type="number"
          inputMode="numeric"
          min={CATALOG_YEAR_MIN}
          max={CATALOG_YEAR_MAX}
          placeholder="From"
          aria-labelledby={`${fromId}-label`}
          className="input"
          value={from.input}
          disabled={disabled}
          onChange={(e) => from.setInput(e.target.value)}
          onBlur={() => commit(from.input, to.input)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(from.input, to.input);
          }}
        />
        <span className="text-sm text-muted">to</span>
        <input
          id={toId}
          type="number"
          inputMode="numeric"
          min={CATALOG_YEAR_MIN}
          max={CATALOG_YEAR_MAX}
          placeholder="To"
          aria-label="Year to"
          className="input"
          value={to.input}
          disabled={disabled}
          onChange={(e) => to.setInput(e.target.value)}
          onBlur={() => commit(from.input, to.input)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(from.input, to.input);
          }}
        />
      </div>
    </div>
  );
}

function FilterChip({
  text,
  label,
  onRemove,
  icon,
  note,
}: {
  /** The value shown; the group around the chip names its kind. */
  text: string;
  /** The full filter for assistive tech ("Tags: anal (must have)"). */
  label: string;
  onRemove: () => void;
  /** star = a mode, not a value; plus/minus = must have / must not have,
   * the same marks the drawer uses. */
  icon?: "star" | "plus" | "minus";
  /** Muted prefix that qualifies the value ("Free text:"), as in the drawer. */
  note?: string;
}) {
  return (
    <button
      type="button"
      className={`filter-chip${icon === "minus" ? " is-exclude" : icon === "plus" ? " is-include" : ""}`}
      onClick={onRemove}
      aria-label={`Remove filter: ${label}`}
    >
      {icon && (
        <Icon
          name={icon}
          filled={icon === "star"}
          className="filter-chip-mark"
        />
      )}
      {note && <span className="text-muted">{note}</span>}
      {text}
      <span className="filter-chip-x" aria-hidden="true">
        <Icon name="close" />
      </span>
    </button>
  );
}

/** Server-side release-date operators; the vocabulary mirrors the route's
 * explicit allow-list, never the provider's. */
const DATE_OPS = [
  { v: ">=", label: "on or after" },
  { v: "<=", label: "on or before" },
  { v: "=", label: "exactly" },
  { v: "<", label: "before" },
  { v: ">", label: "after" },
] as const;

function dateOpLabel(v: string): string {
  return DATE_OPS.find((o) => o.v === v)?.label ?? v;
}

/** TPDB movie only: `date` + `date_operation` commit as one pair —
 * either half alone is a 400. Setting a date clears `year` (the views wire
 * that in onCommit); StashDB has no date filter so this is never rendered
 * there. */
function DateCutoff({
  id,
  date,
  operation,
  disabled,
  onCommit,
}: {
  id: string;
  date: string;
  operation: string;
  disabled?: boolean;
  onCommit: (date: string | null, op: string | null) => void;
}) {
  // The comparison persists locally so choosing it before a date is not
  // lost; nothing reaches the URL until a date completes the pair.
  const [op, setOp] = useState(operation || ">=");
  useEffect(() => {
    if (date && operation) setOp(operation);
  });
  return (
    <div>
      <label className="label" htmlFor={`${id}-date`} id={`${id}-date-label`}>
        Release date
      </label>
      {/* Stacked: five comparison segments do not fit beside a date input
          in the narrow drawer; the strip scrolls when it must. */}
      <div className="grid gap-2">
        <input
          id={`${id}-date`}
          type="date"
          className="input"
          value={date}
          disabled={disabled}
          onChange={(e) =>
            onCommit(e.target.value || null, e.target.value ? op : null)
          }
        />
        {/* Five exclusive comparisons: segments, not a dropdown (rule 39),
            wrapped in rows. The row's visible label names the group. */}
        <div
          role="group"
          aria-labelledby={`${id}-date-label`}
          className="segmented segmented-wrap"
        >
          {DATE_OPS.map((o) => (
            <button
              key={o.v}
              type="button"
              aria-pressed={op === o.v}
              disabled={disabled}
              onClick={() => {
                setOp(o.v);
                if (date) onCommit(date, o.v);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Debounced lookup behind the performer and studio filters: the filters
 * take provider-native ids, so the user picks a result — a typed name is
 * never sent. One field searches both sources; each result carries its
 * side. Failures stay per side and sides the session marks not configured
 * are skipped, so one source failing never hides the other source's rows.
 * TPDB search is paged; StashDB is unpaged and caps its result list, which
 * the pickers say out loud. */
function useCatalogOptions(
  kind: Extract<CatalogKind, "performer" | "studio">,
  term: string,
): {
  items: { detail: CatalogDetail; side: CatalogProvider }[];
  errors: { provider: CatalogProvider; message: string }[];
  skipped: CatalogProvider[];
  loading: boolean;
} {
  const t = term.trim();
  const { providers } = useSession();
  // The debounce commits the read path, not the fetch: keystrokes settle
  // before the hook sees a new read at all.
  const [committed, setCommitted] = useState<string | null>(null);
  useEffect(() => {
    if (t === "") {
      setCommitted(null);
      return;
    }
    const timer = setTimeout(() => setCommitted(t), 400);
    return () => clearTimeout(timer);
  }, [t]);
  const search = (provider: CatalogProvider) =>
    `/api/catalog/search?${new URLSearchParams({
      provider,
      kind,
      q: committed ?? "",
      ...(provider === "tpdb" ? { page: "1", perPage: "10" } : {}),
    })}`;
  // A side the session marks not configured can never answer; looking it up
  // would only draw its guaranteed 503 over the working side's rows. An
  // unknown status (session not loaded) still looks the side up.
  const tpdb = useApiGet<CatalogSearchPage>(
    committed !== null && providers?.tpdb !== "not_configured"
      ? search("tpdb")
      : null,
    [committed],
  );
  const stash = useApiGet<CatalogSearchPage>(
    committed !== null && providers?.stashdb !== "not_configured"
      ? search("stashdb")
      : null,
    [committed],
  );
  // Failures stay per side: one source failing must not hide the other
  // source's rows, and the picker names the side that failed.
  const errors = [
    ...(tpdb.error !== null
      ? [{ provider: "tpdb" as const, message: tpdb.error }]
      : []),
    ...(stash.error !== null
      ? [{ provider: "stashdb" as const, message: stash.error }]
      : []),
  ];
  const skipped = providers
    ? (["tpdb", "stashdb"] as const).filter(
        (p) => providers[p] === "not_configured",
      )
    : [];
  return {
    items: [
      ...(tpdb.data?.items ?? []).map((detail) => ({
        detail,
        side: "tpdb" as const,
      })),
      ...(stash.data?.items ?? []).map((detail) => ({
        detail,
        side: "stashdb" as const,
      })),
    ],
    errors,
    skipped,
    loading: t !== "" && (committed !== t || tpdb.loading || stash.loading),
  };
}

/** The chip label for one browse entity: the writer's captured name when it
 * travelled, else the seeded name for each id it carries (a TPDB studio id
 * may be a slug), joined when one entry pairs both providers. Never a fake
 * label — an unseeded id stays a #fragment (see filterName). */
function entityLabel(e: BrowseEntity, kind: "performer" | "studio"): string {
  if (e.name) return e.name;
  return [
    e.tpdb !== undefined ? filterName("tpdb", kind, e.tpdb) : "",
    e.stashdb !== undefined ? filterName("stashdb", kind, e.stashdb) : "",
  ]
    .filter((s) => s !== "")
    .join(" + ");
}

/** The picked entries of one entity filter, as removable chips — the same
 * chip the active-filter row uses, so a pick looks the same in the drawer
 * and on the page. */
function EntityChips({
  entries,
  kind,
  onRemove,
}: {
  entries: BrowseEntity[];
  kind: "performer" | "studio";
  onRemove: (entry: BrowseEntity) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <ul
      className="mt-2 flex list-none flex-wrap gap-1.5 p-0"
      aria-label={`Picked ${kind}s`}
    >
      {entries.map((entry, i) => (
        <li key={`${i}:${entry.tpdb ?? ""}:${entry.stashdb ?? ""}`}>
          <button
            type="button"
            className="filter-chip"
            onClick={() => onRemove(entry)}
            aria-label={`Remove ${kind}: ${entityLabel(entry, kind)}`}
          >
            {entityLabel(entry, kind)}
            <span className="filter-chip-x" aria-hidden="true">
              <Icon name="close" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The provider ids a filter's entries already hold, per side — the
 * namespaces differ, so each side checks its own set. A search result the
 * filter holds is never offered twice. */
function heldEntityIds(entries: BrowseEntity[]): {
  tpdb: Set<string>;
  stashdb: Set<string>;
} {
  return {
    tpdb: new Set(
      entries.flatMap((e) => (e.tpdb !== undefined ? [e.tpdb] : [])),
    ),
    stashdb: new Set(
      entries.flatMap((e) => (e.stashdb !== undefined ? [e.stashdb] : [])),
    ),
  };
}

function PerformerPicker({
  id,
  entries,
  performerMode,
  starred,
  onStarred,
  onMode,
  onRemove,
  onPick,
}: {
  id: string;
  entries: BrowseEntity[];
  performerMode: PerformerMode;
  starred: boolean;
  onStarred: (on: boolean) => void;
  onMode: (mode: PerformerMode) => void;
  onRemove: (entry: BrowseEntity) => void;
  onPick: (side: CatalogProvider, performerId: string, name: string) => void;
}) {
  const [term, setTerm] = useState("");
  const { items, errors, skipped, loading } = useCatalogOptions(
    "performer",
    term,
  );
  const capped = entries.length >= MAX_BROWSE_ENTITIES;
  const held = heldEntityIds(entries);
  const rows = items.filter(
    ({ detail, side }) => !held[side].has(detail.reference.id),
  );
  return (
    <div>
      <label className="label" htmlFor={id}>
        Performer
      </label>
      {capped ? (
        <p className="cat-note">
          Performer limit reached ({MAX_BROWSE_ENTITIES}) — remove one before
          adding another.
        </p>
      ) : (
        <div className="input-lead">
          <Icon name="performer" />
          <input
            id={id}
            type="search"
            className="input"
            maxLength={200}
            placeholder="Search performers…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
      )}
      <EntityChips entries={entries} kind="performer" onRemove={onRemove} />
      {/* Starred is a mode of this one filter: the server refuses a starred
          filter beside a picked performer, so "any" and "starred" are two
          states of one criterion, shown as one choice under the field. */}
      <div
        role="group"
        aria-label="Which performers"
        className="segmented cat-starred"
      >
        <button
          type="button"
          aria-pressed={!starred}
          onClick={() => starred && onStarred(false)}
        >
          Any performer
        </button>
        <button
          type="button"
          aria-pressed={starred}
          onClick={() => !starred && onStarred(true)}
        >
          <Icon name="star" filled={starred} />
          Starred only
        </button>
      </div>
      {/* Two or more picked performers read as one question: does a title
          need all of them or any of them (StashDB's all/any). The visible
          caption keeps the row from reading as a fourth state of the
          starred choice above it. */}
      {entries.length >= 2 && (
        <div>
          <span className="label">Match</span>
          <div
            role="group"
            aria-label="How the performers match"
            className="segmented"
          >
            <button
              type="button"
              aria-pressed={performerMode === "all"}
              onClick={() => onMode("all")}
            >
              All of them
            </button>
            <button
              type="button"
              aria-pressed={performerMode === "any"}
              onClick={() => onMode("any")}
            >
              Any of them
            </button>
          </div>
        </div>
      )}
      <p className="cat-note">
        {starred
          ? "Scenes featuring any performer you follow. Picking a performer replaces this; performers known only to TPDB cannot match."
          : `Up to ${MAX_BROWSE_ENTITIES} performers, each pickable from either source; with 2 or more, choose All of them or Any of them. A TPDB performer opens movies through the filmography route; a StashDB performer filters scenes (StashDB caps results at about ten rows).`}
      </p>
      {!capped &&
        (loading ? (
          <p className="cat-note" aria-live="polite">
            Searching…
          </p>
        ) : rows.length > 0 ? (
          <ul className="cat-picker">
            {rows.map(({ detail, side }) => (
              <li key={`${side}:${detail.reference.id}`}>
                <button
                  type="button"
                  className="cat-picker-row"
                  onClick={() => {
                    seedPerformerPick(side, detail);
                    onPick(side, detail.reference.id, detail.title);
                    setTerm("");
                  }}
                >
                  <ItemImage
                    name={detail.title}
                    src={imgSrc(detail.imageUrl)}
                    className="cat-picker-img"
                  />
                  <span>{detail.title}</span>
                  <span className="text-xs text-muted">
                    {side === "tpdb" ? "TPDB" : "StashDB"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : term.trim() !== "" &&
          errors.length === 0 &&
          skipped.length === 0 ? (
          // Empty is only claimed when nothing failed and nothing was skipped:
          // the notes below carry the failures, like the grid's per-provider
          // panels.
          <p className="cat-note">No performers match “{term.trim()}”.</p>
        ) : null)}
      {errors.map((e) => (
        <p key={e.provider} className="cat-note" role="alert">
          {providerLabel(e.provider)} search failed: {e.message}
        </p>
      ))}
      {skipped.map((p) => (
        <p key={`skipped-${p}`} className="cat-note">
          {providerLabel(p)} is not configured, so it was not searched.
        </p>
      ))}
    </div>
  );
}

/** The studio filter's picker, the performer picker minus the starred
 * mode: same dual-source search, same chips, same cap, and a result the
 * filter holds is never offered twice. */
function StudioPicker({
  id,
  entries,
  onRemove,
  onPick,
}: {
  id: string;
  entries: BrowseEntity[];
  onRemove: (entry: BrowseEntity) => void;
  onPick: (side: CatalogProvider, studioId: string, name: string) => void;
}) {
  const [term, setTerm] = useState("");
  const { items, errors, skipped, loading } = useCatalogOptions("studio", term);
  const capped = entries.length >= MAX_BROWSE_ENTITIES;
  const held = heldEntityIds(entries);
  const rows = items.filter(
    ({ detail, side }) => !held[side].has(detail.reference.id),
  );
  return (
    <div>
      <label className="label" htmlFor={id}>
        Studio
      </label>
      {capped ? (
        <p className="cat-note">
          Studio limit reached ({MAX_BROWSE_ENTITIES}) — remove one before
          adding another.
        </p>
      ) : (
        <div className="input-lead">
          <Icon name="movie" />
          <input
            id={id}
            type="search"
            className="input"
            maxLength={200}
            placeholder="Search studios…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
      )}
      <EntityChips entries={entries} kind="studio" onRemove={onRemove} />
      <p className="cat-note">
        Up to {MAX_BROWSE_ENTITIES} studios; a title from any of them matches.
      </p>
      {!capped &&
        (loading ? (
          <p className="cat-note" aria-live="polite">
            Searching…
          </p>
        ) : rows.length > 0 ? (
          <ul className="cat-picker">
            {rows.map(({ detail, side }) => (
              <li key={`${side}:${detail.reference.id}`}>
                <button
                  type="button"
                  className="cat-picker-row"
                  onClick={() => {
                    seedName(
                      {
                        provider: side,
                        kind: "studio",
                        id: detail.reference.id,
                      },
                      detail.title,
                    );
                    onPick(side, detail.reference.id, detail.title);
                    setTerm("");
                  }}
                >
                  <ItemImage
                    name={detail.title}
                    src={imgSrc(detail.imageUrl)}
                    className="cat-picker-img"
                  />
                  <span>{detail.title}</span>
                  <span className="text-xs text-muted">
                    {side === "tpdb" ? "TPDB" : "StashDB"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : term.trim() !== "" &&
          errors.length === 0 &&
          skipped.length === 0 ? (
          <p className="cat-note">No studios match “{term.trim()}”.</p>
        ) : null)}
      {errors.map((e) => (
        <p key={e.provider} className="cat-note" role="alert">
          {providerLabel(e.provider)} search failed: {e.message}
        </p>
      ))}
      {skipped.map((p) => (
        <p key={`skipped-${p}`} className="cat-note">
          {providerLabel(p)} is not configured, so it was not searched.
        </p>
      ))}
    </div>
  );
}

function NotConfigured({ provider }: { provider: CatalogProvider }) {
  return (
    <div className="panel p-4" role="note">
      <NotConfiguredLine
        source={provider}
        consequence="there is nothing to search"
      />
    </div>
  );
}

/* ---------- Unified browse ---------- */

/** One page from GET /api/browse. Wire shape mirrors the service's
 * BrowsePage plus the API's per-caller hiddenTagCount; kept local —
 * contracts.ts stays domain records. */
type BrowsePage = {
  items: CatalogDetail[];
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  errors: { provider: CatalogProvider; code: string; message: string }[];
  /** Query-scoped, so every page of one query carries the same set: the
   * latest page's value wins in the accumulator, never a merge. */
  notices?: BrowseNotice[];
  hiddenTagCount?: number;
};

/** The grid's accumulated state: items from every fetched page plus the
 * meta of the latest fetch. `page` is the last fetched page number —
 * component state, never a URL key. */
type BrowseAccum = {
  items: CatalogDetail[];
  page: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  errors: { provider: CatalogProvider; code: string; message: string }[];
  notices: BrowseNotice[];
  hiddenTagCount: number;
};

/** One tag selection as it travels the include list: a single selection or
 * a 2+-selection "or" group (the members are one term — "Blonde or
 * Redhead" — whose union matches). */
type IncludeTag = CatalogTagSelection | CatalogTagSelection[];

function isTagSelection(r: unknown): r is CatalogTagSelection {
  return (
    typeof r === "object" &&
    r !== null &&
    "name" in r &&
    typeof r.name === "string"
  );
}

/** exclude rides the URL as a JSON array of CatalogTagSelection. A
 * malformed value degrades to none — the server is the authority on shape,
 * the URL is just a carrier. */
function parseTags(v: string | null): CatalogTagSelection[] {
  if (!v) return [];
  try {
    const rows: unknown = JSON.parse(v);
    if (!Array.isArray(rows)) return [];
    return rows.filter(isTagSelection);
  } catch {
    return [];
  }
}

/** include rides the URL as a JSON array whose elements are selections or
 * selection arrays ("or" groups). A malformed element degrades to none,
 * exactly like parseTags — the server is the authority on shape. */
function parseIncludeTags(v: string | null): IncludeTag[] {
  if (!v) return [];
  try {
    const rows: unknown = JSON.parse(v);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r): IncludeTag[] => {
      if (isTagSelection(r)) return [r];
      if (Array.isArray(r) && r.length >= 2 && r.every(isTagSelection))
        return [r];
      return [];
    });
  } catch {
    return [];
  }
}

/** Performers/studios ride the URL as JSON arrays of 1–5 entries, each
 * carrying at least one provider id (`{name?, tpdb?, stashdb?}`). A
 * malformed value degrades to none — same carrier rule as the tags. */
function parseEntities(v: string | null): BrowseEntity[] {
  if (!v) return [];
  try {
    const rows: unknown = JSON.parse(v);
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is BrowseEntity => {
      return (
        typeof r === "object" &&
        r !== null &&
        (("tpdb" in r && typeof r.tpdb === "string") ||
          ("stashdb" in r && typeof r.stashdb === "string"))
      );
    });
  } catch {
    return [];
  }
}

/** The muted note for one browse notice: which titles the source skipped
 * or narrowed and why, naming the affected entries and the source that
 * cannot know them. A note, never an error — the grid's total stays
 * honest. A provider's notice always concerns its own media: TPDB owns
 * movies, StashDB scenes. */
function noticeText(n: BrowseNotice): string {
  const media = n.provider === "tpdb" ? "Movies" : "Scenes";
  const source = providerLabel(n.provider);
  const names = n.entries
    .map((e) => {
      if (e.name) return e.name;
      const id = n.provider === "tpdb" ? e.tpdb : e.stashdb;
      return id !== undefined ? filterName(n.provider, n.kind, id) : "";
    })
    .filter((s) => s !== "")
    .join(", ");
  const one = n.entries.length === 1;
  if (n.code === "not_searched")
    return `${media} were not searched: ${names} ${one ? "has" : "have"} no ${source} id in this filter.`;
  return n.kind === "studio"
    ? `${media} from ${names} ${one ? "is" : "are"} not included: no ${source} id in this filter.`
    : `${media} are not filtered by ${names}: no ${source} id in this filter.`;
}

/** Builds the filter part of the GET /api/browse path from canonical URL
 * keys — verbatim plan names, performers/studios/include/exclude as JSON,
 * `date_operation` for dateOperation. The caller appends `&page=${n}`:
 * pages are component state under endless scroll. An outage is an error,
 * never an empty page. */
function browsePath(f: {
  type: "all" | "movie" | "scene";
  q: string;
  include: IncludeTag[];
  exclude: CatalogTagSelection[];
  performers: BrowseEntity[];
  studios: BrowseEntity[];
  performerMode: PerformerMode;
  performerStarred: boolean;
  studioMode: string;
  year: string;
  yearTo: string;
  date: string;
  dateOperation: string;
  sort: string;
  direction: string;
  perPage: number;
}): string {
  const qs = new URLSearchParams();
  if (f.type !== "all") qs.set("type", f.type);
  if (f.q) qs.set("q", f.q);
  if (f.include.length > 0) qs.set("include", JSON.stringify(f.include));
  if (f.exclude.length > 0) qs.set("exclude", JSON.stringify(f.exclude));
  if (f.performers.length > 0)
    qs.set("performers", JSON.stringify(f.performers));
  if (f.studios.length > 0) qs.set("studios", JSON.stringify(f.studios));
  if (f.performerMode === "any") qs.set("performerMode", "any");
  if (f.performerStarred) qs.set("performerStarred", "1");
  if (f.studioMode) qs.set("studioMode", f.studioMode);
  // The range's upper bound travels only beside a start year — a yearTo
  // without a year would 400.
  if (f.year) {
    qs.set("year", f.year);
    if (f.yearTo) qs.set("yearTo", f.yearTo);
  }
  if (f.date) {
    qs.set("date", f.date);
    qs.set("date_operation", f.dateOperation);
  }
  if (f.sort) {
    qs.set("sort", f.sort);
    if (f.direction) qs.set("direction", f.direction);
  }
  qs.set("perPage", String(f.perPage));
  return `/api/browse?${qs.toString()}`;
}

// Detail filter entry points create canonical unified browse constraints:
// the jump always lands on the titles view (any view may host an entry
// point), type and the one constraint follow the filter's provider (year is
// TPDB-movie-only), every other constraint resets — a detail entry point
// starts a clean browse — and the old tags any/all modes are gone.
// Constraint change → push.
export function useBrowseTo(): (filter: BrowseFilter) => void {
  const setP = useParamsSetter();
  return useCallback(
    (filter: BrowseFilter) => setP(browseFilterPatch(filter), { push: true }),
    [setP],
  );
}
/* ---------- Unified titles view ---------- */

const TYPE_LABELS = { all: "All", movie: "Movies", scene: "Scenes" } as const;

/** The one browse destination: TPDB movies and StashDB scenes in a single
 * grid behind GET /api/browse, told apart by the cards' own badges.
 * All/Movies/Scenes is a filter (URL `type`), never separate navigation;
 * a media detail opens over the grid, which stays mounted but hidden.
 * URL keys are the plan's canonical browse keys — performers/studios/
 * include ride as JSON arrays, include with optional "or" groups. */
export function TitlesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  // The detail overlay's entry points jump back into this browse view.
  const browseTo = useBrowseTo();

  const typeRaw = params.get("type");
  // Anything that is not movie/scene reads as the `all` default.
  const type = typeRaw === "movie" || typeRaw === "scene" ? typeRaw : "all";
  const q = params.get("q") ?? "";
  const include = parseIncludeTags(params.get("include"));
  const exclude = parseTags(params.get("exclude"));
  const performers = parseEntities(params.get("performers"));
  const studios = parseEntities(params.get("studios"));
  // `all` is the default and never travels the URL.
  const performerMode = params.get("performerMode") === "any" ? "any" : "all";
  const performerStarred = params.get("performerStarred") === "1";
  const studioMode =
    params.get("studioMode") === "withChildren" ? "withChildren" : "";
  const year = params.get("year") ?? "";
  const yearTo = params.get("yearTo") ?? "";
  // date + date_operation commit as one pair; half a pair is never sent.
  const dateRaw = params.get("date") ?? "";
  const opRaw = params.get("date_operation") ?? "";
  const date = dateRaw !== "" && opRaw !== "" ? dateRaw : "";
  const dateOperation = date !== "" ? opRaw : "";
  // The stream plan is the client half of the server's planner: the same
  // seeds order the merge, and a source that pages 2+ merged upstream
  // lists (2+ TPDB studio lists, 2+ StashDB child-studio searches) only
  // orders honestly by recency and duration. The offers and the stale-sort
  // clamp below keep the URL from ever forming a request the server
  // refuses with invalid_search — same clamp the per-type check applies.
  const streamPlan = planStreams(
    type,
    performers,
    studios,
    performerMode,
    studioMode === "withChildren" ? "withChildren" : "exact",
    performerStarred,
  );
  const merged =
    streamPlan.seeds.filter((s) => s.tpdbStudio !== undefined).length > 1 ||
    streamPlan.seeds.filter((s) => s.parentStudioId !== undefined).length > 1;
  // A sort the selected type does not support — or one a merged source
  // would refuse — is clamped to the provider default: visible in the
  // select, never sent upstream for a 400. A direction rides only on sorts
  // that take one: a stale direction next to TPDB relevance would 400 the
  // search.
  const sorts = browseSortsFor(type).filter(
    (s) => !merged || BROWSE_MIXED_SORTS.includes(s),
  );
  const sortRaw = params.get("sort") ?? "";
  const sort = (sorts as readonly string[]).includes(sortRaw) ? sortRaw : "";
  const dirRaw = params.get("direction") ?? "";
  const direction =
    sort !== "" &&
    browseSortIsDirectional(type, sort as SortKey) &&
    (dirRaw === "asc" || dirRaw === "desc")
      ? dirRaw
      : "";
  // Everything the entry patches need to re-clamp the sort when a pick or
  // a removal changes a source's merge status.
  const entryState: BrowseEntryState = {
    type,
    sortRaw,
    dirRaw,
    performerMode,
    performers,
    studios,
    performerStarred,
  };
  // The TPDB filmography route refuses search, sort and date everywhere
  // but the Scenes tab, where StashDB owns the side and it never runs.
  const filmography = tpdbFilmographyRuns(type, performers, performerMode);
  // Child studios are a StashDB-only criterion: one TPDB id in the studio
  // entries blocks the whole scope choice.
  const studioBlocked = studios.some((e) => e.tpdb !== undefined);
  const [perPage, setPerPage] = useState(() =>
    Math.min(100, Math.max(1, intOr(params.get("perPage"), 24))),
  );
  const [reload, setReload] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Endless scroll: pages accumulate in component state — the URL keeps the
  // filters, never a page number.
  const [acc, setAcc] = useState<BrowseAccum | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  /* Grid columns come from the rendered CSS tracks, so the page size is
   * whole rows: nine columns means 27 items, not 24. The probe is always
   * mounted, so the tracks are known before the first fetch. The size is
   * set once per view: a later column change (sidebar collapse, a window
   * resize) must not refetch from page 1 — that blanked the grid and lost
   * the scroll. The display trims to whole rows instead (below). */
  const [gridRef, cols] = useGridColumns();
  const rounded = cols > 0 ? Math.min(100, cols * Math.ceil(24 / cols)) : 0;
  const sizedRef = useRef(false);
  useEffect(() => {
    if (sizedRef.current || rounded === 0) return;
    sizedRef.current = true;
    if (rounded !== perPage) {
      setPerPage(rounded);
      setP({ perPage: String(rounded) });
    }
  }, [rounded, perPage, setP]);

  // Personal hidden tags changed in Preferences while this view is alive:
  // refetch so hidden rows never linger as current results.
  useEffect(() => {
    const bump = () => setReload((n) => n + 1);
    window.addEventListener("velvarr:preferences-changed", bump);
    return () =>
      window.removeEventListener("velvarr:preferences-changed", bump);
  }, []);

  const basePath = useMemo(
    () =>
      browsePath({
        type,
        q,
        include,
        exclude,
        performers,
        studios,
        performerMode,
        performerStarred,
        studioMode,
        year,
        yearTo,
        date,
        dateOperation,
        sort,
        direction,
        perPage,
      }),
    [
      type,
      q,
      include,
      exclude,
      performers,
      studios,
      performerMode,
      performerStarred,
      studioMode,
      year,
      yearTo,
      date,
      dateOperation,
      sort,
      direction,
      perPage,
    ],
  );

  /** One GET of a browse page. `reset` drops the accumulated grid first — a
   * filter change can never show the previous query's rows under it; `more`
   * appends, deduped, so provider reorders never render a card twice. A
   * stale in-flight response (query changed meanwhile) is dropped. */
  const load = useCallback(
    async (n: number, mode: "reset" | "more") => {
      const seq = ++seqRef.current;
      if (mode === "reset") setAcc(null);
      setLoading(true);
      setError(null);
      try {
        const page = await api<BrowsePage>(`${basePath}&page=${n}`);
        if (seqRef.current !== seq) return;
        setAcc((prev) => {
          if (mode === "reset" || prev === null) {
            return {
              items: page.items,
              page: n,
              hasMore: page.hasMore,
              total: page.total,
              totalCountKnown: page.totalCountKnown,
              errors: page.errors,
              notices: page.notices ?? [],
              hiddenTagCount: page.hiddenTagCount ?? 0,
            };
          }
          const items = mergePageItems(prev.items, page.items);
          return {
            ...prev,
            items,
            page: n,
            // A page that adds no items cannot progress: end automatic
            // pagination, or the sentinel re-fires forever. Named errors
            // stay visible; retry refetches from page 1.
            hasMore: items.length > prev.items.length ? page.hasMore : false,
            ...(page.total !== undefined ? { total: page.total } : {}),
            totalCountKnown: page.totalCountKnown,
            // The server rebuilds each page from scratch and reports only
            // that request's errors, so an append keeps earlier pages'
            // named errors (newest message per provider wins) until a
            // reset; a recovered provider cannot unreport its lost rows.
            errors: [
              ...prev.errors.filter(
                (pe) => !page.errors.some((ne) => ne.provider === pe.provider),
              ),
              ...page.errors,
            ],
            // Notices are query-scoped, not page-scoped: the latest page's
            // set replaces, never accumulates.
            notices: page.notices ?? [],
            hiddenTagCount: page.hiddenTagCount ?? prev.hiddenTagCount,
          };
        });
      } catch (e) {
        if (seqRef.current !== seq) return;
        setError(messageOf(e));
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    },
    [basePath],
  );

  // Any filter, perPage or reload change restarts the grid at page 1.
  useEffect(() => {
    void load(1, "reset");
  }, [load, reload]);

  // Sentinel below the grid: the next page starts loading before the user
  // reaches the bottom (800px early), so scrolling feels continuous.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [nearEnd, setNearEnd] = useState(false);
  const hasGrid = acc !== null && acc.items.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setNearEnd(entries.some((e) => e.isIntersecting)),
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasGrid]);

  // Sentinel visible + more to have + idle: fetch the next page. The effect
  // re-runs after each append, so short pages chain until the grid fills
  // past the sentinel.
  useEffect(() => {
    if (!nearEnd || acc === null || !acc.hasMore || loading || error !== null)
      return;
    void load(acc.page + 1, "more");
  }, [nearEnd, acc, loading, error, load]);

  const hiddenCount = acc?.hiddenTagCount ?? 0;

  const openDetail = useCallback(
    (r: CatalogReference) => setP(detailParams(r), { push: true }),
    [setP],
  );

  const onType = useCallback(
    (t: "all" | "movie" | "scene") => {
      // Sorts are per-type — see typePatch; filters never drop on a tab
      // switch. One clamp: a TPDB performer filmography only composes on
      // the Scenes tab, so moving off it drops the filters that route
      // refuses (typePatch's performer branch).
      setP(typePatch(t, sortRaw, dirRaw, performers, performerMode, studios), {
        push: true,
      });
    },
    [setP, sortRaw, dirRaw, performers, performerMode, studios],
  );
  // Typed fields refine mid-edit (SearchBox debounces, the date input fires
  // per keystroke): push only when the value appears or disappears, replace
  // while it is refined — same rule as the omnibox — so Back never walks
  // through typing prefixes or partial dates.
  const onQ = useCallback(
    (v: string) => setP({ q: v || null }, { push: q === "" || v === "" }),
    [q, setP],
  );
  const onInclude = useCallback(
    (tags: IncludeTag[]) =>
      setP(
        {
          include: tags.length > 0 ? JSON.stringify(tags) : null,
          // `name` is the facet tile's display label — it never survives a
          // change to the selection it names (same rule in every patch below).
          name: null,
        },
        { push: true },
      ),
    [setP],
  );
  const onExclude = useCallback(
    (tags: CatalogTagSelection[]) =>
      setP(
        {
          exclude: tags.length > 0 ? JSON.stringify(tags) : null,
          name: null,
        },
        { push: true },
      ),
    [setP],
  );
  // One performer pick or removal: the patch carries the whole entry list
  // and the state it needs to re-clamp the sort (the filmography route
  // refuses sort; a starred filter and a pick refuse each other — see
  // performersPatch).
  const onPerformers = useCallback(
    (next: BrowseEntity[]) =>
      setP(performersPatch(next, entryState), { push: true }),
    [setP, entryState],
  );
  const onStudios = useCallback(
    (next: BrowseEntity[]) =>
      setP(studiosPatch(next, entryState), { push: true }),
    [setP, entryState],
  );
  const onPerformerMode = useCallback(
    (m: PerformerMode) => setP(performerModePatch(m), { push: true }),
    [setP],
  );
  const onStarred = useCallback(
    (on: boolean) =>
      setP(starredPatch(on, type, sortRaw, dirRaw), { push: true }),
    [setP, type, sortRaw, dirRaw],
  );
  // Both year bounds commit together — one entry point, one patch; the
  // year still displaces a date cutoff (the server refuses the pair).
  const onYearRange = useCallback(
    (y: string, yTo: string) => setP(yearRangePatch(y, yTo), { push: true }),
    [setP],
  );
  // Both halves commit together — one without the other is a 400.
  const onDate = useCallback(
    (d: string | null, op: string | null) =>
      setP(
        { date: d, date_operation: op, year: null },
        { push: date === "" || d === null },
      ),
    [date, setP],
  );
  const onSort = useCallback(
    (v: string) =>
      setP(
        {
          sort: v || null,
          // Only sorts that take one carry a direction; picking a
          // non-directional order removes a stale one instead of 400ing.
          direction:
            v && browseSortIsDirectional(type, v as SortKey)
              ? direction || "desc"
              : null,
        },
        { push: true },
      ),
    [setP, direction, type],
  );
  const onDirection = useCallback(
    (d: "asc" | "desc") => setP({ direction: d }, { push: true }),
    [setP],
  );
  const onStudioMode = useCallback(
    (m: string) =>
      setP({ studioMode: m === "withChildren" ? m : null }, { push: true }),
    [setP],
  );
  const clearFilters = useCallback(() => {
    // The tab and paging survive a clear — every constraint goes, and the
    // facet display label goes with them.
    setP(
      { ...clearBrowseKeys(["type", "perPage"]), name: null },
      { push: true },
    );
  }, [setP]);

  // An active studio/tag id without a captured name stays an id — never a
  // fake label (see filterName). The entity arrays count by length;
  // performerMode and yearTo are modes of other constraints, never a
  // constraint of their own (the plan's countActiveFilters skips).
  const filterCount = countActiveFilters({
    q,
    year,
    date,
    performerStarred,
    studioMode,
    sort,
    performers,
    studios,
    include,
    exclude,
  });

  // `name` is display-only (never queried) — a forged label can misname the
  // heading but never change results.
  const heading = params.get("name") || "Titles";
  const typeSummary =
    type === "movie"
      ? "TPDB movies"
      : type === "scene"
        ? "StashDB scenes"
        : "TPDB movies and StashDB scenes";

  const notConfigured =
    type === "movie" && providers?.tpdb === "not_configured"
      ? "tpdb"
      : type === "scene" && providers?.stashdb === "not_configured"
        ? "stashdb"
        : null;

  const target = detailTarget(params);
  const retry = () => setReload((n) => n + 1);

  // Active filters, grouped by kind: each group shows its name once, and
  // every chip inside is one remove button whose label names the full filter.
  const chipGroups: Record<string, ReactNode[]> = {};
  const chip = (
    group: string,
    key: string,
    text: string,
    onRemove: () => void,
    icon?: "star" | "plus" | "minus",
    note?: string,
  ) => {
    (chipGroups[group] ??= []).push(
      <FilterChip
        key={key}
        text={text}
        note={note}
        label={`${group}: ${note ? `${note} ` : ""}${text}${icon === "plus" ? " (must have)" : icon === "minus" ? " (must not have)" : ""}`}
        icon={icon}
        onRemove={onRemove}
      />,
    );
  };
  if (q) chip("Title", "q", `“${q}”`, () => onQ(""));
  if (year)
    chip(
      "Release",
      "year",
      yearTo !== "" ? `Years ${year}–${yearTo}` : `Year ${year}`,
      // One remove clears the whole range.
      () => onYearRange("", ""),
    );
  if (date)
    chip("Release", "date", `${dateOpLabel(dateOperation)} ${date}`, () =>
      onDate(null, null),
    );
  performers.forEach((entry, i) =>
    chip("Performer", `performer:${i}`, entityLabel(entry, "performer"), () =>
      onPerformers(performers.filter((_, j) => j !== i)),
    ),
  );
  if (performerStarred)
    chip(
      "Performer",
      "performerStarred",
      "Starred",
      () => setP({ performerStarred: null }, { push: true }),
      "star",
    );
  studios.forEach((entry, i) =>
    chip("Studio", `studio:${i}`, entityLabel(entry, "studio"), () =>
      onStudios(studios.filter((_, j) => j !== i)),
    ),
  );
  if (studioMode === "withChildren")
    chip("Studio", "studioMode", "with child studios", () => onStudioMode(""));
  include.forEach((tag, i) => {
    const group = Array.isArray(tag);
    chip(
      "Tags",
      `include:${i}`,
      // An "or" group is ONE term: the chip names it whole and its remove
      // drops the group.
      group ? tag.map((m) => m.name).join(" or ") : tag.name,
      () => onInclude(include.filter((_, j) => j !== i)),
      "plus",
      !group && isFreeText(tag) ? "Free text:" : undefined,
    );
  });
  exclude.forEach((tag, i) =>
    chip(
      "Tags",
      `exclude:${tag.name}:${tag.tpdb ?? ""}:${tag.stashdb ?? ""}:${i}`,
      tag.name,
      () => onExclude(exclude.filter((t) => t !== tag)),
      "minus",
      isFreeText(tag) ? "Free text:" : undefined,
    ),
  );
  if (sort)
    chip(
      "Sort",
      "sort",
      `${SORT_LABELS[sort as SortKey]}${direction ? ` (${direction})` : ""}`,
      () => setP({ sort: null, direction: null }, { push: true }),
    );
  const chipGroupNames = Object.keys(chipGroups);

  return (
    <section aria-label="Titles">
      {/* Invisible zero-height probe: normal flow, so its width is exactly
          the content width the real grid gets; auto-fill tracks depend only
          on that width. */}
      <div
        className={POSTER_GRID}
        ref={gridRef}
        aria-hidden="true"
        style={{
          height: 0,
          overflow: "hidden",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      />
      <div hidden={target !== null}>
        <div className="page-heading">
          <div className="min-w-0">
            <h2 className="page-title">{heading}</h2>
            <p className="page-description">{typeSummary}</p>
          </div>
          <div className="page-toolbar">
            {hiddenCount > 0 && (
              <button
                type="button"
                className="btn"
                aria-label={`${hiddenCount} personal hidden tags active — manage in Preferences`}
                data-prefs-opener="hidden-tags"
                onClick={() =>
                  window.dispatchEvent(new Event(OPEN_PREFERENCES))
                }
              >
                <Icon name="tag" /> {hiddenCount} hidden
              </button>
            )}
            {/* Rule 39: three exclusive types read at once as segments. */}
            <div>
              <span className="label" id="titles-type-label">
                Type
              </span>
              <div
                role="group"
                aria-labelledby="titles-type-label"
                className="segmented"
              >
                {(["all", "movie", "scene"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={type === t}
                    onClick={() => onType(t)}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            {/* TPDB filmography refuses search and order only where the
                TPDB side runs; the Scenes tab runs the StashDB side. A
                merged source offers only recency and duration. */}
            <SortSelect
              id="titles-sort"
              type={type}
              sort={sort}
              direction={direction}
              disabled={filmography}
              merged={merged}
              onSort={onSort}
              onDirection={onDirection}
            />
            <FiltersButton
              count={filterCount}
              onClick={() => setFiltersOpen(true)}
            />
          </div>
        </div>

        {chipGroupNames.length > 0 && (
          <div
            className="filter-chips"
            aria-label="Active filters"
            role="group"
          >
            {chipGroupNames.map((group) => (
              <span
                key={group}
                className="filter-group"
                role="group"
                aria-label={group}
              >
                <span className="filter-group-name" aria-hidden="true">
                  {group}
                </span>
                {chipGroups[group]}
              </span>
            ))}
            <button
              type="button"
              className="cat-inline-link"
              onClick={clearFilters}
            >
              Clear all
            </button>
          </div>
        )}

        <div className="mt-4">
          {notConfigured !== null ? (
            <NotConfigured provider={notConfigured} />
          ) : error !== null && acc === null ? (
            // A failed first page is an outage: an error, never an empty page.
            <ErrorPanel
              title="Browse unavailable"
              message={error}
              onRetry={retry}
            />
          ) : acc === null ? (
            <GridSkeleton
              aspect="aspect-[2/3]"
              cols={POSTER_GRID}
              count={perPage}
            />
          ) : (
            <>
              {acc.errors.map((e) =>
                e.code === "scan_ceiling" ? (
                  // The source answered every scanned page and hit the
                  // documented limit: a partial answer, not an outage. No
                  // retry — only narrower filters change the outcome.
                  <ErrorPanel
                    key={e.provider}
                    title={`${providerLabel(e.provider)}: scan limit reached`}
                    message={e.message}
                  />
                ) : (
                  <ErrorPanel
                    key={e.provider}
                    title={`${providerLabel(e.provider)} unavailable`}
                    message={e.message}
                    onRetry={retry}
                  />
                ),
              )}
              {/* Query-scoped muted notes: a source that skipped or
                  narrowed the filter says so here — never an alert, never
                  hiding the total or the grid. */}
              {acc.notices.map((n, i) => (
                <p
                  key={`${n.provider}:${n.kind}:${n.code}:${i}`}
                  className="cat-note"
                >
                  {noticeText(n)}
                </p>
              ))}
              {acc.items.length === 0 ? (
                // Empty is only claimed when no source failed: the error
                // panels above carry the failures.
                acc.errors.length === 0 && (
                  <div className="panel p-8 text-center text-sm text-muted">
                    {filterCount > 0
                      ? "No titles match your filters. Remove a filter, or check excluded and personal hidden tags."
                      : "Nothing here yet."}
                  </div>
                )
              ) : (
                <>
                  {/* The count leads the results, so the size of the answer
                      is known before scrolling. Shown only when the service
                      attests a real total and no source error stands: a
                      capped total has no honest number, and a standing
                      error may hide rows the exact number would deny. */}
                  {acc.errors.length === 0 &&
                    acc.totalCountKnown &&
                    acc.total != null && (
                      <p className="mb-3 text-sm text-muted" role="status">
                        {new Intl.NumberFormat().format(acc.total)}{" "}
                        {acc.total === 1 ? "title" : "titles"}
                      </p>
                    )}
                  <div className={POSTER_GRID}>
                    {wholeRows(acc.items, cols, acc.hasMore).map((it) =>
                      it.reference.kind === "scene" ? (
                        <SceneCard
                          key={`${it.reference.provider}:${it.reference.id}`}
                          item={it}
                          onOpen={openDetail}
                        />
                      ) : (
                        <MovieCard
                          key={`${it.reference.provider}:${it.reference.id}`}
                          item={it}
                          onOpen={openDetail}
                        />
                      ),
                    )}
                  </div>
                  {loading && (
                    <p
                      className="mt-6 text-center text-sm text-muted"
                      role="status"
                    >
                      Loading more…
                    </p>
                  )}
                  {!loading && error !== null && (
                    <div className="mt-6 flex items-center justify-center gap-3 text-sm text-muted">
                      <span>Couldn&rsquo;t load more titles.</span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void load(acc.page + 1, "more")}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  <div ref={sentinelRef} aria-hidden="true" />
                </>
              )}
            </>
          )}
        </div>
      </div>

      <CatalogDetailView browseTo={browseTo} />

      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        count={filterCount}
        onClear={clearFilters}
      >
        <div
          className="cat-group"
          role="group"
          aria-labelledby="titles-g-search"
        >
          <h3 className="cat-group-title" id="titles-g-search">
            Search
          </h3>
          <SearchBox
            id="titles-q"
            label="Title"
            value={q}
            onCommit={onQ}
            disabled={filmography}
          />
        </div>
        <div
          className="cat-group"
          role="group"
          aria-labelledby="titles-g-performers"
        >
          <h3 className="cat-group-title" id="titles-g-performers">
            Performers
          </h3>
          <PerformerPicker
            id="titles-performer"
            entries={performers}
            performerMode={performerMode}
            starred={performerStarred}
            onStarred={onStarred}
            onMode={onPerformerMode}
            onRemove={(entry) =>
              onPerformers(performers.filter((e) => e !== entry))
            }
            onPick={(side, performerId, name) =>
              onPerformers([
                ...performers,
                side === "tpdb"
                  ? { name, tpdb: performerId }
                  : { name, stashdb: performerId },
              ])
            }
          />
        </div>
        <div
          className="cat-group"
          role="group"
          aria-labelledby="titles-g-studios"
        >
          <h3 className="cat-group-title" id="titles-g-studios">
            Studios
          </h3>
          <StudioPicker
            id="titles-studio"
            entries={studios}
            onRemove={(entry) => onStudios(studios.filter((e) => e !== entry))}
            onPick={(side, studioId, name) =>
              onStudios([
                ...studios,
                side === "tpdb"
                  ? { name, tpdb: studioId }
                  : { name, stashdb: studioId },
              ])
            }
          />
          {/* Child studios are a StashDB criterion: it offers itself once a
              studio entry carries a StashDB id, and a TPDB id in the same
              filter blocks it (the TPDB side takes the site itself, never
              its children). */}
          {studios.some((e) => e.stashdb !== undefined) && (
            <div>
              <span className="label" id="titles-studio-scope-label">
                Studio scope
              </span>
              <div
                role="group"
                aria-labelledby="titles-studio-scope-label"
                className="segmented"
              >
                <button
                  type="button"
                  aria-pressed={(studioMode || "exact") === "exact"}
                  disabled={studioBlocked}
                  onClick={() => onStudioMode("exact")}
                >
                  Exact studio only
                </button>
                <button
                  type="button"
                  aria-pressed={(studioMode || "exact") === "withChildren"}
                  disabled={studioBlocked}
                  onClick={() => onStudioMode("withChildren")}
                >
                  Include child studios
                </button>
              </div>
              {studioBlocked && (
                <p className="cat-note">
                  Include child studios is StashDB-only; a studio entry with a
                  TPDB id blocks it.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="cat-group" role="group" aria-labelledby="titles-g-tags">
          <h3 className="cat-group-title" id="titles-g-tags">
            Tags
          </h3>
          <TagPicker
            id="titles-include"
            label="Must have"
            tone="include"
            selected={include}
            onChange={onInclude}
            allowFreeText
            allowGroups
            description="Titles need every tag here; tags joined by or form one group."
          />
          <TagPicker
            id="titles-exclude"
            label="Must not have"
            tone="exclude"
            selected={exclude}
            onChange={onExclude}
            allowFreeText
            description="Any tag here removes a title. Exclusions win."
            help="Must have: a provider tag matches exactly, and a typed term keeps titles carrying any tag whose name contains it (case and separators ignored), unless it exactly names a tag both providers publish, which then matches exactly on both. Must not have: a tag also covers the ones that contain it as a word (Anal drops Anal Creampie, never Analingus)."
          />
          <p className="cat-note">
            {hiddenCount > 0
              ? `${hiddenCount} personal hidden tag${hiddenCount === 1 ? "" : "s"} appl${hiddenCount === 1 ? "ies" : "y"} on every browse — `
              : "Personal hidden tags apply on every browse — "}
            <button
              type="button"
              className="cat-inline-link"
              data-prefs-opener="drawer-note"
              onClick={() => window.dispatchEvent(new Event(OPEN_PREFERENCES))}
            >
              manage them in Preferences
            </button>
            . Clear filters never removes them.
          </p>
        </div>
        <div
          className="cat-group"
          role="group"
          aria-labelledby="titles-g-release"
        >
          <h3 className="cat-group-title" id="titles-g-release">
            Release
          </h3>
          <YearRange
            fromId="titles-year"
            toId="titles-year-to"
            year={year}
            yearTo={yearTo}
            onCommit={onYearRange}
            disabled={filmography}
          />
          <DateCutoff
            id="titles-date"
            date={date}
            operation={dateOperation}
            disabled={filmography}
            onCommit={onDate}
          />
          {/* The note names the sources a bound is checked on: the start
              year is TPDB-native, every other bound runs locally, so those
              totals are approximate — never silently ignored. */}
          {(year !== "" || date !== "") && (
            <p className="cat-note">
              {year !== "" &&
                (yearTo !== ""
                  ? "The year range applies to TPDB movies and StashDB scenes; the start year is TPDB-native and the upper bound is checked locally, so TPDB movie totals are approximate, and StashDB scene totals are approximate too (the range is checked locally). "
                  : "The year applies to TPDB movies and StashDB scenes; StashDB scene totals are approximate (the year is checked locally). ")}
              {date !== "" &&
                "The release date applies to TPDB movies and StashDB scenes."}
            </p>
          )}
        </div>
      </FilterDrawer>
    </section>
  );
}
