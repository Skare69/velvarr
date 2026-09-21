"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { filterNames } from "./catalog";
import "./discover.css";
import type {
  CatalogDetail,
  CatalogReference,
  LibraryItem,
  RequestDecision,
  RequestRecord,
} from "../lib/contracts";
import {
  CardStatusBadge,
  type CardStatusKind,
  CardTypeBadge,
  detailParams,
  ErrorPanel,
  Icon,
  imgSrc,
  ItemImage,
  api,
  messageOf,
  MovieCard,
  PerformerCard,
  SceneCard,
  useParamsSetter,
  useCatalogSummary,
} from "./shared";

/* Wire shapes mirroring the server's discover response (route.ts Shelf).
 * Kept local: contracts.ts stays domain records; the shelf envelope is a
 * response contract. An errored shelf carries `error` and NO `items` key. */
interface ShelfError {
  code: string;
  message: string;
}

type Genre = { id: string; name: string; imageUrl?: string };

interface Shelf {
  id: string;
  title: string;
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests" | "studios" | "genres";
  items?: CatalogDetail[] | LibraryItem[] | RequestRecord[] | Genre[];
  error?: ShelfError;
}

interface DiscoverPage {
  shelves: Shelf[];
}

/* ---------- Page fetch: one GET, shared across mounts ---------- */

// ponytail: module-level page cache — discover is a homepage snapshot, remounts
// reuse it until a retry or full reload; drop it if per-shelf freshness matters.
let cache: DiscoverPage | null = null;
let inflight: Promise<DiscoverPage> | null = null;

function fetchDiscover(): Promise<DiscoverPage> {
  inflight ??= api<DiscoverPage>("/api/discover")
    .then((page) => {
      cache = page;
      return page;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/* ---------- Small helpers (same conventions as catalog.tsx) ---------- */

function sourceLabel(s: Shelf["source"]): string {
  return s === "tpdb"
    ? "TPDB"
    : s === "stashdb"
      ? "StashDB"
      : s === "jellyfin"
        ? "Jellyfin"
        : "Velvarr";
}

/** Server labels provider shelves view:"catalog"; the URL contract's surfaces
 * are movies|scenes keyed by the shelf's own kind param. */
function targetView(shelf: Shelf): string {
  if (!shelf.browse) return "discover";
  if (shelf.browse.view === "catalog")
    return shelf.browse.params.kind === "scene" ? "scenes" : "movies";
  return shelf.browse.view;
}

/** A browse link starts fresh: filters from another surface never leak in. */
function browseHref(
  shelf: Shelf,
  filters: Record<string, string> = {},
): string {
  return `/?${new URLSearchParams({
    view: targetView(shelf),
    ...shelf.browse?.params,
    ...filters,
  })}`;
}

const NOT_CONFIGURED_CODES = ["provider_not_configured", "not_configured"];

const DATE_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/* ---------- Skeletons: same geometry as the final rail ---------- */

function RailSkeleton({ count }: { count: number }) {
  return (
    <div className="discovery-rail" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="discovery-tile discovery-tile-poster">
          <div className="skel w-full aspect-[2/3]" />
        </div>
      ))}
    </div>
  );
}

/* ---------- Rail plumbing: snap scroller + edge-aware Previous/Next ---------- */

/** Page the rail this header owns. Disabled state mirrors the real scroll
 * edges; scroll + ResizeObserver keep it honest while images load. */
