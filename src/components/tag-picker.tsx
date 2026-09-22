"use client";

/*
 * One accessible tag picker for every tag surface: search include/exclude
 * filters and personal hidden tags all get the same combobox, the same
 * removable chips, the same keyboard story. It searches /api/browse/tags
 * (both providers at once) after the term settles. Includes are always AND
 * and excludes always exclude, so there is deliberately no Any/All operator
 * here — the caller's `description` carries that per-surface help.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  normalizeFacetName,
  type CatalogTagSelection,
} from "../lib/contracts.ts";
import { useApiGet } from "./shared.tsx";

/** The server caps one tag list at 25 — stop offering rather than let the
 * request 400. */
const TAG_CAP = 25;

/** Mirrors the server's UUID_RE; only real provider ids become chips. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept only real offered tags: a bounded label plus at least one provider
 * UUID. Anything else the network coughs up is dropped, never guessed into
 * a selection. */
function realTag(t: CatalogTagSelection): boolean {
  return (
    typeof t.name === "string" &&
    t.name.trim().length > 0 &&
    t.name.length <= 120 &&
    ((typeof t.tpdb === "string" && UUID_RE.test(t.tpdb)) ||
      (typeof t.stashdb === "string" && UUID_RE.test(t.stashdb)))
  );
}

/** Where a tag exists, in library terms: TPDB publishes movies, StashDB
 * scenes; both references means both. */
function sources(t: CatalogTagSelection): string {
  return [t.tpdb !== undefined && "Movies", t.stashdb !== undefined && "Scenes"]
    .filter((s): s is string => typeof s === "string")
    .join(", ");
}

type TagSearchResponse = {
  tags?: CatalogTagSelection[];
  /** Optional second chance (e.g. Jev suggestions) shown only when the
   * direct search found nothing; offered tags are accepted as-is. */
  suggestions?: CatalogTagSelection[];
  /** Per-source failures that still let the other source answer. */
  errors?: { provider: string; message: string }[];
};

