"use client";

/* Library Shell view: LibraryView grid plus the ItemDetail overlay page. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type {
  CatalogDetailResponse,
  Library,
  LibraryItem,
  LibraryPage,
  MediaReference,
} from "../lib/contracts.ts";
import {
  api,
  CardStatusBadge,
  CardTypeBadge,
  EnlargeableImage,
  ErrorPanel,
  duration,
  FileFacts,
  ClampedText,
  Icon,
  ItemImage,
  detailParams,
  messageOf,
  ToolbarGroup,
  useApiGet,
  useGridColumns,
  useNearEnd,
  useCatalogSummary,
  useParamsSetter,
  useSession,
  wholeRows,
  type CatalogSummary,
} from "./shared.tsx";
import { DetailBody, type DetailTarget } from "./catalog-detail.tsx";
import { useBrowseTo, useSyncedInput } from "./catalog.tsx";

const runtime = (ticks?: number) =>
  ticks && ticks > 0 ? `${Math.round(ticks / 600_000_000)} min` : null;

/** A matched item reads its catalog summary once (shared cache), so the tile
 * shows the same facts as a Browse tile. */
function CatalogLibraryTile({
  item,
  catalog,
  onOpen,
}: {
  item: LibraryItem;
  catalog: MediaReference;
  onOpen: () => void;
}) {
  const summary = useCatalogSummary(catalog);
  return <LibraryTile item={item} summary={summary} onOpen={onOpen} />;
}

/** One grid tile: catalog facts once a match loaded (Browse's order: scene =
 * studio · date + performers, movie = year · studio), otherwise only what
 * Jellyfin reports. A failed or pending catalog read never fakes a fact. */
function LibraryTile({
  item,
  summary,
  onOpen,
}: {
  item: LibraryItem;
  summary?: CatalogSummary | null;
  onOpen: () => void;
}) {
  const scene = item.kind === "scene";
  const seconds =
    summary?.durationSeconds ??
    (item.durationTicks ? Math.round(item.durationTicks / 1e7) : undefined);
  const year = summary?.releaseDate?.slice(0, 4) ?? item.year;
  const subtitle = (
    summary
      ? scene
        ? [summary.studio, summary.releaseDate]
        : [year, summary.studio]
      : [item.year, item.kind]
  )
    .filter(Boolean)
    .join(" · ");
  const performers = scene ? summary?.performers?.join(", ") : undefined;
  const description = summary?.description ?? item.overview;
  return (
    <button type="button" className="media-card" onClick={onOpen}>
      <div className="media-art aspect-[2/3]">
        <ItemImage
          name={item.name}
          src={item.image}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <CardTypeBadge kind={item.kind} />
        {item.canPlay && (
          <CardStatusBadge status="available" title={item.name} />
        )}
        {scene && duration(seconds) && (
          <span className="media-runtime">{duration(seconds)}</span>
        )}
        <div className="media-quick-overlay">
          <div className="media-quick-summary" aria-hidden="true">
            {year && <span>{year}</span>}
            <strong>{item.name}</strong>
            {description && <p>{description}</p>}
          </div>
        </div>
      </div>
      <div className="media-meta">
        <div className="media-title">{item.name}</div>
        {subtitle && <div className="media-subtitle">{subtitle}</div>}
        {performers && <div className="media-subtitle">{performers}</div>}
      </div>
    </button>
  );
}

/* ---------- Library ---------- */

