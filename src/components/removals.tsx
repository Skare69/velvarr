"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ProviderStatus,
  RemovalLevel,
  RemovalRequest,
} from "../lib/contracts";
import { isDestructiveLevel, requiresUserToken } from "../lib/contracts";
import {
  api,
  ApiError,
  detailHref,
  ErrorPanel,
  messageOf,
  useApiGet,
  useCatalogSummary,
  useSession,
} from "./shared";
import "./views.css";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  REMOVAL_DECISION_ERRORS,
} from "../lib/decisions";

/* Facts displayed per row, kept visibly separate (the domain model):
 *  1. Removal request — one user's durable intent (this list).
 *  2. Removal execution — shared destructive work done once per external
 *     identity by the worker; never shown here as if it were per-user.
 *  3. Availability — per-user; it lives on the catalog detail, never here.
 * Approval removes only external media in Whisparr/Jellyfin. Catalog history,
 * request history and the append-only audit trail survive. Deciding one
 * request never deletes another user's request. */

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The five-rung ladder, least → most destructive. The UI never preselects a
 * rung; the approver's explicit pick is the only source of the level.
 * Irreversibility is not repeated here — isDestructiveLevel owns that fact. */
const LEVELS: readonly {
  id: RemovalLevel;
  label: string;
  hint: string;
}[] = [
  {
    id: "unmonitor",
    label: "Unmonitor",
    hint: "Whisparr stops watching for this item. Files and the Jellyfin item stay.",
  },
  {
    id: "drop",
    label: "Drop from Whisparr",
    hint: "Removed from Whisparr. Files stay on disk and in Jellyfin.",
  },
  {
    id: "exclude",
    label: "Drop + import exclusion",
    hint: "Removed from Whisparr and blocked from being re-imported. Files stay on disk.",
  },
  {
    id: "delete_files",
    label: "Delete files from disk",
    hint: "Irreversible — permanently deletes the files from disk. There is no undo.",
  },
  {
    id: "delete_jellyfin_item",
    label: "Delete the Jellyfin item",
    hint: "Irreversible — deletes the item from the Jellyfin library and withdraws the watch link immediately. There is no undo.",
  },
];

export function levelLabel(level: RemovalLevel): string {
  return LEVELS.find((l) => l.id === level)?.label ?? level;
}

function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/* ---------- Impact preview (GET /api/removals/impact) ---------- */

type RemovalImpact = {
  whisparr: {
    found: boolean;
    path?: string;
    fileCount?: number;
    sizeOnDisk?: number;
    monitored?: boolean;
  } | null;
  jellyfin: {
    matched: boolean;
    itemName?: string;
    libraryName?: string;
  } | null;
  canDeleteInJellyfin: boolean;
};

/** Why an irreversible rung is not offered right now (null = offered). A
 * missing or failed impact preview refuses the destructive rungs rather than
 * guessing what would disappear. */
function rungGate(
  level: RemovalLevel,
  impact: RemovalImpact | null,
  impactError: string | null,
): string | null {
  if (!isDestructiveLevel(level)) return null;
  if (impactError !== null || impact === null)
    return "The impact preview is not loaded, so this irreversible level is not offered — nothing is deleted on a guess.";
  // The two destructive rungs check different surfaces: the Jellyfin rung is
  // the ladder's only user-token rung and needs a deletable matched item;
  // file deletion needs the item found in Whisparr.
  if (requiresUserToken(level)) {
    if (impact.jellyfin?.matched !== true)
      return "No matching Jellyfin item was found, so this level is not offered — nothing is deleted on a guess.";
    if (!impact.canDeleteInJellyfin)
      return "Your Jellyfin account may not delete library items, so this level is not offered.";
    return null;
  }
  if (impact.whisparr?.found !== true)
    return "The item was not found in Whisparr, so file deletion is not offered — nothing is deleted on a guess.";
  return null;
}

/** Confirmation copy for the two irreversible rungs. Names the item, the
 * library, and the exact file count/size, and states plainly there is no undo. */
