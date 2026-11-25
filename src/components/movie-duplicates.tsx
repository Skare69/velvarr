"use client";

import { useId, useState } from "react";
import type {
  CatalogDetail,
  DuplicateMovieMatch,
  DuplicateMoviesResponse,
  TpdbMergeRequest,
  TpdbMergeResponse,
} from "../lib/contracts";
import { duplicateReport, mergeNotes } from "../lib/duplicate-report";
import { api, messageOf, useApiGet, useSession } from "./shared";

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
      <div>
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
  | { kind: "failed"; error: string };

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
      setState({ kind: "failed", error: messageOf(err) });
    }
  }
  if (state.kind === "done")
    return (
      <p role="status" className="cat-note">
        Merge submitted to TPDB.
        {state.message !== null ? ` TPDB: ${state.message}` : ""}
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
}: {
  movie: CatalogDetail;
  selfUrl: string;
  match: DuplicateMovieMatch;
  isAdmin: boolean;
}) {
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
      {isAdmin ? (
        <MergeForm movie={movie} match={match} report={report} />
      ) : (
        <CopyReport report={report} />
      )}
    </div>
  );
}

export function MovieDuplicates({ movie }: { movie: CatalogDetail }) {
  const isAdmin = useSession().account.role === "admin";
  const [reload, setReload] = useState(0);
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