function useRailNav(label: string, hasRail: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // The rail carries its own inline padding so focus rings are not clipped,
    // and revealing a tile parks it a few pixels in — so "at the start" is a
    // slack of that padding, not an exact zero, or Previous reads enabled
    // while there is nothing behind it.
    const slack = parseFloat(getComputedStyle(el).paddingLeft) || 1;
    setEdges({
      start: el.scrollLeft <= slack,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - slack,
    });
  }, []);

  useEffect(() => {
    sync();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, hasRail]);

  const nudge = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollBy({
      left: dir * el.clientWidth,
      behavior: reduce ? "auto" : "smooth",
    });
  };

  const nav = (
    <div className="discovery-rail-nav">
      <button
        type="button"
        className="discovery-scroll-button"
        aria-label={`Scroll ${label} back`}
        disabled={edges.start}
        onClick={() => nudge(-1)}
      >
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="discovery-scroll-button"
        aria-label={`Scroll ${label} forward`}
        disabled={edges.end}
        onClick={() => nudge(1)}
      >
        <Icon name="chevron-right" />
      </button>
    </div>
  );

  return { ref, nav, onScroll: sync };
}

/** Provider-native facets reuse the same filtered Movies/Scenes destinations. */
function FacetTile({
  shelf,
  item,
}: {
  shelf: Shelf;
  item: CatalogDetail | Genre;
}) {
  const studio = "reference" in item;
  const id = studio ? item.reference.id : item.id;
  const name = studio ? item.title : item.name;
  // A studio rail shows brand marks; its portrait poster belongs to the hero,
  // and a studio with neither stays a plain name.
  const art = studio ? (item.logoUrl ?? item.imageUrl) : item.imageUrl;
  return (
    <div className="discovery-tile discovery-tile-facet">
      <Link
        href={browseHref(shelf, { [studio ? "studio" : "tags"]: id })}
        prefetch={false}
        className={`discovery-facet discovery-facet-${studio ? "studio" : "genre"}`}
        onClick={() =>
          filterNames.set(
            `${shelf.source}:${studio ? "studio" : "tag"}:${id}`,
            name,
          )
        }
      >
        {art && (
          <ItemImage
            src={imgSrc(art)}
            name=""
            className={studio ? "discovery-studio-logo" : "discovery-facet-art"}
          />
        )}
        <span className="discovery-facet-name">{name}</span>
      </Link>
    </div>
  );
}

/* ---------- Shelf bodies ---------- */

/** Shared catalog cards, sized by the rail tile: portrait movies and square
 * performers, landscape scenes. */
