"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  api,
  EnlargeableImage,
  ErrorPanel,
  GridSkeleton,
  detailParams,
  Icon,
  imgSrc,
  ItemImage,
  messageOf,
  MovieCard,
  PerformerCard,
  providerLabel,
  SceneCard,
  spaClick,
  useApiGet,
  useGridColumns,
  wholeRows,
  useParamsSetter,
  useSession,
} from "./shared";
import type {
  CatalogDetail,
  CatalogDetailResponse,
  CatalogPerson,
  CatalogProvider,
  CatalogReference,
  PerformerFollow,
  FollowResponse,
} from "../lib/contracts";
import {
  isBrowseableTagSelection,
  mergeTagCounts,
  performerTagJump,
} from "../lib/contracts";
import { useBrowseTo } from "./catalog";
import { browseFilterHref, type BrowseFilter } from "../lib/browse-url";
import { NotConfiguredLine, RailSkeleton } from "./discover";
import { seedName } from "../lib/names";
import { ageOn, formatCareerRange } from "../lib/person";
import { linkLabel } from "../lib/links";
import { mergePerformerDetails } from "../lib/performer-merge";

import { REQUESTS_CHANGED } from "../lib/approvals";
import "./views.css";

// Displayed totals: locale digit grouping, one format on every count.
const NUM_FMT = new Intl.NumberFormat();

/* ---------- Local shapes ---------- */

type SearchPage = {
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
};

/* ---------- Small helpers (same conventions as catalog.tsx) ---------- */

/** Opening another record leaves this page for that record's own surface;
 * the per-kind page keys are dropped because page 3 of one performer's
 * movies is meaningless on the next. */
function openParams(r: CatalogReference) {
  return { ...detailParams(r), moviePage: null, scenePage: null };
}

/* ---------- Fetch hooks: a live flag makes stale in-flight responses inert ---------- */

/** The view tells three failures apart — provider not configured, a 404 that
 * means "gone at the source", and an outage that deserves a retry — so this
 * read needs the ApiError, not just its message. */
function usePerformerDetail(
  provider: CatalogProvider,
  id: string,
  enabled: boolean,
  reload: number,
): {
  payload: CatalogDetailResponse | null;
  err: ApiError | null;
  loading: boolean;
} {
  const { data, error, err, loading } = useApiGet<CatalogDetailResponse>(
    enabled
      ? `/api/catalog/${provider}/performer/${encodeURIComponent(id)}`
      : null,
    [provider, id, reload],
  );
  return {
    payload: data,
    // A non-ApiError failure still has to reach the retry panel, not fall
    // through to a skeleton that never resolves.
    err: err ?? (error === null ? null : new ApiError(0, "network", error)),
    loading,
  };
}

/* ---------- Cards: the established treatments ---------- */

/* ---------- Panels, skeleton, paging ---------- */

function HeaderSkeleton() {
  return (
    <div
      className="performer-hero relative flex flex-col gap-5 p-5 sm:flex-row sm:p-6"
      aria-label="Loading performer"
      aria-busy="true"
    >
      <div className="skel aspect-[2/3] w-40 shrink-0 self-center sm:w-48 sm:self-start" />
      <div className="min-w-0 flex-1 space-y-3 pt-1">
        <div className="skel h-7 w-1/2" />
        <div className="skel h-4 w-1/4" />
        <div className="skel h-4 w-full" />
        <div className="skel h-4 w-2/3" />
      </div>
    </div>
  );
}

/* ---------- One listing: one kind from the provider that has it ---------- */

/** One kind from one provider, appended a page at a time. A page is always
 * whole grid rows (nine columns load 27, never 24 with three holes), and
 * "Show more" appends the next page in place. Not infinite scroll: the
 * scenes listing sits below the movies, and an endless movie grid would
 * make it unreachable. */
