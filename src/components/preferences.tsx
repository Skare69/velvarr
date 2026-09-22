"use client";

/*
 * Personal content preferences: one account's hidden tags and Discover
 * carousel order. Distinct from the admin Settings view — every authenticated
 * account gets this, no role gate. The endpoint is session-scoped: the server
 * always targets the signed-in account, and this form never sends or reads an
 * account id.
 */

import { useEffect, useState } from "react";
import {
  DISCOVER_SHELVES,
  type ContentPreferences,
  type DiscoverShelfId,
} from "../lib/contracts.ts";
import {
  ErrorPanel,
  PREFERENCES_CHANGED,
  api,
  messageOf,
  useApiGet,
} from "./shared.tsx";
import { TagPicker } from "./tag-picker.tsx";

const DEFAULT_ORDER: DiscoverShelfId[] = DISCOVER_SHELVES.map((s) => s.id);

function shelfTitle(id: DiscoverShelfId): string {
  return DISCOVER_SHELVES.find((s) => s.id === id)?.title ?? id;
}

export function PreferencesView() {
  const saved = useApiGet<ContentPreferences>("/api/me/preferences", []);
  const [draft, setDraft] = useState<ContentPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [announce, setAnnounce] = useState("");

  const loaded = saved.data;

  // Seed the draft from the first good read only; the read-back after a save
  // must never clobber edits made meanwhile.
  useEffect(() => {
    if (draft === null && loaded !== null)
      setDraft({
        hiddenTags: loaded.hiddenTags,
        discoverOrder: loaded.discoverOrder,
      });
  }, [draft, loaded]);

  const dirty =
    draft !== null &&
    loaded !== null &&
    JSON.stringify(draft) !== JSON.stringify(loaded);

  // Keyed by shelf id, so a move reorders the DOM node instead of replacing
  // it — focus rides along with the row. Exception: when the move disables
  // the focused control (a row reaching a boundary), the browser drops it, so
  // focus is parked on the moved row's remaining enabled button.
  function move(id: DiscoverShelfId, to: number) {
    if (draft === null) return;
    const order = [...draft.discoverOrder];
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setDraft({ ...draft, discoverOrder: order });
    setAnnounce(
      `${shelfTitle(id)} moved to position ${to + 1} of ${order.length}.`,
    );
    const pressed = document.activeElement;
    const row = pressed?.closest(`li[data-id="${id}"]`);
    if (pressed instanceof HTMLButtonElement && row instanceof HTMLElement) {
      requestAnimationFrame(() => {
        // Refocus the same control when the move left it enabled, so a
        // repeated Enter/Space keeps moving the row in that direction; only
        // when the move disabled it (a boundary) fall to the row's remaining
        // enabled button.
        const target =
          pressed.isConnected && !pressed.disabled
            ? pressed
            : row.querySelector<HTMLButtonElement>("button:not(:disabled)");
        target?.focus();
      });
    }
  }

  async function save() {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api<ContentPreferences>("/api/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          hiddenTags: draft.hiddenTags,
          discoverOrder: draft.discoverOrder,
        }),
      });
      setDraft(updated);
      window.dispatchEvent(new Event(PREFERENCES_CHANGED));
      setSavedOnce(true);
      // Confirm against a durable read-back, not the PATCH echo.
      saved.reload();
    } catch (e: unknown) {
      // Draft untouched: a failed save keeps every choice on screen.
      setSaveError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  // Keyed by shelf id, so a move reorders the DOM node instead of replacing
  // it — keyboard focus rides along with the row, even to a boundary.
  const orderList =
    draft === null ? null : (
      <section aria-labelledby="discover-order-label" className="mt-5">
        <h3 id="discover-order-label" className="font-semibold">
          Discover shelf order
        </h3>
        <p className="mt-1 text-sm text-muted">
          Sets the order Discover shows its shelves in. Every shelf is listed;
          only “From performers you follow” appears on Discover when it has
          content — before you follow anyone it is absent, but keeps its place
          here.
        </p>
        <ol
          aria-label="Discover shelves, first shown first"
          className="mt-3 list-none space-y-1 p-0"
        >
          {draft.discoverOrder.map((id, i) => {
            const title = shelfTitle(id);
            return (
              <li
                key={id}
                data-id={id}
                className="flex items-center gap-3 rounded border border-edge px-3 py-1"
              >
                <span
                  aria-hidden="true"
                  className="chip w-6 shrink-0 text-center"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">{title}</span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn h-11 w-11 p-0"
                    disabled={saving || i === 0}
                    aria-label={`Move ${title} up (position ${i + 1} of ${draft.discoverOrder.length})`}
                    onClick={() => move(id, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn h-11 w-11 p-0"
                    disabled={saving || i === draft.discoverOrder.length - 1}
                    aria-label={`Move ${title} down (position ${i + 1} of ${draft.discoverOrder.length})`}
                    onClick={() => move(id, i + 1)}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        <span role="status" className="mt-1 block text-sm text-muted">
          {announce}
        </span>
      </section>
    );

  const form =
    draft === null ? null : (
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TagPicker
          id="pref-hidden-tags"
          label="Hidden tags"
          selected={draft.hiddenTags}
          onChange={(hiddenTags) =>
            setDraft((d) => (d === null ? d : { ...d, hiddenTags }))
          }
          allowFreeText
          description="Titles carrying any hidden tag are left out of catalog Browse, Discover, search results and related titles. A hidden tag also covers the tags that contain it as a whole word — hiding Anal hides Anal Creampie, but never Analingus. Search-time includes and excludes are separate and always temporary."
          disabled={saving}
        />
        {orderList}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save preferences"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(loaded);
              setSaveError(null);
              setAnnounce("");
            }}
          >
            Reset changes
          </button>
          <button
            type="button"
            className="btn"
            disabled={
              saving ||
              JSON.stringify(draft.discoverOrder) ===
                JSON.stringify(DEFAULT_ORDER)
            }
            onClick={() => {
              setDraft((d) =>
                d === null ? d : { ...d, discoverOrder: DEFAULT_ORDER },
              );
              setAnnounce("Discover shelf order restored to default.");
            }}
          >
            Restore default order
          </button>
          <button
            type="button"
            className="btn"
            disabled={draft.hiddenTags.length === 0 || saving}
            onClick={() =>
              setDraft((d) => (d === null ? d : { ...d, hiddenTags: [] }))
            }
          >
            Remove all hidden tags
          </button>
          <span role="status" className="text-sm text-muted">
            {savedOnce && !dirty && !saving && saveError === null
              ? "Preferences saved."
              : ""}
          </span>
        </div>
        {saveError !== null && (
          <p className="cat-note mt-2" role="alert">
            Saving failed — your changes are kept. {saveError}
          </p>
        )}
      </form>
    );

  if (saved.error !== null && saved.data === null) {
    return (
      <div className="panel p-5">
        <h2 className="font-semibold">Content &amp; Discover preferences</h2>
        <ErrorPanel
          title="Preferences unavailable"
          message={saved.error}
          onRetry={saved.reload}
        />
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <h2 className="font-semibold">Content &amp; Discover preferences</h2>
      <p className="mt-1 text-sm text-muted">
        Hidden tags are personal: they hide movies and scenes carrying them from
        catalog Browse, Discover, search results and related titles. This works
        through provider metadata, so it is a viewing preference — not an access
        restriction: direct links, your requests and your library history are
        unaffected, and your list applies to your account only.
      </p>
      {form ?? <p className="cat-note">Loading preferences…</p>}
      {saved.error !== null && saved.data !== null && (
        <ErrorPanel
          title="Could not refresh preferences"
          message={saved.error}
          onRetry={saved.reload}
        />
      )}
    </div>
  );
}