export function LibraryView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const search = params.get("search") ?? "";
  const libraryId = params.get("libraryId") ?? "";
  // The URL holds the order; the grid's own Sort control and the Recently
  // added entry point both write it.
  const sort = params.get("sort") === "dateAdded" ? "dateAdded" : null;
  const itemId = params.get("item");

  const {
    input: searchInput,
    setInput: setSearchInput,
    mark,
  } = useSyncedInput(search);
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
    const t = setTimeout(() => {
      mark(searchInput);
      setP({ search: searchInput || null });
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput, search, setP, mark]);

  // Endless scroll, the Browse pattern: a page is whole grid rows (nine
  // columns load 27, not 24), sized once from the first column count so a
  // later change (sidebar collapse, resize) never refetches; the display
  // trims to whole rows instead (wholeRows).
  const [gridRef, cols] = useGridColumns();
  const [limit, setLimit] = useState(0);
  useEffect(() => {
    if (limit === 0 && cols > 0)
      setLimit(Math.min(60, cols * Math.ceil(24 / cols)));
  }, [cols, limit]);
  const [acc, setAcc] = useState<{
    items: LibraryItem[];
    total: number;
    stalled: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [gridError, setGridError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const seqRef = useRef(0);
  const load = useCallback(
    async (start: number, mode: "reset" | "more") => {
      if (limit === 0) return;
      const seq = ++seqRef.current;
      if (mode === "reset") setAcc(null);
      setLoading(true);
      setGridError(null);
      const qs = new URLSearchParams({
        start: String(start),
        limit: String(limit),
        search,
      });
      if (libraryId) qs.set("libraryId", libraryId);
      if (sort) qs.set("sort", sort);
      try {
        const page = await api<LibraryPage>(`/api/library?${qs}`);
        if (seqRef.current !== seq) return;
        setAcc((prev) => {
          if (mode === "reset" || prev === null)
            return { items: page.items, total: page.total, stalled: false };
          const added = page.items.filter(
            (it) => !prev.items.some((p) => p.id === it.id),
          );
          return {
            items: [...prev.items, ...added],
            total: page.total,
            // The server merge never repeats an item across pages, but a
            // library that changed between two reads could: drop repeats.
            // A page that then adds no items cannot progress — end automatic
            // pagination, or the sentinel re-fires forever (same guard as
            // the browse grid).
            stalled: added.length === 0,
          };
        });
      } catch (e) {
        if (seqRef.current !== seq) return;
        setGridError(messageOf(e));
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    },
    [limit, search, libraryId, sort],
  );
  // Any filter, order or reload change restarts the grid at the top.
  useEffect(() => {
    void load(0, "reset");
  }, [load, reloadTick]);
  const items = acc?.items ?? [];
  const hasMore = acc !== null && !acc.stalled && acc.items.length < acc.total;
  const [sentinelRef, nearEnd] = useNearEnd(items.length > 0);
  useEffect(() => {
    if (!nearEnd || !hasMore || loading || gridError !== null) return;
    void load(items.length, "more");
  }, [nearEnd, hasMore, loading, gridError, items.length, load]);
  const retry = () => setReloadTick((n) => n + 1);

  return (
    <section aria-label="Library">
      {/* The grid stays mounted, hidden, while the detail is open — the card
          button that opened the item must still exist when ItemDetail's
          cleanup restores focus to it (same shape as the browse grid). */}
      <div hidden={itemId !== null}>
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
          <ToolbarGroup
            caption="Search"
            htmlFor="lib-search"
            className="sm:max-w-md sm:flex-1"
          >
            <input
              id="lib-search"
              type="search"
              className="input min-w-0 flex-1"
              placeholder="Search titles…"
              maxLength={200}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  mark(searchInput);
                  setP({ search: searchInput || null });
                }
              }}
            />
          </ToolbarGroup>
          {libsError ? (
            <ErrorPanel message={libsError} onRetry={reloadLibs} />
          ) : (
            <ToolbarGroup caption="Library" htmlFor="lib-filter">
              <select
                id="lib-filter"
                className="input"
                value={libraryId}
                onChange={(e) => setP({ libraryId: e.target.value || null })}
              >
                <option value="">All libraries</option>
                {(libs ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </ToolbarGroup>
          )}
          {/* Two orders the library route serves (title, date added); two
              exclusive choices read at once as segments (rule 39). */}
          <ToolbarGroup caption="Sort" captionId="lib-sort-label">
            <div
              role="group"
              aria-labelledby="lib-sort-label"
              className="segmented"
            >
              <button
                type="button"
                aria-pressed={sort === null}
                onClick={() => setP({ sort: null })}
              >
                Title
              </button>
              <button
                type="button"
                aria-pressed={sort === "dateAdded"}
                onClick={() => setP({ sort: "dateAdded" })}
              >
                Recently added
              </button>
            </div>
          </ToolbarGroup>
        </div>
        {/* Invisible zero-height probe with the grid's class: its column
            count sizes pages in whole rows before the first fetch. */}
        <div
          ref={gridRef}
          className="poster-grid"
          aria-hidden="true"
          style={{ height: 0, overflow: "hidden", visibility: "hidden" }}
        />

        {gridError !== null && acc === null ? (
          <ErrorPanel
            title="Library unavailable"
            message={gridError}
            onRetry={retry}
          />
        ) : acc === null ? (
          <div className="poster-grid" aria-label="Loading library">
            {Array.from({ length: limit || 24 }, (_, i) => (
              <div key={i} className="skel aspect-[2/3]" />
            ))}
          </div>
        ) : libs && libs.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-muted">
            Your account has no library access yet. Ask an administrator to
            grant you libraries.
          </div>
        ) : items.length === 0 ? (
          <div className="panel p-8 text-center text-sm text-muted">
            {search || libraryId ? (
              "No items match your search or filter."
            ) : (
              <>
                This library has no items yet.{" "}
                <Link
                  href="/?view=titles"
                  prefetch={false}
                  className="text-accent-text underline"
                >
                  Browse titles
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            {/* ponytail: grid is uniformly 2:3 by operator choice, so a 16:9
              Jellyfin still is centre-cropped to about the middle third of
              its width by object-fit: cover. Upgrade path: per-item aspect
              detection from the Jellyfin image tags. */}
            {/* The count leads the grid; Jellyfin's total is exact. */}
            <p className="mb-3 text-sm text-muted" role="status">
              {new Intl.NumberFormat().format(acc.total)}{" "}
              {acc.total === 1 ? "item" : "items"}
            </p>
            <div className="poster-grid">
              {wholeRows(items, cols, hasMore).map((it) => {
                const open = () => setP({ item: it.id }, { push: true });
                return it.catalog ? (
                  <CatalogLibraryTile
                    key={it.id}
                    item={it}
                    catalog={it.catalog}
                    onOpen={open}
                  />
                ) : (
                  <LibraryTile key={it.id} item={it} onOpen={open} />
                );
              })}
            </div>
            {loading && (
              <p className="mt-6 text-center text-sm text-muted" role="status">
                Loading more…
              </p>
            )}
            {!loading && gridError !== null && (
              <div className="mt-6 flex items-center justify-center gap-3 text-sm text-muted">
                <span>Couldn&rsquo;t load more items: {gridError}</span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void load(items.length, "more")}
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && gridError === null && acc?.stalled && (
              <div className="mt-6 flex items-center justify-center gap-3 text-sm text-muted">
                {/* The stall means the read window moved (items arrived
                    above it between two reads), so resuming at the same
                    offset would repeat it: Retry reloads from the top. */}
                <span>
                  More items exist, but the library changed while paging.
                </span>
                <button type="button" className="btn" onClick={retry}>
                  Retry
                </button>
              </div>
            )}
            <div ref={sentinelRef} aria-hidden="true" />
          </>
        )}
      </div>
      {/* Keyed per item: the hook keeps its last read, so an id change
          without a remount would show the previous item's details until the
          fetch lands. */}
      {itemId && <ItemDetail key={itemId} id={itemId} onClose={closeItem} />}
    </section>
  );
}

/* ---------- Library detail page ---------- */
function ItemDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const setP = useParamsSetter();

  // Captured at first render, before the panel takes focus. The null guard
  // is load-bearing: StrictMode's dev-only effect rerun (mount → cleanup →
  // mount) would otherwise recapture the already-focused panel after the
  // first cleanup ran, and the real close would try to refocus a detached
  // node — focus falls to <body> in every dev-server browser proof.
  if (prevFocus.current === null)
    prevFocus.current = document.activeElement as HTMLElement | null;

  const { data, error, reload } = useApiGet<{
    item: LibraryItem;
    catalog?: MediaReference;
    catalogNote?: string;
    catalogIssue?: "not_connected" | "ambiguous" | "failed";
  }>(`/api/library/${encodeURIComponent(id)}`, [id]);
  const item = data?.item ?? null;
  const catalog = data?.catalog;
  const catalogNote = data?.catalogNote;
  const catalogIssue = data?.catalogIssue;
  const isAdmin = useSession().account.role === "admin";
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
  } = useApiGet<CatalogDetailResponse>(
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
        // Escape inside an open modal dialog closes the dialog, not this
        // detail page under it.
        !document.querySelector("dialog[open]") &&
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
      // The grid is hidden, not unmounted, so the card that opened the
      // detail still exists and takes focus back (catalog-detail pattern).
      prevFocus.current?.focus();
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
      className="cat-detail"
      aria-label="Item details"
    >
      {/* Same frame as the title page (CatalogDetailView): width, back row
          and spacing come from .cat-detail / .cat-topline. */}
      <div className="cat-topline">
        <button type="button" className="btn" onClick={onClose}>
          <Icon name="chevron-left" /> Back to library
        </button>
      </div>
      {error ? (
        <ErrorPanel title="Item unavailable" message={error} onRetry={reload} />
      ) : !item ? (
        <div
          className="skel h-96"
          aria-label="Loading details"
          aria-busy="true"
        />
      ) : catalog && catDetail && target ? (
        // A matched item is its catalog title: the same hero (Play on
        // Jellyfin and the file facts come from the availability check),
        // tags, cast, aside and similar titles.
        <DetailBody
          payload={catDetail}
          target={target}
          onNavigate={(r) => setP(detailParams(r), { push: true })}
          onBrowse={browseTo}
          onRefetch={reloadCat}
          libraryItem={item}
        />
      ) : (
        <>
          {/* Unmatched (or the catalog read pending or failed): the same
              hero layout from what Jellyfin knows, facts in the side panel. */}
          <header
            className="cat-hero"
            style={
              item.image
                ? { backgroundImage: `url("${item.image}")` }
                : undefined
            }
          >
            <div className="cat-hero-scrim" aria-hidden="true" />
            <div className="cat-hero-inner">
              <EnlargeableImage
                name={item.name}
                imageUrl={item.image}
                frameClass="cat-poster block p-0"
                imgClass="cat-poster-img"
              />
              <div className="cat-hero-copy">
                {/* Every item here comes from Jellyfin, so the fact always
                    holds; same badge as a title page's availability. */}
                <span className="cat-badge cat-badge-available">
                  <Icon name="check" />
                  In your library
                </span>
                <h1 className="cat-hero-title">
                  {item.name}
                  {item.year != null && (
                    <>
                      {" "}
                      <span className="cat-hero-year">({item.year})</span>
                    </>
                  )}
                </h1>
                <div className="cat-hero-facts">
                  <FileFacts item={item} />
                </div>
                <div className="cat-hero-actions">
                  {item.canPlay && item.watchUrl ? (
                    <a
                      className="btn btn-accent"
                      href={item.watchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="play" />
                      Play on Jellyfin
                    </a>
                  ) : (
                    <p className="text-sm text-muted">
                      Playback is not available for this item or your account.
                    </p>
                  )}
                </div>
              </div>
              <section aria-label="Details" className="hero-facts">
                <dl>
                  <dt>Source</dt>
                  <dd>Jellyfin {item.kind}</dd>
                  {item.year != null && (
                    <>
                      <dt>Year</dt>
                      <dd>{item.year}</dd>
                    </>
                  )}
                  {runtime(item.durationTicks) && (
                    <>
                      <dt>Duration</dt>
                      <dd>{runtime(item.durationTicks)}</dd>
                    </>
                  )}
                </dl>
              </section>
            </div>
          </header>
          <section className="cat-section" aria-label="Overview">
            <h2 className="cat-section-title">Overview</h2>
            <ClampedText
              text={item.overview || "No synopsis available."}
              lines={5}
              className="mt-2"
              textClassName="cat-overview text-sm leading-relaxed text-muted"
            />
          </section>
          {/* ponytail: identity is Whisparr path correspondence only; the
              upgrade path is mapping Jellyfin ProviderIds. */}
          {/* Why there are no catalog details: one panel with a headline, a
              danger tone only for a failed lookup, and a next step only when
              one exists. */}
          {!catalog && (
            <div
              className={
                catalogIssue === "failed"
                  ? "catalog-note is-failed"
                  : "catalog-note"
              }
              role={catalogIssue === "failed" ? "alert" : "status"}
            >
              <strong>
                {catalogIssue === "not_connected"
                  ? "Catalog details are off"
                  : catalogIssue === "ambiguous"
                    ? "Match needs review"
                    : catalogIssue === "failed"
                      ? "Catalog lookup failed"
                      : "No catalog match"}
              </strong>
              <p>
                {catalogIssue === "not_connected"
                  ? "Velvarr matches library files to TPDB or StashDB through Whisparr, and Whisparr is not connected."
                  : catalogIssue === "ambiguous"
                    ? "More than one Whisparr title uses this file's folder. Velvarr does not guess which one."
                    : (catalogNote ??
                      "Whisparr has no title at this file's folder.")}
                {catalogIssue === "not_connected" &&
                  !isAdmin &&
                  " Ask an administrator to connect it."}
              </p>
              {catalogIssue === "not_connected" && isAdmin && (
                <Link
                  className="btn mt-3"
                  href="/?view=settings#whisparr-heading"
                  prefetch={false}
                >
                  <Icon name="settings" />
                  Open Whisparr settings
                </Link>
              )}
              {catalogIssue === "failed" && (
                <button type="button" className="btn mt-3" onClick={reload}>
                  <Icon name="refresh" />
                  Retry
                </button>
              )}
            </div>
          )}
          {catalog && catError ? (
            catErr?.status === 404 ? (
              // Authoritative absence, not an outage: stated, no retry.
              <p className="mt-4 text-sm text-muted">
                Catalog details unavailable — this item is not in the provider
                catalog.
              </p>
            ) : (
              <div className="mt-4">
                <ErrorPanel
                  title="Catalog details unavailable"
                  message={catError}
                  onRetry={reloadCat}
                />
              </div>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