function Listing({
  provider,
  kind,
  performerId,
  performerName,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  /** Undefined until her detail lands: the listing loads in parallel. */
  performerName?: string;
}) {
  const setP = useParamsSetter();
  const [probeRef, cols] = useGridColumns();
  // The page size is set once from the first column count: a later change
  // (sidebar collapse, resize) must not refetch and blank the grid; the
  // display trims to whole rows instead.
  const [perPage, setPerPage] = useState(0);
  useEffect(() => {
    if (perPage === 0 && cols > 0)
      setPerPage(Math.min(100, cols * Math.ceil(24 / cols)));
  }, [cols, perPage]);
  const [acc, setAcc] = useState<SearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const load = useCallback(
    async (page: number) => {
      const seq = ++seqRef.current;
      if (page === 1) setAcc(null);
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({
        provider,
        kind,
        performer: performerId,
        page: String(page),
        perPage: String(perPage),
      });
      try {
        const next = await api<SearchPage>(`/api/catalog/search?${qs}`);
        if (seqRef.current !== seq) return;
        setAcc((prev) => {
          if (page === 1 || prev === null) return next;
          const seen = new Set(prev.items.map((it) => it.reference.id));
          const items = [
            ...prev.items,
            ...next.items.filter((it) => !seen.has(it.reference.id)),
          ];
          // A page that adds nothing cannot progress: stop offering more.
          const hasMore =
            items.length > prev.items.length ? next.hasMore : false;
          return { ...next, items, hasMore };
        });
      } catch (e) {
        // An outage is an error with retry, never an empty page.
        if (seqRef.current === seq) setError(messageOf(e));
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    },
    [provider, kind, performerId, perPage],
  );
  // A new performer restarts at page 1.
  useEffect(() => {
    if (perPage > 0) void load(1);
  }, [load, perPage]);
  // Same as the performer page: a detail is another surface, so it pushes.
  const open = useCallback(
    (r: CatalogReference) => setP(openParams(r), { push: true }),
    [setP],
  );
  const kindLabel = kind === "movie" ? "movies" : "scenes";
  const total =
    acc?.totalCountKnown && acc.total != null ? acc.total : undefined;
  const shown = acc ? wholeRows(acc.items, cols, acc.hasMore) : [];
  return (
    <div>
      {/* Invisible zero-height probe: its auto-fill tracks are the real
          grid's, so the first page is sized in whole rows. */}
      <div
        ref={probeRef}
        className="poster-grid"
        aria-hidden="true"
        style={{ height: 0, overflow: "hidden", visibility: "hidden" }}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="discovery-shelf-title">
            {performerName
              ? `${performerName}’s ${kindLabel}`
              : kindLabel === "movies"
                ? "Movies"
                : "Scenes"}
          </h3>
          {acc && acc.items.length > 0 && (
            <span className="text-sm text-muted">
              {/* Only an attested total is a count; a capped one never is. */}
              {total !== undefined
                ? `Showing ${NUM_FMT.format(shown.length)} of ${NUM_FMT.format(total)}`
                : `Showing ${NUM_FMT.format(shown.length)}`}
            </span>
          )}
        </div>
        {acc && acc.items.length > 0 && performerName && (
          <BulkRequest
            key={performerId}
            provider={provider}
            kind={kind}
            performerId={performerId}
            performerName={performerName}
          />
        )}
      </div>
      {error && acc === null ? (
        <ErrorPanel
          title={`${providerLabel(provider)} unavailable`}
          message={error}
          onRetry={() => void load(1)}
        />
      ) : acc === null ? (
        <GridSkeleton
          aspect="aspect-[2/3]"
          cols="poster-grid"
          count={perPage || 12}
        />
      ) : acc.items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {providerLabel(provider)} returned no {kindLabel} for {performerName}.
        </div>
      ) : (
        <>
          <div className="poster-grid">
            {shown.map((it) =>
              kind === "movie" ? (
                <MovieCard key={it.reference.id} item={it} onOpen={open} />
              ) : (
                <SceneCard key={it.reference.id} item={it} onOpen={open} />
              ),
            )}
          </div>
          {error ? (
            <div className="mt-6 flex items-center justify-center gap-3 text-sm text-muted">
              <span role="alert">
                Couldn&rsquo;t load more {kindLabel}: {error}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => void load(acc.page + 1)}
              >
                Retry
              </button>
            </div>
          ) : (
            acc.hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  className="btn"
                  disabled={loading}
                  aria-busy={loading || undefined}
                  onClick={() => void load(acc.page + 1)}
                >
                  {loading
                    ? "Loading…"
                    : total !== undefined
                      ? `Show more ${kindLabel} (${NUM_FMT.format(total - shown.length)} left)`
                      : `Show more ${kindLabel}`}
                </button>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Bulk "request everything" ---------- */

/* Only fields the response contained are rendered — a missing count is never
 * shown as 0. */
type BulkResponse = {
  requested?: number;
  skipped?: number;
  autoApproved?: number;
  failed?: { id: string; code: string }[];
  scanned?: number;
  capped?: boolean;
  /** A pass that ended early, before the cap and with provider pages left. */
  error?: { code: string; message: string };
};

function BulkRequest({
  provider,
  kind,
  performerId,
  performerName,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  performerName: string;
}) {
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResponse | null>(null);
  const noun = kind === "movie" ? "movie" : "scene";

  const run = async () => {
    confirmRef.current?.close();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<BulkResponse>("/api/requests/bulk", {
          method: "POST",
          body: JSON.stringify({
            performer: { provider, kind: "performer", id: performerId },
            kind,
          }),
        }),
      );
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const counts = result
    ? [
        typeof result.requested === "number"
          ? `${result.requested} requested`
          : null,
        typeof result.autoApproved === "number"
          ? `${result.autoApproved} auto-approved`
          : null,
        typeof result.skipped === "number" && result.skipped > 0
          ? `${result.skipped} skipped (already requested)`
          : null,
        result.failed ? `${result.failed.length} failed` : null,
      ].filter(Boolean)
    : [];

  // Each page can render one BulkRequest per listing side; the id must be
  // unique or IDREF resolution points every dialog at the first title.
  const titleId = useId();

  return (
    <div className="min-w-0 text-right">
      {/* Speaks the request language of every other Request button: the
          accent fill and the plus mark. It is the one decision of its
          listing (each listing heads its own section), and it still asks
          first in the dialog below. */}
      <button
        type="button"
        className="btn btn-accent"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => {
          setError(null);
          confirmRef.current?.showModal();
        }}
      >
        <Icon name="plus" />
        {busy ? "Requesting…" : `Request every ${noun}`}
      </button>
      {counts.length > 0 && (
        <p className="mt-2 text-sm" role="status">
          {counts.join(" · ")}
          {result?.error
            ? "."
            : result?.capped
              ? " — more titles remain; press again to continue where this stopped."
              : "."}
        </p>
      )}
      {result?.error && (
        <p className="bulk-error mt-2 text-sm" role="alert">
          {result.error.message}
        </p>
      )}
      {error && (
        <p className="bulk-error mt-2 text-sm" role="alert">
          The bulk request did not run: {error}
        </p>
      )}
      <dialog
        ref={confirmRef}
        className="bulk-dialog"
        aria-labelledby={titleId}
      >
        <div className="p-5">
          <h3 id={titleId} className="font-semibold">
            Request every {noun}?
          </h3>
          <p className="mt-2 text-sm text-muted">
            A request is filed for each {noun} {performerName} appears in on{" "}
            {providerLabel(provider)}. Titles you already requested are skipped.
            At most 100 titles are processed per press.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => confirmRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void run()}
            >
              File the requests
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/* ---------- Follow / unfollow the performer on this page ---------- */

/** There is deliberately no per-performer status endpoint: the whole follow
 * list is read and matched here. A follow covers both providers, so this page
 * counts as followed when either side of the stored pair names it. State only
 * moves after the server confirms — never an optimistic flip. If the list
 * cannot be read, the button says so and pressing it retries; it never
 * guesses "not following". */
function FollowStar({
  provider,
  id,
  name,
  imageUrl,
}: {
  provider: CatalogProvider;
  id: string;
  name: string;
  imageUrl: string | null;
}) {
  const [status, setStatus] = useState<
    "unknown" | "following" | "notFollowing"
  >("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const check = useCallback(() => {
    let live = true;
    setError(null);
    setNote(null);
    setStatus("unknown");
    api<{ follows: PerformerFollow[] }>("/api/follows")
      .then((d) => {
        if (!live) return;
        setStatus(
          d.follows.some(
            (f) =>
              (f.reference.provider === provider && f.reference.id === id) ||
              (f.linked?.provider === provider && f.linked.id === id),
          )
            ? "following"
            : "notFollowing",
        );
      })
      .catch((e) => {
        if (live) setError(messageOf(e)); // status stays "unknown"
      });
    return () => {
      live = false;
    };
  }, [provider, id]);
  useEffect(check, [check]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (status === "following") {
        await api(`/api/follows/${provider}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        setStatus("notFollowing");
      } else {
        const res = await api<FollowResponse>("/api/follows", {
          method: "POST",
          body: JSON.stringify({
            performer: { provider, kind: "performer", id },
            name,
            imageUrl,
          }),
        });
        setStatus("following");
        const failure = res.errors?.[0];
        if (failure) {
          setNote(
            `Followed. Pairing with ${providerLabel(failure.provider)} is unknown; try Merge.`,
          );
        }
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`btn follow-toggle${status === "following" ? " is-following" : ""}`}
        aria-pressed={
          status === "following"
            ? true
            : status === "notFollowing"
              ? false
              : undefined
        }
        aria-label={
          status === "following"
            ? `Following ${name} — unfollow`
            : status === "notFollowing"
              ? `Follow ${name}`
              : `Follow status unavailable — check whether you follow ${name}`
        }
        disabled={busy}
        onClick={() => void (status === "unknown" ? check() : toggle())}
      >
        <Icon name="star" filled={status === "following"} />
        {status === "following"
          ? "Following"
          : status === "notFollowing"
            ? "Follow"
            : "Follow status unavailable"}
      </button>
      {error && (
        <p className="bulk-error mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="bulk-error mt-2 text-xs" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

/* ---------- Merge a duplicate entry on the other provider ---------- */

/** Merging records the user's explicit assertion, never a name match. It
 * follows the current entry if needed and links the selected standalone
 * follow on the other provider. Rendered only while this page's provider
 * link is missing. */
function MergeControl({
  reference,
  onMerged,
}: {
  reference: CatalogReference;
  onMerged: () => void;
}) {
  const other: CatalogProvider =
    reference.provider === "tpdb" ? "stashdb" : "tpdb";
  const [open, setOpen] = useState(false);
  const [follows, setFollows] = useState<PerformerFollow[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same live-flag pattern as FollowStar: a stale in-flight list never wins.
  // check is also the picker's retry: a failed read keeps the list unknown,
  // and pressing Retry reads it again.
  const check = useCallback(() => {
    if (!open || follows !== null) return;
    let live = true;
    setError(null);
    api<{ follows: PerformerFollow[] }>("/api/follows")
      .then((d) => {
        if (live) setFollows(d.follows);
      })
      .catch((e) => {
        if (live) setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [open, follows]);
  useEffect(check, [check]);

  const merge = async (f: PerformerFollow) => {
    setBusyId(f.id);
    setError(null);
    try {
      await api("/api/follows/merge", {
        method: "POST",
        body: JSON.stringify({
          performer: {
            provider: reference.provider,
            kind: "performer",
            id: reference.id,
          },
          counterpart: f.reference,
        }),
      });
      // The parent refetches the page; the link resolves and this panel
      // unmounts, so the local list needs no update.
      onMerged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  const needle = filter.trim().toLowerCase();
  const candidates = (follows ?? []).filter(
    (f) =>
      f.reference.provider === other &&
      f.linked === null &&
      (!needle || f.name.toLowerCase().includes(needle)),
  );

  return (
    <div className="mt-4" aria-label="Merge duplicate entries">
      {open ? (
        <>
          <label className="label" htmlFor="merge-filter">
            Filter by name
          </label>
          <input
            id="merge-filter"
            className="mt-1 w-full"
            type="search"
            placeholder="Filter by name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {error !== null && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {error}
              {/* Retry belongs to the failed read only: a merge failure keeps
                  the list, and the Merge button itself is the retry. */}
              {follows === null && (
                <>
                  {" "}
                  <button type="button" className="btn" onClick={check}>
                    Retry
                  </button>
                </>
              )}
            </p>
          )}
          {follows === null ? (
            error === null ? (
              <p className="mt-2 text-sm text-muted" aria-live="polite">
                Loading your follows…
              </p>
            ) : null
          ) : candidates.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No standalone {providerLabel(other)} entry to merge. Follow this
              performer on {providerLabel(other)} first, then merge the two
              entries here.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {candidates.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-sm">{f.name}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId !== null}
                    onClick={() => void merge(f)}
                  >
                    {busyId === f.id ? "Merging…" : "Merge"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn mt-3"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Merge with a duplicate entry…
          </button>
          <p className="mt-1 text-xs text-muted">
            Use this only if you know both entries are the same person — the
            merge records your assertion; Velvarr never matches by name.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- Often appears with ---------- */

type RelatedPayload = {
  items: CatalogDetail[];
  errors: { provider: CatalogProvider; code: string; message: string }[];
};

function relatedPath(r: { provider: CatalogProvider; id: string } | undefined) {
  return r
    ? `/api/catalog/${r.provider}/performer/${encodeURIComponent(r.id)}/related`
    : null;
}

/** Co-appearance on published credits — the providers' own filmographies are
 * the only evidence, so the heading says "often appears with", never
 * "similar". Both linked sides are read in parallel and one is shown:
 * StashDB first (scene credits are the richer evidence), TPDB when StashDB
 * failed or found nobody. Never a mix: the same co-star on both providers
 * has two ids, and pairing them by name is not allowed, so a mix would
 * show people twice. A side that failed while the other answered is named
 * above the grid. Empty evidence renders nothing at all. */
function RelatedPerformers({
  sides,
  linkPending,
  onOpen,
}: {
  sides: { provider: CatalogProvider; id: string }[];
  /** The detail that names the linked side is still loading: wait, so the
   * grid never shows one side and then swaps to the other. */
  linkPending: boolean;
  onOpen: (r: CatalogReference) => void;
}) {
  const [reload, setReload] = useState(0);
  // Up to two full rows: whole rows once a row is filled, so the grid
  // never ends on a half row; fewer than one row shows them all.
  const [probeRef, cols] = useGridColumns();
  const ordered = [...sides].sort((a, b) =>
    a.provider === "stashdb" ? -1 : b.provider === "stashdb" ? 1 : 0,
  );
  const first = useApiGet<RelatedPayload>(relatedPath(ordered[0]), [
    ordered[0]?.provider,
    ordered[0]?.id,
    reload,
  ]);
  const second = useApiGet<RelatedPayload>(relatedPath(ordered[1]), [
    ordered[1]?.provider,
    ordered[1]?.id,
    reload,
  ]);
  const reads = [first, second].slice(0, ordered.length);
  const failure = (r: (typeof reads)[number], i: number) =>
    r.error !== null
      ? `${providerLabel(ordered[i]!.provider)}: ${r.error}`
      : r.data && r.data.errors.length > 0
        ? r.data.errors
            .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
            .join(" · ")
        : null;
  const loading =
    linkPending || reads.some((r) => r.loading && r.data === null);
  const winner = reads.findIndex(
    (r, i) => failure(r, i) === null && (r.data?.items.length ?? 0) > 0,
  );
  const failures = reads
    .map((r, i) => failure(r, i))
    .filter((f): f is string => f !== null);
  const items = winner >= 0 ? reads[winner]!.data!.items : [];
  // No evidence and nothing failed: the whole section, heading included,
  // disappears rather than claiming a similarity.
  if (!loading && items.length === 0 && failures.length === 0) return null;
  const shown =
    cols > 0 && items.length >= cols
      ? items.slice(0, Math.min(2, Math.floor(items.length / cols)) * cols)
      : items;
  const retry = (
    <button
      type="button"
      className="btn"
      onClick={() => setReload((n) => n + 1)}
    >
      Retry
    </button>
  );
  return (
    <div>
      <div
        ref={probeRef}
        className="poster-grid"
        aria-hidden="true"
        style={{ height: 0, overflow: "hidden", visibility: "hidden" }}
      />
      <h3 className="discovery-shelf-title">Often appears with</h3>
      {loading ? (
        <RailSkeleton count={6} />
      ) : (
        <>
          {failures.length > 0 && (
            <p className="mt-2 text-sm text-muted" role="alert">
              {failures.join(" · ")}
              {winner >= 0
                ? ` Showing ${providerLabel(ordered[winner]!.provider)} co-appearances. `
                : " "}
              {retry}
            </p>
          )}
          {shown.length > 0 && (
            <div className="poster-grid mt-3">
              {shown.map((it) => (
                <PerformerCard
                  key={`${it.reference.provider}:${it.reference.id}`}
                  item={it}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- Tags overview: counted across her listed titles ---------- */

type TagCounts = {
  tags: { name: string; count: number; id: string }[];
  scanned: number;
  capped: boolean;
  errors: { provider: CatalogProvider; code: string; message: string }[];
};

const TAGS_SHOWN = 30;

/** Varied chip widths (rem) so the loading row reads as tags, not a bar. */
const TAG_SKELETON_WIDTHS = [5.5, 4, 7, 4.5, 6, 3.5, 8, 5, 4, 6.5, 5, 7.5];

/** Tag counts from one provider side of her filmography, fetched after the
 * page renders so it never delays the follow button or the listings. Each
 * side reports its own coverage (`scanned`/`capped`) and its own errors — a
 * failed side shrinks the overview and says so, never reads as complete. */
function TagsOverview({
  reference,
  linked,
  linkPending,
  name,
}: {
  reference: CatalogReference;
  linked?: CatalogReference;
  /** The detail (which names the linked side) is still loading: her own
   * counts already fetch, but the merged overview waits for the link so it
   * never renders one side and then re-renders as both. */
  linkPending: boolean;
  /** Undefined until her detail lands. */
  name?: string;
}) {
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const [order, setOrder] = useState<"count" | "name">("count");
  // How many CSS columns the tag list gets at its current width, read from
  // its own column width and gap, so the cut can fill each one.
  const [colsEl, setColsEl] = useState<HTMLDivElement | null>(null);
  const [tagCols, setTagCols] = useState(0);
  useEffect(() => {
    if (!colsEl || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const s = getComputedStyle(colsEl);
      const w = parseFloat(s.columnWidth);
      const gap = parseFloat(s.columnGap) || 0;
      if (w > 0)
        setTagCols(
          Math.max(1, Math.floor((colsEl.clientWidth + gap) / (w + gap))),
        );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(colsEl);
    return () => ro.disconnect();
  }, [colsEl]);
  const [showAll, setShowAll] = useState(false);
  // A clicked chip opens unified browse: this performer + that tag.
  const browseTo = useBrowseTo();
  const pathOf = (r: CatalogReference) =>
    `/api/catalog/${r.provider}/performer/${encodeURIComponent(r.id)}/tags`;
  const linkedPath = linked?.kind === "performer" ? pathOf(linked) : null;
  const own = useApiGet<TagCounts>(pathOf(reference), [
    reference.provider,
    reference.id,
    reload,
  ]);
  const other = useApiGet<TagCounts>(linkedPath, [
    linkedPath,
    linked?.id,
    reload,
  ]);
  // Loading keeps the section shell with chip-shaped skeletons in the
  // final chip row's geometry, so the listings below never jump when the
  // tags land.
  if (linkPending || own.loading || (linkedPath !== null && other.loading))
    return (
      <section aria-label="Tags overview" aria-busy="true">
        <h3 className="discovery-shelf-title">Tags</h3>
        <div className="tag-chips mt-2" aria-hidden="true">
          {TAG_SKELETON_WIDTHS.map((w, i) => (
            <span
              key={i}
              className="skel h-[27px]"
              style={{ width: `${w}rem` }}
            />
          ))}
        </div>
      </section>
    );
  // Each side is single-provider, so its rows' native ids become that
  // side's selection ids; the merge then keeps both for labels on both.
  const sides: { provider: CatalogProvider; counts: TagCounts }[] = [];
  if (own.data !== null)
    sides.push({ provider: reference.provider, counts: own.data });
  if (linked?.kind === "performer" && other.data !== null)
    sides.push({ provider: linked.provider, counts: other.data });
  // A whole-side fetch failure becomes evidence in the same shape the server
  // reports partial provider errors in.
  const fetchFailures: TagCounts["errors"] = [];
  if (own.data === null && own.error !== null) {
    fetchFailures.push({
      provider: reference.provider,
      code: "error",
      message: own.error,
    });
  }
  if (
    linked !== undefined &&
    linked.kind === "performer" &&
    other.data === null &&
    other.error !== null
  ) {
    fetchFailures.push({
      provider: linked.provider,
      code: "error",
      message: other.error,
    });
  }
  const errors = [...sides.flatMap((s) => s.counts.errors), ...fetchFailures];
  const merged = mergeTagCounts(
    sides.map((s) =>
      s.counts.tags.map((t) => ({
        name: t.name,
        count: t.count,
        ...(s.provider === "tpdb" ? { tpdb: t.id } : { stashdb: t.id }),
      })),
    ),
  );
  if (merged.length === 0) {
    // No tags counted and nothing failed: no listed titles carry tags, so
    // the section disappears rather than claiming an overview.
    if (errors.length === 0) return null;
    return (
      <p className="text-sm text-muted" role="alert">
        Tags could not be loaded:{" "}
        {errors
          .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
          .join(" · ")}{" "}
        <button type="button" className="btn" onClick={retry}>
          Retry
        </button>
      </p>
    );
  }
  // "Most frequent" shows her top tags and folds the rest behind Show all.
  // A–Z is a lookup, so it lists every tag alphabetically: a cut there
  // would show only the "A" tags or a sorted top 30, neither of which
  // answers "does she have tag X".
  const byCount = merged.sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  // The cut fills every column: CSS columns balance 30 tags over 7 columns
  // as 5 per column and leave the 7th empty, so the count rounds up to
  // whole rows of the columns that actually fit.
  const cut =
    tagCols > 0 ? tagCols * Math.ceil(TAGS_SHOWN / tagCols) : TAGS_SHOWN;
  const shown =
    order === "name"
      ? [...byCount].sort((a, b) => a.name.localeCompare(b.name))
      : showAll
        ? byCount
        : byCount.slice(0, cut);
  const scanned = sides.reduce((n, s) => n + s.counts.scanned, 0);
  const capped = sides.some((s) => s.counts.capped);
  return (
    <section aria-label="Tags overview">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* Title and coverage on the left, like the listings' "Page x of
            y"; the order choice on the right. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="discovery-shelf-title">Tags</h3>
          <span className="text-sm text-muted">
            Counted across {NUM_FMT.format(scanned)} listed titles
            {capped ? " (the first pages each provider returns)" : ""}
          </span>
        </div>
        <div role="group" aria-label="Tag order" className="segmented">
          <button
            type="button"
            aria-pressed={order === "count"}
            onClick={() => setOrder("count")}
          >
            Most frequent
          </button>
          <button
            type="button"
            aria-pressed={order === "name"}
            onClick={() => setOrder("name")}
          >
            A–Z
          </button>
        </div>
      </div>
      {/* Columns: a frequency list reads down, names left and counts in a
          right-aligned column, instead of a ragged run-on cloud. */}
      <div ref={setColsEl} className="tag-columns mt-3">
        {shown.map((t) => {
          const count = (
            <span className="filter-chip-count">
              {new Intl.NumberFormat().format(t.count)}
            </span>
          );
          if (!isBrowseableTagSelection(t))
            // TPDB sometimes emits numeric-string tag ids the filter layer
            // rejects with 400 — those stay plain text, as in catalog-detail.
            return (
              <span key={t.name} className="filter-chip" title={t.name}>
                <span className="min-w-0 truncate">{t.name}</span>
                {count}
              </span>
            );
          // A union jump rides both of her ids and lands on browse All (her
          // TPDB movies plus her StashDB scenes).
          const jump = performerTagJump(reference, linked, t);
          const filter: BrowseFilter = {
            param: jump.param,
            provider: jump.provider,
            id: jump.id ?? reference.id,
            ...(jump.counterpart !== undefined
              ? { counterpart: jump.counterpart }
              : {}),
            tag: t,
          };
          return (
            <a
              title={t.name}
              key={t.name}
              className="filter-chip"
              href={browseFilterHref(filter)}
              onClick={spaClick(() => {
                // The page performer's name is seeded so the chip labels her
                // by name; the linked side stays id-labeled — no known name,
                // never faked.
                if (name)
                  seedName(
                    {
                      provider: reference.provider,
                      kind: "performer",
                      id: reference.id,
                    },
                    name,
                  );
                browseTo(filter);
              })}
            >
              <span className="min-w-0 truncate">{t.name}</span>
              {count}
            </a>
          );
        })}
      </div>
      {order === "count" && merged.length > cut && (
        <button
          type="button"
          className="cat-inline-link mt-3 text-sm"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? `Show the ${cut} most frequent`
            : `Show all ${new Intl.NumberFormat().format(merged.length)} tags`}
        </button>
      )}
      {errors.length > 0 && (
        <p className="mt-2 text-xs text-muted" role="alert">
          Partial:{" "}
          {errors
            .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
            .join(" · ")}{" "}
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </p>
      )}
    </section>
  );
}

/* ---------- Biography facts the provider published ---------- */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Formats per the accuracy the provider vouches for: a padded unknown
 * day/month is never shown as an exact date. */
function formatBirthDate(iso: string, accuracy?: "day" | "month" | "year") {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  if (accuracy === "year") return String(y);
  if (accuracy === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "34DD-24-36": the band(+cup)-waist-hip triple in the provider's inches,
 * rendered the way stash-box shows it. The numbers render only as the
 * complete triple the provider edits together, never as a lone fragment
 * that reads as a different shape. */
function measurementsOf(p: CatalogPerson) {
  const triple =
    p.bandSize !== undefined && p.waistIn !== undefined && p.hipIn !== undefined
      ? `${p.bandSize}${p.cupSize ?? ""}-${p.waistIn}-${p.hipIn}`
      : undefined;
  if (triple !== undefined) return triple;
  // TPDB's free-text measurements, as published, when no triple exists.
  if (p.measurementsText !== undefined) return p.measurementsText;
  return p.cupSize !== undefined ? `${p.cupSize} cup` : undefined;
}

/** "3 May 2020, aged 40": the age only when the death date is day-exact
 * and the birth date settles it. */
function diedText(p: CatalogPerson): string | undefined {
  if (p.deathDate === undefined) return undefined;
  const date = formatBirthDate(p.deathDate, p.deathDateAccuracy);
  const [y, m, d] = p.deathDate.split("-").map(Number);
  const age =
    p.birthDate !== undefined &&
    (p.deathDateAccuracy ?? "day") === "day" &&
    y &&
    m &&
    d
      ? ageOn(p.birthDate, p.birthDateAccuracy, new Date(y, m - 1, d))
      : undefined;
  return age !== undefined ? `${date}, aged ${age}` : date;
}

/** Rows only for facts the response contained — an unknown fact is never
 * shown as a value, and an all-empty person block renders nothing. */
function PerformerBio({ person }: { person: CatalogPerson }) {
  const rows: [string, string][] = (
    [
      [
        "Born",
        person.birthDate !== undefined
          ? formatBirthDate(person.birthDate, person.birthDateAccuracy)
          : undefined,
      ],
      // A death date replaces "Age": the age at death, when both dates are
      // exact enough, rides the Died row instead.
      [
        "Age",
        person.birthDate !== undefined && person.deathDate === undefined
          ? ageOn(
              person.birthDate,
              person.birthDateAccuracy,
              new Date(),
            )?.toString()
          : undefined,
      ],
      ["Died", diedText(person)],
      ["Birthplace", person.birthplace],
      ["Gender", person.gender],
      ["Country", person.country],
      ["Nationality", person.nationality],
      ["Ethnicity", person.ethnicity],
      ["Eye color", person.eyeColor],
      ["Hair color", person.hairColor],
      [
        "Height",
        person.heightCm !== undefined ? `${person.heightCm} cm` : undefined,
      ],
      [
        "Weight",
        person.weightKg !== undefined ? `${person.weightKg} kg` : undefined,
      ],
      ["Measurements", measurementsOf(person)],
      ["Breasts", person.breastType],
      [
        "Career",
        formatCareerRange(person.careerStartYear, person.careerEndYear),
      ],
      ["Tattoos", person.tattoos?.join(", ")],
      ["Piercings", person.piercings?.join(", ")],
    ] as [string, string | undefined][]
  ).filter((row): row is [string, string] => row[1] !== undefined);
  if (rows.length === 0) return null;
  return (
    // The hero's third column (under the identity below lg): a quiet panel
    // over the backdrop, one fact per row, label left and value right.
    <section
      aria-label="Details"
      className="hero-facts sm:col-start-2 lg:col-start-3"
    >
      {/* No visible heading: the label/value rows explain themselves; the
          section's aria-label still names it for assistive tech. */}
      <dl>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

/** The provider's bio, clamped to two lines so a long one never stretches
 * the hero; "Read more" appears only when the text really overflows, and
 * the full text stays in the DOM for search and assistive tech. */
function ClampedBio({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  return (
    <div className="mt-3 max-w-prose">
      <p
        ref={ref}
        className={`text-sm leading-relaxed text-muted${open ? "" : " line-clamp-2"}`}
      >
        {text}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          className="cat-inline-link mt-1 text-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

/** A gender glyph beside the name, from the provider's own gender value.
 * Only values a standard symbol names exactly get one; any other value
 * (intersex, non-binary) stays text in the facts panel, never a guessed
 * symbol. The glyph is named for assistive tech and as a tooltip. */
function GenderMark({ gender }: { gender?: string }) {
  const g = gender?.toLowerCase();
  const icon =
    g === "female"
      ? "gender-female"
      : g === "male"
        ? "gender-male"
        : // stash-box says "Transgender female"; TPDB spellings vary
          // ("Trans Female"), so any trans-prefixed value gets the mark.
          g?.startsWith("trans")
          ? "gender-trans"
          : null;
  if (!icon || !gender) return null;
  return (
    <span className="gender-mark" role="img" aria-label={gender} title={gender}>
      <Icon name={icon} />
    </span>
  );
}

/* ---------- The performer page ---------- */

export function PerformerView({ reference }: { reference: CatalogReference }) {
  const setP = useParamsSetter();
  const { providers } = useSession();
  const notConfigured = providers?.[reference.provider] === "not_configured";
  const [reload, setReload] = useState(0);
  const [merged, setMerged] = useState<string | null>(null);
  useEffect(() => setMerged(null), [reference.provider, reference.id]);

  const { payload, err, loading } = usePerformerDetail(
    reference.provider,
    reference.id,
    !notConfigured,
    reload,
  );
  const linked = payload
    ? "linked" in payload.link
      ? payload.link.linked
      : undefined
    : undefined;
  const unlinkedReason = payload
    ? "unlinkedReason" in payload.link
      ? payload.link.unlinkedReason
      : undefined
    : undefined;
  const linkFailure = payload ? payload.link.failure : undefined;

  // One metadata source per kind: TPDB has her movies, StashDB has her scenes.
  // She is one person, so both catalogs belong on her page — the counterpart
  // comes from the link the providers published, never from her name. Movies
  // first either way, so the order does not depend on which side you opened.
  const sides: { provider: CatalogProvider; id: string }[] = [
    { provider: reference.provider, id: reference.id },
    ...(linked?.kind === "performer"
      ? [{ provider: linked.provider, id: linked.id }]
      : []),
  ].sort((a, b) =>
    a.provider === "tpdb" ? -1 : b.provider === "tpdb" ? 1 : 0,
  );
  // The side that is missing, so the page can say which catalog is absent
  // instead of quietly showing half a career.
  const missing = sides.some((s) => s.provider === "tpdb")
    ? sides.some((s) => s.provider === "stashdb")
      ? null
      : "stashdb"
    : "tpdb";

  // Opening a title leaves the performer page for a detail: push, so Back
  // returns here. Replacing overwrote the performer entry, and Back jumped
  // all the way to whatever preceded it.
  const open = useCallback(
    (r: CatalogReference) => setP(openParams(r), { push: true }),
    [setP],
  );

  // She is one person: when the providers link her two records, the hero
  // reads both, merged in a fixed order (TPDB first, like the listings), so
  // the page is the same whichever side was opened. The other side only
  // fills gaps; a failed fetch of it degrades to the opened record and says
  // so in the provenance line.
  const otherRef = linked?.kind === "performer" ? linked : undefined;
  const other = usePerformerDetail(
    otherRef?.provider ?? reference.provider,
    otherRef?.id ?? reference.id,
    otherRef !== undefined &&
      providers?.[otherRef.provider] !== "not_configured",
    reload,
  );
  const otherDetail = otherRef ? other.payload?.detail : undefined;
  const otherFailed = otherRef !== undefined && other.err !== null;
  const d =
    payload?.detail && otherDetail
      ? reference.provider === "tpdb"
        ? mergePerformerDetails(payload.detail, otherDetail)
        : mergePerformerDetails(otherDetail, payload.detail)
      : payload?.detail;
  const otherLoading = otherRef !== undefined && other.loading;
  const sourceUrl =
    d?.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : undefined;

  // The performer page is entered with a pushed history entry, so Back returns
  // to the results that led here. Shown only when this document was opened
  // from a Velvarr URL — a deep link never offers a control that leaves the
  // app, and history.length alone cannot tell those apart.
  const canGoBack =
    typeof window !== "undefined" &&
    document.referrer.startsWith(window.location.origin);

  return (
    <section aria-label="Performer">
      {canGoBack && (
        <button
          type="button"
          className="btn mb-3"
          onClick={() => window.history.back()}
        >
          Back to results
        </button>
      )}
      {notConfigured || err?.code === "provider_not_configured" ? (
        <div className="panel p-4" role="note">
          <NotConfiguredLine
            source={reference.provider}
            consequence="this performer’s page cannot be loaded"
          />
        </div>
      ) : err?.status === 404 ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">Not in the provider catalog</h3>
          <p className="mt-2 text-sm text-muted">
            {providerLabel(reference.provider)} no longer has this record. It
            may have been removed at the source.
          </p>
        </div>
      ) : err ? (
        <ErrorPanel
          title={`${providerLabel(reference.provider)} unavailable`}
          message={err.message}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : (
        <>
          {loading || otherLoading || !d ? (
            <HeaderSkeleton />
          ) : (
            <div className="performer-hero">
              {d.imageUrl && (
                <ItemImage
                  name=""
                  src={imgSrc(d.imageUrl)}
                  className="performer-backdrop"
                />
              )}
              <div className="performer-scrim" aria-hidden="true" />
              {/* Three columns: photo, identity (name, sources, follow, links),
                and the facts in their own panel on the right, so the hero's
                right half carries content. Below lg the facts drop under the
                identity; below sm everything stacks. */}
              <div className="relative grid items-start gap-5 p-5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6 sm:p-6 lg:grid-cols-[12rem_minmax(0,1fr)_19rem]">
                <EnlargeableImage
                  name={d.title}
                  imageUrl={d.imageUrl}
                  frameClass="relative block aspect-[2/3] w-40 shrink-0 self-center justify-self-center overflow-hidden rounded-lg border border-edge bg-raised p-0 sm:w-48 sm:self-start"
                  imgClass="absolute inset-0 h-full w-full object-cover"
                />
                <div className="min-w-0">
                  <h2 className="page-title performer-title">
                    {d.title}
                    <GenderMark gender={d.person?.gender} />
                  </h2>
                  {/* Which sources this page reads, as provenance text, not
                    chips: nothing here is clickable, so nothing should look
                    like a control. With both sides linked, it says so. */}
                  <p className="mt-1 text-sm text-muted">
                    {sides.length > 1
                      ? `${sides.map((s) => providerLabel(s.provider)).join(" and ")}, linked by the providers${
                          otherFailed && otherRef
                            ? ` (${providerLabel(otherRef.provider)} details could not be loaded)`
                            : ""
                        }`
                      : `From ${providerLabel(reference.provider)}`}
                    {otherFailed && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="cat-inline-link"
                          onClick={() => setReload((n) => n + 1)}
                        >
                          Retry
                        </button>
                      </>
                    )}
                  </p>
                  <div className="mt-3">
                    <FollowStar
                      key={`${reference.provider}:${reference.id}:${reload}`}
                      provider={reference.provider}
                      id={reference.id}
                      name={d.title}
                      imageUrl={d.imageUrl ?? null}
                    />
                    {merged === `${reference.provider}:${reference.id}` && (
                      <p className="mt-2 text-sm text-ok" role="status">
                        Followed and merged with{" "}
                        {providerLabel(
                          reference.provider === "tpdb" ? "stashdb" : "tpdb",
                        )}
                        .
                      </p>
                    )}
                  </div>
                  {d.aliases.length > 0 && (
                    <p className="mt-2 text-sm text-muted">
                      Also known as {d.aliases.join(", ")}
                    </p>
                  )}
                  {d.description && <ClampedBio text={d.description} />}

                  {(d.links.length > 0 || sourceUrl) && (
                    <div className="mt-4">
                      <div className="label">Links</div>
                      <div className="tag-chips mt-1">
                        {d.links.map((l, i) => (
                          <a
                            key={i}
                            className="filter-chip"
                            href={l.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {linkLabel(
                              l,
                              d.links,
                              providerLabel(reference.provider),
                            )}
                          </a>
                        ))}
                        {sourceUrl && (
                          <a
                            className="filter-chip"
                            href={sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Source · {providerLabel(reference.provider)}
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {d.person && <PerformerBio person={d.person} />}
              </div>
            </div>
          )}

          {/* Sections read like Discover's shelves: the shelf title size and
              the shelf rhythm (2.25rem) between them. They mount with the
              hero, not after it: her own listing, tags and co-appearances
              load in parallel with the detail; only the linked side waits
              for the link the detail reports. */}
          <div className="mt-9 space-y-9">
            <TagsOverview
              reference={reference}
              linked={linked}
              linkPending={payload === null}
              name={d?.title}
            />
            {sides.map((s) => (
              <Listing
                key={s.provider}
                provider={s.provider}
                kind={s.provider === "tpdb" ? "movie" : "scene"}
                performerId={s.id}
                performerName={d?.title}
              />
            ))}
            {payload &&
              d &&
              missing &&
              (linkFailure ? (
                <div className="space-y-4">
                  <ErrorPanel
                    title={
                      missing === "tpdb"
                        ? `${d.title}’s movies are not shown`
                        : `${d.title}’s scenes are not shown`
                    }
                    message={`Pairing with ${providerLabel(linkFailure.provider)} is unknown: the lookup failed (${linkFailure.message}). This is not a confirmed absence — retry, or merge the two entries yourself.`}
                    onRetry={() => setReload((n) => n + 1)}
                  />
                  <MergeControl
                    reference={reference}
                    onMerged={() => {
                      setMerged(`${reference.provider}:${reference.id}`);
                      setReload((n) => n + 1);
                    }}
                  />
                </div>
              ) : (
                <div className="panel p-6" role="note">
                  <h3 className="font-semibold">
                    {missing === "tpdb"
                      ? `${d.title}’s movies are not shown`
                      : `${d.title}’s scenes are not shown`}
                  </h3>
                  <p className="mt-2 text-sm text-muted">
                    {unlinkedReason ??
                      `${providerLabel(reference.provider)} publishes no ${providerLabel(missing)} link for this performer, and ${providerLabel(missing)} is the only source for ${missing === "tpdb" ? "movies" : "scenes"}. Velvarr pairs only the records the providers link themselves — it never matches performers by name.`}
                  </p>
                  <MergeControl
                    reference={reference}
                    onMerged={() => {
                      setMerged(`${reference.provider}:${reference.id}`);
                      setReload((n) => n + 1);
                    }}
                  />
                </div>
              ))}
            <RelatedPerformers
              sides={sides}
              linkPending={payload === null}
              onOpen={open}
            />
          </div>
        </>
      )}
    </section>
  );
}
