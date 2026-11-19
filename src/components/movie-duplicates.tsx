"use client";

import { useId, useState } from "react";
import type {
  CatalogDetail,
  DuplicateMovieMatch,
  DuplicateMoviesResponse,
} from "../lib/contracts";
import { duplicateReport } from "../lib/duplicate-report";
import { useApiGet } from "./shared";

function DuplicateNotice({
  movie,
  selfUrl,
  match,
}: {
  movie: CatalogDetail;
  selfUrl: string;
  match: DuplicateMovieMatch;
}) {
  const reportId = useId();
  const [copyState, setCopyState] = useState<
    "idle" | "busy" | "copied" | "failed"
  >("idle");
  const report = duplicateReport(movie, selfUrl, match);
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

export function MovieDuplicates({ movie }: { movie: CatalogDetail }) {
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
          Check both records before you submit a report on TPDB. Velvarr does
          not submit reports.
        </p>
      ) : null}
      {data?.matches.map((match) => (
        <DuplicateNotice
          key={match.reference.id}
          movie={movie}
          selfUrl={data.selfUrl}
          match={match}
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
