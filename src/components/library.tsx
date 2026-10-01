"use client";

/* Library Shell view: LibraryView grid plus the ItemDetail overlay page. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type {
  Library,
  LibraryItem,
  LibraryPage,
  MediaReference,
} from "../lib/contracts.ts";
import {
  CardStatusBadge,
  CardTypeBadge,
  ErrorPanel,
  FileFacts,
  Icon,
  ItemImage,
  detailParams,
  intOr,
  useApiGet,
  useParamsSetter,
} from "./shared.tsx";
import {
  DetailSections,
  type DetailPayload,
  type DetailTarget,
} from "./catalog-detail.tsx";
import { useBrowseTo } from "./catalog.tsx";

const runtime = (ticks?: number) =>
  ticks && ticks > 0 ? `${Math.round(ticks / 600_000_000)} min` : null;

/* ---------- Library ---------- */

export function LibraryView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const search = params.get("search") ?? "";
  const libraryId = params.get("libraryId") ?? "";
  const start = Math.max(0, intOr(params.get("start"), 0));
  const limitRaw = intOr(params.get("limit"), 24);
  const limit = limitRaw >= 1 && limitRaw <= 60 ? limitRaw : 24;
  const itemId = params.get("item");

  const [searchInput, setSearchInput] = useState(search);
  const closeItem = useCallback(() => setP({ item: null }), [setP]);

  const {
    data: libsData,
    error: libsError,
    reload: reloadLibs,
  } = useApiGet<{ libraries: Library[] }>("/api/libraries", []);
  const libs = libsData?.libraries ?? null;

  // ponytail: fixed 400ms debounce; typed-submit (Enter) flushes immediately
  useEffect(() => {
    if (searchInput === search) return;
    const t = setTimeout(
      () => setP({ search: searchInput || null, start: null }),
      400,
    );
    return () => clearTimeout(t);
  }, [searchInput, search, setP]);

  const gridQs = new URLSearchParams({
    start: String(start),
    limit: String(limit),
    search,
  });
  if (libraryId) gridQs.set("libraryId", libraryId);
  const {
    data: pageData,
    error: gridError,
    loading,
    reload,
  } = useApiGet<LibraryPage>(`/api/library?${gridQs}`, [
    start,
    limit,
    search,
    libraryId,
  ]);

  const items = pageData?.items ?? [];
  const end = pageData
    ? Math.min(pageData.start + pageData.items.length, pageData.total)
    : 0;
  const hasNext = pageData
    ? pageData.start + pageData.items.length < pageData.total
    : false;

  // Keyed per item: the hook keeps its last read, so an id change without a
  // remount would show the previous item's details until the fetch lands.
  if (itemId)
    return <ItemDetail key={itemId} id={itemId} onClose={closeItem} />;

  return (
    <section aria-label="Library">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Your library</h1>
          <p className="page-description">
            Browse your collection. Play directly in Jellyfin.
          </p>
        </div>
        <span className="chip">Jellyfin</span>
      </div>
      <div className="page-toolbar">
        <div className="sm:max-w-xs sm:flex-1">
          <label className="label" htmlFor="lib-search">
            Search your library
          </label>
          <input
            id="lib-search"
            type="search"
            className="input"
            placeholder="Search titles…"
            maxLength={200}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setP({ search: searchInput || null, start: null });
            }}
          />
        </div>
        <div className="sm:w-64">
          <label className="label" htmlFor="lib-filter">
            Library
          </label>
          {libsError ? (
            <ErrorPanel message={libsError} onRetry={reloadLibs} />
          ) : (
            <select
              id="lib-filter"
              className="input"
              value={libraryId}
              onChange={(e) =>
                setP({ libraryId: e.target.value || null, start: null })
              }
            >
              <option value="">All libraries</option>
              {(libs ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {gridError ? (
        <ErrorPanel
          title="Library unavailable"
          message={gridError}
          onRetry={reload}
        />
      ) : loading ? (
        <div className="poster-grid" aria-label="Loading library">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skel aspect-[2/3]" />
          ))}
        </div>
      ) : libs && libs.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          Your account has no library access yet. Ask an administrator to grant
          you libraries.
        </div>
      ) : items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {search || libraryId
            ? "No items match your search or filter."
            : "This library has no items yet."}
        </div>
      ) : (
        <>
          {/* ponytail: grid is uniformly 2:3 by operator choice, so a 16:9
              Jellyfin still is centre-cropped to about the middle third of
              its width by object-fit: cover. Upgrade path: per-item aspect
              detection from the Jellyfin image tags. */}
          <div className="poster-grid">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="media-card"
                onClick={() => setP({ item: it.id }, { push: true })}
              >
                <div className="media-art aspect-[2/3]">
                  <ItemImage
                    name={it.name}
                    src={it.image}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <CardTypeBadge kind={it.kind} />
                  {it.canPlay && (
                    <CardStatusBadge status="available" title={it.name} />
                  )}
                  <div className="media-quick-overlay">
                    <div className="media-quick-summary" aria-hidden="true">
                      {it.year && <span>{it.year}</span>}
                      <strong>{it.name}</strong>
                    </div>
                  </div>
                </div>
                <div className="media-meta">
                  <div className="media-title">{it.name}</div>
                  <div className="media-subtitle">
                    {[it.year, it.kind].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="text-sm text-muted">
              {pageData && pageData.total > 0
                ? `Items ${pageData.start + 1}–${end} of ${pageData.total}`
                : "No items"}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                disabled={start === 0}
                onClick={() => {
                  setP({ start: String(Math.max(0, start - limit)) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={!hasNext}
                onClick={() => {
                  setP({ start: String(start + limit) });
                  window.scrollTo({ top: 0 });
                }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- Library detail page ---------- */
function ItemDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const setP = useParamsSetter();

  const { data, error, reload } = useApiGet<{
    item: LibraryItem;
    catalog?: MediaReference;
    catalogNote?: string;
  }>(`/api/library/${encodeURIComponent(id)}`, [id]);
  const item = data?.item ?? null;
  const catalog = data?.catalog;
  const catalogNote = data?.catalogNote;
  const target: DetailTarget | undefined = catalog
    ? { provider: catalog.provider, kind: catalog.kind, id: catalog.id }
    : undefined;
  const browseTo = useBrowseTo();
  // Honest absence: a 404 here means the provider record is gone — no
  // detail sections render, never fake ones. The failure itself is stated
  // below the hero; discarding it left the page bare (card 440e5b8a).
  const {
    data: catDetail,
    error: catError,
    err: catErr,
    reload: reloadCat,
  } = useApiGet<DetailPayload>(
    catalog
      ? `/api/catalog/${catalog.provider}/${catalog.kind}/${encodeURIComponent(catalog.id)}`
      : null,
    [catalog?.provider, catalog?.kind, catalog?.id],
  );

  useEffect(() => {
    const scrollY = window.scrollY;
    panelRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.matches("input, textarea, select")
        )
      )
        onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => {
        // Restore only on return to this library, not when global search or navigation leaves it.
        const params = new URLSearchParams(window.location.search);
        if (params.get("view") === "library" && !params.has("item"))
          window.scrollTo({ top: scrollY });
      });
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="library-detail"
      aria-label="Item details"
    >
      <div className="page-heading">
        <button type="button" className="btn" onClick={onClose}>
          <Icon name="chevron-left" />
          Back to library
        </button>
        <span className="chip">In your library</span>
      </div>
      {error ? (
        <ErrorPanel title="Item unavailable" message={error} onRetry={reload} />
      ) : !item ? (
        <div
          className="skel h-96"
          aria-label="Loading details"
          aria-busy="true"
        />
      ) : (
        <>
          <div className="library-detail-hero">
            {item.image && (
              <img src={item.image} alt="" className="library-backdrop" />
            )}
            <div className="library-detail-poster">
              <ItemImage
                name={item.name}
                src={item.image}
                className="h-full w-full object-cover"
              />
            </div>
            <div className="library-detail-copy">
              <div className="flex flex-wrap gap-2">
                <span className="chip">{item.kind}</span>
                {item.year != null && <span className="chip">{item.year}</span>}
                {runtime(item.durationTicks) && (
                  <span className="chip">{runtime(item.durationTicks)}</span>
                )}
              </div>
              <h2>{item.name}</h2>
              {item.canPlay && item.watchUrl ? (
                <a
                  className="btn btn-accent"
                  href={item.watchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="play" />
                  Watch in Jellyfin
                </a>
              ) : (
                <p className="text-sm text-muted">
                  Playback is not available for this item or your account.
                </p>
              )}
              <FileFacts item={item} />
            </div>
          </div>
          {(!catalog || catError) && (
            <section className="library-overview" aria-label="Overview">
              <h3 className="mb-3 text-xl font-semibold text-ink">Overview</h3>
              <p>{item.overview || "No synopsis available."}</p>
            </section>
          )}
          {/* ponytail: identity is Whisparr path correspondence only; the
              upgrade path is mapping Jellyfin ProviderIds. */}
          {!catalog && (
            <p className="text-sm text-muted">
              Catalog details unavailable
              {catalogNote
                ? `: ${catalogNote}`
                : " — no provider match was found for this item's file paths."}
            </p>
          )}
          {catalog && catError ? (
            catErr?.status === 404 ? (
              // Authoritative absence, not an outage: stated, no retry.
              <p className="text-sm text-muted">
                Catalog details unavailable — this item is not in the provider
                catalog.
              </p>
            ) : (
              <ErrorPanel
                title="Catalog details unavailable"
                message={catError}
                onRetry={reloadCat}
              />
            )
          ) : null}
          {catalog && catDetail && target && (
            <DetailSections
              payload={catDetail}
              target={target}
              onNavigate={(r) => setP(detailParams(r), { push: true })}
              onBrowse={browseTo}
            />
          )}
        </>
      )}
    </div>
  );
}
