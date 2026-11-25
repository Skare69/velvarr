"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  CatalogDetail,
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
import { api, ApiError, messageOf, useApiGet, useSession } from "./shared";

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
          className="btn"
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
      <label htmlFor={notesId}>Merge notes for TPDB</label>
      <textarea
        id={notesId}
        className="input w-full"
        rows={6}
        maxLength={2000}
        value={notes}
        onChange={(event) => setNotes(event.currentTarget.value)}
      />
      <p className="cat-note">
        This record merges into the other record on TPDB.
      </p>
      <div>
        <button
          type="button"
          className="btn"
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
}: {
  movie: CatalogDetail;
  selfUrl: string;
  match: DuplicateMovieMatch;
  isAdmin: boolean;
  canMerge: boolean;
  onMerged: () => void;
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
  return (
    <div className="grid gap-2 min-w-0">
      <h3 className="font-semibold break-words">
        Possible TPDB duplicate: {match.title}
        {match.releaseDate ? ` (${match.releaseDate.slice(0, 4)})` : ""}
      </h3>
      <p className="cat-note">
        {match.rules.includes("hash") && "Shared file hash. "}
        {match.rules.includes("metadata") &&
          "Metadata match: cast, year, tags, and poster. No known duration conflict."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a
          className="inline-flex min-h-11 items-center underline"
          href={selfUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          This record on TPDB
        </a>
        <a
          className="inline-flex min-h-11 items-center underline"
          href={match.tpdbUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Other record on TPDB
        </a>
      </div>
      {match.mergedInto !== undefined &&
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
        ))}
      {isAdmin ? (
        <MergeForm movie={movie} match={match} report={report} />
      ) : (
        <CopyReport report={report} />
      )}
      {match.mergedInto === undefined && canMerge && (
        <MergeMoviesControl movie={movie} match={match} onMerged={onMerged} />
      )}
    </div>
  );
}

/** Inline merge picker for one duplicate pair. `:id` in the merge route is
 * the merged-away record, so Confirm posts the id the user did NOT pick.
 * The smart default resolves while the dialog is already open: the opened
 * record stays checked until the availability reads settle, and a failed
 * read never blocks Confirm. */
function MergeMoviesControl({
  movie,
  match,
  onMerged,
}: {
  movie: CatalogDetail;
  match: DuplicateMovieMatch;
  onMerged: () => void;
}) {
  const groupId = useId();
  const movieRadioId = useId();
  const matchRadioId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // A manual pick beats the late-resolving default; the attempt counter
  // drops answers from an open that already closed.
  const touched = useRef(false);
  const attempt = useRef(0);

  function openPicker() {
    setOpen(true);
    setError(null);
    touched.current = false;
    setChosen(movie.reference.id);
    void applySmartDefault();
  }

  async function applySmartDefault() {
    const gen = ++attempt.current;
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
    if (gen === attempt.current && !touched.current) setChosen(best);
  }

  async function merge() {
    if (chosen === null) return;
    // The merged-away id is the record the user did not pick.
    const away =
      chosen === movie.reference.id ? match.reference : movie.reference;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/api/catalog/tpdb/movie/${encodeURIComponent(away.id)}/velvarr-merge`,
        {
          method: "POST",
          body: JSON.stringify({
            primary: { provider: "tpdb", kind: "movie", id: chosen },
          }),
        },
      );
      setOpen(false);
      onMerged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const sides = [
    {
      id: movieRadioId,
      ref: movie.reference,
      title: movie.title,
      releaseDate: movie.releaseDate,
    },
    {
      id: matchRadioId,
      ref: match.reference,
      title: match.title,
      releaseDate: match.releaseDate,
    },
  ];
  return (
    <div className="grid gap-2 min-w-0">
      <button type="button" className="btn" onClick={openPicker}>
        Merge in Velvarr…
      </button>
      <p className="cat-note">
        Use this only if you know both entries are the same release — the merge
        records your assertion; Velvarr never matches by name.
      </p>
      {open && (
        <>
          <div role="radiogroup" aria-label="Choose the entry to keep">
            {sides.map((side) => (
              <label
                key={side.ref.id}
                htmlFor={side.id}
                className="flex min-h-11 items-center gap-2"
              >
                <input
                  id={side.id}
                  type="radio"
                  name={groupId}
                  checked={chosen === side.ref.id}
                  onChange={() => {
                    touched.current = true;
                    setChosen(side.ref.id);
                  }}
                />
                <span className="min-w-0">
                  <span className="block break-words">
                    {side.title}
                    {side.releaseDate
                      ? ` (${side.releaseDate.slice(0, 4)})`
                      : ""}
                  </span>
                  <span className="block font-mono text-xs break-all text-muted">
                    {side.ref.id}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn"
              disabled={busy || chosen === null}
              aria-busy={busy}
              onClick={() => void merge()}
            >
              {busy ? "Merging…" : "Confirm"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
          {error !== null && (
            <p className="cat-note" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
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
  if (loading)
    return (
      <div
        className="cat-section delayed-reveal"
        role="status"
        aria-busy="true"
      >
        <span className="sr-only">Checking possible TPDB duplicates</span>
        <div className="skel h-12 w-full" />
      </div>
    );
  if (
    !error &&
    (!data ||
      (!data.matches.length && !data.errors.length && !data.incomplete.length))
  )
    return null;
  return (
    <section
      className="cat-section grid gap-4"
      aria-label="Possible TPDB duplicates"
    >
      {data?.matches.length ? (
        <p className="cat-note">
          {isAdmin
            ? "Check both records before you submit a merge. TPDB records the merge under the account of the stored TPDB key."
            : "Check both records before you submit a report on TPDB. Velvarr does not submit reports."}
        </p>
      ) : null}
      {data?.matches.map((match) => (
        <DuplicateNotice
          key={match.reference.id}
          movie={movie}
          selfUrl={data.selfUrl}
          match={match}
          isAdmin={isAdmin}
          canMerge={canMerge}
          onMerged={onMerged}
        />
      ))}
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
      {data?.incomplete.map((reason) => (
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
    </section>
  );
}

/** The merged-away ids a TPDB movie detail carries. Undo deletes the one
 * link row; the refetch (where the page offers one) reads the old way
 * again. The section also drops the row from its own list, so a page
 * without a refetch — the library item detail — still shows the undo. */
export function MergedMovies({
  movie,
  onRefetch,
}: {
  movie: CatalogDetail;
  onRefetch?: () => void;
}) {
  const { account } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Rows this mount already unmerged: gone from the list at once, even
  // where no page refetch exists.
  const [unmergedIds, setUnmergedIds] = useState<string[]>([]);
  useEffect(() => setUnmergedIds([]), [movie.mergedFromIds?.join("\n")]);
  const mergedIds = (movie.mergedFromIds ?? []).filter(
    (id) => !unmergedIds.includes(id),
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
