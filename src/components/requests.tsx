"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  api,
  CardTypeBadge,
  detailHref,
  ErrorPanel,
  imgSrc,
  ItemImage,
  messageOf,
  useCatalogSummary,
  useParamsSetter,
  useSession,
} from "./shared";
import { acquisitionPhase, acquisitionText } from "../lib/status";
import "./views.css";
import type {
  MediaReference,
  ProviderStatus,
  RequestListItem,
  RequestListResponse,
  RequestRecord,
} from "../lib/contracts";
import { canApproveRequest, REQUESTS_CHANGED } from "../lib/approvals";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  REQUEST_DECISION_ERRORS,
  REQUEST_PAGE_MAX,
  REQUEST_PAGE_SIZE,
  REQUEST_SORTS,
  REQUEST_STATUSES,
  REQUEST_STATUS_LABELS,
  REQUEST_TYPES,
} from "../lib/decisions";

/* Facts displayed per row, kept visibly separate:
 *  1. Decision  — one user's intent (this list, from RequestRecord).
 *  2. Acquisition — shared work several requests attach to. Approved rows
 *     carry the shared acquisition state (GET /api/requests enriches them),
 *     so the requester can see whether the work went through.
 *  3. Playback — per-user; resolved on the catalog detail, never here.
 * Cancelling removes only the request (intent) and never shared media — stated
 * in the visible note below. */

// Locale-aware and stable across rows; timestamps are unix milliseconds.
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/* Relative ages, like Seerr's list. Rendered once per load — no ticking
   timer: the list reloads on every decision, and a minute of drift on
   "3 hours ago" is not worth a re-render loop. The exact stamp stays in the
   tooltip. */
const REL_FMT = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const REL_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function RelTime({ at }: { at: number }) {
  const diff = at - Date.now();
  const unit = REL_UNITS.find(([, ms]) => Math.abs(diff) >= ms);
  return (
    <time dateTime={new Date(at).toISOString()} title={DATE_FMT.format(at)}>
      {unit ? REL_FMT.format(Math.round(diff / unit[1]), unit[0]) : "just now"}
    </time>
  );
}

/** PATCH error wording lives in lib/decisions; this adds the ApiError
 * fallback for everything the table does not name. */
function decisionError(e: unknown): string {
  if (e instanceof ApiError) {
    const mapped = REQUEST_DECISION_ERRORS[e.code];
    if (mapped !== undefined) return mapped;
  }
  return messageOf(e);
}

/** The provider reference — shown when the catalog summary is unresolvable.
 * A link, not text: with no summary there is no title link, and the poster
 * link is aria-hidden, so this is the row's only keyboard route to the
 * detail. */
function ReferenceLine({ media }: { media: MediaReference }) {
  return (
    <a
      className="font-mono text-xs break-all text-muted"
      href={detailHref(media)}
    >
      {media.provider} · {media.kind} · {media.id}
    </a>
  );
}

