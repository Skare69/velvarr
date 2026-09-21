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
import {
  api,
  ApiError,
  detailParams,
  duration,
  ErrorPanel,
  FileFacts,
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
import { levelLabel } from "./removals";
import { isDeliverableMedia } from "../lib/contracts";
import type {
  AcquisitionState,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  MediaKind,
  PlaybackAccess,
  RequestDecision,
  RequestRecord,
  RemovalRequest,
} from "../lib/contracts";
import { REQUESTS_CHANGED } from "../lib/approvals";

/* ---------- Local shapes for API responses ---------- */

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

type DetailPayload = {
  detail: CatalogDetail & {
    /** StashDB studio detail only: provider-supplied child-studio count
     * (omitted when the provider supplies none — never defaulted to 0). */
    childStudioCount?: number;
  };
  link: { linked?: CatalogReference } | { unlinkedReason?: string };
  myRequest: {
    id: string;
    decision: RequestDecision;
    createdAt: number;
    decidedAt: number | null;
  } | null;
  acquisition: {
    state: AcquisitionState;
    lastError: string | null;
    updatedAt: number;
    monitored: boolean | null;
    progress: { percent: number | null; timeleft: string | null } | null;
  } | null;
};

type DetailTarget = {
  provider: CatalogProvider;
  kind: CatalogKind;
  id: string;
};

/* ---------- Small helpers ---------- */

const POSTER_GRID = "poster-grid";

function kindStrict(v: string | null): CatalogKind | null {
  // "studio" admits the studio detail page; movie/scene heroes link to it.
  return v === "movie" || v === "scene" || v === "performer" || v === "studio"
    ? v
    : null;
}

function asMediaKind(kind: CatalogKind): MediaKind | null {
  return kind === "movie" || kind === "scene" ? kind : null;
}

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

function sortsFor(
  provider: CatalogProvider,
  kind: CatalogKind,
): readonly SortKey[] {
  if (provider === "tpdb" && kind === "movie")
    return ["relevance", "recency", "duration"];
  if (provider === "stashdb" && kind === "scene")
    return [
      "title",
      "date",
      "duration",
      "trending",
      "popularity",
      "created",
      "updated",
    ];
  return [];
}

/** The browse state behind an open detail: the URL minus the detail params
 * (provider/kind/id) and the performer tab. Keys the scroll store. */
function browseKeyOf(params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  for (const k of ["provider", "kind", "id", "tab"]) p.delete(k);
  p.sort();
  return p.toString();
}

/** Session-scoped scroll positions keyed by browse state. Deliberate
 * filter changes never write it, so they never cause a scroll jump. */
const scrollPositions = new Map<string, number>();

function saveScroll(key: string) {
  if (window.scrollY > 0) scrollPositions.set(key, window.scrollY);
}

function restoreScroll(key: string) {
  const y = scrollPositions.get(key);
  if (y === undefined) return;
  scrollPositions.delete(key);
  window.scrollTo(0, y);
}

/** Names for studio/tag filter ids, captured from details at navigation
 * time — the URL carries only provider-native ids, chips still get labels. */
const filterNames = new Map<string, string>();

function filterName(provider: string, kind: string, id: string): string {
  // An id with no captured name is labeled AS an id — never a fake name.
  return filterNames.get(`${provider}:${kind}:${id}`) ?? `#${id.slice(0, 8)}…`;
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

/** Sort control offering only what the provider+kind genuinely supports;
 * direction appears only with an explicit sort (the route 400s otherwise). */
function SortSelect({
  id,
  provider,
  kind,
  sort,
  direction,
  disabled,
  onSort,
  onDirection,
}: {
  id: string;
  provider: CatalogProvider;
  kind: CatalogKind;
  sort: string;
  direction: string;
  /** TPDB filmography route rejects sort — disabled while a performer
   * filter is active. */
  disabled?: boolean;
  onSort: (v: string) => void;
  onDirection: (v: "asc" | "desc") => void;
}) {
  const sorts = sortsFor(provider, kind);
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
            aria-label="Sort direction"
            disabled={disabled}
            onClick={() => onDirection(direction === "asc" ? "desc" : "asc")}
          >
            {direction === "asc" ? "Sort descending" : "Sort ascending"}
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

/** TPDB only: moves the selected tag ids between `tags` (any) and `tagsAll`
 * (all). StashDB exposes neither tagsAll nor a second tag mode. */
function TagModeSwitch({
  mode,
  onMode,
}: {
  mode: "any" | "all";
  onMode: (m: "any" | "all") => void;
}) {
  return (
    <div role="group" aria-label="Tag matching" className="flex gap-2">
      <button
        type="button"
        className={`btn ${mode === "any" ? "btn-accent" : ""}`}
        aria-pressed={mode === "any"}
        onClick={() => onMode("any")}
      >
        Match any tag
      </button>
      <button
        type="button"
        className={`btn ${mode === "all" ? "btn-accent" : ""}`}
        aria-pressed={mode === "all"}
        onClick={() => onMode("all")}
      >
        Match all tags
      </button>
    </div>
  );
}

/** Debounced performer lookup behind the performer filter: the filter takes
 * a provider-native id, so the user picks a result — a typed name is never
 * sent. TPDB performer search is paged; StashDB is unpaged and caps its
 * result list, which the picker says out loud. */
function usePerformerOptions(
  provider: CatalogProvider,
  term: string,
): {
  items: CatalogDetail[];
  error: string | null;
  loading: boolean;
} {
  const t = term.trim();
  // The debounce commits the read path, not the fetch: keystrokes settle
  // before the hook sees a new read at all.
  const [committed, setCommitted] = useState<{
    term: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (t === "") {
      setCommitted(null);
      return;
    }
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({ provider, kind: "performer", q: t });
      if (provider === "tpdb") {
        qs.set("page", "1");
        qs.set("perPage", "10");
      }
      setCommitted({ term: t, path: `/api/catalog/search?${qs.toString()}` });
    }, 400);
    return () => clearTimeout(timer);
  }, [provider, t]);
  const { data, error, loading } = useApiGet<CatalogSearchPage>(
    committed?.path ?? null,
    [committed?.path],
  );
  return {
    items: data?.items ?? [],
    error,
    loading: t !== "" && (committed?.term !== t || loading),
  };
}

