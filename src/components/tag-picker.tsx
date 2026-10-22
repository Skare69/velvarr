"use client";

/*
 * One accessible tag picker for every tag surface: search include/exclude
 * filters and personal hidden tags all get the same combobox, the same
 * removable chips, the same keyboard story. It searches /api/browse/tags
 * (both providers at once) after the term settles. Includes are always AND
 * and excludes always exclude, so there is deliberately no Any/All operator
 * here — the caller's `description` carries that per-surface help.
 */

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  exactBothProviderTag,
  normalizeFacetName,
  type BrowseTagsResponse,
  type CatalogTagSelection,
} from "../lib/contracts.ts";
import { initTagWait, reduceTagWait } from "../lib/tag-wait.ts";
import { useApiGet } from "./shared.tsx";
import "./catalog.css";

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

/** The typed term itself: a selection with no provider id, workable only
 * where matching runs locally. */
function isFreeText(t: CatalogTagSelection): boolean {
  return t.tpdb === undefined && t.stashdb === undefined;
}

/** Where a tag exists, in library terms: TPDB publishes movies, StashDB
 * scenes; both references means both. */
function sources(t: CatalogTagSelection): string {
  return [t.tpdb !== undefined && "Movies", t.stashdb !== undefined && "Scenes"]
    .filter((s): s is string => typeof s === "string")
    .join(", ");
}

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
  /** Offer the typed term itself as a label-only selection, pinned at the
   * top of the list and kept there even after real matches load. The
   * server expands an include on each provider's published tags — as the
   * native any-of filter when the expansion is complete and within the
   * native id cap, through the local substring re-check otherwise —
   * while excludes and hidden tags always match locally: the chip
   * carries no provider id, so it can never travel as an exact native
   * tag. When the settled search shows the term is a real tag both
   * providers publish, committing it selects that tag instead.
   */
  allowFreeText?: boolean;
}) {
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = term.trim();
  // The debounce commits the term; the route only ever sees settled input.
  // `awaitingFree` is a just-picked free-text chip awaiting proof that the
  // term is a real both-provider tag (VELV-46); the machine keeps it armed
  // only while an answer for it can still arrive (VELV-50).
  const [wait, waitTo] = useReducer(reduceTagWait, undefined, initTagWait);
  const committed = wait.committed;
  useEffect(() => {
    if (t.length < 2) {
      waitTo({ type: "release" });
      return;
    }
    const timer = setTimeout(() => waitTo({ type: "commit", term: t }), 400);
    return () => clearTimeout(timer);
  }, [t]);

  const capped = selected.length >= TAG_CAP;
  // useApiGet owns the stale-response guard: only the latest query's
  // response is ever applied.
  const { data, error, loading } = useApiGet<BrowseTagsResponse>(
    disabled || capped || committed === null
      ? null
      : `/api/browse/tags?q=${encodeURIComponent(committed)}`,
    [committed],
  );

  // The awaited answer landed: when it carries a tag both providers
  // publish under the term's normalized name, the just-added free-text
  // chip becomes that real tag; otherwise it stays free text. The query
  // is released either way (the debounce skip above ends with this).
  useEffect(() => {
    const term = wait.awaitingFree;
    if (term === null || loading) return;
    waitTo({ type: "consumed" });
    const both =
      error === null && data !== null
        ? exactBothProviderTag(data.tags, term)
        : undefined;
    if (both === undefined) return;
    const label = normalizeFacetName(term);
    onChange(
      selected.map((s) =>
        isFreeText(s) && normalizeFacetName(s.name) === label ? both : s,
      ),
    );
  }, [data, error, loading]);

  const picked = new Set(selected.map((s) => normalizeFacetName(s.name)));
  const take = (rows: CatalogTagSelection[] | undefined) =>
    (rows ?? []).filter(
      (r) => realTag(r) && !picked.has(normalizeFacetName(r.name)),
    );
  // A failed search hides the previous list; a partial source failure keeps
  // the returned tags and says so below.
  const current = committed === t && !loading;
  const listed = current && error === null ? take(data?.tags) : [];
  const options = listed;
  // The typed term itself: a real selection with no provider ids, workable
  // only where matching runs locally. It is pinned above the loaded matches
  // and stays offered even when a loaded tag normalizes to the same name —
  // the async load must never take the option away. Terms the server
  // refuses are never offered: a label with nothing left after
  // normalization ("日本", "++") can never match a tag, and one over the
  // server's 120-character cap would 400 the whole save.
  const freeText: CatalogTagSelection | null =
    allowFreeText &&
    t.length >= 2 &&
    t.length <= 120 &&
    normalizeFacetName(t) !== "" &&
    !picked.has(normalizeFacetName(t))
      ? { name: t }
      : null;
  // The free-text offer leads at all times, results loaded or not: the user
  // reads the list top-down and must find the option first even once real
  // matches arrive (efd5cfb's pin; 5c5d7d2 briefly let exact matches take
  // the top, which reads as the option disappearing on arrival). Exact
  // real-tag matches follow the offer: the route answers in provider order,
  // so they must be lifted past the other rows for the active row below to
  // name one.
  const nTerm = normalizeFacetName(t);
  const choices =
    freeText === null
      ? options
      : [
          freeText,
          ...options.filter((o) => normalizeFacetName(o.name) === nTerm),
          ...options.filter((o) => normalizeFacetName(o.name) !== nTerm),
        ];
  // Enter still lands on a real tag that exactly names the term (5c5d7d2's
  // point): the default active row starts on that match — the row right
  // after the pinned offer — and on the offer itself otherwise. While the
  // search is in flight the list holds only the offer, so the row falls
  // back to it.
  const exactLead =
    freeText !== null &&
    options.some((o) => normalizeFacetName(o.name) === nTerm);
  useEffect(() => setActive(exactLead ? 1 : 0), [committed, exactLead]);
  // Typing shrinks the list until the debounced search settles; a stored
  // index must never point past the rendered options.
  const activeIdx =
    choices.length === 0 ? 0 : Math.min(active, choices.length - 1);
  const sourceErrors = current && error === null ? (data?.errors ?? []) : [];
  const showList = open && choices.length > 0;

  function pick(tag: CatalogTagSelection) {
    if (disabled || capped || picked.has(normalizeFacetName(tag.name))) return;
    // A free-text commit that names a tag both providers publish is that
    // real tag instead (VELV-46): exact native ids on both sides beat a
    // label-only selection. When the rows are not settled yet, the chip
    // goes in as free text and the search fires now; the settled answer
    // promotes it in the effect above. A settled answer is final, so the
    // machine arms no wait for one (VELV-50). ponytail: only the latest
    // free-text pick is promoted — rapid consecutive free-text picks
    // keep the earlier chips free text.
    const swap = isFreeText(tag)
      ? exactBothProviderTag(options, tag.name)
      : undefined;
    if (isFreeText(tag) && swap === undefined)
      waitTo({ type: "pickFreeText", term: t, loading });
    onChange([...selected, swap ?? tag]);
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
      setActive(
        e.key === "ArrowDown"
          ? Math.min(activeIdx + 1, last)
          : Math.max(activeIdx - 1, 0),
      );
    } else if (e.key === "Enter") {
      // A tag field must never submit the surrounding form.
      e.preventDefault();
      if (showList && choices[activeIdx] !== undefined)
        pick(choices[activeIdx]);
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
        aria-activedescendant={showList ? `${id}-opt-${activeIdx}` : undefined}
        aria-autocomplete="list"
        maxLength={200}
        placeholder="Search tags…"
        disabled={disabled || capped}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          // A stored pointer describes the previous term's list; typing
          // always falls back to the default row.
          setActive(0);
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
          {showList && (
            <ul
              className="cat-picker"
              role="listbox"
              id={`${id}-listbox`}
              aria-label={`${label} matches`}
            >
              {choices.map((tag, i) => {
                // A free-text term can normalize to the same name as a
                // loaded tag; the label-only row needs its own key.
                const free = isFreeText(tag);
                return (
                  <li
                    key={
                      free
                        ? `free:${normalizeFacetName(tag.name)}`
                        : normalizeFacetName(tag.name)
                    }
                    role="presentation"
                  >
                    <button
                      type="button"
                      role="option"
                      id={`${id}-opt-${i}`}
                      aria-selected={i === activeIdx}
                      tabIndex={-1}
                      className="cat-picker-row"
                      style={
                        i === activeIdx
                          ? { borderColor: "var(--color-accent)" }
                          : undefined
                      }
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(tag)}
                      onMouseMove={() => setActive(i)}
                    >
                      <span>{tag.name}</span>
                      <span className="text-xs text-muted">
                        {free ? "Free text" : sources(tag)}
                      </span>
                      <span className="cat-picker-add" aria-hidden="true">
                        +
                      </span>
                    </button>
                  </li>
                );
              })}
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
                aria-label={`Remove ${
                  isFreeText(tag) ? "free-text tag" : "tag"
                }: ${tag.name}`}
              >
                {isFreeText(tag) && (
                  <span className="text-muted">Free text:</span>
                )}
                {tag.name} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
