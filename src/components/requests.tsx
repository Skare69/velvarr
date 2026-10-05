"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiError,
  api,
  CardTypeBadge,
  detailHref,
  ErrorPanel,
  imgSrc,
  ItemImage,
  messageOf,
  useApiGet,
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
  RequestRecord,
} from "../lib/contracts";
import { REQUESTS_CHANGED } from "../lib/approvals";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  REQUEST_DECISION_ERRORS,
  REQUEST_SORTS,
  REQUEST_STATUSES,
  REQUEST_STATUS_LABELS,
  REQUEST_TYPES,
  filterRequestRows,
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

/** The provider reference — shown when the catalog summary is unresolvable. */
function ReferenceLine({ media }: { media: MediaReference }) {
  return (
    <span className="font-mono text-xs break-all text-muted">
      {media.provider} · {media.kind} · {media.id}
    </span>
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
  const acquisition = r.acquisition ?? null;
  const phase = acquisition ? acquisitionPhase(acquisition) : null;
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
        {/* aria-hidden + tabIndex -1: the title link beside it points at the
            same detail — one keyboard stop, not two. */}
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
          <span className="chip state-badge" data-state={r.decision}>
            {GROUP_LABEL[r.decision]}
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
            className="btn btn-accent"
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
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onDecide(r, "cancelled")}
          >
            Cancel request
          </button>
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

export function RequestsView() {
  const { account, providers } = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { data, error, reload } = useApiGet<{ requests: Row[] }>(
    "/api/requests",
    [],
  );
  const rows = data === null ? null : data.requests;
  const type = oneOf(params.get("type"), REQUEST_TYPES, "all");
  const status = oneOf(params.get("status"), REQUEST_STATUSES, "all");
  const sort = oneOf(params.get("sort"), REQUEST_SORTS, "recent");
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const isStaff = account.role === "admin" || account.role === "moderator";

  // Old load dispatched this on every successful read; data identity marks
  // each read for the pending-approvals badge consumer.
  useEffect(() => {
    if (data !== null) window.dispatchEvent(new Event(REQUESTS_CHANGED));
  }, [data]);

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

  const filtered = useMemo(
    () => filterRequestRows(rows ?? [], type, status, sort),
    [rows, type, status, sort],
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((decision) => ({
        decision,
        items: filtered.filter((row) => row.decision === decision),
      })).filter((g) => g.items.length > 0),
    [filtered],
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
  } else if (rows.length === 0) {
    content = (
      <div className="panel p-8 text-center text-sm text-muted">
        {isStaff
          ? "No one has requested anything yet."
          : "You have not requested anything yet. Find something in the catalog and request it."}
      </div>
    );
  } else if (filtered.length === 0) {
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
                ({g.items.length})
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
                    canApprove={
                      pending && (isStaff || (mine && account.autoApprove))
                    }
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
          <label className="label" htmlFor="req-type">
            Type
          </label>
          <select
            id="req-type"
            className="input"
            value={type}
            onChange={(e) =>
              setP({ type: e.target.value === "all" ? null : e.target.value })
            }
          >
            <option value="all">All</option>
            <option value="movie">Movies</option>
            <option value="scene">Scenes</option>
          </select>
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
          <label className="label" htmlFor="req-sort">
            Sort
          </label>
          <select
            id="req-sort"
            className="input"
            value={sort}
            onChange={(e) =>
              setP({
                sort: e.target.value === "recent" ? null : e.target.value,
              })
            }
          >
            <option value="recent">Most recent</option>
            <option value="modified">Last modified</option>
          </select>
        </div>
      </div>

      {content}
    </div>
  );
}
