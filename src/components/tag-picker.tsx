"use client";

/*
 * One accessible tag picker for every tag surface: search include/exclude
 * filters and personal hidden tags all get the same combobox, the same
 * removable chips, the same keyboard story. It searches /api/browse/tags
 * (both providers at once) after the term settles. Include terms match with
 * AND and can contain OR groups. Exclusions and hidden tags stay flat.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  normalizeFacetName,
  type BrowseTagsResponse,
  type CatalogTagSelection,
} from "../lib/contracts.ts";
import { Icon, InfoTip, useApiGet } from "./shared.tsx";
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
export function isFreeText(t: CatalogTagSelection): boolean {
  return t.tpdb === undefined && t.stashdb === undefined;
}

/** Where a tag exists, in library terms: TPDB publishes movies, StashDB
 * scenes; both references means both. */
function sources(t: CatalogTagSelection): string {
  return [t.tpdb !== undefined && "Movies", t.stashdb !== undefined && "Scenes"]
    .filter((s): s is string => typeof s === "string")
    .join(", ");
}

/** One include row as the picker sees it: a single selection or — only in
 * an include picker with allowGroups — an "or" group, an array of 2+
 * selections that is ONE term ("Blonde or Redhead"). Exclude and hidden
 * tags stay single selections (the server parses them strict). */
type TagRow = CatalogTagSelection | CatalogTagSelection[];

type TagPickerBase = {
  id: string;
  label: string;
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
  /** Include and exclude pickers must not look alike: the chip carries a
   * "+" or "−" mark and an edge style, never color alone. */
  tone?: "include" | "exclude";
  /** Long matching rules, folded behind "How matching works". */
  help?: string;
};

type TagPickerProps = TagPickerBase &
  (
    | {
        allowGroups?: false;
        selected: CatalogTagSelection[];
        onChange: (tags: CatalogTagSelection[]) => void;
      }
    | {
        allowGroups: true;
        selected: TagRow[];
        onChange: (tags: TagRow[]) => void;
      }
  );

