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
  CatalogTagSelection,
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

/** Names for studio/tag filter ids, captured from details or discovery at
 * navigation time — URLs carry provider-native ids, chips still get labels. */
export const filterNames = new Map<string, string>();

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

/** Count text only when the service attests a real total; a capped total
 * (totalCountKnown false) renders paging alone and never a fake denominator.
 * Arrows reuse the discovery chevron buttons: same disabled, focus and
 * 44px-touch states as the rails. */
function Paging({
  page,
  hasMore,
  total,
  totalCountKnown,
  perPage,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  perPage: number;
  onPage: (p: number) => void;
}) {
  const go = (p: number) => {
    onPage(p);
    window.scrollTo({ top: 0 });
  };
  const pages =
    totalCountKnown && total != null
      ? Math.max(1, Math.ceil(total / perPage))
      : null;
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <div className="text-sm text-muted">
        {totalCountKnown && total != null ? `${total} results · ` : ""}Page{" "}
        {page}
        {pages !== null ? ` of ${pages}` : ""}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="discovery-scroll-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          <Icon name="chevron-left" />
        </button>
        <button
          type="button"
          className="discovery-scroll-button"
          aria-label="Next page"
          disabled={!hasMore}
          onClick={() => go(page + 1)}
        >
          <Icon name="chevron-right" />
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

/* ---------- Unified browse ---------- */

/** One browse page from GET /api/browse. Wire shape mirrors the service's
 * BrowsePage plus the API's per-caller hiddenTagCount; kept local like the
 * old CatalogSearchPage — contracts.ts stays domain records. */
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

/** Builds the GET /api/browse path from canonical URL keys — verbatim plan
 * names, include/exclude as JSON, `date_operation` for dateOperation. An
 * outage is an error, never an empty page. */
function browsePath(f: {
  type: "all" | "movie" | "scene";
  q: string;
  include: CatalogTagSelection[];
  exclude: CatalogTagSelection[];
  studioTpdb: string;
  studioStashdb: string;
  performerTpdb: string;
  performerStashdb: string;
  studioMode: string;
  year: string;
  date: string;
  dateOperation: string;
  sort: string;
  direction: string;
  page: number;
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
  qs.set("page", String(f.page));
  qs.set("perPage", String(f.perPage));
  return `/api/browse?${qs.toString()}`;
}

/* ---------- Detail page ---------- */

/** Reads the open detail target (provider + kind + id) from URL params;
 * exported so other catalog surfaces can detect an open detail without
 * re-parsing the contract. */
export function detailTarget(params: URLSearchParams): DetailTarget | null {
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

/** A provider-legal filter entry point handed from a detail page into the
 * unified browse constraints. `param` is a canonical /api/browse key;
 * `id` is the provider-native id, or the YYYY string for `year`; `tag`
 * rides only for `include`; `studioMode` only for StashDB studios. */
type BrowseFilter = {
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
  onBrowse: (filter: BrowseFilter) => void;
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
  // Tag chips become include constraints on media details — the unified
  // browse takes provider-scoped tags on every kind. Performer and studio
  // details keep their tags as plain text rather than dead controls.
  const tagBrowse = mediaKind !== null;
  const isStudio = target.kind === "studio";
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
                    title={`Show TPDB movies from ${releaseYear}`}
                    onClick={() =>
                      onBrowse({
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
                        onBrowse({
                          param: "include",
                          provider: target.provider,
                          id: t.id,
                          tag:
                            target.provider === "tpdb"
                              ? { name: t.name, tpdb: t.id }
                              : { name: t.name, stashdb: t.id },
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
                    {/* Second entry point: the unified browse filtered by
                        this performer, not their detail page. The provider
                        decides which source qualifies. */}
                    {mediaKind && (
                      <button
                        type="button"
                        className="chip cat-person-filter"
                        onClick={() =>
                          onBrowse({
                            param:
                              c.reference.provider === "tpdb"
                                ? "performerTpdb"
                                : "performerStashdb",
                            provider: c.reference.provider,
                            id: c.reference.id,
                          })
                        }
                      >
                        Their{" "}
                        {c.reference.provider === "tpdb" ? "movies" : "scenes"}
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
          {studioRef && !isStudio && (
            <section className="cat-section" aria-label="Studio">
              <h2 className="cat-section-title">Studio</h2>
              <button
                type="button"
                className="chip mt-2"
                title={`Filter ${
                  studioRef.provider === "tpdb" ? "movies" : "scenes"
                } by this studio`}
                aria-label={`Filter ${
                  studioRef.provider === "tpdb" ? "movies" : "scenes"
                } by ${d.studio?.name}`}
                onClick={() =>
                  onBrowse({
                    param:
                      studioRef.provider === "tpdb"
                        ? "studioTpdb"
                        : "studioStashdb",
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
                      onBrowse({
                        param: "studioTpdb",
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
                        onBrowse({
                          param: "studioStashdb",
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
                          onBrowse({
                            param: "studioStashdb",
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
                          onBrowse({
                            param: "studioTpdb",
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
                          onBrowse({
                            param: "studioStashdb",
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

      {/* Fetched separately from the detail payload, so the related reads
          never delay playback, request or removal actions above. */}
      {mediaKind && (
        <RelatedTitles
          target={{ provider: target.provider, kind: mediaKind, id: target.id }}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

/** Separately fetched similar titles for a movie/scene: real shared-tag
 * candidates from the providers, ranked deterministically; the optional Jev
 * pass only reranks those same candidates — it can never add titles. The
 * provider-supplied related references in the aside stay a distinct block. */
function RelatedTitles({
  target,
  onNavigate,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
  onNavigate: (r: CatalogReference) => void;
}) {
  const [rank, setRank] = useState<"tags" | "jev">("tags");
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useApiGet<{
    items: CatalogDetail[];
    ranking: "tags" | "jev";
    canRank: boolean;
    errors: { provider: CatalogProvider; code: string; message: string }[];
  }>(
    `/api/catalog/${target.provider}/${target.kind}/${encodeURIComponent(target.id)}/related?rank=${rank}`,
    [target.provider, target.kind, target.id, rank, reload],
  );
  return (
    <section className="cat-section" aria-label="Similar titles">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="cat-section-title">Similar titles</h2>
        {data?.canRank === true && rank === "tags" && (
          <button type="button" className="btn" onClick={() => setRank("jev")}>
            Refine with Jev
          </button>
        )}
      </div>
      <p className="cat-note">
        {data?.ranking === "jev"
          ? "Jev reranked the same provider candidates by metadata similarity — it never adds titles."
          : "Matched by shared provider tags; a title with no tags has no candidates."}
      </p>
      {error !== null ? (
        <p className="cat-note" role="alert">
          Similar titles failed: {error}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : loading ? (
        <p className="cat-note" aria-live="polite">
          Loading similar titles…
        </p>
      ) : data === null ? null : data.errors.length > 0 ? (
        <p className="cat-note" role="alert">
          {data.errors
            .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
            .join(" · ")}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : data.items.length === 0 ? (
        <p className="cat-note">No shared tags — nothing similar yet.</p>
      ) : (
        <div className="poster-grid mt-3">
          {data.items.map((it) =>
            it.reference.kind === "scene" ? (
              <SceneCard
                key={`${it.reference.provider}:${it.reference.id}`}
                item={it}
                onOpen={onNavigate}
              />
            ) : (
              <MovieCard
                key={`${it.reference.provider}:${it.reference.id}`}
                item={it}
                onOpen={onNavigate}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** The open catalog detail: provider + kind + id URL params, rendered as a
 * full page inside app main — top search and sidebar stay usable. Returns
 * null when closed; mounted by the unified titles view so any surface can
 * open it. The browse grid behind it stays mounted but hidden, so returning
 * is instant and never refetches. Exported for the app shell's mounting. */
export function CatalogDetailView() {
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
  // Detail filter entry points create canonical unified browse constraints:
  // type and the one constraint follow the filter's provider (year is
  // TPDB-movie-only), every other constraint resets — a detail entry point
  // starts a clean browse — and the old tags any/all modes are gone.
  // Constraint change → push.
  const browseTo = useCallback(
    (filter: BrowseFilter) => {
      const patch: Record<string, string | null> = {
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
        studioTpdb: null,
        studioStashdb: null,
        studioMode: null,
        sort: null,
        direction: null,
        page: null,
        kind: null,
        id: null,
      };
      if (filter.param === "include") {
        patch.include = JSON.stringify([filter.tag]);
      } else {
        patch[filter.param] = filter.id;
        if (filter.studioMode) patch.studioMode = filter.studioMode;
      }
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
            // Detail navigation is in-page over the unified view, and a
            // surface change: it pushes, so Back walks the trail.
            setP(detailParams(r), { push: true })
          }
          onBrowse={browseTo}
          onRefetch={() => setReload((n) => n + 1)}
        />
      )}
    </div>
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
  const page = Math.max(1, intOr(params.get("page"), 1));
  const [perPage, setPerPage] = useState(() =>
    Math.min(100, Math.max(1, intOr(params.get("perPage"), 24))),
  );
  const [reload, setReload] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
      setP({ perPage: String(rounded), page: null });
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

  const path = useMemo(
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
        studioMode,
        year,
        date,
        dateOperation,
        sort,
        direction,
        page,
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
      studioMode,
      year,
      date,
      dateOperation,
      sort,
      direction,
      page,
      perPage,
    ],
  );
  const browse = useApiGet<BrowsePage>(path, [path, reload]);
  // While a read is in flight nothing stale renders as current — a filter
  // change can never show the previous query's rows under it.
  const data = browse.loading ? null : browse.data;
  const hiddenCount = data?.hiddenTagCount ?? 0;

  const openDetail = useCallback(
    (r: CatalogReference) => setP(detailParams(r), { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );

  const onType = useCallback(
    (t: "all" | "movie" | "scene") => {
      // Sorts are per-type: one the new type does not support is dropped.
      const keepSort = (sortsFor(t) as readonly string[]).includes(sortRaw);
      setP({
        type: t === "all" ? null : t,
        page: null,
        sort: keepSort ? sortRaw : null,
        direction: keepSort ? dirRaw : null,
      });
    },
    [setP, sortRaw, dirRaw],
  );
  const onQ = useCallback(
    (v: string) => setP({ q: v || null, page: null }),
    [setP],
  );
  const onInclude = useCallback(
    (tags: CatalogTagSelection[]) =>
      setP({
        include: tags.length > 0 ? JSON.stringify(tags) : null,
        page: null,
      }),
    [setP],
  );
  const onExclude = useCallback(
    (tags: CatalogTagSelection[]) =>
      setP({
        exclude: tags.length > 0 ? JSON.stringify(tags) : null,
        page: null,
      }),
    [setP],
  );
  // TPDB's performer filter is the filmography route: everything else goes,
  // including sort (the route rejects all of it).
  const onPerformerTpdb = useCallback(
    (id: string) =>
      setP({
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
        page: null,
      }),
    [setP],
  );
  // StashDB composes a performer with everything else — only the page resets.
  const onPerformerStashdb = useCallback(
    (id: string) => setP({ performerStashdb: id, page: null }),
    [setP],
  );
  const onYear = useCallback(
    (v: string) =>
      setP({ year: v || null, date: null, date_operation: null, page: null }),
    [setP],
  );
  // Both halves commit together — one without the other is a 400.
  const onDate = useCallback(
    (d: string | null, op: string | null) =>
      setP({ date: d, date_operation: op, year: null, page: null }),
    [setP],
  );
  const onSort = useCallback(
    (v: string) =>
      setP({
        sort: v || null,
        direction: v ? direction || "desc" : null,
        page: null,
      }),
    [setP, direction],
  );
  const onDirection = useCallback(
    (d: "asc" | "desc") => setP({ direction: d, page: null }),
    [setP],
  );
  const onStudioTpdb = useCallback(
    (id: string | null) => setP({ studioTpdb: id, page: null }),
    [setP],
  );
  const onStudioStashdb = useCallback(
    (id: string | null) => setP({ studioStashdb: id, page: null }),
    [setP],
  );
  const onStudioMode = useCallback(
    (m: string) =>
      setP({ studioMode: m === "withChildren" ? m : null, page: null }),
    [setP],
  );
  const clearFilters = useCallback(() => {
    setP({
      q: null,
      include: null,
      exclude: null,
      year: null,
      date: null,
      date_operation: null,
      performerTpdb: null,
      performerStashdb: null,
      studioTpdb: null,
      studioStashdb: null,
      studioMode: null,
      sort: null,
      direction: null,
      page: null,
    });
  }, [setP]);

  // An active studio/tag id without a captured name stays an id — never a
  // fake label (see filterName).
  const filterCount =
    (q ? 1 : 0) +
    (year ? 1 : 0) +
    (date ? 1 : 0) +
    (performerTpdb ? 1 : 0) +
    (performerStashdb ? 1 : 0) +
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
        onRemove={() => setP({ performerTpdb: null, page: null })}
      />,
    );
  }
  if (performerStashdb) {
    chips.push(
      <FilterChip
        key="performerStashdb"
        label={`Performer: ${filterName("stashdb", "performer", performerStashdb)} (StashDB)`}
        onRemove={() => setP({ performerStashdb: null, page: null })}
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
        onRemove={() => setP({ sort: null, direction: null, page: null })}
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
          ) : browse.error !== null ? (
            // An outage is an error, never an empty page.
            <ErrorPanel
              title="Browse unavailable"
              message={browse.error}
              onRetry={retry}
            />
          ) : data === null ? (
            <GridSkeleton
              aspect="aspect-[2/3]"
              cols={POSTER_GRID}
              count={perPage}
            />
          ) : (
            <>
              {data.errors.map((e) => (
                <ErrorPanel
                  key={e.provider}
                  title={`${providerLabel(e.provider)} unavailable`}
                  message={e.message}
                  onRetry={retry}
                />
              ))}
              {data.items.length === 0 ? (
                // Empty is only claimed when no source failed: the error
                // panels above carry the failures.
                data.errors.length === 0 && (
                  <div className="panel p-8 text-center text-sm text-muted">
                    {filterCount > 0
                      ? "No titles match your filters. Remove a filter, or check excluded and personal hidden tags."
                      : "Nothing here yet."}
                  </div>
                )
              ) : (
                <>
                  <div className={POSTER_GRID}>
                    {data.items.map((it) =>
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
                  <Paging
                    page={page}
                    hasMore={data.hasMore}
                    total={data.total}
                    totalCountKnown={data.totalCountKnown}
                    perPage={perPage}
                    onPage={onPage}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>

      <CatalogDetailView />

      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        count={filterCount}
        onClear={clearFilters}
      >
        <SortSelect
          id="titles-sort"
          type={type}
          sort={sort}
          direction={direction}
          disabled={performerTpdb !== ""}
          onSort={onSort}
          onDirection={onDirection}
        />
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
          description="Titles carrying any of these tags are left out — exclusions win over includes, and a tag also covers the ones that contain it as a word (Anal drops Anal Creampie, never Analingus)."
        />
        <div>
          <PerformerPicker
            id="titles-performer-tpdb"
            provider="tpdb"
            onPick={onPerformerTpdb}
          />
          <p className="cat-note">
            TPDB serves a performer&apos;s whole filmography — it replaces the
            other filters, which are unavailable until it is removed.
          </p>
        </div>
        <PerformerPicker
          id="titles-performer-stashdb"
          provider="stashdb"
          onPick={onPerformerStashdb}
        />
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
