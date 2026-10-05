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
import Link from "next/link";
import "./catalog.css";
import { TagPicker } from "./tag-picker.tsx";
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
  providerLabel,
  SceneCard,
  useApiGet,
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
// Names for studio/tag filter ids live in lib/names, seeded at navigation
// time (details, picks, tiles) — URLs carry ids, chips still get labels.
import { filterName, seedPerformerPick } from "../lib/names";
// Detail views (payload types, DetailSections, RelatedTitles,
// CatalogDetailView) live in catalog-detail.tsx; the browse view hosts the
// detail overlay and reads its target from the URL.
import { CatalogDetailView, detailTarget } from "./catalog-detail.tsx";
// Endless scroll appends pages through this dedupe-append (lib stays
// React-free so node --test can exercise it directly).
import { mergePageItems } from "../lib/browse-items.ts";

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

const POSTER_GRID = "poster-grid";

/* ---------- Browse-context helpers ---------- */

/** Sorts each provider+kind genuinely supports, mirroring the route's
 * SORT_SUPPORT: TPDB movie has relevance|recency|duration, StashDB
 * scene has title|date|duration|trending|popularity|created|updated.
 * Unsupported options are never offered, and trending/popularity are
 * labeled as StashDB's own ordering — recency is never called trending. */
type SortKey =
  | "relevance"
  | "recency"
  | "duration"
  | "title"
  | "date"
  | "trending"
  | "popularity"
  | "created"
  | "updated";

const SORT_LABELS: Record<SortKey, string> = {
  relevance: "Best match",
  recency: "Release recency",
  duration: "Duration",
  title: "Title",
  date: "Release date",
  trending: "Trending (StashDB ordering)",
  popularity: "Popularity (StashDB ordering)",
  created: "Recently added (StashDB)",
  updated: "Last updated (StashDB)",
};