export function TagPicker(props: TagPickerProps) {
  const {
    id,
    label,
    description,
    disabled,
    allowFreeText = false,
    tone,
    help,
    allowGroups = false,
  } = props;
  // The union exists for the callers: with allowGroups unset the picker
  // can never emit a group, and the caller's types say so. Internally the
  // code works over the wide row shape and branches on Array.isArray.
  const rows = props.selected as TagRow[];
  const emit = props.onChange as (tags: TagRow[]) => void;
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Bind the target to this exact selection snapshot, not an index alone.
  const [orTarget, setOrTarget] = useState<{
    index: number;
    signature: string;
  } | null>(null);
  const selectionSignature = JSON.stringify(rows);
  const targetIndex =
    allowGroups && orTarget?.signature === selectionSignature
      ? orTarget.index
      : null;
  const targetRow = targetIndex === null ? undefined : rows[targetIndex];
  useEffect(() => {
    setOrTarget((target) =>
      target?.signature === selectionSignature && allowGroups && !disabled
        ? target
        : null,
    );
  }, [selectionSignature, allowGroups, disabled]);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = term.trim();
  // The debounce commits the term; the route only ever sees settled input.
  // Under two characters there is no query.
  const [committed, setCommitted] = useState<string | null>(null);
  useEffect(() => {
    if (t.length < 2) {
      setCommitted(null);
      return;
    }
    const timer = setTimeout(() => setCommitted(t), 400);
    return () => clearTimeout(timer);
  }, [t]);

  // The server's cap counts every member, so a group of 3 is 3 toward 25 —
  // the picker stops offering at the same number the server refuses at.
  const memberCount = rows.reduce(
    (n, r) => n + (Array.isArray(r) ? r.length : 1),
    0,
  );
  const capped = memberCount >= TAG_CAP;
  // useApiGet owns the stale-response guard: only the latest query's
  // response is ever applied.
  const { data, error, loading, reload } = useApiGet<BrowseTagsResponse>(
    disabled || capped || committed === null
      ? null
      : `/api/browse/tags?q=${encodeURIComponent(committed)}`,
    [committed],
  );

  // A tag already carried — alone or inside a group — is never offered
  // again.
  const picked = new Set(
    rows
      .flatMap((r) => (Array.isArray(r) ? r : [r]))
      .map((s) => normalizeFacetName(s.name)),
  );
  const take = (list: CatalogTagSelection[] | undefined) =>
    (list ?? []).filter(
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
    // A typed term commits as free text, never as the exact tag of the
    // same name: free text means "contains" ("anal" also matches
    // "Analingus" and "Anal Fisting"). Picking a listed row is the way to
    // ask for one exact tag.
    const chosen = tag;
    // One pick consumes the target. A stale target appends an AND term.
    setOrTarget(null);
    if (targetIndex !== null && targetRow !== undefined && allowGroups) {
      const members = Array.isArray(targetRow) ? targetRow : [targetRow];
      emit(rows.map((r, i) => (i === targetIndex ? [...members, chosen] : r)));
      setTerm("");
      setOpen(false);
      inputRef.current?.focus();
      return;
    }
    emit([...rows, chosen]);
    setTerm("");
    setOpen(false);
    inputRef.current?.focus();
  }

  /** Remove a whole term and cancel the next OR pick. */
  function removeRow(i: number) {
    setOrTarget(null);
    emit(rows.filter((_, j) => j !== i));
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
      {/* The rule text sits behind an info chip beside the label: the
          drawer stays short, and a tap opens it on touch too. */}
      <div className="label-row">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {(description !== undefined || help !== undefined) && (
          <InfoTip id={`${id}-info`} label={label}>
            {description !== undefined && <p>{description}</p>}
            {help !== undefined && <p>{help}</p>}
          </InfoTip>
        )}
      </div>
      {allowGroups && (
        <div className="tag-next">
          <span className="label" id={`${id}-next-label`}>
            Add next tag
          </span>
          <div
            className="segmented"
            role="group"
            aria-labelledby={`${id}-next-label`}
          >
            <button
              type="button"
              aria-pressed={targetRow === undefined}
              disabled={disabled || capped}
              onClick={() => setOrTarget(null)}
            >
              AND
            </button>
            <button
              type="button"
              aria-pressed={targetRow !== undefined}
              disabled={disabled || capped || rows.length === 0}
              onClick={() =>
                setOrTarget({
                  index: rows.length - 1,
                  signature: selectionSignature,
                })
              }
            >
              OR
            </button>
          </div>
        </div>
      )}
      {allowGroups && targetRow !== undefined && (
        <p className="cat-note tag-target" role="status">
          Add OR to “
          {Array.isArray(targetRow)
            ? targetRow.map((member) => member.name).join(" OR ")
            : targetRow.name}
          ”. Select AND to cancel.
        </p>
      )}
      <div className="input-lead">
        <Icon
          name={
            tone === "exclude" ? "minus" : tone === "include" ? "plus" : "tag"
          }
        />
        <input
          ref={inputRef}
          id={id}
          type="search"
          className="input"
          role="combobox"
          aria-describedby={
            description === undefined ? undefined : `${id}-info-text`
          }
          aria-expanded={showList}
          aria-controls={showList ? `${id}-listbox` : undefined}
          aria-activedescendant={
            showList ? `${id}-opt-${activeIdx}` : undefined
          }
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
      </div>
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
              Tag search failed: {error}{" "}
              <button type="button" className="btn" onClick={reload}>
                Retry search
              </button>
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
                      disabled={disabled || capped}
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
      {rows.length > 0 && (
        <ul
          className={`mt-2 flex list-none flex-wrap gap-1.5 p-0${allowGroups ? " tag-terms" : ""}`}
          aria-label={`Selected ${label}`}
        >
          {rows.map((row, i) => {
            const group = Array.isArray(row);
            const text = group ? row.map((m) => m.name).join(" OR ") : row.name;
            // Same chip as the active-filter row above Browse results, so
            // a tag looks the same in the drawer and on the page.
            const chip = (
              <button
                type="button"
                className={`filter-chip${
                  tone === "include"
                    ? " is-include"
                    : tone === "exclude"
                      ? " is-exclude"
                      : ""
                }`}
                disabled={disabled}
                onClick={() => removeRow(i)}
                aria-label={`Remove ${
                  group
                    ? "tag group"
                    : isFreeText(row)
                      ? "free-text tag"
                      : "tag"
                }: ${text}`}
              >
                {tone && (
                  <Icon
                    name={tone === "include" ? "plus" : "minus"}
                    className="filter-chip-mark"
                  />
                )}
                {!group && isFreeText(row) && (
                  <span className="text-muted">Free text:</span>
                )}
                <span className="tag-term-name">{text}</span>
                <span className="filter-chip-x" aria-hidden="true">
                  <Icon name="close" />
                </span>
              </button>
            );
            return (
              <li
                key={`${group ? "group" : "tag"}:${i}:${normalizeFacetName(group ? (row[0]?.name ?? "") : row.name)}`}
              >
                {allowGroups && i > 0 && (
                  <span className="tag-term-and">AND</span>
                )}
                {allowGroups ? (
                  <span className="filter-chip-with">
                    {chip}
                    <button
                      type="button"
                      className="filter-chip-or"
                      disabled={disabled || capped}
                      aria-pressed={targetIndex === i}
                      aria-label={`Add OR to “${text}”`}
                      onClick={() => {
                        setOrTarget({
                          index: i,
                          signature: selectionSignature,
                        });
                        inputRef.current?.focus();
                      }}
                    >
                      Add OR
                    </button>
                  </span>
                ) : (
                  chip
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
