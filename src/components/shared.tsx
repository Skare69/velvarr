"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type {
  Account,
  AcquisitionState,
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  MediaReference,
  PlaybackAccess,
  ProviderStatus,
  RequestRecord,
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
  star: "m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8L12 3.6Z",
  tag: "M20 12.5 12.5 20a2 2 0 0 1-2.8 0L4 14.2V4h10.2l5.8 5.7a2 2 0 0 1 0 2.8ZM8.5 8.5h.01",
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

type CardStatus = {
  detail: CatalogDetail;
  myRequest: Pick<RequestRecord, "decision"> | null;
  acquisition: { state: AcquisitionState } | null;
  availability: PlaybackAccess;
};

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

  // ponytail: check on hover/focus, not one Jellyfin sweep per card on load.
  // Batch/index these reads only if interaction-time checks become too costly.
  async function check() {
    if (working.current) return;
    working.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setBusy("checking");
    setError(null);
    try {
      const path = `${media.provider}/${media.kind}/${encodeURIComponent(media.id)}`;
      const [detail, availability] = await Promise.all([
        api<Omit<CardStatus, "availability">>(`/api/catalog/${path}`, {
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
    }
  }

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
  // A request intent does not depend on Jellyfin, so an outage or a denied
  // verdict must not hide the button the detail page still offers: the note
  // carries the truth instead.
  const requestable =
    status !== null &&
    !requested &&
    !available &&
    (media.kind === "movie" || media.kind === "scene");
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
  const note =
    error ??
    (availability?.outcome === "unavailable"
      ? "Library status unavailable."
      : availability?.outcome === "ambiguous"
        ? "Library match needs review."
        : availability?.outcome === "denied"
          ? "No playback access."
          : null);

  return (
    <div
      className={`media-card media-request-card${scene ? " scene-card" : ""}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") void check();
      }}
    >
      <button
        type="button"
        className="media-open"
        aria-label={`View details for ${item.title}`}
        onFocus={() => void check()}
        onClick={() => onOpen(media)}
      >
        <div className="media-art aspect-[2/3]">
          <ItemImage
            name={item.title}
            src={imgSrc(item.imageUrl)}
            className="h-full w-full object-cover"
          />
          <span className="media-badge">{scene ? "Scene" : "Movie"}</span>
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
              className="btn media-quick-watch"
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
