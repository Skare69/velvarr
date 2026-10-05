"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import { useRouter } from "next/navigation";
import { isDeliverableMedia } from "../lib/contracts.ts";
import type {
  Account,
  CatalogDetail,
  CatalogDetailResponse,
  CatalogProvider,
  CatalogReference,
  LibraryItem,
  MediaReference,
  PlaybackAccess,
  ProviderStatus,
  RequestRecord,
  UpdateInfo,
} from "../lib/contracts.ts";
import { REQUESTS_CHANGED } from "../lib/approvals.ts";
import { ApiGetCache } from "../lib/api-get.ts";
import packageJson from "../../package.json" with { type: "json" };

const { version } = packageJson;

/* ---------- API helper ---------- */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      init?.body
        ? { ...init, headers: { "content-type": "application/json" } }
        : init,
    );
  } catch {
    throw new ApiError(0, "network", "Cannot reach the Velvarr server.");
  }
  const data: unknown =
    res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)
      ?.error;
    if (res.status === 401)
      window.dispatchEvent(new Event("velvarr:unauthorized"));
    throw new ApiError(
      res.status,
      err?.code ?? "error",
      err?.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

/* ---------- One GET of server state ---------- */

/* ---------- Per-tab GET cache (Seerr/SWR-style) ---------- */

// Cached GET responses shared across every mount in this tab, plus the
// in-flight dedupe. Cleared on sign-out and on any 401 so one account's
// reads never reach the next sign-in. The coordination rules (a manual
// reload never joins a pre-mutation request; a superseded response never
// lands) live in src/lib/api-get.ts, testable without a React harness.
const apiGetCache = new ApiGetCache();

export function clearApiCache(): void {
  apiGetCache.clear();
}

/** One GET of server state, backed by a per-tab cache shared across mounts
 * (Seerr/SWR style): a path fetched before paints its cached data on the
 * first render and is always revalidated in the background; concurrent
 * identical GETs dedupe into one network request. A manual `reload()` always
 * shows the loading state and always issues a fresh GET — it never joins an
 * in-flight request, which may have been sent before the mutation it
 * re-reads. `revalidating` is true while a fetch is in flight — including
 * the background refresh that follows a cache hit, where `loading` stays
 * false — so callers can show a refresh that `loading` hides.
 * On revalidation failure the cached snapshot is
 * dropped (`data` becomes null) so a stale snapshot never reads as current;
 * a live first fetch keeps the old "never blanks on retry" behavior.
 *
 * `error` is what views render; `err` is for the two views that must tell one
 * failure from another (a 404 "not in the provider catalog" versus an outage),
 * which a flattened string cannot express.
 *
 * `{ fresh: true }` opts a path out of the cache in both directions: no
 * cached first paint, no cache write — every read is live. One-shot edit
 * forms (preferences, admin accounts) use it, so a stale tab snapshot is
 * never seeded into a draft and saved back over a newer server value. */
export function useApiGet<T>(
  path: string | null,
  deps: DependencyList,
  opts?: { fresh?: boolean },
): {
  data: T | null;
  error: string | null;
  err: ApiError | null;
  loading: boolean;
  /** True while a fetch (first or background revalidation) is in flight. */
  revalidating: boolean;
  reload: () => void;
} {
  const fresh = opts?.fresh === true;
  const [data, setData] = useState<T | null>(() =>
    path !== null && !fresh && apiGetCache.has(path)
      ? (apiGetCache.peek(path) as T)
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(
    path !== null && (fresh || !apiGetCache.has(path)),
  );
  // A path always starts a fetch (live or cache revalidation), so this is
  // true from the first render: a remount never paints a settled state that
  // a pending revalidation is about to replace.
  const [revalidating, setRevalidating] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const lastTick = useRef(tick);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (path === null) {
      setData(null);
      setError(null);
      setErr(null);
      setLoading(false);
      setRevalidating(false);
      return;
    }
    // Manual reload() vs mount/path change: only a reload shows the loading
    // state; a mount/path change with a cache hit paints cached data at once.
    const manual = tick !== lastTick.current;
    lastTick.current = tick;
    const cached = apiGetCache.peek(path);
    const fromCache = !manual && !fresh && cached !== undefined;
    let live = true;
    setError(null);
    setErr(null);
    if (fromCache) {
      setData(cached as T);
      setLoading(false);
    } else {
      setLoading(true);
    }
    // Every effect run with a path starts a fetch; `revalidating` spans it.
    setRevalidating(true);
    // api-get.ts owns joining and cache currency; `manual` keeps a reload()
    // from joining a request that may predate the mutation it re-reads.
    // A fresh read bypasses the cache in both directions: it neither joins
    // an in-flight entry nor writes one — a written entry would reach the
    // useState initializer on the next mount and reintroduce the stale
    // first paint (edit-form drafts seed from it).
    const pending = fresh
      ? api<T>(path)
      : apiGetCache.get<T>(path, () => api<T>(path), manual);
    pending
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
          setRevalidating(false);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setError(messageOf(e));
          setErr(e instanceof ApiError ? e : null);
          setRevalidating(false);
          setLoading(false);
          // A failed revalidation must not leave the cached snapshot standing
          // in as current state; a live first fetch has no snapshot to drop.
          if (fromCache) setData(null);
        }
      });
    return () => {
      live = false; // stale in-flight responses are ignored
    };
  }, [...deps, path, tick]);
  return { data, error, err, loading, revalidating, reload };
}