function CatalogTile({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const kind = item.reference.kind;
  return (
    <div className="discovery-tile discovery-tile-poster">
      {kind === "scene" ? (
        <SceneCard item={item} onOpen={onOpen} />
      ) : kind === "performer" ? (
        <PerformerCard item={item} onOpen={onOpen} />
      ) : (
        <MovieCard item={item} onOpen={onOpen} />
      )}
    </div>
  );
}

/** The decision is the request's state, not playback: an approval means the
 * request was accepted, never that the title is watchable. */
const DECISION_LABELS: Record<RequestDecision, string> = {
  pending: "Pending approval",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

function RequestTile({
  item,
  onOpen,
}: {
  item: RequestRecord;
  onOpen: (r: CatalogReference) => void;
}) {
  const art = useCatalogSummary(item.media);
  const label = DECISION_LABELS[item.decision];
  const statusKind: CardStatusKind =
    item.decision === "approved"
      ? "approved"
      : item.decision === "pending"
        ? "requested"
        : "declined";

  return (
    <div className="discovery-tile discovery-tile-poster">
      <button
        type="button"
        className="discovery-art-card media-card"
        onClick={() => onOpen(item.media)}
        aria-label={`Request ${art?.title ?? item.media.id} — ${label}; open catalog details`}
      >
        <div className="discovery-art">
          <ItemImage
            name={art?.title ?? "·"}
            src={art ? imgSrc(art.imageUrl) : undefined}
          />
          <CardTypeBadge kind={item.media.kind} />
          <CardStatusBadge status={statusKind} title={art?.title} />
          <div className="media-quick-overlay">
            <div className="media-quick-summary" aria-hidden="true">
              <strong>
                {art === undefined
                  ? "Loading…"
                  : (art?.title ??
                    `${item.media.provider} · ${item.media.kind} · ${item.media.id}`)}
              </strong>
              <p>{DATE_FMT.format(item.createdAt)}</p>
            </div>
            <div className="media-quick-action">
              <span
                className={`btn${item.decision === "pending" ? " btn-accent" : ""}`}
              >
                <Icon
                  name={statusKind === "approved" ? "check" : "hourglass"}
                />
                {label}
              </span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

/** Jellyfin tiles: the item image is already a same-origin /api/images path,
 * and the outward link appears only when playback is genuinely permitted;
 * otherwise the tile says so instead of implying availability. The art opens
 * the library item page — a Jellyfin item has no provider identity, so the
 * catalog detail page is not its destination, but a tile must still open
 * something. */
function LibraryTile({ item }: { item: LibraryItem }) {
  const setP = useParamsSetter();
  const mins =
    item.durationTicks != null && item.durationTicks > 0
      ? Math.round(item.durationTicks / 600000000)
      : null;
  return (
    <div className="discovery-tile discovery-tile-poster">
      <div className="discovery-art-card media-card">
        <button
          type="button"
          className="media-open"
          onClick={() =>
            setP({ view: "library", item: item.id }, { push: true })
          }
          aria-label={`Open ${item.name}`}
        >
          <div className="discovery-art">
            <ItemImage name={item.name} src={item.image} />
            <CardTypeBadge kind={item.kind} />
            <CardStatusBadge status="available" title={item.name} />
          </div>
        </button>
        <div className="media-quick-overlay">
          <div className="media-quick-summary" aria-hidden="true">
            {item.year && <span>{item.year}</span>}
            <strong>{item.name}</strong>
            {item.overview ? (
              <p>{item.overview}</p>
            ) : (
              mins !== null && <p>{mins} min</p>
            )}
          </div>
          <div className="media-quick-action">
            {item.canPlay && item.watchUrl ? (
              <a
                className="btn btn-accent"
                href={item.watchUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${item.name} in Jellyfin`}
              >
                <Icon name="play" /> Jellyfin
              </a>
            ) : (
              <span className="discovery-library-note">No playback access</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- One shelf: header + body by kind ---------- */

function ShelfSection({
  shelf,
  busy,
  onRetry,
  onOpen,
}: {
  shelf: Shelf;
  busy: boolean;
  onRetry: () => void;
  onOpen: (r: CatalogReference) => void;
}) {
  /* One rail body per shelf kind; panel bodies (errors/empty) get none. */
  const catalogItems = shelf.items?.filter(
    (it): it is CatalogDetail => "reference" in it,
  );
  const libraryItems = shelf.items?.filter(
    (it): it is LibraryItem => "canPlay" in it,
  );
  const requestItems = shelf.items?.filter(
    (it): it is RequestRecord => "media" in it,
  );

  const railLabel = `${shelf.title} rail`;
  /* Only rail bodies get Previous/Next; panel bodies (errors/empty) none. */
  const hasRail = !shelf.error && !!shelf.items && shelf.items.length > 0;
  const rail = useRailNav(railLabel, hasRail);

  let body: ReactNode;
  if (shelf.error) {
    if (busy) {
      // Retrying the page: keep the shelf slot reserved with its skeleton.
      body = <RailSkeleton count={6} />;
    } else if (NOT_CONFIGURED_CODES.includes(shelf.error.code)) {
      // A missing key is stated as a missing key — never an outage, never
      // an empty catalog, never with a retry that cannot help.
      body = (
        <div className="discovery-shelf-body panel p-4">
          <span className="chip chip-accent">Not configured</span>
          <p className="mt-2 text-sm text-muted">
            {sourceLabel(shelf.source)} has no API key on this server, so this
            shelf cannot be filled. Add the key under Settings — that is a
            missing credential, not an outage.
          </p>
        </div>
      );
    } else {
      body = (
        <ErrorPanel
          title={`${sourceLabel(shelf.source)} is unavailable`}
          message={shelf.error.message}
          onRetry={onRetry}
        />
      );
    }
  } else if (!shelf.items || shelf.items.length === 0) {
    body = (
      <div className="discovery-shelf-body panel p-4 text-sm text-muted">
        Nothing here yet.
      </div>
    );
  } else {
    const tiles: ReactNode[] = [];
    if (shelf.kind === "genres" || shelf.kind === "studios") {
      for (const it of shelf.items) {
        if ("reference" in it || ("name" in it && !("canPlay" in it))) {
          tiles.push(
            <FacetTile
              key={"reference" in it ? it.reference.id : it.id}
              shelf={shelf}
              item={it}
            />,
          );
        }
      }
    } else if (requestItems && requestItems.length > 0) {
      for (const r of requestItems)
        tiles.push(<RequestTile key={r.id} item={r} onOpen={onOpen} />);
    } else if (libraryItems && libraryItems.length > 0) {
      libraryItems.forEach((it, i) =>
        tiles.push(<LibraryTile key={`${shelf.id}-${i}`} item={it} />),
      );
    } else {
      for (const it of catalogItems ?? [])
        tiles.push(
          <CatalogTile key={it.reference.id} item={it} onOpen={onOpen} />,
        );
    }
    body = (
      <div
        ref={rail.ref}
        className="discovery-rail"
        aria-label={railLabel}
        tabIndex={0}
        onScroll={rail.onScroll}
      >
        {tiles}
      </div>
    );
  }

  return (
    <section className="discovery-shelf" aria-busy={busy || undefined}>
      <div className="discovery-shelf-head">
        <h3 className="discovery-shelf-title">
          {shelf.browse ? (
            <Link
              className="discovery-shelf-link"
              href={browseHref(shelf)}
              prefetch={false}
            >
              {shelf.title}
              <span className="discovery-browse-icon">
                <Icon name="arrow-right" />
              </span>
            </Link>
          ) : (
            shelf.title
          )}
        </h3>
        {hasRail && rail.nav}
      </div>
      {body}
    </section>
  );
}

/* ---------- The discover homepage ---------- */

const PAGE_HEADING = (
  <header className="page-heading">
    <div>
      <h2 className="page-title">Discover</h2>
    </div>
  </header>
);

export function DiscoverShelves() {
  const setP = useParamsSetter();
  const [page, setPage] = useState(cache);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(cache === null);

  const load = useCallback((force: boolean) => {
    if (!force && cache) {
      setPage(cache);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    fetchDiscover()
      .then((p) => {
        setPage(p);
        setBusy(false);
      })
      .catch((e: unknown) => {
        setError(messageOf(e));
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Catalog cards open the detail over the matching surface view; the
  // destination view mounts the shared detail for provider+kind+id.
  // Surface/detail transitions push a history entry so Back returns here.
  const openDetail = useCallback(
    (r: CatalogReference) => setP(detailParams(r), { push: true }),
    [setP],
  );

  // Presentation order only: what was added (library), then requests, then
  // the provider shelves in the server's order. Titles stay the server's own
  // honest words.
  const ORDER: Record<Shelf["kind"], number> = {
    library: 0,
    requests: 1,
    catalog: 2,
    studios: 2,
    genres: 2,
  };

  const shelves = page
    ? [...page.shelves].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    : [];

  if (busy && !page) {
    return (
      <section aria-label="Discover" aria-busy="true">
        {PAGE_HEADING}
        <RailSkeleton count={5} />
        <RailSkeleton count={5} />
        <RailSkeleton count={6} />
        <RailSkeleton count={5} />
        <RailSkeleton count={5} />
      </section>
    );
  }
  if (error && !page) {
    return (
      <section aria-label="Discover">
        {PAGE_HEADING}
        <ErrorPanel
          title="Discover is unavailable"
          message={error}
          onRetry={() => load(true)}
        />
      </section>
    );
  }
  if (!page) return null;
  return (
    <section aria-label="Discover">
      {PAGE_HEADING}
      {shelves.map((s) => (
        <ShelfSection
          key={s.id}
          shelf={s}
          busy={busy}
          onRetry={() => load(true)}
          onOpen={openDetail}
        />
      ))}
    </section>
  );
}