function RequestCard({
  record: r,
  canApprove,
  canDecline,
  canCancel,
  busy,
  providers,
  onDecide,
  rowError,
}: {
  record: RequestListItem;
  canApprove: boolean;
  canDecline: boolean;
  canCancel: boolean;
  busy: boolean;
  providers: ProviderStatus | null;
  onDecide: (
    record: RequestRecord,
    decision: "approved" | "declined" | "cancelled",
  ) => void;
  rowError: { id: string; message: string } | null;
}) {
  const summary = useCatalogSummary(r.media, providers);
  const cancelRef = useRef<HTMLDialogElement>(null);
  const cancelTitleId = useId();
  const acquisition = r.acquisition ?? null;
  const phase = acquisition ? acquisitionPhase(acquisition) : null;
  // Imported work reads "In library", not "Approved": the cancel button
  // hides on this same fact, so the decision label read as a stuck request.
  // The list carries no Jellyfin verdict — Whisparr's import is the fact.
  const statusChip =
    phase === "library"
      ? { label: "In library", state: "available" }
      : {
          label: GROUP_LABEL[r.decision],
          // status.ts's ladder reads a pending decision as "requested", so
          // the chip takes the requested tone — never the accent.
          state: r.decision === "pending" ? "requested" : r.decision,
        };
  let pill: { label: string; tone: string } | null = null;
  if (acquisition) {
    if (phase === "paused") pill = { label: "Paused", tone: "paused" };
    else if (phase === "processing")
      pill = {
        label:
          typeof acquisition.progress?.percent === "number"
            ? `Processing ${acquisition.progress.percent}%`
            : "Processing",
        tone: "processing",
      };
  }
  const year = summary?.releaseDate?.slice(0, 4);
  const meta = [r.media.provider, r.media.kind, summary?.studio]
    .filter(Boolean)
    .join(" · ");
  const art = summary ? imgSrc(summary.imageUrl) : undefined;
  // The confirm dialog names the request; with no resolved summary the
  // provider reference stands in — never a guessed title.
  const requestTitle =
    summary?.title ?? `${r.media.provider} · ${r.media.kind} · ${r.media.id}`;
  return (
    <li className="panel request-card">
      {/* The only art the providers give us is the portrait poster, so the
          banner is that poster blurred out to an ambient wash — no second
          image request, and it never competes with the text over it. */}
      {art && (
        <div
          className="request-card-bg"
          style={{ backgroundImage: `url(${art})` }}
          aria-hidden="true"
        />
      )}
      <div className="request-card-head">
        {/* aria-hidden + tabIndex -1: a link beside it (the title, or the
            reference line when no summary resolved) points at the same
            detail — one keyboard stop, not two. */}
        <a
          className="request-poster"
          href={detailHref(r.media)}
          tabIndex={-1}
          aria-hidden="true"
        >
          <ItemImage
            name={summary?.title ?? "·"}
            src={art}
            className="h-full w-full object-cover"
          />
          <CardTypeBadge kind={r.media.kind} />
        </a>
        <div className="min-w-0">
          {year && <p className="request-year">{year}</p>}
          <div className="text-base">
            {summary === undefined ? (
              <span className="skel inline-block h-5 w-40" aria-hidden="true" />
            ) : summary === null ? (
              <ReferenceLine media={r.media} />
            ) : (
              <a className="request-title" href={detailHref(r.media)}>
                {summary.title}
              </a>
            )}
          </div>
          {meta && <p className="request-meta">{meta}</p>}
        </div>
      </div>
      <dl className="request-facts">
        <dt>Status</dt>
        <dd className="flex flex-wrap gap-2">
          <span className="chip state-badge" data-state={statusChip.state}>
            {statusChip.label}
          </span>
          {pill && (
            <span className="chip state-badge" data-state={pill.tone}>
              {pill.label}
            </span>
          )}
        </dd>
        <dt>Requested</dt>
        <dd>
          <RelTime at={r.createdAt} />
          {r.requestedBy && (
            <>
              {" by "}
              <span className="request-who">{r.requestedBy}</span>
            </>
          )}
        </dd>
        {r.decidedAt !== null && (
          <>
            <dt>{GROUP_LABEL[r.decision]}</dt>
            <dd>
              <RelTime at={r.decidedAt} />
            </dd>
          </>
        )}
        {acquisition && (
          <>
            <dt>Acquisition</dt>
            <dd>{acquisitionText(acquisition)}</dd>
          </>
        )}
      </dl>
      <div className="request-card-actions flex flex-wrap gap-2 sm:flex-col sm:items-end">
        {canApprove && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onDecide(r, "approved")}
          >
            Approve
          </button>
        )}
        {canDecline && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onDecide(r, "declined")}
          >
            Decline
          </button>
        )}
        {canCancel && (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => cancelRef.current?.showModal()}
            >
              Cancel request
            </button>
            <dialog
              ref={cancelRef}
              className="bulk-dialog"
              aria-labelledby={cancelTitleId}
            >
              <div className="p-5">
                <h3 id={cancelTitleId} className="font-semibold">
                  Cancel “{requestTitle}”?
                </h3>
                <p className="mt-2 text-sm text-muted">
                  Cancelling removes only this request&rsquo;s intent — never
                  shared media. You can request the title again.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => cancelRef.current?.close()}
                  >
                    Keep request
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      cancelRef.current?.close();
                      onDecide(r, "cancelled");
                    }}
                  >
                    Cancel request
                  </button>
                </div>
              </div>
            </dialog>
          </>
        )}
      </div>
      {rowError !== null && rowError.id === r.id && (
        <div className="request-card-error">
          <ErrorPanel title="Update not applied" message={rowError.message} />
        </div>
      )}
    </li>
  );
}

type Row = RequestListItem;

/** URL params are untrusted input: anything outside the vocabulary falls
 *  back to the default instead of rendering an empty list. */
function oneOf<T extends string>(
  v: string | null,
  allowed: readonly T[],
  dflt: T,
): T {
  return allowed.find((a) => a === v) ?? dflt;
}

/** GET /api/requests with the active filters plus page params. */
function requestsPath(filters: string, page: Record<string, string>): string {
  const p = new URLSearchParams(filters);
  for (const [k, v] of Object.entries(page)) p.set(k, v);
  return `/api/requests?${p}`;
}