/* ---------- Touch: first tap reveals, second tap opens ---------- */

/** A coarse pointer has no hover, so a single tap would open a card whose
 * overlay (description, status, request action) the mouse user sees first.
 * The first tap inside a card reveals that overlay instead; the next tap in
 * the same card acts normally.
 *
 * ponytail: one delegated capture listener for every card kind, present and
 * future, instead of touch state threaded through each card component. */
export function useTapReveal(): void {
  useEffect(() => {
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const REVEALED = "tap-revealed";
    const clear = (except?: Element) => {
      for (const el of document.querySelectorAll(`.${REVEALED}`))
        if (el !== except) el.classList.remove(REVEALED);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest(".media-card");
      if (!card) return clear();
      // A card with nothing to reveal (performer, follow) opens on one tap.
      if (
        card.classList.contains(REVEALED) ||
        !card.querySelector(".media-quick-overlay")
      )
        return;
      // Swallow only this first tap: the card stays un-opened and shows what
      // hovering would have shown.
      event.preventDefault();
      event.stopPropagation();
      clear(card);
      card.classList.add(REVEALED);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

/* ---------- URL helpers ---------- */

/** Dispatched (by the preferences view) after hidden tags change, so
 * personalized surfaces — the followed-titles shelf, personal rails — refetch
 * instead of showing the previous decision. Pinned name; do not rename here
 * without the dispatchers. */
export const PREFERENCES_CHANGED = "velvarr:preferences-changed";

/** URL is the source of truth. The default replaces the entry so internal
 * corrections (perPage normalization, legacy normalization) do not fill the
 * history stack; user-initiated changes — surface navigation and every
 * browse filter commit — opt into `push` so browser Back walks back through
 * them instead of skipping filter states. */
export function useParamsSetter() {
  const router = useRouter();
  return useCallback(
    (
      updates: Record<string, string | null | undefined>,
      options?: { push?: boolean },
    ) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const href = qs ? `?${qs}` : window.location.pathname;
      if (options?.push) router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [router],
  );
}

export function intOr(v: string | null, dflt: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isInteger(n) ? n : dflt;
}

/** One-shot normalization of pre-titles URLs into the canonical browse
 * contract, so old bookmarks and old facet links land on the unified view
 * with their selections intact — never a blanket reset. Returns null when
 * the URL is already canonical. Old tag URLs carried bare provider ids, so
 * the selection keeps its real UUID and gets the established `#xxxxxxxx`
 * id-fragment label (never a fabricated name; the server matches by UUID). */
export function legacyBrowsePatch(
  p: URLSearchParams,
): Record<string, string | null> | null {
  const legacyView = p.get("view");
  const facet = p.get("facet");
  if (legacyView !== "movies" && legacyView !== "scenes" && !facet) return null;

  const patch: Record<string, string | null> = { view: "titles" };
  const idsOf = (key: string): string[] =>
    (p.get(key) ?? "").split(",").filter(Boolean);

  if (facet) {
    // Old discover facet tiles: view=titles&facet=studio|tag&name=N&tpdb=I[&stashdb=J].
    if (facet === "tag") {
      const sel: { name: string; tpdb?: string; stashdb?: string } = {
        name: p.get("name") ?? "#",
      };
      if (p.get("tpdb")) sel.tpdb = p.get("tpdb")!;
      if (p.get("stashdb")) sel.stashdb = p.get("stashdb")!;
      // A tag selection without a provider id identifies nothing; the server
      // refuses it, so an id-less old link normalizes to plain Browse.
      if (sel.tpdb !== undefined || sel.stashdb !== undefined)
        patch.include = JSON.stringify([sel]);
    } else if (p.get("tpdb")) {
      patch.studioTpdb = p.get("tpdb");
      if (p.get("stashdb")) patch.studioStashdb = p.get("stashdb");
    } else if (p.get("stashdb")) {
      patch.studioStashdb = p.get("stashdb");
    }
    return { ...patch, facet: null, tpdb: null, stashdb: null };
  }

  // Old split views: movies were the TPDB surface, scenes the StashDB one.
  const side = legacyView === "movies" ? "tpdb" : "stashdb";
  const suffix = side === "tpdb" ? "Tpdb" : "Stashdb";
  patch.type = legacyView === "movies" ? "movie" : "scene";
  if (p.get("performer")) patch[`performer${suffix}`] = p.get("performer");
  if (p.get("studio")) patch[`studio${suffix}`] = p.get("studio");
  const tagged = (id: string) => ({ name: `#${id.slice(0, 8)}`, [side]: id });
  const include = [...idsOf("tags"), ...idsOf("tagsAll")].map(tagged);
  if (include.length > 0) patch.include = JSON.stringify(include);
  const exclude = idsOf("tagsExclude").map(tagged);
  if (exclude.length > 0) patch.exclude = JSON.stringify(exclude);
  // q/year/date/date_operation/sort/direction/page/perPage/studioMode share
  // their names with the new contract and ride along untouched.
  if (!p.get("id")) {
    // No detail overlay: provider/kind described the old browse source, a
    // meaning the mapped keys above now carry.
    patch.provider = null;
    patch.kind = null;
  }
  return {
    ...patch,
    tags: null,
    tagsAll: null,
    tagsExclude: null,
    tab: null,
  };
}

/* ---------- Catalog summary hook ---------- */

export type CatalogSummary = {
  title: string;
  imageUrl?: string;
  description?: string;
  /** ISO YYYY-MM-DD when the provider supplies one. */
  releaseDate?: string;
  durationSeconds?: number;
  /** Studio name only. */
  studio?: string;
};

/**
 * Cache is module-level: these are public provider facts shared by every
 * viewer of the same media, bounded only by distinct requested media. Drop
 * if that grows.
 */
const catalogSummaryCache = new Map<string, CatalogSummary | null>();

/** undefined = still loading, null = unresolvable (caller degrades to the
 * reference). Consolidates the per-file detail caches from requests and
 * discover. */
export function useCatalogSummary(
  media: MediaReference,
  providers?: ProviderStatus | null,
): CatalogSummary | null | undefined {
  const key = `${media.provider}:${media.kind}:${media.id}`;
  const [summary, setSummary] = useState<CatalogSummary | null | undefined>(
    () => catalogSummaryCache.get(key),
  );

  useEffect(() => {
    if (summary !== undefined) return;

    // A not-configured provider can never answer; null is the honest result.
    if (providers && providers[media.provider] === "not_configured") {
      catalogSummaryCache.set(key, null);
      setSummary(null);
      return;
    }
    let live = true;
    api<{ detail: CatalogDetail }>(
      `/api/catalog/${media.provider}/${media.kind}/${media.id}`,
    )
      .then((d) => {
        const s: CatalogSummary = {
          title: d.detail.title,
          imageUrl: d.detail.imageUrl,
          description: d.detail.description,
          releaseDate: d.detail.releaseDate,
          durationSeconds: d.detail.durationSeconds,
          studio: d.detail.studio?.name,
        };
        catalogSummaryCache.set(key, s);
        if (live) setSummary(s);
      })
      .catch(() => {
        catalogSummaryCache.set(key, null);
        if (live) setSummary(null);
      });
    return () => {
      live = false;
    };
  }, [key, summary, providers, media.provider, media.kind, media.id]);

  return summary;
}

/** One library-presence read for a tile badge: `undefined` = loading,
 * `null` = the read failed (the caller falls back to the request's own
 * state). Uncached on purpose — a badge must report the state now, and a
 * discover rail is a bounded set of tiles. */
export function useAvailability(
  media: MediaReference,
): PlaybackAccess | null | undefined {
  const path = `${media.provider}/${media.kind}/${encodeURIComponent(media.id)}`;
  const [access, setAccess] = useState<PlaybackAccess | null | undefined>(
    undefined,
  );
  useEffect(() => {
    setAccess(undefined);
    let live = true;
    api<PlaybackAccess>(`/api/availability/${path}`)
      .then((a) => {
        if (live) setAccess(a);
      })
      .catch(() => {
        if (live) setAccess(null);
      });
    return () => {
      live = false;
    };
  }, [path]);
  return access;
}

/* ---------- Shared small components ---------- */

interface SessionInfo {
  account: Account;
  providers: ProviderStatus | null;
  signOut: () => void;
}

export const SessionCtx = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("Session context missing");
  return s;
}

export function ItemImage({
  name,
  src,
  className,
}: {
  name: string;
  src?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`img-fallback ${className ?? ""}`} aria-hidden="true">
        {name.slice(0, 1).toUpperCase() || "·"}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function ErrorPanel({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="panel panel-error flex items-start justify-between gap-3 p-4"
    >
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-1 text-sm text-muted">{message}</div>
      </div>
      {onRetry && (
        <button type="button" className="btn shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function ForbiddenPanel() {
  return (
    <div className="panel panel-error p-6" role="alert">
      <h2 className="text-lg font-semibold">403 · Administrators only</h2>
      <p className="mt-2 text-sm text-muted">
        Your account does not have permission to view this area.
      </p>
    </div>
  );
}

const ICON_PATHS = {
  discover: "m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z",
  movie: "M4 3h16v18H4z M4 8h16M4 16h16M8 3v18M16 3v18",
  scene: "M3 5h18v14H3z m7 3 6 4-6 4V8Z",
  performer: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 21v-2a8 8 0 0 1 16 0v2",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z m-2 5 6 6",
  requests: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 7v5l3 2",
  library: "M4 4v16M8 4v16M12 4v16M16 4l4 16",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  users:
    "M14 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M2 21v-2a8 8 0 0 1 16 0v2 M17 4a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  "chevron-left": "m15 5-7 7 7 7",
  "chevron-right": "m9 5 7 7-7 7",
  filter: "M4 6h16M7 12h10M10 18h4",
  play: "m8 4 12 8-12 8V4Z",
  logout: "M10 3H4v18h6M10 12h11m-5-5 5 5-5 5",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  "sort-asc": "M12 20V4m-6 6 6-6 6 6",
  "sort-desc": "M12 4v16m-6-6 6 6 6-6",
  check: "m5 12 4 4L19 6",
  "check-double": "M18 6 7 17l-5-5 M22 10l-7.5 7.5-1.5-1.5",
  hourglass:
    "M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4v6l4 2",
  plus: "M12 4v16M4 12h16",
  star: "m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8L12 3.6Z",
  tag: "M20 12.5 12.5 20a2 2 0 0 1-2.8 0L4 14.2V4h10.2l5.8 5.7a2 2 0 0 1 0 2.8ZM8.5 8.5h.01",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 3v12",
  pause: "M9 5v14M15 5v14",
  reorder:
    "M4 6h9M4 12h9M4 18h9M17.5 20V4m0 0-3.5 3.5M17.5 4 21 7.5M17.5 20l-3.5-3.5M17.5 20 21 16.5",
} as const;

export function Icon({
  name,
  className,
  filled,
}: {
  name: keyof typeof ICON_PATHS;
  className?: string;
  /** Solid fill instead of outline — used for on/off states (followed star). */
  filled?: boolean;
}) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** The credit, a user-specified layout: bold "Velvarr" links to the repo, the
 *  version to its GitHub release. The shell shows it in the sidebar and the
 *  More sheet; the root layout shows it as a fixed bar on screens without one.
 *  When the server reports a newer release, a chip links to it just above the
 *  version. */
let updatePromise: Promise<UpdateInfo | null> | null = null;

/** One shared fetch for every Credit on the page. A failed or empty check
 * degrades to no chip, never to a guessed update. */
function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    updatePromise ??= api<{ update: UpdateInfo | null }>("/api/update").then(
      (r) => r.update,
      () => null,
    );
    let alive = true;
    void updatePromise.then((u) => {
      if (alive) setUpdate(u);
    });
    return () => {
      alive = false;
    };
  }, []);
  return update;
}

export function Credit() {
  const update = useUpdate();
  return (
    <p className="credit">
      <a
        href="https://github.com/Skare69/velvarr"
        target="_blank"
        rel="noreferrer noopener"
      >
        Velvarr
      </a>
      {update && (
        <a
          className="chip chip-accent"
          href={update.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Update available: version ${update.version}`}
          title={`Velvarr v${update.version} is available`}
        >
          <Icon name="download" /> v{update.version}
        </a>
      )}
      <a
        href={`https://github.com/Skare69/velvarr/releases/tag/v${version}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        v{version}
      </a>
    </p>
  );
}

/** What the media server actually holds: the facts Whisparr/Jellyfin show and
 * Velvarr used to hide. Each one is optional upstream, so the line renders
 * whatever arrived and nothing when nothing did. */
export function FileFacts({ item }: { item: LibraryItem }) {
  const f = item.file;
  if (!f) return null;
  const gib = f.sizeBytes ? f.sizeBytes / 1024 ** 3 : null;
  const parts = [
    f.resolution,
    gib !== null ? `${gib < 10 ? gib.toFixed(2) : gib.toFixed(1)} GiB` : null,
    f.videoCodec,
    f.container ? f.container.toUpperCase() : null,
  ].filter(Boolean);
  if (parts.length === 0 && !f.path) return null;
  return (
    <div className="mt-1 text-xs text-muted">
      {parts.length > 0 && <div>{parts.join(" · ")}</div>}
      {f.path && <div className="mt-1 break-all font-mono">{f.path}</div>}
    </div>
  );
}

/* ---------- Card Badges (Seerr-style pill + status) ---------- */

export function CardTypeBadge({ kind }: { kind: "movie" | "scene" | string }) {
  const k = kind.toLowerCase();
  const isScene = k === "scene";
  // Library kinds beyond movie/scene (episode, musicvideo, video) name
  // themselves: a MOVIE pill over an episode would lie.
  return (
    <span
      className={`media-type-badge ${isScene ? "media-type-scene" : "media-type-movie"}`}
    >
      {isScene ? "SCENE" : k === "movie" ? "MOVIE" : k.toUpperCase()}
    </span>
  );
}

import type { CardStatusKind } from "../lib/status.ts";
import { statusOf } from "../lib/status.ts";
export type { CardStatusKind };

export const STATUS_ICONS: Record<CardStatusKind, keyof typeof ICON_PATHS> = {
  requested: "hourglass",
  approved: "check",
  available: "check-double",
  declined: "close",
  processing: "download",
  paused: "pause",
};

export const STATUS_LABELS: Record<CardStatusKind, string> = {
  requested: "Requested",
  approved: "Approved",
  available: "In library",
  declined: "Declined",
  processing: "Processing",
  paused: "Paused in Whisparr",
};

export function CardStatusBadge({
  status,
  title,
}: {
  status: CardStatusKind;
  title?: string;
}) {
  return (
    <span
      className={`media-status-badge media-status-${status}`}
      aria-label={
        title ? `${title}: ${STATUS_LABELS[status]}` : STATUS_LABELS[status]
      }
      title={STATUS_LABELS[status]}
    >
      <Icon name={STATUS_ICONS[status]} />
    </span>
  );
}

/* ---------- Shared catalog presentation ---------- */

/** Provider artwork may only reach the DOM through the same-origin proxy. */
export function imgSrc(url: string | undefined): string | undefined {
  return url ? `/api/catalog/image?url=${encodeURIComponent(url)}` : undefined;
}

export function duration(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function providerLabel(p: CatalogProvider): string {
  return p === "tpdb" ? "TPDB" : "StashDB";
}

/** Which surface renders a reference's detail: a movie or scene detail lives
 * over the unified Titles view — `type` is deliberately not set, so whatever
 * browse filter the viewer came from stays in the URL. A performer detail
 * lives over Performers. A studio detail opens where you already are, so no
 * view is named. One table, because the copies of this rule drifted — one
 * named a view that does not exist, and one surface named none at all, so
 * those cards opened nothing. */
export function detailParams(r: CatalogReference): {
  view?: string;
  provider: string;
  kind: string;
  id: string;
} {
  const view =
    r.kind === "movie" || r.kind === "scene"
      ? "titles"
      : r.kind === "performer"
        ? "following"
        : null;
  return {
    ...(view ? { view } : {}),
    provider: r.provider,
    kind: r.kind,
    id: r.id,
  };
}

/** Link target for the same contract, for anchors rather than param patches.
 * Built through URLSearchParams so an absent view (studio refs) stays absent
 * instead of rendering the string "undefined" into the href. */
export function detailHref(media: MediaReference): string {
  const p = detailParams(media);
  const qs = new URLSearchParams(
    Object.entries(p).filter(([, v]) => v !== undefined) as [string, string][],
  );
  return `/?${qs}`;
}

/** A surface change that first clears every existing param, then applies
 * `updates` — the search and view-switch contract, written once. */
export function setParamsClearing(
  setP: (
    updates: Record<string, string | null | undefined>,
    options?: { push?: boolean },
  ) => void,
  updates: Record<string, string | null | undefined>,
  options?: { push?: boolean },
): void {
  const cleared: Record<string, string | null> = {};
  for (const key of new URLSearchParams(window.location.search).keys())
    cleared[key] = null;
  setP({ ...cleared, ...updates }, options);
}

export function GridSkeleton({
  aspect,
  cols,
  count,
}: {
  aspect: string;
  cols: string;
  count: number;
}) {
  return (
    <div className={cols} aria-label="Loading results" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel ${aspect}`} />
      ))}
    </div>
  );
}

/** The request card's state: the shared catalog detail envelope plus the
 * card's own availability verdict. */
type CardStatus = CatalogDetailResponse & { availability: PlaybackAccess };

// ponytail: two background lanes for bounded pages/rails; batch availability
// server-side if per-card Jellyfin reads become the bottleneck.
const cardPreloads: Promise<void>[] = [Promise.resolve(), Promise.resolve()];

function RequestableCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const [status, setStatus] = useState<CardStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "requesting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const media = item.reference;
  const scene = media.kind === "scene";
  const performers = scene ? item.credits.map((c) => c.name).join(", ") : "";
  useEffect(() => () => controller.current?.abort(), []);

  const check = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy("checking");
    setError(null);
    try {
      const path = `${media.provider}/${media.kind}/${encodeURIComponent(media.id)}`;
      const [detail, availability] = await Promise.all([
        api<CatalogDetailResponse>(`/api/catalog/${path}`, {
          signal: abort.signal,
        }),
        api<PlaybackAccess>(`/api/availability/${path}`, {
          signal: abort.signal,
        }),
      ]);
      if (!abort.signal.aborted) setStatus({ ...detail, availability });
    } catch (e) {
      if (!abort.signal.aborted) {
        setStatus(null);
        setError(messageOf(e));
      }
    } finally {
      working.current = false;
      if (!abort.signal.aborted) setBusy(null);
      abort.abort();
    }
  }, [media.provider, media.kind, media.id]);

  useEffect(() => {
    if (status) return;
    let cancelled = false;
    const preload = () => {
      const previous = cardPreloads.shift()!;
      cardPreloads.push(
        previous.then(() => {
          if (!cancelled) return check();
        }),
      );
    };
    if (document.readyState === "complete") preload();
    else window.addEventListener("load", preload, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", preload);
    };
  }, [check, status]);

  async function request() {
    if (working.current) return;
    working.current = true;
    setBusy("requesting");
    setError(null);
    let exists = false;
    try {
      const result = await api<{ request: RequestRecord }>("/api/requests", {
        method: "POST",
        body: JSON.stringify({ media }),
      });
      setStatus((current) =>
        current ? { ...current, myRequest: result.request } : current,
      );
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
    } catch (e) {
      exists = e instanceof ApiError && e.code === "request_exists";
      // Re-check before offering another POST: a lost response may have saved it.
      setStatus(null);
      if (!exists) setError(messageOf(e));
    } finally {
      working.current = false;
      setBusy(null);
    }
    if (exists) await check();
  }

  const availability = status?.availability;
  const available = availability?.outcome === "available" ? availability : null;
  const requested = Boolean(status?.myRequest || status?.acquisition);
  // One ladder for every surface (lib/status): playable beats downloading
  // beats unmonitored; imported-but-unscanned is a decision fact, never
  // "Paused".
  const statusKind: CardStatusKind | null = statusOf(status ?? {});
  // A request intent does not depend on Jellyfin, so an outage or a denied
  // verdict must not hide the button the detail page still offers: the note
  // carries the truth instead.
  const deliverable = isDeliverableMedia(media);
  const requestable =
    status !== null && !requested && !available && deliverable;
  const label =
    busy === "requesting"
      ? "Requesting…"
      : busy === "checking"
        ? "Checking…"
        : error
          ? "Retry check"
          : !status
            ? "Check status"
            : available
              ? "In your library"
              : requested
                ? availability?.outcome === "awaiting_scan"
                  ? "Awaiting scan"
                  : status.myRequest?.decision === "approved"
                    ? "Approved"
                    : "Requested"
                : "Request";
  const note = !deliverable
    ? "Browse only — Whisparr cannot acquire TPDB scenes."
    : (error ??
      (availability?.outcome === "unavailable"
        ? "Library status unavailable."
        : availability?.outcome === "ambiguous"
          ? "Library match needs review."
          : availability?.outcome === "denied"
            ? "No playback access."
            : null));

  return (
    <div
      className={`media-card media-request-card${scene ? " scene-card" : ""}`}
      onPointerEnter={(e) => {
        if (!status && e.pointerType !== "touch") void check();
      }}
    >
      <button
        type="button"
        className="media-open"
        aria-label={`View details for ${item.title}`}
        onFocus={() => {
          if (!status) void check();
        }}
        onClick={() => onOpen(media)}
      >
        <div className="media-art aspect-[2/3]">
          <ItemImage
            name={item.title}
            src={imgSrc(item.imageUrl)}
            className="h-full w-full object-cover"
          />
          <CardTypeBadge kind={media.kind} />
          {statusKind && (
            <CardStatusBadge status={statusKind} title={item.title} />
          )}
          {scene && duration(item.durationSeconds) && (
            <span className="media-runtime">
              {duration(item.durationSeconds)}
            </span>
          )}
        </div>
        <div className="media-meta">
          <div className="media-title">{item.title}</div>
          <div className="media-subtitle">
            {(scene
              ? [item.studio?.name, item.releaseDate]
              : [item.releaseDate?.slice(0, 4), item.studio?.name]
            )
              .filter(Boolean)
              .join(" · ")}
          </div>
          {performers && <div className="media-subtitle">{performers}</div>}
        </div>
      </button>
      <div className="media-quick-overlay">
        <div className="media-quick-summary" aria-hidden="true">
          {item.releaseDate && <span>{item.releaseDate.slice(0, 4)}</span>}
          <strong>{item.title}</strong>
          {(status?.detail.description || item.description) && (
            <p>{status?.detail.description || item.description}</p>
          )}
        </div>
        {note && (
          <p className="media-quick-note" role={error ? "alert" : "status"}>
            {note}
          </p>
        )}
        <div className="media-quick-action" aria-live="polite">
          {!busy && available?.watchUrl ? (
            <a
              className="btn btn-accent"
              href={available.watchUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Watch ${item.title} in Jellyfin`}
            >
              <Icon name="play" /> Watch
            </a>
          ) : (
            <button
              type="button"
              className={`btn${requestable && !error ? " btn-accent" : ""}`}
              aria-disabled={busy !== null}
              aria-label={`${label}: ${item.title}`}
              onClick={() => {
                if (working.current) return;
                if (!status || error) void check();
                else if (requestable) void request();
                else onOpen(media);
              }}
            >
              <Icon
                name={
                  busy || requested
                    ? "requests"
                    : requestable
                      ? "plus"
                      : available
                        ? "check"
                        : "arrow-right"
                }
              />
              {label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function MovieCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <RequestableCard
      key={`${item.reference.provider}:${item.reference.kind}:${item.reference.id}`}
      item={item}
      onOpen={onOpen}
    />
  );
}

export function SceneCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <RequestableCard
      key={`${item.reference.provider}:${item.reference.kind}:${item.reference.id}`}
      item={item}
      onOpen={onOpen}
    />
  );
}

export function PerformerCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <button
      type="button"
      className="media-card performer-card"
      onClick={() => onOpen(item.reference)}
    >
      <div className="media-art aspect-square">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="h-full w-full object-cover"
        />
        <span className="media-badge">Performer</span>
        <span className="media-reveal">
          Explore filmography <Icon name="arrow-right" />
        </span>
      </div>
      <div className="media-meta">
        <div className="media-title">{item.title}</div>
        {item.aliases[0] && (
          <div className="media-subtitle">Also known as {item.aliases[0]}</div>
        )}
      </div>
    </button>
  );
}