function confirmCopy(
  level: RemovalLevel,
  record: RemovalRequest,
  impact: RemovalImpact | null,
): { heading: string; lead: string; facts: string[] } {
  const name = impact?.jellyfin?.itemName ?? "this item";
  const w = impact?.whisparr;
  if (level === "delete_files") {
    const facts = [
      `Item: ${name} (${record.media.provider} ${record.media.kind} ${record.media.id})`,
      `Location: ${w?.path ?? "unknown"}`,
      `Files that will disappear: ${w?.fileCount ?? "unknown"} file(s), ${sizeText(w?.sizeOnDisk)}`,
    ];
    if (impact?.jellyfin?.matched === true)
      facts.push(
        `Jellyfin: "${impact.jellyfin.itemName ?? name}" in library "${impact.jellyfin.libraryName ?? "unknown"}" will lose its source files.`,
      );
    return {
      heading: "Irreversible — approve file deletion?",
      lead: `Approving permanently deletes the files for "${name}" from disk. File deletion has no undo — the files cannot be recovered afterwards.`,
      facts,
    };
  }
  const facts = [
    `Item: ${name} (${record.media.provider} ${record.media.kind} ${record.media.id})`,
    `Jellyfin library: ${impact?.jellyfin?.libraryName ?? "unknown"}`,
  ];
  if (w?.found === true)
    facts.push(
      `Whisparr item: ${w.path ?? "unknown path"}, ${w.fileCount ?? "unknown"} file(s), ${sizeText(w.sizeOnDisk)}`,
    );
  return {
    heading: "Irreversible — approve Jellyfin deletion?",
    lead: `Approving permanently deletes "${name}" from the Jellyfin library "${impact?.jellyfin?.libraryName ?? "unknown"}". This cannot be undone — the item cannot be recovered, and its watch link stops working immediately.`,
    facts,
  };
}

/* ---------- Row helpers ---------- */

/** PATCH error wording lives in lib/decisions; this adds the ApiError
 * fallback for everything the table does not name. */
function decisionError(e: unknown): string {
  if (e instanceof ApiError) {
    const mapped = REMOVAL_DECISION_ERRORS[e.code];
    if (mapped !== undefined) return mapped;
  }
  return messageOf(e);
}

/* ---------- Row ---------- */

