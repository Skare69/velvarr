"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  CatalogDetail,
  CatalogDetailResponse,
  CatalogReference,
  DuplicateMovieMatch,
  DuplicateMoviesResponse,
  PlaybackAccess,
  TpdbMergeRequest,
  TpdbMergeResponse,
} from "../lib/contracts";
import {
  duplicateReport,
  mergeNotes,
  mergeNotSubmitted,
} from "../lib/duplicate-report";
import { canMergeDuplicates } from "../lib/approvals";
import {
  api,
  ApiError,
  detailParams,
  Icon,
  messageOf,
  MovieCard,
  useApiGet,
  useParamsSetter,
  useSession,
} from "./shared";

/** Manual fallback: copy a report and submit it on TPDB by hand. */
function CopyReport({ report }: { report: string }) {
  const reportId = useId();
  const [copyState, setCopyState] = useState<
    "idle" | "busy" | "copied" | "failed"
  >("idle");
  async function copy() {
    setCopyState("busy");
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <div className="grid gap-2 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-accent"
          disabled={copyState === "busy"}
          aria-busy={copyState === "busy"}
          onClick={() => void copy()}
        >
          {copyState === "busy" ? "Copying report…" : "Copy report"}
        </button>
      </div>
      <p role="status" className="cat-note">
        {copyState === "copied"
          ? "Report copied. Submit it on TPDB after you check both records."
          : copyState === "failed"
            ? "Clipboard unavailable. Select and copy the report below."
            : ""}
      </p>
      {copyState === "failed" && (
        <div className="grid gap-2">
          <label htmlFor={reportId}>Manual report</label>
          <textarea
            id={reportId}
            className="input w-full"
            rows={10}
            value={report}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}

type MergeState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; message: string | null }
  | { kind: "failed"; error: string }
  | { kind: "unknown"; error: string };

const SUBMITTED_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

/** A merge TPDB already confirmed for this pair: no second form, because a
 * resubmit files a second request with TPDB's moderators. */
function MergeSubmitted({
  movie,
  submitted,
}: {
  movie: CatalogDetail;
  submitted: NonNullable<DuplicateMovieMatch["tpdbMerge"]>;
}) {
  const mine = submitted.sourceId === movie.reference.id.toLowerCase();
  return (
    <p role="status" className="cat-note">
      Merge submitted to TPDB on {SUBMITTED_FMT.format(submitted.submittedAt)}:{" "}
      {mine
        ? "this record merges into the other record."
        : "the other record merges into this record."}
      {submitted.message !== null ? ` TPDB: ${submitted.message}` : ""}
    </p>
  );
}

/** Admin path: submit TPDB's merge form. The viewed record merges into
 * `match`. Velvarr changes no data of its own here. */
function MergeForm({
  movie,
  match,
  report,
}: {
  movie: CatalogDetail;
  match: DuplicateMovieMatch;
  report: string;
}) {
  const notesId = useId();
  const [notes, setNotes] = useState(() => mergeNotes(movie, match));
  const [state, setState] = useState<MergeState>({ kind: "idle" });
  async function submit() {
    setState({ kind: "busy" });
    try {
      const body: TpdbMergeRequest = { target: match.reference.id, notes };
      const res = await api<TpdbMergeResponse>(
        `/api/catalog/tpdb/movie/${encodeURIComponent(movie.reference.id)}/duplicates/merge`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setState({ kind: "done", message: res.message });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network";
      setState({
        kind: mergeNotSubmitted(code) ? "failed" : "unknown",
        error: messageOf(err),
      });
    }
  }
  if (state.kind === "done")
    return (
      <p role="status" className="cat-note">
        Merge submitted to TPDB.
        {state.message !== null ? ` TPDB: ${state.message}` : ""}
      </p>
    );
  // No resubmit and no report: TPDB may hold the merge already, and a
  // second press would file it twice.
  if (state.kind === "unknown")
    return (
      <p role="alert" className="cat-note">
        Merge result unknown: {state.error} Check the{" "}
        <a
          className="underline"
          href={match.tpdbUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          other record on TPDB
        </a>{" "}
        before you submit it again.
      </p>
    );
  const busy = state.kind === "busy";
  return (
    <div className="grid gap-2 min-w-0">
      <p className="cat-note">
        Check both records first. This record merges into the other one on TPDB,
        under the account of the stored TPDB key.
      </p>
      <label htmlFor={notesId}>Merge notes for TPDB</label>
      <textarea
        id={notesId}
        className="input w-full"
        rows={6}
        maxLength={2000}
        value={notes}
        onChange={(event) => setNotes(event.currentTarget.value)}
      />
      <div>
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy || !notes.trim()}
          aria-busy={busy}
          onClick={() => void submit()}
        >
          {busy ? "Submitting merge…" : "Submit merge to TPDB"}
        </button>
      </div>
      {state.kind === "failed" && (
        <>
          <p role="alert" className="cat-note">
            Merge not submitted: {state.error}
          </p>
          <CopyReport report={report} />
        </>
      )}
    </div>
  );
}

function DuplicateNotice({
  movie,
  selfUrl,
  match,
  isAdmin,
  canMerge,
  onMerged,
  scanNotes,
}: {
  movie: CatalogDetail;
  selfUrl: string;
  match: DuplicateMovieMatch;
  isAdmin: boolean;
  canMerge: boolean;
  onMerged: () => void;
  /** How complete the check was (caps, skipped candidates). */
  scanNotes: string[];
}) {
  const [unmergeBusy, setUnmergeBusy] = useState(false);
  const [unmergeError, setUnmergeError] = useState<string | null>(null);
  async function unmerge() {
    setUnmergeBusy(true);
    setUnmergeError(null);
    try {
      await api(
        `/api/catalog/tpdb/movie/${encodeURIComponent(match.reference.id)}/velvarr-merge`,
        { method: "DELETE" },
      );
      onMerged();
    } catch (e) {
      setUnmergeError(messageOf(e));
    } finally {
      setUnmergeBusy(false);
    }
  }
  const report = duplicateReport(movie, selfUrl, match);
  const ev = match.evidence;
  const minutes = (s?: number) =>
    s === undefined ? undefined : `${Math.round(s / 60)} min`;
  const checks: DupCheck[] = [
    ...(match.rules.includes("metadata")
      ? [
          {
            label: "Same release year",
            met: true,
            detail: match.releaseDate?.slice(0, 4) ?? "",
          },
          {
            label: "Cast on both records",
            met: true,
            detail: `${ev.sharedPerformerIds?.length ?? 0} shared performers`,
          },
          {
            label: "Tags overlap 50% or more",
            met: true,
            detail: `${Math.round((ev.tagOverlap ?? 0) * 100)}% overlap`,
          },
          {
            label: "Duration within 10%",
            met: true,
            detail:
              movie.durationSeconds !== undefined &&
              match.durationSeconds !== undefined
                ? `${minutes(movie.durationSeconds)} and ${minutes(match.durationSeconds)}`
                : "Unknown for one record, so no conflict",
          },
          {
            label: "Poster looks the same",
            met: true,
            detail: `${ev.posterDistance} of 64 bits differ (limit 10)`,
          },
        ]
      : [
          {
            label: "Metadata checks",
            met: false,
            detail:
              "Year, cast, tags, duration, and poster did not all match, or the poster was not compared",
          },
        ]),
    {
      label: "Shared video file hash",
      met: match.rules.includes("hash"),
      detail: ev.sharedHashes?.length
        ? ev.sharedHashes.map((h) => h.type).join(", ")
        : "No shared OSHASH or PHASH",
    },
  ];
  const passed = checks.filter((c) => c.met).length;
  const merged =
    match.mergedInto !== undefined &&
    (match.mergedInto === movie.reference.id ? (
      <div className="flex flex-wrap items-center gap-3">
        <p className="cat-note">Merged in Velvarr.</p>
        {canMerge && (
          <button
            type="button"
            className="btn"
            disabled={unmergeBusy}
            aria-busy={unmergeBusy}
            onClick={() => void unmerge()}
          >
            {unmergeBusy ? "Unmerging…" : "Unmerge"}
          </button>
        )}
        {unmergeError !== null && (
          <p className="cat-note" role="alert">
            {unmergeError}
          </p>
        )}
      </div>
    ) : (
      <p className="cat-note">
        Merged into another entry ({match.mergedInto}).
      </p>
    ));
  const actions = (
    <div className="dup-actions">
      <div className="dup-group">
        <h4 className="dup-group-title">On TPDB</h4>
        {match.tpdbMerge ? (
          <MergeSubmitted movie={movie} submitted={match.tpdbMerge} />
        ) : isAdmin ? (
          <MergeForm movie={movie} match={match} report={report} />
        ) : (
          <>
            <p className="cat-note">
              Check both records first. Velvarr does not submit reports.
            </p>
            <CopyReport report={report} />
          </>
        )}
      </div>
    </div>
  );
  const setP = useParamsSetter();
  const openDetail = (r: CatalogReference) =>
    setP(detailParams(r), { push: true });
  const other = useApiGet<CatalogDetailResponse>(
    `/api/catalog/tpdb/movie/${encodeURIComponent(match.reference.id)}`,
    [match.reference.id],
  );
  const picking = match.mergedInto === undefined && canMerge;
  const pick = useMergePick(movie, match, onMerged, picking);
  const groupName = useId();
  const keptSelf = pick.kept === movie.reference.id;
  const ring = (self: boolean) =>
    !picking
      ? self
        ? " dup-ring"
        : ""
      : keptSelf === self
        ? " dup-ring"
        : " dup-away";
  // The tile titles sit hidden under the posters, and a duplicate often
  // shares its title, so each radio names which record it keeps and its
  // title; "Keep this one" alone does not say which.
  const keepRadio = (id: string, who: string, title: string) =>
    picking && (
      <label className="dup-keep">
        <input
          type="radio"
          name={groupName}
          checked={pick.kept === id}
          disabled={pick.busy}
          onChange={() => pick.pick(id)}
        />
        Keep this one
        <span className="sr-only">
          : {who}, {title}
        </span>
      </label>
    );
  const ruleText = match.rules
    .map((r) => (r === "hash" ? "Video file hash match" : "Metadata match"))
    .join(" · ");
  const selfTile = (
    <figure className={`dup-tile dup-tile-self${ring(true)}`}>
      <MovieCard item={movie} onOpen={openDetail} />
      <figcaption className="dup-tile-caption">
        <span className="dup-tile-label">This record</span>
        {keepRadio(movie.reference.id, "this record", movie.title)}
        <a
          className="dup-tile-link"
          href={selfUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View this record on TPDB"
        >
          View on TPDB
        </a>
      </figcaption>
    </figure>
  );
  const otherTile = (
    <figure className={`dup-tile${ring(false)}`}>
      {other.data ? (
        <MovieCard item={other.data.detail} onOpen={openDetail} />
      ) : other.loading ? (
        <div className="skel aspect-[2/3] w-full" />
      ) : (
        <p className="cat-note" role="alert">
          {match.title}: tile unavailable. {other.error}
        </p>
      )}
      <figcaption className="dup-tile-caption">
        <span className="dup-tile-label">Possible duplicate</span>
        {keepRadio(match.reference.id, "the possible duplicate", match.title)}
        <a
          className="dup-tile-link"
          href={match.tpdbUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View the other record on TPDB"
        >
          View on TPDB
        </a>
      </figcaption>
    </figure>
  );
  return (
    <article className="dup-card">
      <div className="dup-verdict">
        <details className="dup-checks">
          <summary>
            <Icon name="chevron-right" className="dup-chev" />
            <span className="dup-rule">{ruleText}</span>
            <span className="dup-score">
              {passed} of {checks.length} checks passed
            </span>
          </summary>
          <ChecksList checks={checks} />
          {scanNotes.map((note) => (
            <p key={note} className="cat-note dup-scan-note">
              {note}
            </p>
          ))}
        </details>
      </div>
      <div className="dup-tray">
        <div
          className="dup-pair"
          role={picking ? "radiogroup" : undefined}
          aria-label={picking ? "Entry to keep in Velvarr" : undefined}
        >
          {selfTile}
          <span className="dup-link" aria-hidden="true">
            ≈
          </span>
          {otherTile}
        </div>
        {picking && (
          <div className="dup-merge">
            <div>
              <button
                type="button"
                className="btn"
                disabled={pick.busy}
                aria-busy={pick.busy}
                onClick={() => void pick.merge()}
              >
                {pick.busy ? "Merging…" : "Merge in Velvarr"}
              </button>
            </div>
            <p className="cat-note">
              Keeps {keptSelf ? "this record" : "the possible duplicate"}. The
              other one leaves every list here, and its links open the kept
              entry. TPDB stays unchanged. Unmerge undoes it. Merge only the
              same release: Velvarr never matches by name.
            </p>
            {pick.error !== null && (
              <p className="cat-note" role="alert">
                {pick.error}
              </p>
            )}
          </div>
        )}
        {merged}
      </div>
      {actions}
    </article>
  );
}

type DupCheck = { label: string; met: boolean; detail: string };

function ChecksList({ checks }: { checks: DupCheck[] }) {
  return (
    <ul className="dup-check-list">
      {checks.map((c) => (
        <li key={c.label}>
          <span className="dup-box" data-met={c.met} aria-hidden="true">
            {c.met ? "✓" : ""}
          </span>
          <span>
            <span className="dup-check-label">
              {c.label}
              <span className="sr-only">
                {c.met ? ": passed" : ": not met"}
              </span>
            </span>
            <span className="dup-check-detail">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The Velvarr merge choice for one duplicate pair, shown in the tile tray.
 * `:id` in the merge route is the merged-away record, so merge() posts the
 * id the user did NOT keep. The smart default resolves after mount: this
 * record stays kept until the availability reads settle, a manual pick
 * beats the late default, and a failed read never blocks the merge. */
function useMergePick(
  movie: CatalogDetail,
  match: DuplicateMovieMatch,
  onMerged: () => void,
  enabled: boolean,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState(movie.reference.id);
  const touched = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      const [mine, theirs] = await Promise.allSettled([
        api<PlaybackAccess>(
          `/api/availability/tpdb/movie/${encodeURIComponent(movie.reference.id)}`,
        ),
        api<PlaybackAccess>(
          `/api/availability/tpdb/movie/${encodeURIComponent(match.reference.id)}`,
        ),
      ]);
      const mineHasFile =
        mine.status === "fulfilled" && mine.value.outcome === "available";
      const theirsHasFile =
        theirs.status === "fulfilled" && theirs.value.outcome === "available";
      let best: string;
      if (mineHasFile !== theirsHasFile) {
        best = mineHasFile ? movie.reference.id : match.reference.id;
      } else if (movie.releaseDate && match.releaseDate) {
        best =
          movie.releaseDate <= match.releaseDate
            ? movie.reference.id
            : match.reference.id;
      } else if (movie.releaseDate) {
        best = movie.reference.id;
      } else if (match.releaseDate) {
        best = match.reference.id;
      } else {
        best =
          movie.reference.id <= match.reference.id
            ? movie.reference.id
            : match.reference.id;
      }
      if (live && !touched.current) setKept(best);
    })();
    return () => {
      live = false;
    };
  }, [
    enabled,
    movie.reference.id,
    movie.releaseDate,
    match.reference.id,
    match.releaseDate,
  ]);

  function pick(id: string) {
    touched.current = true;
    setKept(id);
  }

  async function merge() {
    const away =
      kept === movie.reference.id ? match.reference : movie.reference;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/api/catalog/tpdb/movie/${encodeURIComponent(away.id)}/velvarr-merge`,
        {
          method: "POST",
          body: JSON.stringify({
            primary: { provider: "tpdb", kind: "movie", id: kept },
          }),
        },
      );
      onMerged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return { kept, pick, merge, busy, error };
}

export function MovieDuplicates({
  movie,
  onRefetch,
}: {
  movie: CatalogDetail;
  onRefetch?: () => void;
}) {
  const { account } = useSession();
  const isAdmin = account.role === "admin";
  const canMerge = canMergeDuplicates(account);
  const [reload, setReload] = useState(0);
  const onMerged = () => {
    setReload((n) => n + 1);
    onRefetch?.();
  };
  const { data, error, loading } = useApiGet<DuplicateMoviesResponse>(
    `/api/catalog/tpdb/movie/${encodeURIComponent(movie.reference.id)}/duplicates`,
    [movie.reference.id, reload],
  );
  // Merged entries open with the duplicate details when a banner shows;
  // without one they stay on the page, so their Unmerge is never lost.
  const mergedEntries = <MergedMovies movie={movie} onRefetch={onRefetch} />;
  if (loading)
    return (
      <>
        <div
          className="cat-section delayed-reveal"
          role="status"
          aria-busy="true"
        >
          <span className="sr-only">Checking possible TPDB duplicates</span>
          <div className="skel h-12 w-full" />
        </div>
        {mergedEntries}
      </>
    );
  if (
    !error &&
    (!data ||
      (!data.matches.length && !data.errors.length && !data.incomplete.length))
  )
    return mergedEntries;
  const found = data?.matches.length ?? 0;
  // A match merged in Velvarr (either way) needs no action on this page.
  const pending =
    data?.matches.filter((m) => m.mergedInto === undefined).length ?? 0;
  const resolved = found > 0 && pending === 0;
  const headline = resolved
    ? found === 1
      ? "Duplicate merged in Velvarr"
      : `${found} duplicates merged in Velvarr`
    : pending === 1
      ? "Possible duplicate found"
      : `${pending} possible duplicates found`;
  const body = (
    <>
      {data?.matches.map((match) => (
        <DuplicateNotice
          key={match.reference.id}
          movie={movie}
          selfUrl={data.selfUrl}
          match={match}
          isAdmin={isAdmin}
          canMerge={canMerge}
          onMerged={onMerged}
          scanNotes={data.incomplete}
        />
      ))}
      <div className="dup-fine">
        {error && (
          <p className="cat-note" role="alert">
            Duplicate check unavailable: TPDB: {error}
          </p>
        )}
        {data?.errors.map((failure, i) => (
          <p key={`${failure.code}:${i}`} className="cat-note" role="alert">
            Duplicate check unavailable: TPDB: {failure.message}
          </p>
        ))}
        {/* With a match, the scan notes sit in its opened check list. */}
        {!data?.matches.length &&
          data?.incomplete.map((reason) => (
            <p key={reason} className="cat-note">
              {reason}
            </p>
          ))}
        {error || data?.errors.length ? (
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => setReload((n) => n + 1)}
            >
              Retry duplicate check
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <>
      <section
        className="cat-section dup panel"
        aria-label="Possible TPDB duplicates"
      >
        {found ? (
          <>
            {/* Screen readers expose summary as a button and drop a heading
            inside it, so the section heading sits outside. */}
            <h2 className="sr-only">TPDB duplicate check: {headline}</h2>
            <details className="dup-disclosure">
              <summary
                className={`dup-banner${resolved ? " dup-banner-done" : ""}`}
              >
                <span className="dup-banner-icon">
                  <Icon name={resolved ? "check" : "info"} />
                </span>
                <span className="cat-section-title" aria-hidden="true">
                  TPDB duplicate check
                </span>
                <span className="dup-headline">{headline}</span>
                <span className="dup-toggle">
                  <span className="dup-toggle-show">Show details</span>
                  <span className="dup-toggle-hide">Hide details</span>
                  <Icon name="chevron-right" />
                </span>
              </summary>
              <div className="dup-body">
                {body}
                <MergedMovies
                  movie={movie}
                  onRefetch={onRefetch}
                  shownAbove={(data?.matches ?? [])
                    .filter((m) => m.mergedInto === movie.reference.id)
                    .map((m) => m.reference.id)}
                />
              </div>
            </details>
          </>
        ) : (
          <>
            <h2 className="cat-section-title">TPDB duplicate check</h2>
            {body}
          </>
        )}
      </section>
      {!found && mergedEntries}
    </>
  );
}

/** The merged-away ids a TPDB movie detail carries. Undo deletes the one
 * link row; the refetch (where the page offers one) reads the old way
 * again. The section also drops the row from its own list, so a page
 * without a refetch — the library item detail — still shows the undo. */
function MergedMovies({
  movie,
  onRefetch,
  shownAbove = [],
}: {
  movie: CatalogDetail;
  onRefetch?: () => void;
  /** Ids a duplicate card above already lists with its own Unmerge. */
  shownAbove?: string[];
}) {
  const { account } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Rows this mount already unmerged: gone from the list at once, even
  // where no page refetch exists.
  const [unmergedIds, setUnmergedIds] = useState<string[]>([]);
  useEffect(() => setUnmergedIds([]), [movie.mergedFromIds?.join("\n")]);
  const mergedIds = (movie.mergedFromIds ?? []).filter(
    (id) =>
      !unmergedIds.includes(id) &&
      !shownAbove.some((other) => other.toLowerCase() === id.toLowerCase()),
  );
  if (mergedIds.length === 0) return null;
  async function unmerge(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(
        `/api/catalog/tpdb/movie/${encodeURIComponent(id)}/velvarr-merge`,
        {
          method: "DELETE",
        },
      );
      setUnmergedIds((cur) => [...cur, id]);
      onRefetch?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  }
  return (
    <section className="cat-section grid gap-2" aria-label="Merged entries">
      <h2 className="cat-section-title">Merged entries</h2>
      <p className="cat-note">
        Velvarr treats these TPDB entries as the same release as this one. An
        unmerge restores them everywhere.
      </p>
      {error !== null && (
        <p className="cat-note" role="alert">
          {error}
        </p>
      )}
      <ul className="grid gap-1">
        {mergedIds.map((id) => (
          <li
            key={id}
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span className="font-mono text-xs break-all text-muted">{id}</span>
            {canMergeDuplicates(account) && (
              <button
                type="button"
                className="btn"
                disabled={busyId !== null}
                aria-busy={busyId === id}
                onClick={() => void unmerge(id)}
              >
                {busyId === id ? "Unmerging…" : "Unmerge"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
