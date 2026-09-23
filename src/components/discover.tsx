"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { seedFacetTile } from "../lib/names";
import { statusOf } from "../lib/status";
import "./discover.css";
import "./views.css";
import type {
  CatalogDetail,
  CatalogReference,
  LibraryItem,
  RequestListItem,
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
  MovieCard,
  PerformerCard,
  SceneCard,
  PREFERENCES_CHANGED,
  STATUS_LABELS,
  useApiGet,
  useAvailability,
  useParamsSetter,
  useCatalogSummary,
  useSession,
} from "./shared";

/* Wire shapes mirroring the server's discover response (route.ts Shelf).
 * Kept local: contracts.ts stays domain records; the shelf envelope is a
 * response contract. An errored shelf carries `error` and NO `items` key. */
interface ShelfError {
  code: string;
  message: string;
}

interface FacetItem {
  facet: "studio" | "tag";
  provider: "tpdb" | "stashdb"; // the snapshot side this tile came from
  id: string;
  name: string;
  imageUrl?: string;
  logoUrl?: string; // studio brand mark only
  linked?: { provider: "tpdb" | "stashdb"; id: string }; // resolved counterpart, omitted when none
}

interface Shelf {
  id: string;
  title: string;
  description?: string; // the server's own honest words for the rail
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests" | "facets";
  items?: CatalogDetail[] | LibraryItem[] | RequestListItem[] | FacetItem[];
  /** Per-source partial failures: items may coexist with these. */
  errors?: { provider: "tpdb" | "stashdb"; code: string; message: string }[];
  error?: ShelfError;
}