function RemovalRow({
  record,
  canApprove,
  canCancel,
  busy,
  providers,
  onDecide,
  rowError,
}: {
  record: RemovalRequest;
  canApprove: boolean;
  canCancel: boolean;
  busy: boolean;
  providers: ProviderStatus | null;
  onDecide: (
    record: RemovalRequest,
    decision: "approved" | "declined" | "cancelled",
    level?: RemovalLevel,
  ) => void;
  rowError: { id: string; message: string } | null;
}) {
  const r = record;
  const needsImpact = canApprove && r.decision === "pending";
  // Read-only impact check for the approver's pending rows; fetched before
  // any approval so the confirmation names real facts, never guesses. A
  // missing or failed read leaves impact null so rungGate keeps refusing.
  const impactQuery = new URLSearchParams({
    provider: r.media.provider,
    kind: r.media.kind,
    id: r.media.id,
  });
  const {
    data: impact,
    error: impactError,
    loading: impactLoading,
    reload: reloadImpact,
  } = useApiGet<RemovalImpact>(
    needsImpact ? `/api/removals/impact?${impactQuery}` : null,
    [needsImpact, r.media.provider, r.media.kind, r.media.id],
  );
  const [level, setLevel] = useState<RemovalLevel | "">("");
  const [confirming, setConfirming] = useState(false);
  // Title degrades to the reference line while loading or unresolvable,
  // same as every other list.
  const art = useCatalogSummary(r.media, providers);

  const selected =
    level === "" ? null : (LEVELS.find((l) => l.id === level) ?? null);
  const selectedGate =
    selected !== null && isDestructiveLevel(selected.id)
      ? rungGate(selected.id, impact, impactError)
      : null;

  const approve = () => {
    if (selected === null || selectedGate !== null) return;
    // A single click can never reach an irreversible rung: destructive picks
    // stop here and require the separate confirmation below.
    if (isDestructiveLevel(selected.id)) {
      setConfirming(true);
      return;
    }
    onDecide(r, "approved", selected.id);
  };

  const copy =
    confirming && selected !== null && isDestructiveLevel(selected.id)
      ? confirmCopy(selected.id, r, impact)
      : null;

  return (
    <li className="panel mgmt-row p-4">
      <div className="min-w-0">
        <div className="text-base">
          {art?.title ? (
            <span className="font-medium">{art.title}</span>
          ) : (
            <span className="font-mono text-xs break-all text-muted">
              {r.media.provider} · {r.media.kind} · {r.media.id}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          {r.media.provider} · {r.media.kind} · {r.media.id}
        </p>
        <p className="mt-1 text-xs text-muted">
          Requested {DATE_FMT.format(new Date(r.createdAt))}
          {r.decidedAt !== null
            ? ` · Decided ${DATE_FMT.format(new Date(r.decidedAt))}`
            : ""}
        </p>
        <p className="mt-2 max-w-prose text-sm">Reason: {r.reason}</p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <span className="chip state-badge" data-state={r.decision}>
          {GROUP_LABEL[r.decision]}
        </span>
        {r.level !== null && (
          <span className="chip">{levelLabel(r.level)}</span>
        )}
      </div>

      {needsImpact && (
        <div className="border-t border-edge pt-3 sm:col-span-2">
          <div className="label">
            Removal level — your explicit choice; the requester never picks it
          </div>
          <select
            id={`removal-level-${r.id}`}
            className="input mt-1"
            value={level}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              setLevel(
                LEVELS.some((l) => l.id === v) ? (v as RemovalLevel) : "",
              );
              setConfirming(false);
            }}
          >
            <option value="" disabled>
              Choose a level…
            </option>
            {LEVELS.map((l) => {
              const gate = rungGate(l.id, impact, impactError);
              return (
                <option key={l.id} value={l.id} disabled={gate !== null}>
                  {l.label}
                  {isDestructiveLevel(l.id) ? " — irreversible" : ""}
                  {gate !== null ? " — unavailable" : ""}
                </option>
              );
            })}
          </select>
          {selected !== null && (
            <p className="mt-1 text-xs text-muted">{selected.hint}</p>
          )}
          {selectedGate !== null && (
            <p className="mt-1 text-xs text-danger" role="alert">
              {selectedGate}
            </p>
          )}

          <div className="label mt-3">
            What will disappear (checked live, before you decide)
          </div>
          {impactLoading ? (
            <div className="skel mt-1 h-16 w-full" aria-hidden="true" />
          ) : impactError !== null ? (
            <div className="mt-1">
              <ErrorPanel
                title="Impact preview failed"
                message={`${impactError} Irreversible levels stay unavailable until the preview loads.`}
                onRetry={reloadImpact}
              />
            </div>
          ) : (
            <ul className="mt-1 space-y-1 text-sm text-muted">
              <li>
                {`Whisparr: ${
                  impact?.whisparr?.found === true
                    ? `${impact.whisparr.path ?? "unknown path"} · ${impact.whisparr.fileCount ?? "?"} file(s) · ${sizeText(impact.whisparr.sizeOnDisk)}`
                    : "not found (it may already be gone)"
                }`}
              </li>
              <li>
                {`Jellyfin: ${
                  impact?.jellyfin?.matched === true
                    ? `"${impact.jellyfin.itemName ?? "unknown item"}" in library "${impact.jellyfin.libraryName ?? "unknown"}"`
                    : "no matching item"
                }`}
              </li>
              <li>
                {impact?.canDeleteInJellyfin === true
                  ? "Your Jellyfin account may delete library items."
                  : "Your Jellyfin account may not delete library items."}
              </li>
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy || selected === null || selectedGate !== null}
              onClick={approve}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onDecide(r, "declined")}
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {copy !== null && (
        <div role="alert" className="panel panel-error p-4 sm:col-span-2">
          <div className="font-medium">{copy.heading}</div>
          <p className="mt-1 text-sm">{copy.lead}</p>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {copy.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => onDecide(r, "approved", selected?.id)}
            >
              Confirm — I understand this cannot be undone
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
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
        <a className="btn" href={detailHref(r.media)}>
          View in catalog
        </a>
      </div>

      {rowError !== null && rowError.id === r.id && (
        <div className="sm:col-span-2">
          <ErrorPanel title="Decision not applied" message={rowError.message} />
        </div>
      )}
    </li>
  );
}

/* ---------- View ---------- */

export function RemovalsView() {
  const { account, providers } = useSession();
  // Re-read after every successful decision — the UI never guesses a result.
  const {
    data,
    error,
    reload: load,
  } = useApiGet<{ removals: RemovalRequest[]; enabled: boolean }>(
    "/api/removals",
    [],
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const isStaff = account.role === "admin" || account.role === "moderator";
  // Approving needs the elevated role AND the removal grant; the server
  // re-reads the grant anyway — this only hides controls that would 403.
  const canApprove = isStaff && account.canRemove;

  const decide = useCallback(
    (
      record: RemovalRequest,
      decision: "approved" | "declined" | "cancelled",
      level?: RemovalLevel,
    ) => {
      if (busyRef.current) return; // belt for same-tick double clicks
      busyRef.current = true;
      setBusyId(record.id);
      setRowError(null);
      // The level is sent only with an approval; the endpoint rejects it
      // otherwise.
      const body: { decision: string; level?: RemovalLevel } =
        decision === "approved" && level !== undefined
          ? { decision, level }
          : { decision };
      api<{ removal?: RemovalRequest }>(`/api/removals/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
        .then(() => {
          setAnnouncement(
            decision === "approved"
              ? `Removal approved at level ${levelLabel(level ?? "unmonitor")}. The removal will be carried out by the worker.`
              : `Removal request ${decision}.`,
          );
          busyRef.current = false;
          setBusyId(null);
          load();
        })
        .catch((e: unknown) => {
          const msg = decisionError(e);
          setAnnouncement(msg);
          busyRef.current = false;
          setBusyId(null);
          setRowError({ id: record.id, message: msg });
        });
    },
    [load],
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((decision) => ({
        decision,
        items: (data?.removals ?? [])
          .filter((r) => r.decision === decision)
          .sort((a, b) => b.createdAt - a.createdAt),
      })).filter((g) => g.items.length > 0),
    [data],
  );

  let content;
  if (error !== null) {
    content = (
      <ErrorPanel title="Removals unavailable" message={error} onRetry={load} />
    );
  } else if (data === null) {
    content = (
      <>
        <div className="sr-only" role="status">
          Loading removal requests
        </div>
        <div className="grid gap-3" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skel h-20 w-full" />
          ))}
        </div>
      </>
    );
  } else if (data.removals.length === 0) {
    content = (
      <div className="panel p-8 text-center text-sm text-muted">
        {isStaff
          ? "No removal requests on record."
          : "You have not requested any removal. If something in the catalog should be taken down, open it and use Remove."}
      </div>
    );
  } else {
    content = (
      <div className="grid gap-8">
        {groups.map((g) => (
          <section key={g.decision} aria-labelledby={`removals-${g.decision}`}>
            <h2
              id={`removals-${g.decision}`}
              className="mb-3 text-lg font-semibold"
            >
              {GROUP_LABEL[g.decision]}{" "}
              <span className="text-sm font-normal text-muted">
                ({g.items.length})
              </span>
            </h2>
            <ul className="grid gap-3">
              {g.items.map((r) => (
                <RemovalRow
                  key={r.id}
                  record={r}
                  providers={providers}
                  busy={busyId !== null}
                  rowError={rowError}
                  onDecide={decide}
                  canApprove={canApprove}
                  // Only the requester can withdraw their own intent.
                  canCancel={
                    r.accountId === account.id && r.decision === "pending"
                  }
                />
              ))}
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
          <h2 className="page-title">Removals</h2>
          <p className="page-description">
            {isStaff
              ? "Showing every user's removal requests."
              : "Showing only your own removal requests."}
          </p>
        </div>
        <button
          type="button"
          className="btn shrink-0"
          onClick={() => {
            setRowError(null);
            load();
          }}
        >
          Refresh
        </button>
      </div>

      <p className="page-description mb-6 mt-4 max-w-prose">
        Three separate things: a removal request is one person&rsquo;s intent;
        the removal execution is shared destructive work done once per item; and
        availability afterwards is decided per person. Approving removes only
        the external media in Whisparr and Jellyfin — catalog history, request
        history, and the audit trail survive, and deciding a request never
        deletes anyone else&rsquo;s.
      </p>

      {data !== null && !data.enabled && (
        <div className="panel panel-error mb-4 p-4" role="alert">
          <div className="font-medium">Removal is turned off</div>
          <p className="mt-1 text-sm text-muted">
            The operator has not turned removal on for this Velvarr instance
            (VELVARR_ENABLE_REMOVAL), so nothing can be requested, approved, or
            carried out right now. The requests below are kept for the record —
            they are shown, not hidden, and they are not being acted on.
          </p>
        </div>
      )}

      {data !== null && data.enabled && isStaff && !account.canRemove && (
        <p className="mb-4 text-sm text-muted">
          You can read removal requests, but deciding them needs the removal
          grant, which an administrator sets on your account.
        </p>
      )}

      {content}
    </div>
  );
}