function sortsFor(type: "all" | "movie" | "scene"): readonly SortKey[] {
  // type=all merges both sources, so only sorts both genuinely support are
  // offered; per-source sorts appear only on their own type.
  if (type === "movie") return ["relevance", "recency", "duration"];
  if (type === "scene")
    return [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ];
  return ["date", "duration"];
}

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
          Done
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
 * direction appears only with an explicit sort (the route 400s otherwise). */
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
  const sorts = sortsFor(type);
  if (sorts.length === 0) return null;
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
        {sort && (
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
function useSyncedInput(value: string) {
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
    if (t !== "" && (Number(t) < 1870 || Number(t) > 2100)) return;
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
        min={1870}
        max={2100}
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
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onRemove}
      aria-label={`Remove filter: ${label}`}
    >
      {label} <span aria-hidden="true">×</span>
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
      <label className="label" htmlFor={`${id}-date`}>
        Release date
      </label>
      <div className="flex gap-2">
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
        <select
          id={`${id}-op`}
          className="input"
          aria-label="Release date comparison"
          value={op}
          disabled={disabled}
          onChange={(e) => {
            setOp(e.target.value);
            if (date) onCommit(date, e.target.value);
          }}
        >
          {DATE_OPS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Debounced performer lookup behind the performer filter: the filter takes
 * a provider-native id, so the user picks a result — a typed name is never
 * sent. One field searches both sources; each result carries its side.
 * TPDB performer search is paged; StashDB is unpaged and caps its result
 * list, which the picker says out loud. */
function usePerformerOptions(term: string): {
  items: { performer: CatalogDetail; side: CatalogProvider }[];
  error: string | null;
  loading: boolean;
} {
  const t = term.trim();
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
  const tpdb = useApiGet<CatalogSearchPage>(
    committed !== null ? search("tpdb") : null,
    [committed],
  );
  const stash = useApiGet<CatalogSearchPage>(
    committed !== null ? search("stashdb") : null,
    [committed],
  );
  const error = [tpdb.error, stash.error].find((e) => e !== null) ?? null;
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
    error,
    loading: t !== "" && (committed !== t || tpdb.loading || stash.loading),
  };
}

function PerformerPicker({
  id,
  onPick,
}: {
  id: string;
  onPick: (side: CatalogProvider, performerId: string, name: string) => void;
}) {
  const [term, setTerm] = useState("");
  const { items, error, loading } = usePerformerOptions(term);
  return (
    <div>
      <label className="label" htmlFor={id}>
        Performer
      </label>
      <input
        id={id}
        type="search"
        className="input"
        maxLength={200}
        placeholder="Search performers…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      <p className="cat-note">
        One field, both sources: a TPDB performer opens their whole filmography
        (movies) and replaces the other filters until removed; a StashDB
        performer filters scenes. StashDB caps results at about ten rows.
      </p>
      {error ? (
        <p className="cat-note" role="alert">
          Performer search failed: {error}
        </p>
      ) : loading ? (
        <p className="cat-note" aria-live="polite">
          Searching…
        </p>
      ) : term.trim() !== "" && items.length === 0 ? (
        <p className="cat-note">No performers match “{term.trim()}”.</p>
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
      ) : null}
    </div>
  );
}

function NotConfigured({ provider }: { provider: CatalogProvider }) {
  return (
    <div className="panel p-6" role="note">
      <h3 className="font-semibold">
        {providerLabel(provider)} is not configured
      </h3>
      <p className="mt-2 text-sm text-muted">
        No API key is present for {providerLabel(provider)}, so there is nothing
        to search. Ask an administrator to add a key in Settings. This is
        different from a temporary outage — an outage would show a retry.
      </p>
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

/** A provider-legal filter entry point handed from a detail page into the
 * unified browse constraints. `param` is a canonical /api/browse key;
 * `id` is the provider-native id, or the YYYY string for `year`; `tag`
 * rides for `include` and as a co-filter on the performer params;
 * `studioMode` only for StashDB studios; `counterpart` only with the
 * performer params — her id on the other provider, so browse runs both
 * sides at once. */
export type BrowseFilter = {
  param:
    | "studioTpdb"
    | "studioStashdb"
    | "performerTpdb"
    | "performerStashdb"
    | "year"
    | "include";
  provider: CatalogProvider;
  id: string;
  tag?: CatalogTagSelection;
  studioMode?: "withChildren";
  counterpart?: { param: "performerTpdb" | "performerStashdb"; id: string };
};

// Detail filter entry points create canonical unified browse constraints:
// the jump always lands on the titles view (any view may host an entry
// point), type and the one constraint follow the filter's provider (year is
// TPDB-movie-only), every other constraint resets — a detail entry point
// starts a clean browse — and the old tags any/all modes are gone.
// Constraint change → push.
export function useBrowseTo(): (filter: BrowseFilter) => void {
  const setP = useParamsSetter();
  return useCallback(
    (filter: BrowseFilter) => {
      // Any view may host an entry point (performer pages live on the
      // following view), so the jump always lands on the titles view and
      // drops that view's own keys (provider, per-view paging).
      const patch: Record<string, string | null> = {
        view: "titles",
        type:
          filter.param === "year" || filter.provider === "tpdb"
            ? "movie"
            : "scene",
        q: null,
        include: null,
        exclude: null,
        year: null,
        date: null,
        date_operation: null,
        performerTpdb: null,
        performerStashdb: null,
        performerStarred: null,
        studioTpdb: null,
        studioStashdb: null,
        studioMode: null,
        sort: null,
        direction: null,
        provider: null,
        perPage: null,
        moviePage: null,
        scenePage: null,
        kind: null,
        id: null,
      };
      // Only the selection fields ride the URL; count-style extras a caller
      // carries on its tag objects never leak into the wire.
      const cleanTag = ({ name, tpdb, stashdb }: CatalogTagSelection) => ({
        name,
        ...(tpdb !== undefined ? { tpdb } : {}),
        ...(stashdb !== undefined ? { stashdb } : {}),
      });
      if (filter.param === "include" && filter.tag !== undefined) {
        patch.include = JSON.stringify([cleanTag(filter.tag)]);
      } else {
        patch[filter.param] = filter.id;
        // A union jump rides both of her ids; no single type can run both
        // providers, so it lands on browse All.
        if (filter.counterpart !== undefined) {
          patch[filter.counterpart.param] = filter.counterpart.id;
          patch.type = null;
        }
        if (filter.studioMode) patch.studioMode = filter.studioMode;
        if (filter.tag !== undefined) {
          patch.include = JSON.stringify([cleanTag(filter.tag)]);
        }
      }
      setP(patch, { push: true });
    },
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
  // default — visible in the select, never sent upstream for a 400.
  const sorts = sortsFor(type);
  const sortRaw = params.get("sort") ?? "";
  const sort = (sorts as readonly string[]).includes(sortRaw) ? sortRaw : "";
  const dirRaw = params.get("direction") ?? "";
  const direction =
    sort !== "" && (dirRaw === "asc" || dirRaw === "desc") ? dirRaw : "desc";
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

  /* Grid columns come from the rendered CSS tracks, so a fetched page is
   * always whole rows: nine columns means 27 items, not 24. The probe is
   * always mounted, so the tracks are known before the first fetch — the
   * page is sized right the first time, not corrected afterwards. */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const tracks = getComputedStyle(el)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length;
      if (tracks > 0) setCols(tracks);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rounded = cols > 0 ? Math.min(100, cols * Math.ceil(24 / cols)) : 0;
  useEffect(() => {
    if (rounded > 0 && rounded !== perPage) {
      setPerPage(rounded);
      // A page sized for other tracks is not comparable: reset it.
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
            errors: page.errors,
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
      // Sorts are per-type: one the new type does not support is dropped.
      const keepSort = (sortsFor(t) as readonly string[]).includes(sortRaw);
      setP(
        {
          type: t === "all" ? null : t,
          sort: keepSort ? sortRaw : null,
          direction: keepSort ? dirRaw : null,
          // Both performer chips active would 400 on a single type (the
          // server refuses both ids with a kind), so the tab visibly drops
          // the chip that cannot run on the target kind — the same clamp
          // the sort gets above.
          ...(t === "movie"
            ? { performerStashdb: null, performerStarred: null }
            : {}),
          ...(t === "scene" ? { performerTpdb: null } : {}),
        },
        { push: true },
      );
    },
    [setP, sortRaw, dirRaw],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null }, { push: true }),
    [setP],
  );
  const onInclude = useCallback(
    (tags: CatalogTagSelection[]) =>
      setP(
        {
          include: tags.length > 0 ? JSON.stringify(tags) : null,
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
        },
        { push: true },
      ),
    [setP],
  );
  // TPDB's performer filter is the filmography route: everything else goes,
  // including sort (the route rejects all of it).
  const onPerformerTpdb = useCallback(
    (id: string) =>
      setP(
        {
          performerTpdb: id,
          q: null,
          include: null,
          exclude: null,
          year: null,
          date: null,
          date_operation: null,
          studioTpdb: null,
          studioStashdb: null,
          studioMode: null,
          sort: null,
          direction: null,
        },
        { push: true },
      ),
    [setP],
  );
  // StashDB composes a performer with everything else — no other key moves.
  const onPerformerStashdb = useCallback(
    (id: string) => setP({ performerStashdb: id }, { push: true }),
    [setP],
  );
  const onStarred = useCallback(
    (on: boolean) =>
      setP({ performerStarred: on ? "1" : null }, { push: true }),
    [setP],
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
      setP({ date: d, date_operation: op, year: null }, { push: true }),
    [setP],
  );
  const onSort = useCallback(
    (v: string) =>
      setP(
        {
          sort: v || null,
          direction: v ? direction || "desc" : null,
        },
        { push: true },
      ),
    [setP, direction],
  );
  const onDirection = useCallback(
    (d: "asc" | "desc") => setP({ direction: d }, { push: true }),
    [setP],
  );
  const onStudioTpdb = useCallback(
    (id: string | null) => setP({ studioTpdb: id }, { push: true }),
    [setP],
  );
  const onStudioStashdb = useCallback(
    (id: string | null) => setP({ studioStashdb: id }, { push: true }),
    [setP],
  );
  const onStudioMode = useCallback(
    (m: string) =>
      setP({ studioMode: m === "withChildren" ? m : null }, { push: true }),
    [setP],
  );
  const clearFilters = useCallback(() => {
    setP(
      {
        q: null,
        include: null,
        exclude: null,
        year: null,
        date: null,
        date_operation: null,
        performerTpdb: null,
        performerStashdb: null,
        performerStarred: null,
        studioTpdb: null,
        studioStashdb: null,
        studioMode: null,
        sort: null,
        direction: null,
      },
      { push: true },
    );
  }, [setP]);

  // An active studio/tag id without a captured name stays an id — never a
  // fake label (see filterName).
  const filterCount =
    (q ? 1 : 0) +
    (year ? 1 : 0) +
    (date ? 1 : 0) +
    (performerTpdb ? 1 : 0) +
    (performerStashdb ? 1 : 0) +
    (performerStarred ? 1 : 0) +
    (studioTpdb ? 1 : 0) +
    (studioStashdb ? 1 : 0) +
    (studioMode ? 1 : 0) +
    include.length +
    exclude.length +
    (sort ? 1 : 0);

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

  const chips: ReactNode[] = [];
  if (q) {
    chips.push(
      <FilterChip key="q" label={`“${q}”`} onRemove={() => onQ("")} />,
    );
  }
  if (year) {
    chips.push(
      <FilterChip
        key="year"
        label={`Year ${year}`}
        onRemove={() => onYear("")}
      />,
    );
  }
  if (date) {
    chips.push(
      <FilterChip
        key="date"
        label={`Released ${dateOpLabel(dateOperation)} ${date}`}
        onRemove={() => onDate(null, null)}
      />,
    );
  }
  if (performerTpdb) {
    chips.push(
      <FilterChip
        key="performerTpdb"
        label={`Performer: ${filterName("tpdb", "performer", performerTpdb)} (TPDB)`}
        // Chip removal only drops the constraint — unlike picking a
        // performer, which starts the filmography browse and clears the rest.
        onRemove={() => setP({ performerTpdb: null }, { push: true })}
      />,
    );
  }
  if (performerStashdb) {
    chips.push(
      <FilterChip
        key="performerStashdb"
        label={`Performer: ${filterName("stashdb", "performer", performerStashdb)} (StashDB)`}
        onRemove={() => setP({ performerStashdb: null }, { push: true })}
      />,
    );
  }
  if (performerStarred) {
    chips.push(
      <FilterChip
        key="performerStarred"
        label="Performer: my starred performers"
        onRemove={() => setP({ performerStarred: null }, { push: true })}
      />,
    );
  }
  if (studioTpdb) {
    chips.push(
      <FilterChip
        key="studioTpdb"
        label={`Studio: ${filterName("tpdb", "studio", studioTpdb)} (TPDB)`}
        onRemove={() => onStudioTpdb(null)}
      />,
    );
  }
  if (studioStashdb) {
    chips.push(
      <FilterChip
        key="studioStashdb"
        label={`Studio: ${filterName("stashdb", "studio", studioStashdb)} (StashDB)`}
        onRemove={() => onStudioStashdb(null)}
      />,
    );
  }
  if (studioMode === "withChildren") {
    chips.push(
      <FilterChip
        key="studioMode"
        label="Scope: include child studios"
        onRemove={() => onStudioMode("")}
      />,
    );
  }
  include.forEach((tag, i) => {
    chips.push(
      <FilterChip
        key={`include:${tag.name}:${tag.tpdb ?? ""}:${tag.stashdb ?? ""}:${i}`}
        label={`Tag: ${tag.name} (include)`}
        onRemove={() => onInclude(include.filter((t) => t !== tag))}
      />,
    );
  });
  exclude.forEach((tag, i) => {
    chips.push(
      <FilterChip
        key={`exclude:${tag.name}:${tag.tpdb ?? ""}:${tag.stashdb ?? ""}:${i}`}
        label={`Tag: ${tag.name} (exclude)`}
        onRemove={() => onExclude(exclude.filter((t) => t !== tag))}
      />,
    );
  });
  if (sort) {
    chips.push(
      <FilterChip
        key="sort"
        label={`Sort: ${SORT_LABELS[sort as SortKey]} (${direction})`}
        onRemove={() => setP({ sort: null, direction: null }, { push: true })}
      />,
    );
  }

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
              <Link
                href="/?view=preferences"
                className="btn"
                aria-label={`${hiddenCount} personal hidden tags active — manage in Preferences`}
              >
                <Icon name="tag" /> {hiddenCount} hidden
              </Link>
            )}
            <div role="group" aria-label="Title type" className="flex gap-2">
              {(["all", "movie", "scene"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`btn ${type === t ? "btn-accent" : ""}`}
                  aria-pressed={type === t}
                  onClick={() => onType(t)}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
            <SortSelect
              id="titles-sort"
              type={type}
              sort={sort}
              direction={direction}
              disabled={performerTpdb !== ""}
              onSort={onSort}
              onDirection={onDirection}
            />
            <FiltersButton
              count={filterCount}
              onClick={() => setFiltersOpen(true)}
            />
          </div>
        </div>

        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Filters:</span>
            {chips}
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
              {acc.errors.map((e) => (
                <ErrorPanel
                  key={e.provider}
                  title={`${providerLabel(e.provider)} unavailable`}
                  message={e.message}
                  onRetry={retry}
                />
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
                  <div className={POSTER_GRID}>
                    {acc.items.map((it) =>
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
                  {!loading &&
                    error === null &&
                    !acc.hasMore &&
                    acc.totalCountKnown &&
                    acc.total != null && (
                      // Count only when the service attests a real total; a
                      // capped total ends the scroll without a denominator.
                      <p className="mt-6 text-center text-sm text-muted">
                        {acc.total} titles
                      </p>
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
        <SearchBox
          id="titles-q"
          label="Title search"
          value={q}
          onCommit={onQ}
          disabled={performerTpdb !== ""}
        />
        <TagPicker
          id="titles-include"
          label="Include tags"
          selected={include}
          onChange={onInclude}
          description="Titles must carry every selected tag (AND), matched exactly — the provider filters on the tag itself."
        />
        <TagPicker
          id="titles-exclude"
          label="Exclude tags"
          selected={exclude}
          onChange={onExclude}
          allowFreeText
          description="Titles carrying any of these tags are left out — exclusions win over includes, and a tag also covers the ones that contain it as a word (Anal drops Anal Creampie, never Analingus)."
        />
        <PerformerPicker
          id="titles-performer"
          onPick={(side, performerId) =>
            side === "tpdb"
              ? onPerformerTpdb(performerId)
              : onPerformerStashdb(performerId)
          }
        />
        <div>
          <label
            className="label flex items-center gap-2"
            htmlFor="titles-starred"
          >
            <input
              id="titles-starred"
              type="checkbox"
              className="check"
              checked={performerStarred}
              onChange={(e) => onStarred(e.target.checked)}
            />
            My starred performers
          </label>
          <p className="cat-note">
            Scenes featuring any performer you follow. Performers known only to
            TPDB cannot match this filter.
          </p>
        </div>
        <YearBox
          id="titles-year"
          value={year}
          onCommit={onYear}
          disabled={performerTpdb !== ""}
        />
        <DateCutoff
          id="titles-date"
          date={date}
          operation={dateOperation}
          disabled={performerTpdb !== ""}
          onCommit={onDate}
        />
        {/* Year and the date cutoff are TPDB-movie criteria; while either is
            set only TPDB qualifies, and the note says so — never silently
            ignored. */}
        {(year !== "" || date !== "") && (
          <p className="cat-note">
            Year and release date apply to TPDB movies — while set, StashDB
            scenes are left out.
          </p>
        )}
        {studioStashdb !== "" && (
          <div>
            <label className="label" htmlFor="titles-studio-scope">
              Studio scope
            </label>
            <select
              id="titles-studio-scope"
              className="input"
              value={studioMode || "exact"}
              onChange={(e) => onStudioMode(e.target.value)}
            >
              <option value="exact">Exact studio only</option>
              <option value="withChildren">Include child studios</option>
            </select>
          </div>
        )}
        <p className="cat-note">
          {hiddenCount > 0
            ? `${hiddenCount} personal hidden tag${hiddenCount === 1 ? "" : "s"} appl${hiddenCount === 1 ? "ies" : "y"} on every browse — `
            : "Personal hidden tags apply on every browse — "}
          <Link href="/?view=preferences">manage them in Preferences</Link>.
          Clear filters never removes them.
        </p>
      </FilterDrawer>
    </section>
  );
}