interface DiscoverPage {
  shelves: Shelf[];
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

/** A browse link starts fresh and passes the server's canonical params
 * (view=titles|following plus browse keys) through verbatim — the server owns
 * the composition, the URL owns the state. Filters from another surface never
 * leak in. */
function browseHref(shelf: Shelf): string {
  const browse = shelf.browse;
  if (!browse) return "/";
  return `/?${new URLSearchParams({ view: browse.view, ...browse.params })}`;
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

/** One mixed grid per facet: the tile's own provider side plus its resolved
 * counterpart, when one exists. `name` is a display label only — results are
 * keyed by the provider ids, so a forged label can never change them. The
 * link is the canonical browse shape: a studio constraint per provider key,
 * or one typed tag selection carrying both provider UUIDs as JSON. */
function FacetTile({ item }: { item: FacetItem }) {
  const studio = item.facet === "studio";
  // A studio rail shows brand marks; its portrait poster belongs to the hero,
  // and a facet with neither stays a plain name.
  const art = studio ? (item.logoUrl ?? item.imageUrl) : item.imageUrl;
  const params: Record<string, string> = {
    view: "titles",
    name: item.name,
  };
  if (studio) {
    params[item.provider === "tpdb" ? "studioTpdb" : "studioStashdb"] = item.id;
    if (item.linked)
      params[item.linked.provider === "tpdb" ? "studioTpdb" : "studioStashdb"] =
        item.linked.id;
  } else {
    const sel: Record<string, string> = { name: item.name };
    sel[item.provider] = item.id;
    if (item.linked) sel[item.linked.provider] = item.linked.id;
    params.include = JSON.stringify([sel]);
  }
  return (
    <div className="discovery-tile discovery-tile-facet">
      <Link
        href={`/?${new URLSearchParams(params)}`}
        prefetch={false}
        className={`discovery-facet discovery-facet-${studio ? "studio" : "genre"}`}
        onClick={() => {
          // Seed both sides so chips and headings show names, not raw ids.
          seedFacetTile(item);
        }}
      >
        {art && (
          <ItemImage
            src={imgSrc(art)}
            name=""
            className={studio ? "discovery-studio-logo" : "discovery-facet-art"}
          />
        )}
        <span className="discovery-facet-name">{item.name}</span>
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

/** The status chip is the request's REAL state, not just the decision: an
 * approval means the request was accepted, never that the title is
 * watchable — the shared.tsx ladder (library availability, acquisition
 * progress, then decision) owns the wording. */

function RequestTile({
  item,
  onOpen,
}: {
  item: RequestListItem;
  onOpen: (r: CatalogReference) => void;
}) {
  const art = useCatalogSummary(item.media);
  const session = useSession();
  const availability = useAvailability(item.media);
  const acq = item.acquisition;
  // The badge and chip are the truth, not the decision: a request whose
  // title already plays in the library reads "In library" here exactly as it
  // does on the library rail; an approval alone is only ever a single check.
  // The one ladder (lib/status) serves this tile and every card.
  const statusKind: CardStatusKind =
    statusOf({
      availability,
      acquisition: acq,
      myRequest: item.decision ? { decision: item.decision } : null,
    }) ?? "declined";
  const label = STATUS_LABELS[statusKind];
  const requester = item.requestedBy ?? session.account.name;

  return (
    <div className="discovery-tile discovery-request">
      <button
        type="button"
        className="discovery-request-card media-card"
        onClick={() => onOpen(item.media)}
        aria-label={`${art?.title ?? item.media.id} — ${label}; open catalog details`}
      >
        {art?.imageUrl !== undefined && (
          <span
            aria-hidden="true"
            className="discovery-request-backdrop"
            style={{ backgroundImage: `url(${imgSrc(art.imageUrl)})` }}
          />
        )}
        <span className="discovery-request-info">
          <span className="discovery-request-year">
            {art?.releaseDate?.slice(0, 4)}
          </span>
          <strong className="discovery-request-title">
            {art?.title ??
              `${item.media.provider} · ${item.media.kind} · ${item.media.id}`}
          </strong>
          <span className="discovery-request-by">{requester}</span>
          <span className="state-badge" data-state={statusKind}>
            {label}
          </span>
        </span>
        <ItemImage
          name={art?.title ?? "·"}
          src={art ? imgSrc(art.imageUrl) : undefined}
          className="discovery-request-poster"
        />
        <CardStatusBadge status={statusKind} title={art?.title} />
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
    (it): it is RequestListItem => "media" in it,
  );
  const facetItems = shelf.items?.filter(
    (it): it is FacetItem => "facet" in it,
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
          title={
            shelf.kind === "facets"
              ? `${shelf.title} unavailable` // velvarr-sourced: naming a provider would be a lie
              : `${sourceLabel(shelf.source)} is unavailable`
          }
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
    if (shelf.kind === "facets") {
      for (const it of facetItems ?? [])
        tiles.push(<FacetTile key={`${it.provider}:${it.id}`} item={it} />);
    } else if (requestItems && requestItems.length > 0) {
      for (const r of requestItems)
        tiles.push(<RequestTile key={r.id} item={r} onOpen={onOpen} />);
    } else if (libraryItems && libraryItems.length > 0) {
      libraryItems.forEach((it, i) =>
        tiles.push(<LibraryTile key={`${shelf.id}-${i}`} item={it} />),
      );
    } else {
      // Mixed movies and scenes share one rail, so the key carries the
      // full provider identity — a TPDB movie and a StashDB scene never
      // collide on a bare id.
      for (const it of catalogItems ?? [])
        tiles.push(
          <CatalogTile
            key={`${it.reference.provider}:${it.reference.kind}:${it.reference.id}`}
            item={it}
            onOpen={onOpen}
          />,
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
      {shelf.description && (
        <p className="text-sm text-muted">{shelf.description}</p>
      )}
      {/* A source that failed while its sibling filled the rail still gets
          named — partial success never reads as complete. */}
      {!shelf.error && (shelf.errors?.length ?? 0) > 0 && (
        <div className="panel p-4 text-sm text-muted" role="note">
          {shelf.errors!.map((e) => (
            <p key={e.provider}>
              <span className="chip chip-accent">
                {sourceLabel(e.provider)}
              </span>{" "}
              {e.message}
            </p>
          ))}
        </div>
      )}
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
    <Link
      href="/?view=preferences"
      prefetch={false}
      className="text-sm text-muted"
    >
      Reorder shelves
    </Link>
  </header>
);

interface FacetDirectory {
  kind: string;
  tiles: FacetItem[];
  errors: { provider: "tpdb" | "stashdb"; code: string; message: string }[];
}

/** The Genres/Studios overview behind the shelf headline arrows: the same
 * facet tiles at directory size. A side that failed (StashDB refuses
 * empty-term tag searches on some tiers) is named — never a fabricated
 * list; the studios page states its real breadth (recent releases). */
export function FacetsView() {
  const params = useSearchParams();
  const kind = params.get("kind") === "studios" ? "studios" : "genres";
  const title = kind === "studios" ? "Studios" : "Genres";
  const { data, error, err, loading, reload } = useApiGet<FacetDirectory>(
    `/api/discovery/facets?kind=${kind}`,
    [kind],
  );
  if (loading && !data) {
    return (
      <section aria-label={title} aria-busy="true">
        <RailSkeleton count={6} />
        <RailSkeleton count={6} />
      </section>
    );
  }
  if ((error || err) && !data) {
    return (
      <section aria-label={title}>
        <ErrorPanel
          title={`${title} are unavailable`}
          message={error ?? err!.message}
          onRetry={reload}
        />
      </section>
    );
  }
  if (!data) return null;
  return (
    <section aria-label={title}>
      <header className="page-heading">
        <div>
          <h2 className="page-title">{title}</h2>
          <p className="text-sm text-muted">
            {kind === "studios"
              ? "Studios in recent releases — no provider publishes a full studio directory."
              : "Every genre each provider lists."}
          </p>
        </div>
      </header>
      {data.errors.length > 0 && (
        <div className="panel p-4 text-sm text-muted" role="note">
          {data.errors.map((e) => (
            <p key={e.provider}>
              <span className="chip chip-accent">
                {sourceLabel(e.provider)}
              </span>{" "}
              {e.message}
            </p>
          ))}
        </div>
      )}
      {data.tiles.length === 0 ? (
        <p className="cat-note">Nothing to list yet.</p>
      ) : (
        <div className="discovery-facet-grid">
          {data.tiles.map((item) => (
            <FacetTile
              key={`${item.provider}:${item.facet}:${item.id}`}
              item={item}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function DiscoverShelves() {
  const setP = useParamsSetter();
  // One GET per mount/retry, owned by the hook — deliberately no module-level
  // page cache: followed-titles is personal (who you follow, your hidden
  // tags), so a cached snapshot could hand one account's rail to the next
  // sign-in. useApiGet refetches on every mount; sign-out unmounts the app.
  const {
    data: page,
    error,
    loading,
    reload,
  } = useApiGet<DiscoverPage>("/api/discover", []);

  // Preference changes (hidden tags, shelf order) land as this event; the
  // page refetches instead of showing yesterday's decisions.
  useEffect(() => {
    window.addEventListener(PREFERENCES_CHANGED, reload);
    return () => window.removeEventListener(PREFERENCES_CHANGED, reload);
  }, [reload]);

  // Catalog cards open the detail over the matching surface view; the
  // destination view mounts the shared detail for provider+kind+id.
  // Surface/detail transitions push a history entry so Back returns here.
  const openDetail = useCallback(
    (r: CatalogReference) => setP(detailParams(r), { push: true }),
    [setP],
  );

  if (loading && !page) {
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
          onRetry={reload}
        />
      </section>
    );
  }
  if (!page) return null;
  return (
    <section aria-label="Discover">
      {PAGE_HEADING}
      {/* The server's shelf order IS the composition — it resolves each
          account's saved order (personal content preferences) over the
          default, and only shelves present in this response are rendered.
          The API is authoritative: no client re-sort, no preferences fetch
          here. Personal shelves refetch on PREFERENCES_CHANGED above. */}
      {page.shelves.map((s) => (
        <ShelfSection
          key={s.id}
          shelf={s}
          busy={loading}
          onRetry={reload}
          onOpen={openDetail}
        />
      ))}
    </section>
  );
}
