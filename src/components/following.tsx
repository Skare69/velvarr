"use client";

/*
 * Following view: the list of performers the user follows, with the
 * performer detail page opened in place for a follow's id.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CatalogReference, PerformerFollow } from "../lib/contracts.ts";
import {
  api,
  ErrorPanel,
  Icon,
  ItemImage,
  imgSrc,
  messageOf,
  useParamsSetter,
} from "./shared.tsx";
import { PerformerView } from "./performer.tsx";

export function FollowingView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const [follows, setFollows] = useState<PerformerFollow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api<{ follows: PerformerFollow[] }>("/api/follows")
      .then((d) => {
        if (live) setFollows(d.follows);
      })
      .catch((e) => {
        if (live) setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [reload]);

  // Opening a performer stays on this view — the same URL carries the
  // performer page below. Push, so Back returns to the list.
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
    [setP],
  );

  // The row leaves the list only after the server confirmed the delete; a
  // failure keeps the row and says so.
  const unfollow = (f: PerformerFollow) => {
    setBusyId(f.id);
    setRowError(null);
    api<void>(
      `/api/follows/${f.reference.provider}/${encodeURIComponent(f.reference.id)}`,
      { method: "DELETE" },
    )
      .then(() => {
        setFollows((list) => (list ?? []).filter((x) => x.id !== f.id));
      })
      .catch((e) => {
        setRowError(`${f.name} is still followed — ${messageOf(e)}`);
      })
      .finally(() => setBusyId(null));
  };

  // Performer detail is this view's own detail page: provider + id in the
  // URL open it, and Back drops straight to the follow list. The kind is
  // checked, because a movie or scene id here is not a performer — this view
  // used to hand any id to the performer page, which then asked the provider
  // for a performer that never existed.
  const id = params.get("id");
  const provider = params.get("provider");
  const kind = params.get("kind");
  if (
    id &&
    (provider === "tpdb" || provider === "stashdb") &&
    (kind === null || kind === "performer")
  ) {
    return (
      <section aria-label="Performer">
        <PerformerView reference={{ provider, kind: "performer", id }} />
      </section>
    );
  }

  return (
    <section aria-label="Performers you follow">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Performers</h1>
        </div>
      </div>
      {rowError && <ErrorPanel title="Could not unfollow" message={rowError} />}
      {error ? (
        <ErrorPanel
          title="Follow list unavailable"
          message={error}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : follows === null ? (
        <div
          className="performer-grid"
          aria-label="Loading follows"
          aria-busy="true"
        >
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skel aspect-square" />
          ))}
        </div>
      ) : follows.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          You are not following anyone yet. Open a performer and press Follow —
          the star on their page — and they will appear here.
        </div>
      ) : (
        <div className="performer-grid">
          {follows.map((f) => (
            <div key={f.id} className="media-card performer-card follow-card">
              <button
                type="button"
                className="follow-open"
                onClick={() => open(f.reference)}
              >
                <div className="media-art aspect-square">
                  <ItemImage
                    name={f.name}
                    src={imgSrc(f.imageUrl ?? undefined)}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
                {/* No provider chip: a follow covers both metadata sources,
                    so naming one here would be a half-truth. The performer's
                    own page still says which source it is reading. */}
                <div className="media-meta">
                  <div className="media-title">{f.name}</div>
                </div>
              </button>
              <button
                type="button"
                className="follow-star"
                aria-label={`Unfollow ${f.name}`}
                disabled={busyId === f.id}
                onClick={() => unfollow(f)}
              >
                <Icon name="star" filled />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
