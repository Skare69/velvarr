"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { api, messageOf, useParamsSetter, useSession } from "./shared";
import { BROWSE_KEYS } from "../lib/browse-url";
import { PROSE_TEXT_MAX } from "../lib/prose-draft";
import type { ProseNote, ProseSearchResult } from "../lib/prose-map";

const SNAPSHOT_KEYS = BROWSE_KEYS.filter((k) => k !== "perPage");

/** The browse filter state of a URL: perPage is a display setting, and an
 * empty value reads as absent (useParamsSetter deletes it). */
function browseSnapshot(sp: { get(key: string): string | null }): string {
  return JSON.stringify(
    SNAPSHOT_KEYS.flatMap((k) => {
      const v = sp.get(k);
      return v == null || v === "" ? [] : [[k, v]];
    }),
  );
}

/** The URL a patch produces, applied the way useParamsSetter applies it. */
function patchedSearch(
  search: string,
  patch: Record<string, string | null> | null,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v == null || v === "") next.delete(k);
    else next.set(k, v);
  }
  return next;
}

const STATUS_NOTES = {
  not_configured: "An administrator must set this up in Settings.",
  not_granted:
    "An administrator must turn on natural-language search for your account.",
} as const;

type Outcome = { notes: ProseNote[]; applied: boolean; snapshot: string };

/** Plain-words search: the server drafts filters from the text and answers a
 * URL patch plus notes. The text lives only in this component's state —
 * never in the URL. */
export function ProseSearchField({
  type,
}: {
  type: "all" | "movie" | "scene";
}) {
  const { proseSearchStatus } = useSession();
  const params = useSearchParams();
  const setP = useParamsSetter();
  const inputId = useId();
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const refocus = useRef(false);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Disabling the focused input drops focus to the page; give it back.
  useEffect(() => {
    if (running || !refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [running]);

  const ready = proseSearchStatus === "ready";
  const trimmed = text.trim();
  const statusNote = ready ? null : STATUS_NOTES[proseSearchStatus];

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || running || trimmed.length < 2) return;
    refocus.current = document.activeElement === inputRef.current;
    setRunning(true);
    setOutcome(null);
    setError(null);
    try {
      const result = await api<ProseSearchResult>("/api/browse/prose", {
        method: "POST",
        body: JSON.stringify({ text: trimmed, type }),
      });
      // Browse left while the server worked: its filters belong elsewhere.
      if (!live.current) return;
      setOutcome({
        notes: result.notes,
        applied: result.params !== null,
        snapshot: browseSnapshot(
          patchedSearch(window.location.search, result.params),
        ),
      });
      if (result.params !== null) setP(result.params, { push: true });
    } catch (err) {
      if (live.current) setError(messageOf(err));
    } finally {
      if (live.current) setRunning(false);
    }
  };

  // Notes describe one applied result: once the filters move (an edit, Back),
  // they no longer describe what the page shows.
  const shown = outcome !== null && outcome.snapshot === browseSnapshot(params);

  return (
    <form
      role="search"
      aria-label="Natural-language search"
      className="prose-search"
      onSubmit={(e) => void onSubmit(e)}
    >
      <label className="label" htmlFor={inputId}>
        Describe what you want
      </label>
      <div className="prose-search-row">
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          type="text"
          value={text}
          maxLength={PROSE_TEXT_MAX}
          placeholder="For example: Vixen scenes from 2019, newest first"
          disabled={!ready || running}
          aria-describedby={statusNote ? noteId : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-accent"
          disabled={!ready || running || trimmed.length < 2}
        >
          Search
        </button>
      </div>
      {statusNote && (
        <p id={noteId} className="cat-note">
          {statusNote}
        </p>
      )}
      <div aria-live="polite">
        {running && <p className="cat-note">Reading your search…</p>}
        {shown && (
          <>
            {!outcome.applied && <p className="cat-note">Nothing applied.</p>}
            {outcome.notes.length > 0 && (
              <ul className="prose-search-notes">
                {outcome.notes.map((n, i) => (
                  <li key={`${n.code}:${i}`} className="cat-note">
                    {n.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {error !== null && (
        <p className="cat-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
