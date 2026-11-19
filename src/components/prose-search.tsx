"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, Icon, messageOf, useParamsSetter, useSession } from "./shared";
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

/** Why the describe search is unavailable, in the same shape as Discover's
 * missing-key line: a neutral state chip, what is missing, then the fix — a
 * link for an administrator, who can make it, and a named person for
 * everyone else. */
const STATUS = {
  not_configured: {
    chip: "Not set up",
    text: "Natural-language search has no AI service yet.",
    fix: {
      href: "/?view=settings#prose-heading",
      label: "Set it up in Settings",
    },
    ask: "Ask an administrator to set it up.",
  },
  not_granted: {
    chip: "Off",
    text: "Natural-language search is off for your account.",
    fix: { href: "/?view=admin", label: "Turn it on in Users" },
    ask: "Ask an administrator to turn it on.",
  },
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
  const { proseSearchStatus, account } = useSession();
  const isAdmin = account.role === "admin";
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
  const status = ready ? null : STATUS[proseSearchStatus];
  const statusNote = status !== null;

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

  // The search is the toolbar's first group (same panel, caption and 32px
  // controls as Type and Sort); its status and notes sit on their own full
  // line under the toolbar row (.prose-search-status), so they never push
  // the controls apart.
  return (
    <>
      <form
        role="search"
        aria-label="Natural-language search"
        className="toolbar-group prose-group"
        onSubmit={(e) => void onSubmit(e)}
      >
        <label className="filter-group-name" htmlFor={inputId}>
          Describe
        </label>
        <div className="prose-field">
          <Icon name="sparkle" />
          <input
            ref={inputRef}
            id={inputId}
            className="input"
            type="text"
            value={text}
            maxLength={PROSE_TEXT_MAX}
            placeholder="Vixen, 2019, newest first"
            disabled={!ready || running}
            aria-describedby={statusNote ? noteId : undefined}
            onChange={(e) => setText(e.target.value)}
          />
          {/* Clears the typed text only, never the applied filters; the
              focus stays in the field for the next description. */}
          {text !== "" && !running && (
            <button
              type="button"
              className="prose-clear"
              aria-label="Clear the description"
              title="Clear the description"
              disabled={!ready}
              onClick={() => {
                setText("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
        {/* The house pending pattern (DESIGN.md Buttons): the action names
            what it is doing, with aria-busy, until the answer lands. */}
        <button
          type="submit"
          className="btn btn-accent"
          disabled={!ready || running || trimmed.length < 2}
          aria-busy={running || undefined}
        >
          {running ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="prose-search-status">
        {status !== null && (
          <p id={noteId} className="discovery-setup-line text-sm text-muted">
            <span className="chip">{status.chip}</span> {status.text}{" "}
            {isAdmin ? (
              <Link
                className="discovery-setup-link"
                href={status.fix.href}
                prefetch={false}
              >
                {status.fix.label}
                <Icon name="arrow-right" />
              </Link>
            ) : (
              status.ask
            )}
          </p>
        )}
        <div aria-live="polite">
          {running && (
            <p className="cat-note">
              Reading your search with the AI service. This can take up to 30
              seconds.
            </p>
          )}
          {shown && (
            <>
              {!outcome.applied && <p className="cat-note">Nothing applied.</p>}
              <ReadAsLine notes={outcome.notes} />
              {outcome.notes.some((n) => n.read === undefined) && (
                <ul className="prose-search-notes">
                  {outcome.notes.map(
                    (n, i) =>
                      n.read === undefined && (
                        <li key={`${n.code}:${i}`} className="cat-note">
                          {n.message}
                        </li>
                      ),
                  )}
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
      </div>
    </>
  );
}

/** Every reading in one quiet line: "Read as  young guy → Twink · anal
 * masturbation → Anal, Solo, Anal Toys". One phrase shows once, its
 * readings joined, in note order; the reading is in ink, the member's own
 * words stay muted. */
function ReadAsLine({ notes }: { notes: ProseNote[] }) {
  const byPhrase = new Map<string, string[]>();
  for (const n of notes) {
    if (n.read === undefined) continue;
    const to = byPhrase.get(n.read.from) ?? [];
    if (!to.includes(n.read.to)) to.push(n.read.to);
    byPhrase.set(n.read.from, to);
  }
  if (byPhrase.size === 0) return null;
  return (
    <p className="cat-note prose-read-as">
      <span className="prose-read-as-cap">Read as</span>
      {[...byPhrase].map(([from, to], i) => (
        <span key={from}>
          {i > 0 && (
            <span className="prose-read-as-sep" aria-hidden="true">
              ·
            </span>
          )}
          {from} → <b>{to.join(", ")}</b>
        </span>
      ))}
    </p>
  );
}
