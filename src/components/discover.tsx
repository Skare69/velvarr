"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./discover.css";
import type {
  CatalogDetail,
  CatalogReference,
  LibraryItem,
  MediaReference,
  RequestDecision,
  RequestRecord,
} from "../lib/contracts";
import {
  CardStatusBadge,
  type CardStatusKind,
  CardTypeBadge,
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
} from "./shared";

/* Wire shapes mirroring the server's discover response (route.ts Shelf).
 * Kept local: contracts.ts stays domain records; the shelf envelope is a
 * response contract. An errored shelf carries `error` and NO `items` key. */
interface ShelfError {
  code: string;
  message: string;
}

interface Shelf {
  id: string;
  title: string;
  scope: string;
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests";
  items?: CatalogDetail[] | LibraryItem[] | RequestRecord[];
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

const BROWSE_KEYS = [
  "q",
  "year",
  "performer",
  "studio",
  "tags",
  "tagsAll",
  "tagsExclude",
  "sort",
  "direction",
  "page",
  "perPage",
  "tab",
  "id",
  "provider",
  "kind",
];

/** Browse-all lands on the filtered surface carrying exactly the shelf's
 * filters: shelf params applied, every other browse-state key cleared. */
function browseUpdates(shelf: Shelf): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const k of BROWSE_KEYS) updates[k] = null;
  if (shelf.browse)
    for (const [k, v] of Object.entries(shelf.browse.params)) updates[k] = v;
  updates.view = targetView(shelf);
  return updates;
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
function useRailNav(label: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    sync();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync]);

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
        className="btn"
        aria-label={`Scroll ${label} back`}
        disabled={edges.start}
        onClick={() => nudge(-1)}
      >
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="btn"
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

/* Request tiles resolve title + artwork once via the existing detail endpoint.
 * Module cache (same pattern as requests.tsx): an unresolvable reference
 * stays the reference — never a fabricated title or image. */
interface RequestArt {
  title: string;
  imageUrl?: string;
}

const requestArtCache: Record<string, RequestArt | null> = {};

function useRequestArt(media: MediaReference): RequestArt | null | undefined {
  const key = `${media.provider}:${media.kind}:${media.id}`;
  const [art, setArt] = useState<RequestArt | null | undefined>(
    () => requestArtCache[key],
  );
  useEffect(() => {
    if (art !== undefined) return;
    let live = true;
    api<{ detail: CatalogDetail }>(
      `/api/catalog/${media.provider}/${media.kind}/${media.id}`,
    )
      .then((d) => {
        const found: RequestArt = {
          title: d.detail.title,
          imageUrl: d.detail.imageUrl,
        };
        requestArtCache[key] = found;
        if (live) setArt(found);
      })
      .catch(() => {
        requestArtCache[key] = null;
        if (live) setArt(null);
      });
    return () => {
      live = false;
    };
  }, [key, art, media.provider, media.kind, media.id]);
  return art;
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
  const art = useRequestArt(item.media);
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
 * otherwise the tile says so instead of implying availability. */
function LibraryTile({ item }: { item: LibraryItem }) {
  const mins =
    item.durationTicks != null && item.durationTicks > 0
      ? Math.round(item.durationTicks / 600000000)
      : null;
  return (
    <div className="discovery-tile discovery-tile-poster">
      <div className="discovery-art-card media-card">
        <div className="discovery-art">
          <ItemImage name={item.name} src={item.image} />
          <CardTypeBadge kind={item.kind} />
          <CardStatusBadge status="available" title={item.name} />
          <div className="media-quick-overlay">
            <div className="media-quick-summary" aria-hidden="true">
              {item.year && <span>{item.year}</span>}
              <strong>{item.name}</strong>
              {mins !== null && <p>{mins} min</p>}
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
                <span className="discovery-library-note">
                  No playback access
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- One shelf: header + honest scope + body by kind ---------- */

function ShelfSection({
  shelf,
  busy,
  onRetry,
  onBrowse,
  onOpen,
}: {
  shelf: Shelf;
  busy: boolean;
  onRetry: () => void;
  onBrowse: (updates: Record<string, string | null>) => void;
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
  const rail = useRailNav(railLabel);
  /* Only rail bodies get Previous/Next; panel bodies (errors/empty) none. */
  const hasRail = !shelf.error && !!shelf.items && shelf.items.length > 0;

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
    if (requestItems && requestItems.length > 0) {
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
        <div>
          <h3 className="discovery-shelf-title">{shelf.title}</h3>
          <p className="discovery-shelf-scope">{shelf.scope}</p>
          {shelf.kind === "requests" && !shelf.error && (
            <p className="discovery-note">
              A decision records the request's outcome — approval is not
              playback availability.
            </p>
          )}
        </div>
        <div className="discovery-shelf-tools">
          {shelf.browse && (
            <button
              type="button"
              className="btn"
              onClick={() => onBrowse(browseUpdates(shelf))}
            >
              Browse all <Icon name="arrow-right" />
            </button>
          )}
          {hasRail && rail.nav}
        </div>
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
      <p className="page-description">
        Fresh from each source: new releases, trending scenes, recent additions
        in your libraries, and the latest requests.
      </p>
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
  // destination view mounts the shared detail dialog for provider+kind+id.
  // Surface/detail transitions push a history entry so Back returns here.
  const openDetail = useCallback(
    (r: CatalogReference) =>
      setP(
        {
          view:
            r.kind === "movie"
              ? "movies"
              : r.kind === "scene"
                ? "scenes"
                : "performers",
          provider: r.provider,
          kind: r.kind,
          id: r.id,
        },
        { push: true },
      ),
    [setP],
  );

  // Presentation order only: what was added (library), then requests, then
  // the provider shelves in the server's order. Titles and scopes stay the
  // server's own honest words.
  const ORDER: Record<Shelf["kind"], number> = {
    library: 0,
    requests: 1,
    catalog: 2,
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
          onBrowse={(updates) => setP(updates, { push: true })}
          onOpen={openDetail}
        />
      ))}
    </section>
  );
}