function PerformerPicker({
  id,
  provider,
  onPick,
}: {
  id: string;
  provider: CatalogProvider;
  onPick: (performerId: string, name: string) => void;
}) {
  const [term, setTerm] = useState("");
  const { items, error, loading } = usePerformerOptions(provider, term);
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
      {provider === "stashdb" && (
        <p className="cat-note">
          StashDB caps performer search at about ten rows — the list may be
          incomplete.
        </p>
      )}
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
          {items.map((it) => (
            <li key={it.reference.id}>
              <button
                type="button"
                className="cat-picker-row"
                onClick={() => {
                  filterNames.set(
                    `${provider}:performer:${it.reference.id}`,
                    it.title,
                  );
                  onPick(it.reference.id, it.title);
                  setTerm("");
                }}
              >
                <ItemImage
                  name={it.title}
                  src={imgSrc(it.imageUrl)}
                  className="cat-picker-img"
                />
                <span>{it.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The server caps one tag filter at 25 ids — the picker stops offering more
 * rather than letting the request 400. */
const TAG_CAP = 25;

function TagPicker({
  id,
  provider,
  label,
  selected,
  disabled,
  note,
  onAdd,
}: {
  id: string;
  provider: CatalogProvider;
  label: string;
  selected: string[];
  disabled?: boolean;
  note?: string;
  onAdd: (tag: { id: string; name: string }) => void;
}) {
  const [term, setTerm] = useState("");
  const t = term.trim();
  // The debounce commits the term; the route only ever sees settled input.
  const [committed, setCommitted] = useState<string | null>(null);
  useEffect(() => {
    if (t.length < 2) {
      // The route 400s under two characters; it is simply not called.
      setCommitted(null);
      return;
    }
    const timer = setTimeout(() => setCommitted(t), 400);
    return () => clearTimeout(timer);
  }, [t]);
  const { data, error } = useApiGet<{
    tags: { id: string; name: string }[];
  }>(
    committed === null
      ? null
      : `/api/catalog/tags?provider=${provider}&q=${encodeURIComponent(committed)}`,
    [provider, committed],
  );
  // A failed search hides the previous list, as the old catch did.
  const tags = error === null ? (data?.tags ?? null) : null;
  const capped = selected.length >= TAG_CAP;
  const matches = (tags ?? []).filter(
    (tg) => UUID_RE.test(tg.id) && !selected.includes(tg.id),
  );
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
        placeholder="Search tags…"
        disabled={disabled || capped}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {capped ? (
        <p className="cat-note">
          Tag limit reached ({TAG_CAP}) — remove one before adding another.
        </p>
      ) : (
        <>
          {note && <p className="cat-note">{note}</p>}
          {t.length > 0 && t.length < 2 && (
            <p className="cat-note">Type at least two characters.</p>
          )}
          {error && (
            <p className="cat-note" role="alert">
              Tag search failed: {error}
            </p>
          )}
          {tags !== null &&
            (matches.length === 0 ? (
              <p className="cat-note">No more tags match “{t}”.</p>
            ) : (
              <ul className="cat-picker">
                {matches.map((tg) => (
                  <li key={tg.id}>
                    <button
                      type="button"
                      className="cat-picker-row"
                      onClick={() => {
                        filterNames.set(`${provider}:tag:${tg.id}`, tg.name);
                        onAdd(tg);
                        setTerm("");
                      }}
                    >
                      <span>{tg.name}</span>
                      <span className="cat-picker-add" aria-hidden="true">
                        +
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </div>
  );
}

/** Count text only when the provider attests a real total; a capped total
 * (totalCountKnown false) renders paging alone and never a fake size. */
function Paging({
  page,
  hasMore,
  total,
  totalCountKnown,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  onPage: (p: number) => void;
}) {
  const go = (p: number) => {
    onPage(p);
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <div className="text-sm text-muted">
        {totalCountKnown && total != null ? `${total} results · ` : ""}Page{" "}
        {page}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasMore}
          onClick={() => go(page + 1)}
        >
          Next
        </button>
      </div>
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

/* ---------- Search hook ---------- */

type CatalogQuery = {
  provider: CatalogProvider;
  kind: CatalogKind;
  q: string;
  year: string;
  performer: string;
  studio: string;
  /** StashDB scene + studio only; omitted means exact studio. */
  studioMode?: string;
  tags: string;
  /** TPDB only: match-all tag list; mutually exclusive with `tags`. */
  tagsAll: string;
  /** StashDB scene only: excluded tag list; mutually exclusive with `tags`. */
  tagsExclude: string;
  /** TPDB movie only; date_operation must always ride along. */
  date: string;
  dateOperation: string;
  sort: string;
  direction: string;
  page: number;
  perPage: number;
  paged: boolean;
  enabled: boolean;
  reload: number;
};

function useCatalogSearch(f: CatalogQuery): {
  data: CatalogSearchPage | null;
  error: string | null;
  loading: boolean;
} {
  const path = useMemo(() => {
    if (!f.enabled) return null;
    const qs = new URLSearchParams({ provider: f.provider, kind: f.kind });
    if (f.paged) {
      qs.set("page", String(f.page));
      qs.set("perPage", String(f.perPage));
    }
    if (f.q) qs.set("q", f.q);
    if (f.year) qs.set("year", f.year);
    if (f.performer) qs.set("performer", f.performer);
    if (f.studio) qs.set("studio", f.studio);
    if (f.studioMode) qs.set("studioMode", f.studioMode);
    if (f.tags) qs.set("tags", f.tags);
    if (f.tagsAll) qs.set("tagsAll", f.tagsAll);
    if (f.tagsExclude) qs.set("tagsExclude", f.tagsExclude);
    if (f.date) {
      qs.set("date", f.date);
      qs.set("date_operation", f.dateOperation);
    }
    if (f.sort) {
      qs.set("sort", f.sort);
      if (f.direction) qs.set("direction", f.direction);
    }
    return `/api/catalog/search?${qs.toString()}`;
  }, [
    f.provider,
    f.kind,
    f.q,
    f.year,
    f.performer,
    f.studio,
    f.studioMode,
    f.tags,
    f.tagsAll,
    f.tagsExclude,
    f.date,
    f.dateOperation,
    f.sort,
    f.direction,
    f.page,
    f.perPage,
    f.paged,
    f.enabled,
  ]);
  // An outage is an error, never an empty page: the error string rides out
  // of the hook and the view offers a retry instead of a "no rows" panel.
  // f.reload is the caller's retry counter, not a path input.
  return useApiGet<CatalogSearchPage>(path, [path, f.reload]);
}

/* ---------- Detail page ---------- */

function detailTarget(params: URLSearchParams): DetailTarget | null {
  const providerRaw = params.get("provider");
  const provider =
    providerRaw === "tpdb" || providerRaw === "stashdb" ? providerRaw : null;
  const kind = kindStrict(params.get("kind"));
  const id = params.get("id");
  if (!provider || !kind || !id) return null;
  return { provider, kind, id };
}

function DetailSkeleton() {
  return (
    <div aria-label="Loading details" aria-busy="true">
      <div className="skel cat-hero-skel" />
      <div className="cat-cols">
        <div className="space-y-3">
          <div className="skel h-24 w-full" />
          <div className="skel h-6 w-3/4" />
          <div className="skel h-4 w-full" />
          <div className="skel h-4 w-5/6" />
        </div>
        <div className="space-y-3">
          <div className="skel h-4 w-1/3" />
          <div className="skel h-20 w-full" />
          <div className="skel h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

const DECISION_TEXT: Record<RequestDecision, string> = {
  pending: "Requested — waiting for a moderator",
  approved: "Request approved",
  declined: "Request declined",
  cancelled: "Request cancelled",
};

export function acquisitionText(a: {
  state: AcquisitionState;
  lastError: string | null;
  monitored?: boolean | null;
  progress?: { percent: number | null; timeleft: string | null } | null;
}): string {
  // Unmonitored outranks every state but imported — Whisparr will never deliver it.
  if (a.monitored === false && a.state !== "imported")
    return "Paused — Whisparr is not monitoring this item";
  switch (a.state) {
    case "unsent":
      return "Queued — not submitted yet";
    case "submitting":
      return "Queued — being submitted";
    case "monitoring":
      return "Watching for a release (this is not a failure)";
    case "downloading": {
      if (typeof a.progress?.percent !== "number") return "Downloading";
      const left = a.progress.timeleft;
      return left
        ? `Downloading — ${a.progress.percent}% (${left} left)`
        : `Downloading — ${a.progress.percent}%`;
    }
    case "imported":
      return "Imported — in your library";
    case "uncertain":
      return a.lastError
        ? `Being reconciled — last check: ${a.lastError}`
        : "Being reconciled — the last check was inconclusive";
    case "failed":
      return a.lastError ? `Failed — ${a.lastError}` : "Failed";
    case "blocked":
      return "Blocked — delivery is turned off";
  }
}

/** Availability of the media target; null while loading or on error — a
 * failed check renders nothing, no claim either way. No request for
 * performer/studio targets. */
function useAvailability(
  target: {
    provider: CatalogProvider;
    kind: MediaKind;
    id: string;
  } | null,
): PlaybackAccess | null {
  const { data } = useApiGet<PlaybackAccess>(
    target
      ? `/api/availability/${target.provider}/${target.kind}/${encodeURIComponent(target.id)}`
      : null,
    [target?.provider, target?.kind, target?.id],
  );
  return data;
}

/** Error codes from POST /api/removals, mapped faithfully. */
function removalRequestError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "removal_disabled":
        return "Removal is turned off by the operator — it cannot be requested right now.";
      case "account_not_admitted":
        return "Your account does not have the removal grant — ask an administrator.";
      case "removal_request_exists":
        return "A removal request for this item already exists.";
      case "invalid_reason":
        return "Give a reason for the removal.";
      case "invalid_reference":
        return "This item is not removable media.";
    }
  }
  return messageOf(e);
}

/** Requester-side removal entry: a reason, never a level — the level is the
 * approver's explicit choice. Rendered only for removable media kinds
 * (movie/scene), at the end of the detail aside. */
function RemovalAction({
  target,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
}) {
  const { account } = useSession();
  const grant = account.canRemove;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RemovalRequest | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // One read gives the operator flag (enabled) and this user's existing
  // removal requests, so the surface never guesses its own availability.
  const {
    data,
    error: loadError,
    reload,
  } = useApiGet<{ removals: RemovalRequest[]; enabled: boolean }>(
    grant ? "/api/removals" : null,
    [grant, target.provider, target.kind, target.id],
  );

  const existing =
    data?.removals.find(
      (r) =>
        r.media.provider === target.provider &&
        r.media.kind === target.kind &&
        r.media.id === target.id &&
        (r.decision === "pending" || r.decision === "approved"),
    ) ?? null;
  const shown = created ?? existing;

  const submit = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api<{ removal: RemovalRequest }>("/api/removals", {
      method: "POST",
      body: JSON.stringify({
        media: {
          provider: target.provider,
          kind: target.kind,
          id: target.id,
        },
        reason: reason.trim(),
      }),
    })
      .then((d) => {
        setCreated(d.removal);
        setReason("");
        setAnnouncement(
          "Removal request submitted — an approver will choose the level.",
        );
      })
      .catch((e: unknown) => {
        const msg = removalRequestError(e);
        setError(msg);
        setAnnouncement(msg);
        if (
          e instanceof ApiError &&
          (e.code === "removal_request_exists" || e.code === "forbidden")
        )
          reload(); // surface the server's real state
      })
      .finally(() => setBusy(false));
  };

  if (!grant) return null;
  return (
    <section className="cat-section" aria-label="Removal">
      <h2 className="cat-section-title">Removal</h2>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {shown ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={`chip ${shown.decision === "pending" ? "chip-accent" : ""}`}
          >
            Removal {shown.decision}
          </span>
          {shown.level !== null && (
            <span className="chip">Level: {levelLabel(shown.level)}</span>
          )}
        </div>
      ) : loadError !== null ? (
        <div className="mt-2">
          <ErrorPanel
            title="Removal state unavailable"
            message={loadError}
            onRetry={reload}
          />
        </div>
      ) : data === null ? (
        <div className="skel mt-2 h-16 w-full" aria-hidden="true" />
      ) : data.enabled ? (
        <form
          className="mt-2 max-w-prose"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="removal-reason" className="label">
            Why should this be removed? (shown to the approver)
          </label>
          <textarea
            id="removal-reason"
            className="input mt-1"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn btn-accent"
              disabled={busy || reason.trim() === ""}
            >
              {busy ? "Requesting…" : "Request removal"}
            </button>
            {error !== null && (
              <span className="text-sm text-danger" role="alert">
                {error}
              </span>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function MediaActions({
  target,
  mine,
  availability,
  onRefetch,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
  mine: DetailPayload["myRequest"];
  availability: PlaybackAccess | null;
  onRefetch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(mine);
  const [autoApproved, setAutoApproved] = useState(false);
  useEffect(() => setRequested(mine), [mine]);
  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ request: RequestRecord; autoApproved?: boolean }>(
        "/api/requests",
        {
          method: "POST",
          body: JSON.stringify({
            media: {
              provider: target.provider,
              kind: target.kind,
              id: target.id,
            },
          }),
        },
      );
      setRequested({
        id: d.request.id,
        decision: d.request.decision,
        createdAt: d.request.createdAt,
        decidedAt: d.request.decidedAt,
      });
      setAutoApproved(d.autoApproved === true);
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
    } catch (e) {
      if (e instanceof ApiError && e.code === "request_exists") {
        // An existing request is a state, not an error: reload the detail so
        // the real decision shows.
        onRefetch();
      } else {
        setError(messageOf(e));
      }
    } finally {
      setBusy(false);
    }
  }, [target, onRefetch]);
  // Already playable: the Play button is the only honest action left — a
  // second request would file intent for something the library already has.
  const available = availability?.outcome === "available";
  return (
    <div className="flex flex-col gap-2">
      {available ? null : requested ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip chip-accent">
            {DECISION_TEXT[requested.decision]}
          </span>
          {autoApproved && <span className="chip">Auto-approved</span>}
        </div>
      ) : !isDeliverableMedia(target) ? (
        <p className="text-xs text-muted">
          Browse only — Whisparr has no metadata source for a TPDB scene.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void request()}
          >
            {busy ? "Requesting…" : "Request this title"}
          </button>
          {error && (
            <span className="text-sm text-danger" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      {availability?.outcome === "available" && availability.watchUrl && (
        <a
          className="btn btn-accent"
          href={availability.watchUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="play" /> Play on Jellyfin
        </a>
      )}
    </div>
  );
}

/** A provider-legal filter entry point handed from a detail page to the
 * matching browse surface. `id` is the provider-native id, or the YYYY
 * string for `year`; `studioMode` rides along only for StashDB studios. */
type BrowseFilter = {
  param: "studio" | "tags" | "performer" | "year";
  provider: CatalogProvider;
  id: string;
  studioMode?: "withChildren";
};

/** Tag filters accept UUID ids only; mirrors the server's UUID_RE. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function DetailBody({
  payload,
  target,
  onNavigate,
  onBrowse,
  onRefetch,
}: {
  payload: DetailPayload;
  target: DetailTarget;
  onNavigate: (r: CatalogReference) => void;
  onBrowse: (view: "movies" | "scenes", filter: BrowseFilter) => void;
  onRefetch: () => void;
}) {
  const d = payload.detail;
  const mediaKind = asMediaKind(target.kind);
  const linked = "linked" in payload.link ? payload.link.linked : undefined;
  // A provider-supplied studio reference (kind "studio") becomes a real
  // control; without one the studio stays plain text.
  const studioRef =
    d.studio?.reference && d.studio.reference.kind === "studio"
      ? d.studio.reference
      : null;
  // Tag-filtered search exists for movie/scene only; performer and studio
  // details keep their tags as plain text rather than dead controls. A
  // TPDB scene's tags stay plain too — its kind has no listing to filter.
  const tagBrowse =
    target.kind === "movie" ||
    (target.kind === "scene" && target.provider === "stashdb");
  const isStudio = target.kind === "studio";
  const mediaView = mediaKind === "movie" ? "movies" : "scenes";
  // One listing source per kind: a TPDB scene has no browse surface, so
  // its detail renders none of the "browse scenes" entry points.
  const tpdbScene = target.kind === "scene" && target.provider === "tpdb";
  // Availability is a media-target concept: no fetch for performer/studio.
  const mediaTarget =
    mediaKind !== null
      ? { provider: target.provider, kind: mediaKind, id: target.id }
      : null;
  const availability = useAvailability(mediaTarget);
  // Year filtering exists on TPDB movie lists only; StashDB has no
  // year or date filter (the route rejects it), so its dates stay plain.
  const releaseYear =
    mediaKind === "movie" && target.provider === "tpdb"
      ? (d.releaseDate?.slice(0, 4) ?? null)
      : null;
  const showSourceUrl =
    d.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : null;
  const posterClass =
    target.kind === "performer" ? "cat-poster cat-poster-square" : "cat-poster";
  const backdrop = imgSrc(d.imageUrl);
  // Remember studio/tag names so browse chips can label the ids the URL
  // carries — details are where names are known.
  useEffect(() => {
    if (studioRef)
      filterNames.set(
        `${studioRef.provider}:studio:${studioRef.id}`,
        d.studio?.name ?? studioRef.id,
      );
    if (tagBrowse)
      for (const t of d.tags)
        filterNames.set(`${target.provider}:tag:${t.id}`, t.name);
    for (const c of d.credits)
      filterNames.set(
        `${c.reference.provider}:performer:${c.reference.id}`,
        c.name,
      );
  }, [studioRef, tagBrowse, d, target.provider]);
  return (
    <>
      <header
        className="cat-hero"
        style={backdrop ? { backgroundImage: `url("${backdrop}")` } : undefined}
      >
        <div className="cat-hero-scrim" aria-hidden="true" />
        <div className="cat-hero-inner">
          <div className={posterClass}>
            <ItemImage
              name={d.title}
              src={imgSrc(d.imageUrl)}
              className="cat-poster-img"
            />
          </div>
          <div className="cat-hero-copy">
            <div className="cat-hero-meta">
              <span className="chip">
                {providerLabel(target.provider)} · {target.kind}
              </span>
              {/* Year filter on TPDB movie lists only; StashDB has
                  no year or date filter, so its dates stay plain text. */}
              {d.releaseDate &&
                (releaseYear ? (
                  <button
                    type="button"
                    className="chip"
                    title={`Show ${mediaView} from ${releaseYear}`}
                    onClick={() =>
                      onBrowse(mediaView, {
                        param: "year",
                        provider: target.provider,
                        id: releaseYear,
                      })
                    }
                  >
                    {d.releaseDate}
                  </button>
                ) : (
                  <span className="chip">{d.releaseDate}</span>
                ))}
              {/* Duration stays plain text: no provider offers a duration filter. */}
              {duration(d.durationSeconds) && (
                <span className="chip">{duration(d.durationSeconds)}</span>
              )}
            </div>
            {availability?.outcome === "available" && (
              <span className="cat-badge cat-badge-available">Available</span>
            )}
            {availability?.outcome === "denied" && (
              <span className="cat-badge">No playback access</span>
            )}
            <h1 className="cat-hero-title">
              {d.title}
              {d.releaseDate?.slice(0, 4) ? (
                <>
                  {" "}
                  <span className="cat-hero-year">
                    ({d.releaseDate.slice(0, 4)})
                  </span>
                </>
              ) : null}
            </h1>
            {d.studio && (
              <p className="cat-hero-sub">
                {studioRef ? (
                  <>
                    {/* The hero name opens the studio's own detail page;
                        the aside's Studio chip filters the list instead. */}
                    <button
                      type="button"
                      className="cat-hero-studio"
                      title="Open the studio page"
                      aria-label={`Open the studio page: ${d.studio?.name}`}
                      onClick={() => onNavigate(studioRef)}
                    >
                      {d.studio?.name}
                    </button>
                  </>
                ) : (
                  d.studio.name
                )}
              </p>
            )}
            {(payload.acquisition || availability?.outcome === "available") && (
              <div className="cat-hero-facts">
                {payload.acquisition && (
                  <span>{acquisitionText(payload.acquisition)}</span>
                )}
                {availability?.outcome === "available" && (
                  <FileFacts item={availability.item} />
                )}
              </div>
            )}
          </div>
          {mediaKind && (
            <div className="cat-hero-actions">
              <MediaActions
                target={{
                  provider: target.provider,
                  kind: mediaKind,
                  id: target.id,
                }}
                mine={payload.myRequest}
                availability={availability}
                onRefetch={onRefetch}
              />
            </div>
          )}
        </div>
      </header>

      <div className="cat-cols">
        <div>
          {(d.description || d.aliases.length > 0) && (
            <section
              className={mediaKind ? "cat-section" : undefined}
              aria-label="Overview"
            >
              <h2 className="cat-section-title">Overview</h2>
              {d.description && (
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {d.description}
                </p>
              )}
              {d.aliases.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Also known as: {d.aliases.join(", ")}
                </p>
              )}
            </section>
          )}

          {d.tags.length > 0 && (
            <section className="cat-section" aria-label="Tags">
              <h2 className="cat-section-title">Tags</h2>
              <div className="mt-2 flex flex-wrap gap-1">
                {d.tags.map((t) =>
                  // TPDB sometimes emits numeric-string tag ids that the
                  // filter layer rejects with 400 — those stay plain text.
                  tagBrowse && UUID_RE.test(t.id) ? (
                    <button
                      key={t.id}
                      type="button"
                      className="chip"
                      onClick={() =>
                        onBrowse(mediaView, {
                          param: "tags",
                          provider: target.provider,
                          id: t.id,
                        })
                      }
                    >
                      {t.name}
                    </button>
                  ) : (
                    <span key={t.id} className="chip">
                      {t.name}
                    </span>
                  ),
                )}
              </div>
            </section>
          )}

          {d.credits.length > 0 && (
            <section className="cat-section cat-cast" aria-label="Performers">
              <h2 className="cat-section-title">Cast</h2>
              <div className="cat-people mt-2">
                {d.credits.map((c) => (
                  <div
                    key={`${c.reference.provider}:${c.reference.id}`}
                    className="cat-person-cell"
                  >
                    <button
                      type="button"
                      className="cat-person"
                      onClick={() => onNavigate(c.reference)}
                    >
                      <ItemImage
                        name={c.name}
                        src={imgSrc(c.imageUrl)}
                        className="cat-person-img"
                      />
                      <span className="cat-person-name">{c.name}</span>
                    </button>
                    {/* Second entry point: the current surface filtered by
                        this performer, not their detail page. A TPDB scene
                        has no listing, so the chip only exists there. */}
                    {mediaKind && !tpdbScene && (
                      <button
                        type="button"
                        className="chip cat-person-filter"
                        onClick={() =>
                          onBrowse(mediaView, {
                            param: "performer",
                            provider: c.reference.provider,
                            id: c.reference.id,
                          })
                        }
                      >
                        Their {mediaView}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {target.kind === "movie" && target.provider === "tpdb" && (
                <p className="mt-2 text-xs text-muted">
                  On TPDB a performer filter opens their whole filmography — it
                  replaces other filters rather than combining with them.
                </p>
              )}
            </section>
          )}
        </div>

        <aside>
          {studioRef && !isStudio && !tpdbScene && (
            <section className="cat-section" aria-label="Studio">
              <h2 className="cat-section-title">Studio</h2>
              <button
                type="button"
                className="chip mt-2"
                title={`Filter ${mediaView} by this studio`}
                aria-label={`Filter ${mediaView} by ${d.studio?.name}`}
                onClick={() =>
                  onBrowse(mediaView, {
                    param: "studio",
                    provider: studioRef.provider,
                    id: studioRef.id,
                  })
                }
              >
                {d.studio?.name}
              </button>
            </section>
          )}

          {/* A studio detail had no way to browse its own titles. Child
              scope is offered only when the provider reported children —
              the count is StashDB-only and never defaulted to 0. */}
          {isStudio && (
            <section className="cat-section" aria-label="Studio titles">
              <h2 className="cat-section-title">Titles from this studio</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {target.provider === "tpdb" ? (
                  <button
                    type="button"
                    className="chip"
                    onClick={() =>
                      onBrowse("movies", {
                        param: "studio",
                        provider: target.provider,
                        id: target.id,
                      })
                    }
                  >
                    Movies from this studio
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="chip"
                      onClick={() =>
                        onBrowse("scenes", {
                          param: "studio",
                          provider: target.provider,
                          id: target.id,
                        })
                      }
                    >
                      Scenes from this studio only
                    </button>
                    {(d.childStudioCount ?? 0) > 0 && (
                      <button
                        type="button"
                        className="chip"
                        onClick={() =>
                          onBrowse("scenes", {
                            param: "studio",
                            provider: target.provider,
                            id: target.id,
                            studioMode: "withChildren",
                          })
                        }
                      >
                        Scenes including child studios ({d.childStudioCount})
                      </button>
                    )}
                  </>
                )}
              </div>
              {/* On a studio detail the studio field is the parent network;
                  browse its titles the same way when it carries a reference. */}
              {studioRef && (
                <div className="mt-3">
                  <p className="text-xs text-muted">
                    Parent studio: {d.studio?.name}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {target.provider === "tpdb" && (
                      <button
                        type="button"
                        className="chip"
                        onClick={() =>
                          onBrowse("movies", {
                            param: "studio",
                            provider: studioRef.provider,
                            id: studioRef.id,
                          })
                        }
                      >
                        Movies from {d.studio?.name}
                      </button>
                    )}
                    {target.provider === "stashdb" && (
                      <button
                        type="button"
                        className="chip"
                        onClick={() =>
                          onBrowse("scenes", {
                            param: "studio",
                            provider: studioRef.provider,
                            id: studioRef.id,
                          })
                        }
                      >
                        Scenes from {d.studio?.name}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="cat-section" aria-label="Cross-provider link">
            <h2 className="cat-section-title">Cross-provider link</h2>
            {linked ? (
              <button
                type="button"
                className="chip chip-accent mt-2"
                onClick={() => onNavigate(linked)}
              >
                Open the linked {providerLabel(linked.provider)} record
              </button>
            ) : (
              <p className="mt-2 text-xs text-muted">
                {"unlinkedReason" in payload.link
                  ? payload.link.unlinkedReason
                  : "No cross-provider link."}
              </p>
            )}
          </section>

          {(d.links.length > 0 || showSourceUrl) && (
            <section className="cat-section" aria-label="Links">
              <h2 className="cat-section-title">Links</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.links.map((l, i) => (
                  <a
                    key={i}
                    className="chip"
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {l.label ?? providerLabel(target.provider)}
                  </a>
                ))}
                {showSourceUrl && (
                  <a
                    className="chip"
                    href={showSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source · {providerLabel(target.provider)}
                  </a>
                )}
              </div>
            </section>
          )}

          {d.related.length > 0 && (
            <section className="cat-section" aria-label="Related">
              <h2 className="cat-section-title">
                {target.kind === "movie"
                  ? "Scenes in this movie (as supplied by the provider)"
                  : "Related"}
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.related.map((r, i) => (
                  <button
                    key={`${r.provider}:${r.kind}:${r.id}:${i}`}
                    type="button"
                    className="chip"
                    onClick={() => onNavigate(r)}
                  >
                    {providerLabel(r.provider)} · {r.kind} · {r.id.slice(0, 8)}…
                  </button>
                ))}
              </div>
            </section>
          )}

          {mediaKind && (
            <RemovalAction
              target={{
                provider: target.provider,
                kind: mediaKind,
                id: target.id,
              }}
            />
          )}
        </aside>
      </div>
    </>
  );
}

/** The open catalog detail: provider + kind + id URL params, rendered as a
 * full page inside app main — top search and sidebar stay usable. Returns
 * null when closed; mounted by every catalog view so any surface can open
 * it. The browse grid behind it stays mounted but hidden, so returning is
 * instant and never refetches. */
function CatalogDetail() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const target = detailTarget(params);
  const pageRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [reload, setReload] = useState(0);
  const provider = target?.provider;
  const kind = target?.kind;
  const id = target?.id;
  const refKey = provider && kind && id ? `${provider}:${kind}:${id}` : null;
  const detail = useApiGet<DetailPayload>(
    provider && kind && id
      ? `/api/catalog/${provider}/${kind}/${encodeURIComponent(id)}`
      : null,
    [provider, kind, id, reload],
  );
  // 404 catalog_not_found is authoritative absence, not an outage: it gets its
  // own panel and no retry, so it must not reach the error string.
  const notFound = detail.err?.status === 404;
  const error = notFound ? null : detail.error;
  // Blank while a read is in flight, so a new target never renders the
  // previous item's body under the new key.
  const payload = detail.loading ? null : detail.data;

  // Closing clears only the detail target. `provider` is also the browse
  // source, so clearing it silently switched a StashDB browse back to TPDB.
  const close = useCallback(() => setP({ kind: null, id: null }), [setP]);
  // Studio/tag/performer/year navigation leaves the page for a fresh
  // browse on the matching surface: same provider, provider-native id or
  // YYYY, the other provider's filter ids never carried across. Every
  // other filter resets — a detail entry point starts a clean browse, and
  // TPDB's performer filter (filmography route) rejects all of them.
  // Surface change → push.
  const browseTo = useCallback(
    (view: "movies" | "scenes", filter: BrowseFilter) => {
      const patch: Record<string, string | null> = {
        view,
        provider: filter.provider,
        q: null,
        year: null,
        date: null,
        date_operation: null,
        performer: null,
        studio: null,
        studioMode: null,
        tags: null,
        tagsAll: null,
        tagsExclude: null,
        sort: null,
        direction: null,
        page: null,
        tab: null,
        kind: null,
        id: null,
      };
      patch[filter.param] = filter.id;
      if (filter.studioMode) patch.studioMode = filter.studioMode;
      setP(patch, { push: true });
    },
    [setP],
  );

  // Escape closes; focus moves in on open and is restored on close.
  const open = refKey !== null;
  // Runs once per open/close — in-page navigation must not re-capture or
  // restore focus; only closing does.
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus.current?.focus();
    };
  }, [open, close]);
  // Moves focus to the page on open and whenever the target changes.
  useEffect(() => {
    if (open) pageRef.current?.focus();
  }, [open, refKey]);
  // Scroll: the position behind the detail is saved under the browse state
  // (URL minus provider/kind/id/tab) when it opens and restored when it
  // closes — Escape, Back to browse and Back all close it. Deliberate
  // filter changes never open the detail, so they never cause a jump.
  useEffect(() => {
    if (refKey === null) {
      if (wasOpen.current) {
        wasOpen.current = false;
        restoreScroll(browseKeyOf(params));
      }
      return;
    }
    if (!wasOpen.current) {
      wasOpen.current = true;
      saveScroll(browseKeyOf(params));
      window.scrollTo(0, 0);
    }
  });

  if (!target) return null;
  return (
    <div
      ref={pageRef}
      className="cat-detail"
      tabIndex={-1}
      aria-label={
        payload ? `${payload.detail.title} details` : "Catalog details"
      }
    >
      <div className="cat-topline">
        <button type="button" className="btn" onClick={close}>
          <Icon name="chevron-left" /> Back to browse
        </button>
      </div>
      {notFound ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">Not in the provider catalog</h3>
          <p className="mt-2 text-sm text-muted">
            {providerLabel(target.provider)} no longer has this record. It may
            have been removed at the source.
          </p>
        </div>
      ) : error ? (
        <ErrorPanel
          title="Catalog unavailable"
          message={error}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : !payload ? (
        <DetailSkeleton />
      ) : (
        <DetailBody
          key={refKey}
          payload={payload}
          target={target}
          onNavigate={(r) =>
            // Each kind's detail lives on its own surface; without the view
            // switch the reference changed but nothing rendered it.
            // Detail navigation is a surface change: Back walks the trail.
            setP(detailParams(r), { push: true })
          }
          onBrowse={browseTo}
          onRefetch={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}

/* ---------- Views ---------- */

export function MoviesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  const q = params.get("q") ?? "";
  const year = params.get("year") ?? "";
  const performer = params.get("performer") ?? "";
  const studio = params.get("studio") ?? "";
  const tags = params.get("tags") ?? "";
  const tagsAll = params.get("tagsAll") ?? "";
  // TPDB movie: a performer filter is the filmography route — it composes
  // with nothing. Stale combinations left in the URL (Back, old links) are
  // dropped here so they are never sent for a 400.
  const performerActive = performer !== "";
  const effQ = performerActive ? "" : q;
  const effYear = performerActive ? "" : year;
  const dateRaw = performerActive ? "" : (params.get("date") ?? "");
  const opRaw = performerActive ? "" : (params.get("date_operation") ?? "");
  // A complete pair only; an orphan half from an old URL never ships.
  const effDate = dateRaw !== "" && opRaw !== "" ? dateRaw : "";
  const effDateOp = effDate !== "" ? opRaw : "";
  const effStudio = performerActive ? "" : studio;
  // `tags` (any) wins when a stale URL holds both exclusive parameters.
  const effTags = performerActive ? "" : tags;
  const effTagsAll = performerActive || effTags !== "" ? "" : tagsAll;
  const tagList = [...new Set(effTags.split(",").filter(Boolean))];
  const tagAllList = [...new Set(effTagsAll.split(",").filter(Boolean))];
  const tagAllMode = tagAllList.length > 0;
  // A sort from another provider, or one no longer supported, in the URL is
  // ignored rather than sent upstream for an explicit 400.
  const sortParam = params.get("sort");
  const sortKey = sortsFor("tpdb", "movie").some((s) => s === sortParam)
    ? (sortParam as SortKey)
    : null;
  const effSortKey = performerActive ? null : sortKey;
  const dirRaw = params.get("direction");
  const direction = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : "";
  const effDirection = performerActive ? "" : direction;
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const notConfigured = providers?.tpdb === "not_configured";
  const target = detailTarget(params);
  const filterCount =
    (effQ ? 1 : 0) +
    (effYear ? 1 : 0) +
    (effDate ? 1 : 0) +
    (performer ? 1 : 0) +
    (effStudio ? 1 : 0) +
    tagList.length +
    tagAllList.length;
  const { data, error } = useCatalogSearch({
    provider: "tpdb",
    kind: "movie",
    q: effQ,
    year: effYear,
    performer,
    studio: effStudio,
    tags: effTags,
    tagsAll: effTagsAll,
    tagsExclude: "",
    date: effDate,
    dateOperation: effDateOp,
    sort: effSortKey ?? "",
    direction: effDirection,
    page,
    perPage,
    paged: true,
    enabled: !notConfigured,
    reload,
  });
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  // Year and the release-date pair are mutually exclusive in this UI:
  // setting one clears the other (the server rejects some combined forms).
  const onYear = useCallback(
    (v: string) =>
      setP({ year: v || null, date: null, date_operation: null, page: null }),
    [setP],
  );
  // Both halves commit together — one without the other is a 400.
  const onDate = useCallback(
    (d: string | null, op: string | null) =>
      setP({ date: d, date_operation: d ? op : null, year: null, page: null }),
    [setP],
  );
  // The filmography route: everything else must go, including sort.
  const onPerformerPick = useCallback(
    (id: string) =>
      setP({
        performer: id,
        q: null,
        year: null,
        date: null,
        date_operation: null,
        studio: null,
        tags: null,
        tagsAll: null,
        tagsExclude: null,
        sort: null,
        direction: null,
        page: null,
      }),
    [setP],
  );
  const onPerformerClear = useCallback(
    () => setP({ performer: null, page: null }),
    [setP],
  );
  const onSort = useCallback(
    (v: string) => setP({ sort: v || null, direction: null, page: null }),
    [setP],
  );
  const onDirection = useCallback(
    (v: "asc" | "desc") => setP({ direction: v, page: null }),
    [setP],
  );
  // Applying a studio clears the performer filter — TPDB rejects the pair.
  const onStudio = useCallback(
    (v: string) => setP({ studio: v || null, performer: null, page: null }),
    [setP],
  );
  const onTagMode = useCallback(
    (m: "any" | "all") => {
      const ids = (m === "all" ? tagList : tagAllList).join(",");
      setP(
        m === "all"
          ? { tagsAll: ids || null, tags: null, page: null }
          : { tags: ids || null, tagsAll: null, page: null },
      );
    },
    [setP, tagAllList, tagList],
  );
  const addTag = useCallback(
    (tg: { id: string; name: string }) => {
      const list = tagAllMode ? tagAllList : tagList;
      if (list.length >= TAG_CAP) return;
      const next = [...new Set([...list, tg.id])].join(",");
      setP(
        tagAllMode
          ? { tagsAll: next, tags: null, page: null }
          : { tags: next, tagsAll: null, page: null },
      );
    },
    [setP, tagAllList, tagAllMode, tagList],
  );
  const removeTag = useCallback(
    (id: string) => {
      const list = tagAllMode ? tagAllList : tagList;
      const next = list.filter((t) => t !== id).join(",") || null;
      setP(
        tagAllMode ? { tagsAll: next, page: null } : { tags: next, page: null },
      );
    },
    [setP, tagAllList, tagAllMode, tagList],
  );
  const clearFilters = useCallback(
    () =>
      setP({
        q: null,
        year: null,
        date: null,
        date_operation: null,
        performer: null,
        studio: null,
        tags: null,
        tagsAll: null,
        page: null,
      }),
    [setP],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  // An active studio id with no captured name is resolved once through its
  // detail endpoint; failure keeps the honest id label.
  const { data: studioDetail } = useApiGet<DetailPayload>(
    studio && !filterNames.has(`tpdb:studio:${studio}`)
      ? `/api/catalog/tpdb/studio/${encodeURIComponent(studio)}`
      : null,
    [studio],
  );
  // The payload names itself (its own reference), so a response raced by a
  // studio switch is never written under the wrong key nor mislabels a chip.
  const studioName =
    studio && studioDetail?.detail.reference.id === studio
      ? studioDetail.detail.title
      : null;
  useEffect(() => {
    if (studioName && studio)
      filterNames.set(`tpdb:studio:${studio}`, studioName);
  }, [studio, studioName]);
  // Every active filter, labelled; reused by the chip row and the drawer's
  // "From details" block.
  const chips: ReactNode[] = [];
  if (effQ)
    chips.push(
      <FilterChip key="q" label={`“${effQ}”`} onRemove={() => onQ("")} />,
    );
  if (effYear)
    chips.push(
      <FilterChip
        key="year"
        label={`Year ${effYear}`}
        onRemove={() => onYear("")}
      />,
    );
  if (effDate)
    chips.push(
      <FilterChip
        key="date"
        label={`Released ${dateOpLabel(effDateOp)} ${effDate}`}
        onRemove={() => onDate(null, null)}
      />,
    );
  if (performer)
    chips.push(
      <FilterChip
        key="performer"
        label={`Performer: ${filterName("tpdb", "performer", performer)}`}
        onRemove={onPerformerClear}
      />,
    );
  if (effStudio)
    chips.push(
      <FilterChip
        key="studio"
        label={`Studio: ${studioName ?? filterName("tpdb", "studio", studio)}`}
        onRemove={() => onStudio("")}
      />,
    );
  for (const id of tagList)
    chips.push(
      <FilterChip
        key={`tag-${id}`}
        label={`Tag: ${filterName("tpdb", "tag", id)}`}
        onRemove={() => removeTag(id)}
      />,
    );
  for (const id of tagAllList)
    chips.push(
      <FilterChip
        key={`tagall-${id}`}
        label={`Tag (all): ${filterName("tpdb", "tag", id)}`}
        onRemove={() => removeTag(id)}
      />,
    );
  return (
    <section aria-label="Movies">
      <div hidden={target !== null}>
        <div className="page-heading">
          <div>
            <h2 className="page-title">Movies</h2>
            <p className="page-description">
              Browsed from TPDB — StashDB has no movie records, so no source
              choice is offered here.
            </p>
          </div>
          <div className="page-toolbar">
            <SortSelect
              id="movie-sort"
              provider="tpdb"
              kind="movie"
              sort={effSortKey ?? ""}
              direction={effDirection}
              disabled={performerActive}
              onSort={onSort}
              onDirection={onDirection}
            />
            <FiltersButton
              count={filterCount}
              onClick={() => setFiltersOpen(true)}
            />
          </div>
        </div>
        {(filterCount > 0 || effSortKey) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Filters:</span>
            {chips}
            {effSortKey && (
              <FilterChip
                label={`Sort: ${SORT_LABELS[effSortKey]}${effDirection ? ` (${effDirection})` : ""}`}
                onRemove={() => onSort("")}
              />
            )}
          </div>
        )}
        <div className="mt-4">
          {notConfigured ? (
            <NotConfigured provider="tpdb" />
          ) : error ? (
            <ErrorPanel
              title="TPDB unavailable"
              message={error}
              onRetry={retry}
            />
          ) : !data ? (
            <GridSkeleton aspect="aspect-[2/3]" cols={POSTER_GRID} count={10} />
          ) : data.items.length === 0 ? (
            <div className="panel p-8 text-center text-sm text-muted">
              {tagList.length > 0 || tagAllList.length > 0
                ? "No movies match your filters. TPDB accepts a tag filter but has returned no rows for one on every attempt measured here — the filter is wired, the provider answers empty. StashDB scenes do filter by tag."
                : filterCount > 0
                  ? "No movies match your filters."
                  : "No movies found."}
            </div>
          ) : (
            <>
              <div className={POSTER_GRID}>
                {data.items.map((it) => (
                  <MovieCard key={it.reference.id} item={it} onOpen={open} />
                ))}
              </div>
              <Paging
                page={page}
                hasMore={data.hasMore}
                total={data.total}
                totalCountKnown={data.totalCountKnown}
                onPage={onPage}
              />
            </>
          )}
        </div>
      </div>
      <CatalogDetail />
      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        count={filterCount}
        onClear={clearFilters}
      >
        <SearchBox
          id="movie-q"
          label="Title"
          value={effQ}
          onCommit={onQ}
          disabled={performerActive}
        />
        <YearBox
          id="movie-year"
          value={effYear}
          onCommit={onYear}
          disabled={performerActive}
        />
        <DateCutoff
          id="movie-date"
          date={effDate}
          operation={effDateOp}
          disabled={performerActive}
          onCommit={onDate}
        />
        <PerformerPicker
          id="movie-performer"
          provider="tpdb"
          onPick={onPerformerPick}
        />
        {performerActive && (
          <p className="cat-note">
            TPDB serves a performer's whole filmography — it replaces the other
            filters, which are unavailable until it is removed.
          </p>
        )}
        <TagPicker
          id="movie-tags"
          provider="tpdb"
          label="Tags"
          selected={tagAllMode ? tagAllList : tagList}
          disabled={performerActive}
          onAdd={addTag}
        />
        {(tagList.length > 0 || tagAllList.length > 0) && (
          <TagModeSwitch mode={tagAllMode ? "all" : "any"} onMode={onTagMode} />
        )}
        {filterCount > 0 && (
          <div>
            <div className="label">From details</div>
            <div className="flex flex-wrap gap-2">{chips}</div>
          </div>
        )}
      </FilterDrawer>
    </section>
  );
}

export function ScenesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  // Scenes are StashDB-only. The URL's provider param is ignored — a
  // stale ?provider=tpdb bookmark renders StashDB scenes, never a 400.
  const provider: CatalogProvider = "stashdb";
  const q = params.get("q") ?? "";
  const performer = params.get("performer") ?? "";
  const studio = params.get("studio") ?? "";
  // studioMode is real only for a scene browse with a studio filter
  // active; every other combination is ignored here so a stale URL
  // value can never trigger the server's 400.
  const studioMode =
    studio !== "" && params.get("studioMode") === "withChildren"
      ? "withChildren"
      : "";
  // tagsExclude is StashDB-scene-only; a stale tagsAll never leaves here.
  const tags = params.get("tags") ?? "";
  const tagsExclude = params.get("tagsExclude") ?? "";
  // Within StashDB's single tag criterion, the include list wins when a
  // stale URL holds both.
  const effTagsExclude = tags === "" ? tagsExclude : "";
  const tagList = [...new Set(tags.split(",").filter(Boolean))];
  const excludeList = [...new Set(effTagsExclude.split(",").filter(Boolean))];
  // A sort no longer supported is ignored rather than sent upstream for
  // an explicit 400.
  const sortParam = params.get("sort");
  const sorts = sortsFor(provider, "scene");
  const sortKey = sorts.some((s) => s === sortParam)
    ? (sortParam as SortKey)
    : null;
  const dirRaw = params.get("direction");
  const direction = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : "";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const notConfigured = providers?.[provider] === "not_configured";
  const target = detailTarget(params);
  const filterCount =
    (q ? 1 : 0) +
    (performer ? 1 : 0) +
    (studio ? 1 : 0) +
    tagList.length +
    excludeList.length;
  const { data, error } = useCatalogSearch({
    provider,
    kind: "scene",
    q,
    year: "",
    performer,
    studio,
    studioMode,
    tags,
    tagsAll: "",
    tagsExclude: effTagsExclude,
    date: "",
    dateOperation: "",
    sort: sortKey ?? "",
    direction,
    page,
    perPage,
    paged: true,
    enabled: !notConfigured,
    reload,
  });
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  // StashDB composes a performer with everything else.
  const onPerformerPick = useCallback(
    (id: string) => setP({ performer: id, page: null }),
    [setP],
  );
  const onPerformerClear = useCallback(
    () => setP({ performer: null, page: null }),
    [setP],
  );
  const onSort = useCallback(
    (v: string) => setP({ sort: v || null, direction: null, page: null }),
    [setP],
  );
  const onDirection = useCallback(
    (v: "asc" | "desc") => setP({ direction: v, page: null }),
    [setP],
  );
  const onStudio = useCallback(
    (v: string) =>
      setP({
        studio: v || null,
        studioMode: null,
        performer: performer || null,
        page: null,
      }),
    [performer, setP],
  );
  const onStudioMode = useCallback(
    (v: string) =>
      setP({
        studioMode: v === "withChildren" ? "withChildren" : null,
        page: null,
      }),
    [setP],
  );
  // StashDB allows one tag criterion per search: adding to either list
  // clears the other. The picker's cap keeps each list at 25 ids.
  const addTag = useCallback(
    (tg: { id: string; name: string }) => {
      if (tagList.length >= TAG_CAP) return;
      setP({
        tags: [...new Set([...tagList, tg.id])].join(","),
        tagsExclude: null,
        page: null,
      });
    },
    [setP, tagList],
  );
  const addExcludeTag = useCallback(
    (tg: { id: string; name: string }) => {
      if (excludeList.length >= TAG_CAP) return;
      setP({
        tagsExclude: [...new Set([...excludeList, tg.id])].join(","),
        tags: null,
        page: null,
      });
    },
    [excludeList, setP],
  );
  const removeTag = useCallback(
    (id: string) =>
      setP({
        tags: tagList.filter((t) => t !== id).join(",") || null,
        page: null,
      }),
    [setP, tagList],
  );
  const removeExcludeTag = useCallback(
    (id: string) =>
      setP({
        tagsExclude: excludeList.filter((t) => t !== id).join(",") || null,
        page: null,
      }),
    [excludeList, setP],
  );
  const clearFilters = useCallback(
    () =>
      setP({
        q: null,
        performer: null,
        studio: null,
        studioMode: null,
        tags: null,
        tagsExclude: null,
        page: null,
      }),
    [setP],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  // An active studio id with no captured name is resolved once through its
  // detail endpoint (same pattern as the parent-studio hint below);
  // failure keeps the honest id label.
  const { data: studioDetail } = useApiGet<DetailPayload>(
    studio && !filterNames.has(`${provider}:studio:${studio}`)
      ? `/api/catalog/${provider}/studio/${encodeURIComponent(studio)}`
      : null,
    [provider, studio],
  );
  // The payload names itself (its own reference), so a response raced by a
  // studio switch is never written under the wrong key nor mislabels a chip.
  const studioName =
    studio && studioDetail?.detail.reference.id === studio
      ? studioDetail.detail.title
      : null;
  useEffect(() => {
    if (studioName && studio)
      filterNames.set(`${provider}:studio:${studio}`, studioName);
  }, [provider, studio, studioName]);
  // A StashDB studio browse that returns zero items may mean the studio is
  // a parent label whose scenes live under its child studios. The studio's
  // own detail is fetched only in exactly that case, to tell "parent
  // label" from a genuinely empty result; a failed fetch keeps the wording
  // honest without asserting a number.
  const emptyStashStudio =
    studio !== "" && data !== null && data.items.length === 0;
  const { data: studioInfoDetail, error: studioInfoError } =
    useApiGet<DetailPayload>(
      emptyStashStudio
        ? `/api/catalog/stashdb/studio/${encodeURIComponent(studio)}`
        : null,
      [emptyStashStudio, studio, data],
    );
  // The payload names itself (its own reference), so a response raced by a
  // studio or result change never reports the wrong label.
  const studioInfo:
    { title: string; childStudioCount?: number } | "failed" | null =
    studioInfoError !== null
      ? "failed"
      : emptyStashStudio && studioInfoDetail?.detail.reference.id === studio
        ? {
            title: studioInfoDetail.detail.title,
            childStudioCount: studioInfoDetail.detail.childStudioCount,
          }
        : null;
  const parentEmpty = emptyStashStudio
    ? studioInfo === null || studioInfo === "failed"
      ? { kind: "maybe" as const }
      : typeof studioInfo.childStudioCount === "number" &&
          studioInfo.childStudioCount > 0
        ? {
            kind: "count" as const,
            count: studioInfo.childStudioCount,
            title: studioInfo.title,
          }
        : null
    : null;
  // Every active filter, labelled; reused by the chip row and the drawer's
  // "From details" block.
  const chips: ReactNode[] = [];
  if (q)
    chips.push(
      <FilterChip key="q" label={`“${q}”`} onRemove={() => onQ("")} />,
    );
  if (performer)
    chips.push(
      <FilterChip
        key="performer"
        label={`Performer: ${filterName(provider, "performer", performer)}`}
        onRemove={onPerformerClear}
      />,
    );
  if (studio)
    chips.push(
      <FilterChip
        key="studio"
        label={`Studio: ${studioName ?? filterName(provider, "studio", studio)}`}
        onRemove={() => onStudio("")}
      />,
    );
  if (studioMode === "withChildren")
    chips.push(
      <FilterChip
        key="studioMode"
        label="Scope: include child studios"
        onRemove={() => onStudioMode("")}
      />,
    );
  for (const id of tagList)
    chips.push(
      <FilterChip
        key={`tag-${id}`}
        label={`Tag: ${filterName(provider, "tag", id)}`}
        onRemove={() => removeTag(id)}
      />,
    );
  for (const id of excludeList)
    chips.push(
      <FilterChip
        key={`tagx-${id}`}
        label={`Excluded tag: ${filterName(provider, "tag", id)}`}
        onRemove={() => removeExcludeTag(id)}
      />,
    );
  return (
    <section aria-label="Scenes">
      <div hidden={target !== null}>
        <div className="page-heading">
          <div>
            <h2 className="page-title">Scenes</h2>
          </div>
          <div className="page-toolbar">
            <SortSelect
              id="scene-sort"
              provider={provider}
              kind="scene"
              sort={sortKey ?? ""}
              direction={direction}
              onSort={onSort}
              onDirection={onDirection}
            />
            <FiltersButton
              count={filterCount}
              onClick={() => setFiltersOpen(true)}
            />
          </div>
        </div>
        {(filterCount > 0 || sortKey) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Filters:</span>
            {chips}
            {sortKey && (
              <FilterChip
                label={`Sort: ${SORT_LABELS[sortKey]}${direction ? ` (${direction})` : ""}`}
                onRemove={() => onSort("")}
              />
            )}
          </div>
        )}
        <div className="mt-4">
          {notConfigured ? (
            <NotConfigured provider={provider} />
          ) : error ? (
            <ErrorPanel
              title={`${providerLabel(provider)} unavailable`}
              message={error}
              onRetry={retry}
            />
          ) : !data ? (
            <GridSkeleton aspect="aspect-[2/3]" cols={POSTER_GRID} count={6} />
          ) : data.items.length === 0 ? (
            parentEmpty ? (
              <div className="panel p-8 text-center text-sm text-muted">
                <p>
                  {parentEmpty.kind === "count"
                    ? `No ${providerLabel(provider)} scenes match your filters. ${parentEmpty.title} is a parent label — its scenes are catalogued under its ${parentEmpty.count} child studios.`
                    : `No ${providerLabel(provider)} scenes match your filters. If ${filterName("stashdb", "studio", studio)} is a parent label, its scenes are catalogued under its child studios.`}
                </p>
                <button
                  type="button"
                  className="btn mt-3"
                  onClick={() => onStudioMode("withChildren")}
                >
                  Include child studios
                </button>
              </div>
            ) : (
              <div className="panel p-8 text-center text-sm text-muted">
                {filterCount > 0
                  ? `No ${providerLabel(provider)} scenes match your filters.`
                  : `No ${providerLabel(provider)} scenes found.`}
              </div>
            )
          ) : (
            <>
              <div className={POSTER_GRID}>
                {data.items.map((it) => (
                  <SceneCard key={it.reference.id} item={it} onOpen={open} />
                ))}
              </div>
              <Paging
                page={page}
                hasMore={data.hasMore}
                total={data.total}
                totalCountKnown={data.totalCountKnown}
                onPage={onPage}
              />
            </>
          )}
        </div>
      </div>
      <CatalogDetail />
      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        count={filterCount}
        onClear={clearFilters}
      >
        <SearchBox id="scene-q" label="Title" value={q} onCommit={onQ} />
        <PerformerPicker
          id="scene-performer"
          provider={provider}
          onPick={onPerformerPick}
        />
        <TagPicker
          id="scene-tags"
          provider="stashdb"
          label="Include tags"
          selected={tagList}
          onAdd={addTag}
          note={
            excludeList.length > 0
              ? "Adding an included tag clears the excluded list — StashDB allows only one tag criterion per search."
              : undefined
          }
        />
        <TagPicker
          id="scene-tags-exclude"
          provider="stashdb"
          label="Exclude tags"
          selected={excludeList}
          onAdd={addExcludeTag}
          note={
            tagList.length > 0
              ? "Adding an excluded tag clears the included list — StashDB allows only one tag criterion per search."
              : undefined
          }
        />
        {studio && (
          <div>
            <label className="label" htmlFor="scene-studio-scope">
              Studio scope
            </label>
            <select
              id="scene-studio-scope"
              className="input"
              value={studioMode}
              onChange={(e) => onStudioMode(e.target.value)}
            >
              <option value="">This studio only</option>
              <option value="withChildren">Include child studios</option>
            </select>
          </div>
        )}
        {filterCount > 0 && (
          <div>
            <div className="label">From details</div>
            <div className="flex flex-wrap gap-2">{chips}</div>
          </div>
        )}
      </FilterDrawer>
    </section>
  );
}
