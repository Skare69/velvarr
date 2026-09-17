"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Account,
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  MediaReference,
  ProviderStatus,
} from "../lib/contracts.ts";

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

/* ---------- URL helpers ---------- */

/** URL is the source of truth. Filter tweaks replace the entry so typing does
 * not fill the history stack; a surface change (opting into `push`) leaves an
 * entry so browser Back returns to the previous surface instead of exiting. */
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
  removals: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  "chevron-left": "m15 5-7 7 7 7",
  "chevron-right": "m9 5 7 7-7 7",
  filter: "M4 6h16M7 12h10M10 18h4",
  play: "m8 4 12 8-12 8V4Z",
  logout: "M10 3H4v18h6M10 12h11m-5-5 5 5-5 5",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  plus: "M12 4v16M4 12h16",
} as const;

export function Icon({
  name,
  className,
}: {
  name: keyof typeof ICON_PATHS;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
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

/** Link target for the shared URL contract: an open catalog detail is
 * view + provider + kind + id; the catalog view matches the media kind. */
export function detailHref(media: MediaReference): string {
  const view = media.kind === "movie" ? "movies" : "scenes";
  return `/?view=${view}&provider=${media.provider}&kind=${media.kind}&id=${encodeURIComponent(media.id)}`;
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

export function MovieCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <button
      type="button"
      className="media-card"
      onClick={() => onOpen(item.reference)}
    >
      <div className="media-art aspect-[2/3]">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="h-full w-full object-cover"
        />
        <span className="media-badge">Movie</span>
        <span className="media-reveal">
          <Icon name="plus" /> View details
        </span>
      </div>
      <div className="media-meta">
        <div className="media-title">{item.title}</div>
        <div className="media-subtitle">
          {[item.releaseDate?.slice(0, 4), item.studio?.name]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </button>
  );
}

export function SceneCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  const performers = item.credits.map((c) => c.name).join(", ");
  return (
    <button
      type="button"
      className="media-card scene-card"
      onClick={() => onOpen(item.reference)}
    >
      <div className="media-art aspect-video">
        <ItemImage
          name={item.title}
          src={imgSrc(item.imageUrl)}
          className="h-full w-full object-cover"
        />
        <span className="media-badge">Scene</span>
        {duration(item.durationSeconds) && (
          <span className="media-runtime">
            {duration(item.durationSeconds)}
          </span>
        )}
        <span className="media-reveal">
          <Icon name="plus" /> View details
        </span>
      </div>
      <div className="media-meta">
        <div className="media-title">{item.title}</div>
        <div className="media-subtitle">
          {[item.studio?.name, item.releaseDate].filter(Boolean).join(" · ")}
        </div>
        {performers && <div className="media-subtitle">{performers}</div>}
      </div>
    </button>
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
