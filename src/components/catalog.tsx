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
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
} from "../lib/contracts";
import { CATALOG_YEAR_MAX, CATALOG_YEAR_MIN } from "../lib/contracts";
// Names for studio/tag filter ids live in lib/names, seeded at navigation
// time (details, picks, tiles) — URLs carry ids, chips still get labels.
import { filterName, seedPerformerPick } from "../lib/names";
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
  performerStashdbPatch,
  performerTpdbPatch,
  starredPatch,
  typePatch,
  type BrowseFilter,
} from "../lib/browse-url";
// Sort capability is shared with the server: the options offered per tab,
// the labels and the direction rule all derive from src/lib/sorts.ts — one
// table answers what the client offers and what the server accepts.
import {
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
  onSort: (v: string) => void;
  onDirection: (v: "asc" | "desc") => void;
}) {
  const sorts = browseSortsFor(type);
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

function YearBox({
  id,
  value,
  onCommit,
  disabled,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
}) {
  const { input, setInput, mark } = useSyncedInput(value);
  const commit = useCallback(() => {
    if (disabled) return;
    const t = input.trim();
    // Server rejects anything but a 4-digit year in range; never send junk.
    if (t !== "" && !/^\d{4}$/.test(t)) return;
    if (
      t !== "" &&
      (Number(t) < CATALOG_YEAR_MIN || Number(t) > CATALOG_YEAR_MAX)
    )
      return;
    mark(t);
    onCommit(t);
  }, [disabled, input, mark, onCommit]);
  return (
    <div>
      <label className="label" htmlFor={id}>
        Year
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={CATALOG_YEAR_MIN}
        max={CATALOG_YEAR_MAX}
        placeholder="Any year"
        className="input"
        value={input}
        disabled={disabled}
        onChange={(e) => setInput(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
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

/** Debounced performer lookup behind the performer filter: the filter takes
 * a provider-native id, so the user picks a result — a typed name is never
 * sent. One field searches both sources; each result carries its side.
 * Failures stay per side and sides the session marks not configured are
 * skipped, so one source failing never hides the other source's rows.
 * TPDB performer search is paged; StashDB is unpaged and caps its result
 * list, which the picker says out loud. */
function usePerformerOptions(term: string): {
  items: { performer: CatalogDetail; side: CatalogProvider }[];
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
      kind: "performer",
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
      ...(tpdb.data?.items ?? []).map((performer) => ({
        performer,
        side: "tpdb" as const,
      })),
      ...(stash.data?.items ?? []).map((performer) => ({
        performer,
        side: "stashdb" as const,
      })),
    ],
    errors,
    skipped,
    loading: t !== "" && (committed !== t || tpdb.loading || stash.loading),
  };
}

function PerformerPicker({
  id,
  onPick,
  starred,
  onStarred,
}: {
  id: string;
  onPick: (side: CatalogProvider, performerId: string, name: string) => void;
  starred: boolean;
  onStarred: (on: boolean) => void;
}) {
  const [term, setTerm] = useState("");
  const { items, errors, skipped, loading } = usePerformerOptions(term);
  return (
    <div>
      <label className="label" htmlFor={id}>
        Performer
      </label>
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
      <p className="cat-note">
        {starred
          ? "Scenes featuring any performer you follow. Picking a performer replaces this; performers known only to TPDB cannot match."
          : "A TPDB performer opens their movies and replaces the other filters until removed; a StashDB performer filters scenes (StashDB caps results at about ten rows)."}
      </p>
      {loading ? (
        <p className="cat-note" aria-live="polite">
          Searching…
        </p>
      ) : items.length > 0 ? (
        <ul className="cat-picker">
          {items.map(({ performer, side }) => (
            <li key={`${side}:${performer.reference.id}`}>
              <button
                type="button"
                className="cat-picker-row"
                onClick={() => {
                  seedPerformerPick(side, performer);
                  onPick(side, performer.reference.id, performer.title);
                  setTerm("");
                }}
              >
                <ItemImage
                  name={performer.title}
                  src={imgSrc(performer.imageUrl)}
                  className="cat-picker-img"
                />
                <span>{performer.title}</span>
                <span className="text-xs text-muted">
                  {side === "tpdb" ? "TPDB" : "StashDB"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : term.trim() !== "" && errors.length === 0 && skipped.length === 0 ? (
        // Empty is only claimed when nothing failed and nothing was skipped:
        // the notes below carry the failures, like the grid's per-provider
        // panels.
        <p className="cat-note">No performers match “{term.trim()}”.</p>
      ) : null}
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
  hiddenTagCount: number;
};

/** include/exclude ride the URL as JSON arrays of CatalogTagSelection.
 * A malformed value degrades to none — the server is the authority on
 * shape, the URL is just a carrier. */
function parseTags(v: string | null): CatalogTagSelection[] {
  if (!v) return [];
  try {
    const rows: unknown = JSON.parse(v);
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is CatalogTagSelection => {
      return (
        typeof r === "object" &&
        r !== null &&
        "name" in r &&
        typeof r.name === "string"
      );
    });
  } catch {
    return [];
  }
}

/** Builds the filter part of the GET /api/browse path from canonical URL
 * keys — verbatim plan names, include/exclude as JSON, `date_operation` for
 * dateOperation. The caller appends `&page=${n}`: pages are component
 * state under endless scroll. An outage is an error, never an empty page. */
function browsePath(f: {
  type: "all" | "movie" | "scene";
  q: string;
  include: CatalogTagSelection[];
  exclude: CatalogTagSelection[];
  studioTpdb: string;
  studioStashdb: string;
  performerTpdb: string;
  performerStashdb: string;
  performerStarred: boolean;
  studioMode: string;
  year: string;
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
  if (f.studioTpdb) qs.set("studioTpdb", f.studioTpdb);
  if (f.studioStashdb) qs.set("studioStashdb", f.studioStashdb);
  if (f.performerTpdb) qs.set("performerTpdb", f.performerTpdb);
  if (f.performerStashdb) qs.set("performerStashdb", f.performerStashdb);
  if (f.performerStarred) qs.set("performerStarred", "1");
  if (f.studioMode) qs.set("studioMode", f.studioMode);
  if (f.year) qs.set("year", f.year);
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
 * URL keys are the plan's canonical browse keys — include/exclude ride as
 * JSON arrays of CatalogTagSelection. */
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
  const include = parseTags(params.get("include"));
  const exclude = parseTags(params.get("exclude"));
  const studioTpdb = params.get("studioTpdb") ?? "";
  const studioStashdb = params.get("studioStashdb") ?? "";
  const performerTpdb = params.get("performerTpdb") ?? "";
  const performerStashdb = params.get("performerStashdb") ?? "";
  const performerStarred = params.get("performerStarred") === "1";
  const studioMode =
    params.get("studioMode") === "withChildren" ? "withChildren" : "";
  const year = params.get("year") ?? "";
  // date + date_operation commit as one pair; half a pair is never sent.
  const dateRaw = params.get("date") ?? "";
  const opRaw = params.get("date_operation") ?? "";
  const date = dateRaw !== "" && opRaw !== "" ? dateRaw : "";
  const dateOperation = date !== "" ? opRaw : "";
  // A sort the selected type does not support is clamped to the provider
  // default — visible in the select, never sent upstream for a 400. A
  // direction rides only on sorts that take one: a stale direction next to
  // TPDB relevance would 400 the search.
  const sorts = browseSortsFor(type);
  const sortRaw = params.get("sort") ?? "";
  const sort = (sorts as readonly string[]).includes(sortRaw) ? sortRaw : "";
  const dirRaw = params.get("direction") ?? "";
  const direction =
    sort !== "" &&
    browseSortIsDirectional(type, sort as SortKey) &&
    (dirRaw === "asc" || dirRaw === "desc")
      ? dirRaw
      : "";
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
        studioTpdb,
        studioStashdb,
        performerTpdb,
        performerStashdb,
        performerStarred,
        studioMode,
        year,
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
      studioTpdb,
      studioStashdb,
      performerTpdb,
      performerStashdb,
      performerStarred,
      studioMode,
      year,
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
      // refuses (typePatch's tpdbPerformer branch).
      setP(typePatch(t, sortRaw, dirRaw, performerTpdb !== ""), {
        push: true,
      });
    },
    [setP, sortRaw, dirRaw, performerTpdb],
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
    (tags: CatalogTagSelection[]) =>
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
  // TPDB's performer filter is the filmography route — everything else
  // goes, see performerTpdbPatch.
  const onPerformerTpdb = useCallback(
    (id: string) => setP(performerTpdbPatch(id, type), { push: true }),
    [setP, type],
  );
  // StashDB composes a performer with everything else — no other key moves.
  const onPerformerStashdb = useCallback(
    // Starred and a picked performer refuse each other on the server; the
    // pick replaces the starred filter instead of letting the browse 400.
    // A StashDB performer cannot constrain the movies side: on that tab no
    // side would qualify and the grid would show an empty page that names
    // the wrong cause — drop to the combined browse, keeping the sort only
    // where the all tab supports it (the clamp onStarred applies).
    (id: string) =>
      setP(performerStashdbPatch(id, type, sortRaw, dirRaw), { push: true }),
    [setP, type, sortRaw, dirRaw],
  );
  const onStarred = useCallback(
    (on: boolean) =>
      setP(starredPatch(on, type, sortRaw, dirRaw), { push: true }),
    [setP, type, sortRaw, dirRaw],
  );
  const onYear = useCallback(
    (v: string) =>
      setP(
        { year: v || null, date: null, date_operation: null },
        { push: true },
      ),
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
  const onStudioTpdb = useCallback(
    (id: string | null) => setP({ studioTpdb: id, name: null }, { push: true }),
    [setP],
  );
  const onStudioStashdb = useCallback(
    (id: string | null) =>
      setP({ studioStashdb: id, name: null }, { push: true }),
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
  // fake label (see filterName).
  const filterCount = countActiveFilters({
    q,
    year,
    date,
    performerTpdb,
    performerStashdb,
    performerStarred,
    studioTpdb,
    studioStashdb,
    studioMode,
    sort,
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
  if (year) chip("Release", "year", `Year ${year}`, () => onYear(""));
  if (date)
    chip("Release", "date", `${dateOpLabel(dateOperation)} ${date}`, () =>
      onDate(null, null),
    );
  // Chip removal only drops the constraint — unlike picking a performer,
  // which starts the filmography browse and clears the rest.
  if (performerTpdb)
    chip(
      "Performer",
      "performerTpdb",
      `${filterName("tpdb", "performer", performerTpdb)} (TPDB)`,
      () => setP({ performerTpdb: null }, { push: true }),
    );
  if (performerStashdb)
    chip(
      "Performer",
      "performerStashdb",
      `${filterName("stashdb", "performer", performerStashdb)} (StashDB)`,
      () => setP({ performerStashdb: null }, { push: true }),
    );
  if (performerStarred)
    chip(
      "Performer",
      "performerStarred",
      "Starred",
      () => setP({ performerStarred: null }, { push: true }),
      "star",
    );
  if (studioTpdb)
    chip(
      "Studio",
      "studioTpdb",
      `${filterName("tpdb", "studio", studioTpdb)} (TPDB)`,
      () => onStudioTpdb(null),
    );
  if (studioStashdb)
    chip(
      "Studio",
      "studioStashdb",
      `${filterName("stashdb", "studio", studioStashdb)} (StashDB)`,
      () => onStudioStashdb(null),
    );
  if (studioMode === "withChildren")
    chip("Studio", "studioMode", "with child studios", () => onStudioMode(""));
  include.forEach((tag, i) =>
    chip(
      "Tags",
      `include:${tag.name}:${tag.tpdb ?? ""}:${tag.stashdb ?? ""}:${i}`,
      tag.name,
      () => onInclude(include.filter((t) => t !== tag)),
      "plus",
      isFreeText(tag) ? "Free text:" : undefined,
    ),
  );
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
                TPDB side runs; the Scenes tab runs her StashDB side. */}
            <SortSelect
              id="titles-sort"
              type={type}
              sort={sort}
              direction={direction}
              disabled={performerTpdb !== "" && type !== "scene"}
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
            disabled={performerTpdb !== "" && type !== "scene"}
          />
          <PerformerPicker
            id="titles-performer"
            starred={performerStarred}
            onStarred={onStarred}
            onPick={(side, performerId) =>
              side === "tpdb"
                ? onPerformerTpdb(performerId)
                : onPerformerStashdb(performerId)
            }
          />
          {studioStashdb !== "" && (
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
                  onClick={() => onStudioMode("exact")}
                >
                  Exact studio only
                </button>
                <button
                  type="button"
                  aria-pressed={(studioMode || "exact") === "withChildren"}
                  onClick={() => onStudioMode("withChildren")}
                >
                  Include child studios
                </button>
              </div>
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
            description="Titles need every tag here."
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
          <YearBox
            id="titles-year"
            value={year}
            onCommit={onYear}
            disabled={performerTpdb !== "" && type !== "scene"}
          />
          <DateCutoff
            id="titles-date"
            date={date}
            operation={dateOperation}
            disabled={performerTpdb !== "" && type !== "scene"}
            onCommit={onDate}
          />
          {/* Year and date apply to both sides: TPDB natively, StashDB with
            the year checked locally, so scene totals are approximate. The
            note says exactly that — never silently ignored. */}
          {(year !== "" || date !== "") && (
            <p className="cat-note">
              Year and release date apply to TPDB movies and StashDB scenes; the
              year is checked locally for scenes, so totals are approximate.
            </p>
          )}
        </div>
      </FilterDrawer>
    </section>
  );
}