export function TagPicker({
  id,
  label,
  selected,
  onChange,
  description,
  disabled,
  allowFreeText = false,
}: {
  id: string;
  label: string;
  selected: CatalogTagSelection[];
  onChange: (tags: CatalogTagSelection[]) => void;
  description?: string;
  disabled?: boolean;
  /** Offer the typed term itself as a label-only selection. Only for
   * surfaces that filter locally (excludes, hidden tags): a free-text
   * include cannot travel to a provider that filters on its own tag ids. */
  allowFreeText?: boolean;
}) {
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = term.trim();
  // The debounce commits the term; the route only ever sees settled input.
  const [committed, setCommitted] = useState<string | null>(null);
  useEffect(() => {
    if (t.length < 2) {
      setCommitted(null); // the route 400s under two characters
      return;
    }
    const timer = setTimeout(() => setCommitted(t), 400);
    return () => clearTimeout(timer);
  }, [t]);
  useEffect(() => setActive(0), [committed]);

  const capped = selected.length >= TAG_CAP;
  // useApiGet owns the stale-response guard: only the latest query's
  // response is ever applied.
  const { data, error, loading } = useApiGet<TagSearchResponse>(
    disabled || capped || committed === null
      ? null
      : `/api/browse/tags?q=${encodeURIComponent(committed)}`,
    [committed],
  );

  const picked = new Set(selected.map((s) => normalizeFacetName(s.name)));
  const take = (rows: CatalogTagSelection[] | undefined) =>
    (rows ?? []).filter(
      (r) => realTag(r) && !picked.has(normalizeFacetName(r.name)),
    );
  // A failed search hides the previous list; a partial source failure keeps
  // the returned tags and says so below.
  const current = committed === t && !loading;
  const listed = current && error === null ? take(data?.tags) : [];
  const suggested =
    current && error === null && listed.length === 0
      ? take(data?.suggestions)
      : [];
  const options = listed.length > 0 ? listed : suggested;
  // The typed term itself, when it matches no offered tag: a real selection
  // with no provider ids, workable only where matching runs locally.
  const freeText: CatalogTagSelection | null =
    allowFreeText &&
    t.length >= 2 &&
    !picked.has(normalizeFacetName(t)) &&
    !options.some((o) => normalizeFacetName(o.name) === normalizeFacetName(t))
      ? { name: t }
      : null;
  const choices = freeText === null ? options : [...options, freeText];
  const sourceErrors = current && error === null ? (data?.errors ?? []) : [];
  const showList = open && choices.length > 0;

  function pick(tag: CatalogTagSelection) {
    if (disabled || capped || picked.has(normalizeFacetName(tag.name))) return;
    onChange([...selected, tag]);
    setTerm("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (choices.length === 0) return;
      setOpen(true);
      const last = choices.length - 1;
      setActive((a) =>
        e.key === "ArrowDown" ? Math.min(a + 1, last) : Math.max(a - 1, 0),
      );
    } else if (e.key === "Enter") {
      // A tag field must never submit the surrounding form.
      e.preventDefault();
      if (showList && choices[active] !== undefined) pick(choices[active]);
    } else if (e.key === "Escape") {
      if (showList) {
        e.preventDefault();
        setOpen(false);
      } else if (term !== "") {
        setTerm("");
      }
    }
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {description !== undefined && (
        <p id={`${id}-hint`} className="cat-note">
          {description}
        </p>
      )}
      <input
        ref={inputRef}
        id={id}
        type="search"
        className="input"
        role="combobox"
        aria-describedby={description === undefined ? undefined : `${id}-hint`}
        aria-expanded={showList}
        aria-controls={showList ? `${id}-listbox` : undefined}
        aria-activedescendant={showList ? `${id}-opt-${active}` : undefined}
        aria-autocomplete="list"
        maxLength={200}
        placeholder="Search tags…"
        disabled={disabled || capped}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (choices.length > 0) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {capped ? (
        <p className="cat-note">
          Tag limit reached ({TAG_CAP}) — remove one before adding another.
        </p>
      ) : (
        <>
          {t.length > 0 && t.length < 2 && (
            <p className="cat-note">Type at least two characters.</p>
          )}
          {loading && <p className="cat-note">Searching tags…</p>}
          {error !== null && (
            <p className="cat-note" role="alert">
              Tag search failed: {error}
            </p>
          )}
          {sourceErrors.length > 0 && (
            <p className="cat-note">
              Some sources failed — showing the rest:{" "}
              {sourceErrors
                .map((e) => `${e.provider}: ${e.message}`)
                .join("; ")}
            </p>
          )}
          {showList && listed.length === 0 && suggested.length > 0 && (
            <p className="cat-note">Did you mean:</p>
          )}
          {showList && (
            <ul
              className="cat-picker"
              role="listbox"
              id={`${id}-listbox`}
              aria-label={`${label} suggestions`}
            >
              {choices.map((tag, i) => (
                <li key={normalizeFacetName(tag.name)} role="presentation">
                  <button
                    type="button"
                    role="option"
                    id={`${id}-opt-${i}`}
                    aria-selected={i === active}
                    tabIndex={-1}
                    className="cat-picker-row"
                    style={
                      i === active
                        ? { borderColor: "var(--color-accent)" }
                        : undefined
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(tag)}
                    onMouseMove={() => setActive(i)}
                  >
                    <span>{tag.name}</span>
                    <span className="text-xs text-muted">
                      {tag.tpdb === undefined && tag.stashdb === undefined
                        ? "Free text"
                        : sources(tag)}
                    </span>
                    <span className="cat-picker-add" aria-hidden="true">
                      +
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!showList &&
            error === null &&
            current &&
            committed !== null &&
            choices.length === 0 && (
              <p className="cat-note">No tags match “{t}”.</p>
            )}
        </>
      )}
      {selected.length > 0 && (
        <ul
          className="mt-2 flex list-none flex-wrap gap-1.5 p-0"
          aria-label={`Selected ${label}`}
        >
          {selected.map((tag, i) => (
            <li key={normalizeFacetName(tag.name)}>
              <button
                type="button"
                className="chip"
                disabled={disabled}
                onClick={() => onChange(selected.filter((_, j) => j !== i))}
                aria-label={`Remove tag: ${tag.name}`}
              >
                {tag.name} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