export function RequestsView() {
  const { account, providers } = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const type = oneOf(params.get("type"), REQUEST_TYPES, "all");
  const status = oneOf(params.get("status"), REQUEST_STATUSES, "all");
  const sort = oneOf(params.get("sort"), REQUEST_SORTS, "recent");
  // The server filters, sorts and pages; only non-default values travel.
  const filters = useMemo(() => {
    const p = new URLSearchParams();
    if (type !== "all") p.set("type", type);
    if (status !== "all") p.set("status", status);
    if (sort !== "recent") p.set("sort", sort);
    return p.toString();
  }, [type, status, sort]);
  const [list, setList] = useState<{
    rows: Row[];
    nextCursor: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const rows = list === null ? null : list.rows;
  // Each top read bumps the generation, so a superseded read or a Load more
  // still in flight can never overwrite newer rows.
  const generation = useRef(0);
  const loaded = useRef(0);
  useEffect(() => {
    if (list !== null) loaded.current = list.rows.length;
  }, [list]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const isStaff = account.role === "admin" || account.role === "moderator";

  // A reload re-reads from the top as many rows as are loaded, so a decision
  // or a poll keeps the rows the user paged through in place.
  // ponytail: beyond REQUEST_PAGE_MAX loaded rows a reload trims to
  // REQUEST_PAGE_MAX.
  const reload = useCallback(() => {
    const gen = ++generation.current;
    const limit = Math.min(
      Math.max(loaded.current, REQUEST_PAGE_SIZE),
      REQUEST_PAGE_MAX,
    );
    setError(null);
    setMore({ loading: false, error: null });
    api<RequestListResponse>(
      requestsPath(
        filters,
        limit === REQUEST_PAGE_SIZE ? {} : { limit: String(limit) },
      ),
    )
      .then((d) => {
        if (gen !== generation.current) return;
        setList({ rows: d.requests, nextCursor: d.nextCursor });
        // Fresh authoritative rows: the pending-approvals badge re-reads.
        window.dispatchEvent(new Event(REQUESTS_CHANGED));
      })
      .catch((e: unknown) => {
        if (gen === generation.current) setError(messageOf(e));
      });
  }, [filters]);

  // A filter change never shows rows of the previous filter, and its first
  // read is one page, not the previous filter's loaded count.
  useEffect(() => {
    loaded.current = 0;
    setList(null);
    reload();
  }, [reload]);

  const nextCursor = list === null ? null : list.nextCursor;
  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    const gen = generation.current;
    setMore({ loading: true, error: null });
    api<RequestListResponse>(requestsPath(filters, { cursor: nextCursor }))
      .then((d) => {
        if (gen !== generation.current) return;
        setList((prev) => {
          if (prev === null) return prev;
          const seen = new Set(prev.rows.map((r) => r.id));
          return {
            rows: [...prev.rows, ...d.requests.filter((r) => !seen.has(r.id))],
            nextCursor: d.nextCursor,
          };
        });
        setMore({ loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (gen === generation.current)
          setMore({ loading: false, error: messageOf(e) });
      });
  }, [filters, nextCursor]);

  // Poll only while something is actually moving and the tab is watching.
  const anyDownloading =
    rows?.some((r) => r.acquisition?.state === "downloading") ?? false;
  useEffect(() => {
    if (!anyDownloading) return;
    // ponytail: fixed 15s client poll over the worker's 60s recheck; add a
    // push channel only if operators need sub-minute progress movement.
    const tick = () => {
      if (document.visibilityState === "visible") reload();
    };
    const id = window.setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyDownloading, reload]);

  const decide = useCallback(
    (
      record: RequestRecord,
      decision: "approved" | "declined" | "cancelled",
    ) => {
      if (busyRef.current) return; // belt for same-tick double clicks
      busyRef.current = true;
      setBusyId(record.id);
      setRowError(null);
      api<{ request: RequestRecord }>(`/api/requests/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      })
        .then(() => {
          setAnnouncement(`Request ${decision}.`);
          busyRef.current = false;
          setBusyId(null);
          reload(); // re-read; server truth, no optimism
        })
        .catch((e: unknown) => {
          const msg = decisionError(e);
          setAnnouncement(msg);
          busyRef.current = false;
          setBusyId(null);
          setRowError({ id: record.id, message: msg });
        });
    },
    [reload],
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((decision) => ({
        decision,
        items: (rows ?? []).filter((row) => row.decision === decision),
      })).filter((g) => g.items.length > 0),
    [rows],
  );

  let content;
  if (error !== null) {
    // Provider/server outage is an error with retry, never an empty state.
    content = (
      <ErrorPanel
        title="Requests unavailable"
        message={error}
        onRetry={reload}
      />
    );
  } else if (rows === null) {
    content = (
      <>
        <div className="sr-only" role="status">
          Loading requests
        </div>
        <div className="grid gap-3" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skel h-20 w-full" />
          ))}
        </div>
      </>
    );
  } else if (rows.length === 0 && type === "all" && status === "all") {
    content = (
      <div className="panel p-8 text-center text-sm text-muted">
        {isStaff ? (
          <>
            No one has requested anything yet.{" "}
            <Link
              href="/?view=titles"
              prefetch={false}
              className="text-accent underline"
            >
              Browse titles
            </Link>
          </>
        ) : (
          "You have not requested anything yet. Find something in the catalog and request it."
        )}
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <div className="panel p-8 text-center text-sm text-muted">
        <p>No requests match the current filters.</p>
        <button
          type="button"
          className="btn mt-4"
          onClick={() => setP({ type: null, status: null, sort: null })}
        >
          Clear filters
        </button>
      </div>
    );
  } else {
    content = (
      <div className="grid gap-8">
        {groups.map((g) => (
          <section key={g.decision} aria-labelledby={`requests-${g.decision}`}>
            <h2
              id={`requests-${g.decision}`}
              className="mb-3 text-lg font-semibold tracking-tight"
            >
              {GROUP_LABEL[g.decision]}{" "}
              <span className="text-sm font-normal text-muted">
                ({g.items.length}
                {nextCursor !== null ? "+" : ""})
              </span>
            </h2>
            <ul className="grid gap-3">
              {g.items.map((row) => {
                const r = row;
                const mine = r.accountId === account.id;
                const pending = r.decision === "pending";
                return (
                  <RequestCard
                    key={r.id}
                    record={r}
                    providers={providers}
                    busy={busyId !== null}
                    rowError={rowError}
                    onDecide={decide}
                    // Staff decide anyone's pending request; the owner cancels
                    // their own pending or approved one; an owner holding the
                    // autoApprove grant may approve their own pending request.
                    canApprove={canApproveRequest(r, account)}
                    canDecline={pending && isStaff && !mine}
                    canCancel={
                      mine &&
                      (pending || r.decision === "approved") &&
                      // imported work is past withdrawUndispatched — cancel
                      // would change nothing shared, so the button is noise.
                      row.acquisition?.state !== "imported"
                    }
                  />
                );
              })}
            </ul>
          </section>
        ))}
        {more.error !== null && (
          <ErrorPanel
            title="More requests unavailable"
            message={more.error}
            onRetry={loadMore}
          />
        )}
        {nextCursor !== null && more.error === null && (
          <div className="flex justify-center">
            <button
              type="button"
              className="btn"
              disabled={more.loading}
              onClick={loadMore}
            >
              {more.loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="page-heading">
        <div className="min-w-0">
          <h2 className="page-title">Requests</h2>
          <p className="page-description">
            {isStaff
              ? "Showing every user's requests."
              : "Showing only your own requests."}
          </p>
        </div>
        <button
          type="button"
          className="btn shrink-0"
          onClick={() => {
            setRowError(null);
            reload();
          }}
        >
          Refresh
        </button>
      </div>

      <p className="page-description mb-4 mt-4 max-w-prose">
        A request is one person&rsquo;s intent. Downloading is shared work that
        several requests can attach to, and playback access is decided per
        person — neither is changed here. Cancelling removes only that
        request&rsquo;s intent — never shared media — and a title already
        imported into the library has nothing left to cancel.
      </p>

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <span className="label" id="req-type-label">
            Type
          </span>
          <div
            role="group"
            aria-labelledby="req-type-label"
            className="segmented"
          >
            <button
              type="button"
              aria-pressed={type === "all"}
              onClick={() => setP({ type: null })}
            >
              All
            </button>
            <button
              type="button"
              aria-pressed={type === "movie"}
              onClick={() => setP({ type: "movie" })}
            >
              Movies
            </button>
            <button
              type="button"
              aria-pressed={type === "scene"}
              onClick={() => setP({ type: "scene" })}
            >
              Scenes
            </button>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="req-status">
            Status
          </label>
          <select
            id="req-status"
            className="input"
            value={status}
            onChange={(e) =>
              setP({
                status: e.target.value === "all" ? null : e.target.value,
              })
            }
          >
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REQUEST_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="label" id="req-sort-label">
            Sort
          </span>
          <div
            role="group"
            aria-labelledby="req-sort-label"
            className="segmented"
          >
            <button
              type="button"
              aria-pressed={sort === "recent"}
              onClick={() => setP({ sort: null })}
            >
              Most recent
            </button>
            <button
              type="button"
              aria-pressed={sort === "modified"}
              onClick={() => setP({ sort: "modified" })}
            >
              Last modified
            </button>
          </div>
        </div>
      </div>

      {content}
    </div>
  );
}
