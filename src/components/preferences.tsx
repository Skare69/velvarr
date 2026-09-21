"use client";

/*
 * Personal content preferences: one account's hidden tags. Distinct from the
 * admin Settings view — every authenticated account gets this, no role gate.
 * The endpoint is session-scoped: the server always targets the signed-in
 * account, and this form never sends or reads an account id.
 */

import { useEffect, useState } from "react";
import type {
  CatalogTagSelection,
  ContentPreferences,
} from "../lib/contracts.ts";
import {
  ErrorPanel,
  PREFERENCES_CHANGED,
  api,
  messageOf,
  useApiGet,
} from "./shared.tsx";
import { TagPicker } from "./tag-picker.tsx";

export function PreferencesView() {
  const saved = useApiGet<ContentPreferences>("/api/me/preferences", []);
  const [draft, setDraft] = useState<CatalogTagSelection[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const loaded = saved.data?.hiddenTags ?? [];

  // Seed the draft from the first good read only; the read-back after a save
  // must never clobber edits made meanwhile.
  useEffect(() => {
    if (draft === null && saved.data !== null) setDraft(loaded);
  }, [draft, saved.data]);

  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(loaded);

  async function save() {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api<ContentPreferences>("/api/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ hiddenTags: draft }),
      });
      setDraft(updated.hiddenTags);
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
          selected={draft}
          onChange={setDraft}
          description="Titles carrying any hidden tag are left out of catalog Browse, Discover, search results and related titles. Search-time includes and excludes are separate and always temporary."
          disabled={saving}
        />
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
            }}
          >
            Reset changes
          </button>
          <button
            type="button"
            className="btn"
            disabled={draft.length === 0 || saving}
            onClick={() => setDraft([])}
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
        <h2 className="font-semibold">Content preferences</h2>
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
      <h2 className="font-semibold">Content preferences</h2>
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
