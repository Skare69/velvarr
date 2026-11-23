"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import "./catalog.css";
// The bulk dialog and its inline error text share views.css with the
// performer page's BulkRequest.
import "./views.css";
import { isFreeText, TagPicker } from "./tag-picker.tsx";
import {
  api,
  ApiError,
  artSrcSet,
  detailParams,
  ErrorPanel,
  GridSkeleton,
  Icon,
  InfoTip,
  ToolbarGroup,
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
  useNearEnd,
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
// Names for studio/tag filter ids live in lib/names, seeded at navigation
// time (details, picks, tiles) — URLs carry ids, chips still get labels.
import { filterName, hasName, seedName, seedPerformerPick } from "../lib/names";
// Detail views (payload types, DetailSections, RelatedTitles,
// CatalogDetailView) live in catalog-detail.tsx; the browse view hosts the
// detail overlay and reads its target from the URL.
// The missing-key line is the discover surface's shared component (same
// wording everywhere: a missing credential, never an outage).
import { NotConfiguredLine } from "./discover";
import { CatalogDetailView, detailTarget } from "./catalog-detail.tsx";
import { ProseSearchField } from "./prose-search";
import { REQUESTS_CHANGED } from "../lib/approvals";
// The "Request all" plan and runner are React-free so node --test pins the
// cap, the skip rules and the request_limit stop directly.
import {
  planRequestAll,
  REQUEST_ALL_CAP,
  requestAllKey,
  runRequestAll,
  type RequestAllResult,
} from "../lib/request-all";
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
  dateRangePatch,
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
  // The sort set changes with the type (All, Movies, Scenes), so segments
  // made the toolbar change width and jump on every type switch. One
  // fixed-width select keeps the row still; the direction button stays in
  // place too and is disabled for an order that has no direction.
  const directional =
    sort !== "" && browseSortIsDirectional(type, sort as SortKey);
  return (
    <ToolbarGroup caption="Sort" htmlFor={id} className="sort-group">
      <div className="flex flex-1 gap-1">
        <select
          id={id}
          className="input sort-select"
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
        <button
          type="button"
          className="btn shrink-0"
          aria-label={
            direction === "asc" ? "Sort ascending" : "Sort descending"
          }
          title={
            directional
              ? direction === "asc"
                ? "Sort ascending"
                : "Sort descending"
              : "This order has no direction"
          }
          disabled={disabled || !directional}
          onClick={() => onDirection(direction === "asc" ? "desc" : "asc")}
        >
          <Icon name={direction === "asc" ? "sort-asc" : "sort-desc"} />
        </button>
      </div>
    </ToolbarGroup>
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
      {/* The group title ("Title") names the field on screen; the label
          stays for assistive tech. */}
      <label className="sr-only" htmlFor={id}>
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

/** The drawer's release-time filter: two native date inputs, from and to.
 * The URL keeps its existing keys (see dateRangePatch): from-only and
 * to-only are a `date` + `date_operation` pair, a full range adds the
 * inclusive `dateTo`. A date from another surface with another operator
 * (prose search) shows here as the bound it implies; editing rewrites it. */
function DateRange({
  id,
  date,
  operation,
  dateTo,
  disabled,
  onCommit,
}: {
  id: string;
  date: string;
  operation: string;
  dateTo: string;
  disabled?: boolean;
  onCommit: (from: string, to: string) => void;
}) {
  const from =
    operation === ">=" || operation === ">" || operation === "=" ? date : "";
  const to =
    dateTo ||
    (operation === "<=" || operation === "<" || operation === "=" ? date : "");
  return (
    <div className="flex items-center gap-2">
      <input
        id={`${id}-from`}
        type="date"
        className="input"
        aria-label="Released from"
        value={from}
        max={to || undefined}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value, to)}
      />
      <span className="text-sm text-muted">to</span>
      <input
        id={`${id}-to`}
        type="date"
        className="input"
        aria-label="Released to"
        value={to}
        min={from || undefined}
        disabled={disabled}
        onChange={(e) => onCommit(from, e.target.value)}
      />
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

/** Looks up the name of every picked performer or studio whose URL entry
 * carries only ids (a jump from a detail page, a bookmark, a reload) and
 * seeds it, so the chips show "Jewelz Blu", not "#27e0d48d…". The record's
 * own title from its provider is the only source; a failed lookup leaves
 * the id shown as an id. */
function useEntityNames(
  entries: BrowseEntity[],
  kind: "performer" | "studio",
): void {
  const [, rerender] = useState(0);
  const missing = entries.flatMap((e) =>
    e.name
      ? []
      : (["tpdb", "stashdb"] as const).flatMap((p) => {
          const id = e[p];
          return id !== undefined && !hasName(p, kind, id)
            ? [`${p}/${id}`]
            : [];
        }),
  );
  const sig = missing.join(",");
  useEffect(() => {
    if (sig === "") return;
    let live = true;
    void Promise.all(
      sig.split(",").map(async (pair) => {
        const [provider, id] = pair.split("/") as [string, string];
        try {
          const r = await api<{ detail: { title: string } }>(
            `/api/catalog/${provider}/${kind}/${encodeURIComponent(id)}`,
          );
          seedName({ provider, kind, id }, r.detail.title);
        } catch {
          // Not resolvable (outage, removed record): the chip keeps the
          // id shown as an id, which is the documented honest fallback.
        }
      }),
    ).then(() => {
      if (live) rerender((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [sig, kind]);
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
      {/* The group title ("Performers") names the field on screen; the
          label stays for assistive tech. */}
      <label className="sr-only" htmlFor={id}>
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
                    srcSet={artSrcSet(detail.imageUrl)}
                    sizes="32px"
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
      <label className="sr-only" htmlFor={id}>
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
                    srcSet={artSrcSet(detail.imageUrl)}
                    sizes="32px"
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
  dateTo: string;
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
    // The inclusive upper bound rides only beside a `>=` start date.
    if (f.dateTo && f.dateOperation === ">=") qs.set("dateTo", f.dateTo);
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
  useEntityNames(performers, "performer");
  useEntityNames(studios, "studio");
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
  const dateTo = date !== "" ? (params.get("dateTo") ?? "") : "";
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
  // The filmography route refuses every order; a sort still in the URL when
  // it runs (a forged URL, or a mode switch that started it) would 400.
  // Declared here: the sort clamp, the drawer's disabled props and the
  // entryState comment below all read it.
  const filmography = tpdbFilmographyRuns(type, performers, performerMode);
  const merged =
    streamPlan.seeds.filter((s) => s.tpdbStudio !== undefined).length > 1 ||
    streamPlan.seeds.filter((s) => s.parentStudioId !== undefined).length > 1;
  // A sort the selected type does not support — one a merged source would
  // refuse, or one the filmography route rejects — is clamped to the
  // provider default: visible in the select, never sent upstream for a
  // 400. A direction rides only on sorts that take one: a stale direction
  // next to TPDB relevance would 400 the search.
  const sorts = browseSortsFor(type).filter(
    (s) => !merged || BROWSE_MIXED_SORTS.includes(s),
  );
  const sortRaw = params.get("sort") ?? "";
  const sort =
    !filmography && (sorts as readonly string[]).includes(sortRaw)
      ? sortRaw
      : "";
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
  // query_too_broad is an answer, not an outage: the scan read its page
  // limit without filling the page. A retry repeats the same scan, so that
  // code gets its own wording and no Retry.
  const [scanLimited, setScanLimited] = useState(false);
  const seqRef = useRef(0);
  // "Request all": keys settled by earlier presses (requested or already
  // requested) leave the next plan; a run counter drops a run's answer when
  // the grid restarted under it.
  const [requestDone, setRequestDone] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestResult, setRequestResult] = useState<
    (RequestAllResult & { over: number; undeliverable: number }) | null
  >(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Each RequestableCard keeps its own status; a bumped count in its key
  // remounts only the cards a run touched, so they re-check.
  const [cardEpoch, setCardEpoch] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const requestRunRef = useRef(0);
  const requestDialogRef = useRef<HTMLDialogElement>(null);
  const requestTitleId = useId();

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
        dateTo,
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
      dateTo,
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
      setScanLimited(false);
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
        setScanLimited(e instanceof ApiError && e.code === "query_too_broad");
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    },
    [basePath],
  );

  // Any filter, perPage or reload change restarts the grid at page 1, and
  // with it the "Request all" state: a new grid gets a fresh plan.
  useEffect(() => {
    requestRunRef.current += 1;
    setRequestDone(new Set());
    setRequestBusy(false);
    setRequestResult(null);
    setRequestError(null);
    setCardEpoch(new Map());
    void load(1, "reset");
  }, [load, reload]);

  const [sentinelRef, nearEnd] = useNearEnd(
    acc !== null && acc.items.length > 0,
  );

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
    (m: PerformerMode) =>
      setP(performerModePatch(m, entryState), { push: true }),
    [setP, entryState],
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
  // Both bounds commit together through one patch (dateRangePatch): it
  // also drops a year window, which the server refuses beside a date.
  const onDateRange = useCallback(
    (from: string, to: string) =>
      setP(dateRangePatch(from, to), {
        push: date === "" || (from === "" && to === ""),
      }),
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

  // The displayed cards: whole rows only. "Request all" plans from exactly
  // these, so a title trimmed off the last row is never requested unseen.
  const shown = acc === null ? [] : wholeRows(acc.items, cols, acc.hasMore);
  const requestPlan = planRequestAll(shown, requestDone);
  const shownTotal =
    acc !== null && acc.errors.length === 0 && acc.totalCountKnown
      ? acc.total
      : undefined;
  const showRequestAll = requestPlan.batch.length > 0 || requestBusy;
  const cardKey = (r: CatalogReference) => {
    const epoch = cardEpoch.get(requestAllKey(r));
    return epoch === undefined
      ? `${r.provider}:${r.id}`
      : `${r.provider}:${r.id}:${epoch}`;
  };

  const runRequests = async () => {
    requestDialogRef.current?.close();
    const run = requestRunRef.current;
    const { batch, over, undeliverable } = requestPlan;
    const attempted: string[] = [];
    setRequestBusy(true);
    setRequestError(null);
    setRequestResult(null);
    try {
      const res = await runRequestAll(batch, (media) => {
        attempted.push(requestAllKey(media));
        return api<{ autoApproved?: boolean }>("/api/requests", {
          method: "POST",
          body: JSON.stringify({ media }),
        });
      });
      if (requestRunRef.current !== run) return;
      setRequestDone((prev) => new Set([...prev, ...res.settled]));
      setRequestResult({ ...res, over, undeliverable });
    } catch (e) {
      if (requestRunRef.current !== run) return;
      setRequestError(messageOf(e));
    } finally {
      // Any post may have landed, even in a run that threw or went stale.
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
      if (requestRunRef.current === run) {
        setCardEpoch((prev) => {
          const next = new Map(prev);
          for (const k of attempted) next.set(k, (next.get(k) ?? 0) + 1);
          return next;
        });
        setRequestBusy(false);
      }
    }
  };

  // Only counts the run observed; zero-valued extras stay unsaid.
  const requestCounts = requestResult
    ? [
        `${requestResult.requested} requested`,
        requestResult.autoApproved > 0
          ? `${requestResult.autoApproved} auto-approved`
          : null,
        requestResult.existing > 0
          ? `${requestResult.existing} already requested`
          : null,
        requestResult.failed > 0 ? `${requestResult.failed} failed` : null,
      ].filter(Boolean)
    : [];

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
    chip(
      "Release",
      "date",
      dateTo !== ""
        ? `${date} – ${dateTo}`
        : `${dateOpLabel(dateOperation)} ${date}`,
      () => onDateRange("", ""),
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
        </div>
        {/* One toolbar row under the heading, every control the same 44px
            group: describe, type, sort, filters. The describe search's notes
            wrap onto their own line below the row. */}
        <div className="page-toolbar titles-toolbar">
          <ProseSearchField type={type} />
          {hiddenCount > 0 && (
            <button
              type="button"
              className="btn"
              aria-label={`${hiddenCount} personal hidden tags active — manage in Preferences`}
              data-prefs-opener="hidden-tags"
              onClick={() => window.dispatchEvent(new Event(OPEN_PREFERENCES))}
            >
              <Icon name="tag" /> {hiddenCount} hidden
            </button>
          )}
          {/* Rule 39: three exclusive types read at once as segments. Each
                control sits in its own small panel with its name inside, the
                same look as the active-filter groups below. */}
          <ToolbarGroup caption="Type" captionId="titles-type-label">
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
          </ToolbarGroup>
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
          ) : error !== null && acc === null && scanLimited ? (
            <div className="panel p-5" role="status">
              <h3 className="font-semibold">No match within the scan limit</h3>
              <p className="mt-2 max-w-[75ch] text-sm text-muted">
                Velvarr reads a limited number of pages from each provider and
                found no title that matches every filter there. Remove a filter,
                or pick tags from the list instead of typing them: a picked tag
                narrows the search at the provider, typed text is checked here.
              </p>
            </div>
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
              {/* Failures and notes stack with a gap of their own and
                  clear space before the results (rule 26: the gap inside
                  a group is smaller than the gap to the next group). */}
              {(acc.errors.length > 0 || acc.notices.length > 0) && (
                <div className="mb-5 grid gap-3">
                  {acc.errors.map((e) =>
                    e.code === "scan_ceiling" ? (
                      // The source answered every scanned page and hit the
                      // documented limit: a partial answer, not an outage.
                      // No retry — only narrower filters change the outcome.
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
                      narrowed the filter says so here — never an alert,
                      never hiding the total or the grid. */}
                  {acc.notices.map((n, i) => (
                    <p
                      key={`${n.provider}:${n.kind}:${n.code}:${i}`}
                      className="cat-note m-0"
                    >
                      {noticeText(n)}
                    </p>
                  ))}
                </div>
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
                      error may hide rows the exact number would deny.
                      "Request all" sits beside it, over the grid it acts
                      on. */}
                  {(shownTotal != null ||
                    showRequestAll ||
                    requestResult !== null ||
                    requestError !== null) && (
                    <div className="mb-3">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                        {shownTotal != null && (
                          <p className="m-0 text-sm text-muted" role="status">
                            {new Intl.NumberFormat().format(shownTotal)}{" "}
                            {shownTotal === 1 ? "title" : "titles"}
                          </p>
                        )}
                        {showRequestAll && (
                          <button
                            type="button"
                            className="btn btn-accent ml-auto"
                            disabled={requestBusy}
                            aria-busy={requestBusy || undefined}
                            onClick={() => {
                              setRequestError(null);
                              requestDialogRef.current?.showModal();
                            }}
                          >
                            <Icon name="plus" />
                            {requestBusy
                              ? "Requesting…"
                              : `Request all (${requestPlan.batch.length})`}
                          </button>
                        )}
                      </div>
                      {requestCounts.length > 0 && requestResult && (
                        <p className="mt-2 text-sm" role="status">
                          {requestCounts.join(" · ")}
                          {requestResult.over > 0 &&
                          requestResult.stopped === null
                            ? ` — ${requestResult.over} more loaded titles were not included; press again for the next ${REQUEST_ALL_CAP}.`
                            : "."}
                        </p>
                      )}
                      {requestResult?.stopped && (
                        <p className="bulk-error mt-2 text-sm" role="alert">
                          {requestResult.stopped.message}
                          {requestResult.notSent > 0
                            ? ` ${requestResult.notSent} not sent.`
                            : ""}
                        </p>
                      )}
                      {requestError && (
                        <p className="bulk-error mt-2 text-sm" role="alert">
                          The requests did not run: {requestError}
                        </p>
                      )}
                    </div>
                  )}
                  <dialog
                    ref={requestDialogRef}
                    className="bulk-dialog"
                    aria-labelledby={requestTitleId}
                  >
                    <div className="p-5">
                      <h3 id={requestTitleId} className="font-semibold">
                        Request {requestPlan.batch.length}{" "}
                        {requestPlan.batch.length === 1 ? "title" : "titles"}?
                      </h3>
                      <p className="mt-2 text-sm text-muted">
                        Velvarr files a request for each requestable title
                        loaded on this page, at most {REQUEST_ALL_CAP} per
                        press. Titles you already requested are skipped.
                        {requestPlan.over > 0 &&
                          ` ${requestPlan.over} more loaded ${requestPlan.over === 1 ? "title stays" : "titles stay"} for the next press.`}
                        {requestPlan.undeliverable > 0 &&
                          ` ${requestPlan.undeliverable} TPDB ${requestPlan.undeliverable === 1 ? "scene is" : "scenes are"} skipped: Whisparr cannot acquire them.`}
                      </p>
                      <div className="mt-4 flex justify-end gap-2">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => requestDialogRef.current?.close()}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-accent"
                          disabled={
                            requestBusy || requestPlan.batch.length === 0
                          }
                          onClick={() => void runRequests()}
                        >
                          File the requests
                        </button>
                      </div>
                    </div>
                  </dialog>
                  <div className={POSTER_GRID}>
                    {shown.map((it) =>
                      it.reference.kind === "scene" ? (
                        <SceneCard
                          key={cardKey(it.reference)}
                          item={it}
                          onOpen={openDetail}
                        />
                      ) : (
                        <MovieCard
                          key={cardKey(it.reference)}
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
                      {/* The named error is the point (VELV-167): a bare
                          "Retry" hid the server's diagnosis, e.g. the scan
                          ceiling's "narrow the filters". */}
                      <span>Couldn&rsquo;t load more titles: {error}</span>
                      {!scanLimited && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void load(acc.page + 1, "more")}
                        >
                          Retry
                        </button>
                      )}
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
            Title
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
          <div className="cat-group-head">
            <h3 className="cat-group-title" id="titles-g-performers">
              Performers
            </h3>
            <InfoTip id="titles-performer-info" label="Performers">
              <p>
                {performerStarred
                  ? "Scenes featuring any performer you follow. Picking a performer replaces this; performers known only to TPDB cannot match."
                  : `Up to ${MAX_BROWSE_ENTITIES} performers, each pickable from either source; with 2 or more, choose All of them or Any of them.`}
              </p>
              <p>
                A TPDB performer opens movies through the filmography route; a
                StashDB performer filters scenes (StashDB caps results at about
                ten rows).
              </p>
            </InfoTip>
          </div>
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
          <div className="cat-group-head">
            <h3 className="cat-group-title" id="titles-g-studios">
              Studios
            </h3>
            <InfoTip id="titles-studio-info" label="Studios">
              <p>
                Up to {MAX_BROWSE_ENTITIES} studios; a title from any of them
                matches.
              </p>
            </InfoTip>
          </div>
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
            help="A tag picked from the list matches exactly. A typed term matches every tag whose name contains it (case and separators ignored): “anal” also matches Analingus and Anal Fisting."
          />
          <TagPicker
            id="titles-exclude"
            label="Must not have"
            tone="exclude"
            selected={exclude}
            onChange={onExclude}
            allowFreeText
            description="Any tag here removes a title. Exclusions win."
            help="A typed term removes titles with any tag whose name contains it: “anal” also removes Analingus and Anal Fisting. A tag picked from the list also covers the ones that contain it as a word (Anal drops Anal Creampie, never Analingus)."
          />
          {/* Hidden tags filter silently, so this line stays visible. */}
          <p className="cat-note">
            {hiddenCount > 0
              ? `${hiddenCount} hidden tag${hiddenCount === 1 ? "" : "s"} from `
              : "Hidden tags from "}
            <button
              type="button"
              className="cat-inline-link"
              data-prefs-opener="drawer-note"
              onClick={() => window.dispatchEvent(new Event(OPEN_PREFERENCES))}
            >
              Preferences
            </button>{" "}
            always apply; Clear all keeps them.
          </p>
        </div>
        <div
          className="cat-group"
          role="group"
          aria-labelledby="titles-g-release"
        >
          <div className="cat-group-head">
            <h3 className="cat-group-title" id="titles-g-release">
              Release date
            </h3>
            <InfoTip id="titles-date-info" label="Release date">
              <p>
                Applies to TPDB movies and StashDB scenes. Both bounds are
                included. Leave one empty for an open range.
              </p>
            </InfoTip>
          </div>
          <DateRange
            id="titles-date"
            date={date}
            operation={dateOperation}
            dateTo={dateTo}
            disabled={filmography}
            onCommit={onDateRange}
          />
          {/* A bound that is checked locally makes totals approximate:
              said while it applies, never silently. */}
          {(dateTo !== "" || year !== "") && (
            <p className="cat-note">
              {dateTo !== ""
                ? "Totals are approximate: the end date is checked after the results arrive."
                : `A release year from an earlier link still applies (${yearTo !== "" ? `${year}–${yearTo}` : year}); setting a date replaces it.`}
            </p>
          )}
        </div>
      </FilterDrawer>
    </section>
  );
}
