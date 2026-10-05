"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import "./catalog.css";
import {
  api,
  ApiError,
  detailParams,
  duration,
  ErrorPanel,
  FileFacts,
  Icon,
  imgSrc,
  ItemImage,
  messageOf,
  MovieCard,
  providerLabel,
  SceneCard,
  useApiGet,
  useParamsSetter,
} from "./shared";
import { isDeliverableMedia } from "../lib/contracts";
import type {
  AcquisitionState,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  MediaKind,
  PlaybackAccess,
  RequestDecision,
  RequestRecord,
} from "../lib/contracts";
import { acquisitionText } from "../lib/status";
import { REQUESTS_CHANGED } from "../lib/approvals";
// Detail-seeded names: studio/tag chips label the ids the URL carries —
// details are where names are known.
import { seedDetail } from "../lib/names";
// Type-only on purpose: the erased type crosses, the runtime graph stays
// one-way (catalog.tsx renders catalog-detail.tsx, never the reverse).
import type { BrowseFilter } from "./catalog.tsx";

export type DetailPayload = {
  detail: CatalogDetail & {
    /** StashDB studio detail only: provider-supplied child-studio count
     * (omitted when the provider supplies none — never defaulted to 0). */
    childStudioCount?: number;
  };
  link: { linked?: CatalogReference } | { unlinkedReason?: string };
  myRequest: {
    id: string;
    decision: RequestDecision;
    createdAt: number;
    decidedAt: number | null;
  } | null;
  acquisition: {
    state: AcquisitionState;
    lastError: string | null;
    updatedAt: number;
    monitored: boolean | null;
    progress: { percent: number | null; timeleft: string | null } | null;
  } | null;
};

export type DetailTarget = {
  provider: CatalogProvider;
  kind: CatalogKind;
  id: string;
};

function kindStrict(v: string | null): CatalogKind | null {
  // "studio" is deliberately absent: a studio has no detail body, so every
  // studio reference lands on the filtered titles grid. Old ?kind=studio URLs
  // degrade to the plain browse grid.
  return v === "movie" || v === "scene" || v === "performer" ? v : null;
}

function asMediaKind(kind: CatalogKind): MediaKind | null {
  return kind === "movie" || kind === "scene" ? kind : null;
}

/** The browse state behind an open detail: the URL minus the detail params
 * (provider/kind/id) and the performer tab. Keys the scroll store. */
function browseKeyOf(params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  for (const k of ["provider", "kind", "id", "tab"]) p.delete(k);
  p.sort();
  return p.toString();
}

/** Session-scoped scroll positions keyed by browse state. Deliberate
 * filter changes never write it, so they never cause a scroll jump. */
const scrollPositions = new Map<string, number>();

function saveScroll(key: string) {
  if (window.scrollY > 0) scrollPositions.set(key, window.scrollY);
}

function restoreScroll(key: string) {
  const y = scrollPositions.get(key);
  if (y === undefined) return;
  scrollPositions.delete(key);
  window.scrollTo(0, y);
}

/* ---------- Detail page ---------- */

/** Reads the open detail target (provider + kind + id) from URL params;
 * exported so other catalog surfaces can detect an open detail without
 * re-parsing the contract. */
export function detailTarget(params: URLSearchParams): DetailTarget | null {
  const providerRaw = params.get("provider");
  const provider =
    providerRaw === "tpdb" || providerRaw === "stashdb" ? providerRaw : null;
  const kind = kindStrict(params.get("kind"));
  const id = params.get("id");
  if (!provider || !kind || !id) return null;
  return { provider, kind, id };
}

/** Resolves a credit's other-provider identity for the "+ Filter" jump from
 * the link the providers published (identity URL match), with the account's
 * own stored merge as fallback — the same resolution the performer page
 * uses. Returns null when the providers never paired her (or resolution
 * fails), so the jump filters with the known side only. */
async function performerCounterpart(
  reference: CatalogReference,
): Promise<BrowseFilter["counterpart"] | null> {
  try {
    const payload = await api<{
      link: { linked?: CatalogReference } | { unlinkedReason?: string };
    }>(
      `/api/catalog/${reference.provider}/performer/${encodeURIComponent(reference.id)}`,
    );
    const linked = "linked" in payload.link ? payload.link.linked : undefined;
    if (linked?.kind !== "performer") return null;
    return {
      param:
        linked.provider === "stashdb" ? "performerStashdb" : "performerTpdb",
      id: linked.id,
    };
  } catch {
    // ponytail: best-effort enrichment — an outage while resolving still
    // browses the side we have; no error panel blocks the jump.
    return null;
  }
}

function DetailSkeleton() {
  return (
    <div aria-label="Loading details" aria-busy="true">
      <div className="skel cat-hero-skel" />
      <div className="cat-cols">
        <div className="space-y-3">
          <div className="skel h-24 w-full" />
          <div className="skel h-6 w-3/4" />
          <div className="skel h-4 w-full" />
          <div className="skel h-4 w-5/6" />
        </div>
        <div className="space-y-3">
          <div className="skel h-4 w-1/3" />
          <div className="skel h-20 w-full" />
          <div className="skel h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

const DECISION_TEXT: Record<RequestDecision, string> = {
  pending: "Requested — waiting for a moderator",
  approved: "Request approved",
  declined: "Request declined",
  cancelled: "Request cancelled",
};

/** Availability of the media target; null while loading or on error — a
 * failed check renders nothing, no claim either way. No request for
 * performer/studio targets. */
function useAvailability(
  target: {
    provider: CatalogProvider;
    kind: MediaKind;
    id: string;
  } | null,
): PlaybackAccess | null {
  const { data } = useApiGet<PlaybackAccess>(
    target
      ? `/api/availability/${target.provider}/${target.kind}/${encodeURIComponent(target.id)}`
      : null,
    [target?.provider, target?.kind, target?.id],
  );
  return data;
}

function MediaActions({
  target,
  mine,
  availability,
  onRefetch,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
  mine: DetailPayload["myRequest"];
  availability: PlaybackAccess | null;
  onRefetch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(mine);
  const [autoApproved, setAutoApproved] = useState(false);
  useEffect(() => setRequested(mine), [mine]);
  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ request: RequestRecord; autoApproved?: boolean }>(
        "/api/requests",
        {
          method: "POST",
          body: JSON.stringify({
            media: {
              provider: target.provider,
              kind: target.kind,
              id: target.id,
            },
          }),
        },
      );
      setRequested({
        id: d.request.id,
        decision: d.request.decision,
        createdAt: d.request.createdAt,
        decidedAt: d.request.decidedAt,
      });
      setAutoApproved(d.autoApproved === true);
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
    } catch (e) {
      if (e instanceof ApiError && e.code === "request_exists") {
        // An existing request is a state, not an error: reload the detail so
        // the real decision shows.
        onRefetch();
      } else {
        setError(messageOf(e));
      }
    } finally {
      setBusy(false);
    }
  }, [target, onRefetch]);
  // Already playable: the Play button is the only honest action left — a
  // second request would file intent for something the library already has.
  const available = availability?.outcome === "available";
  return (
    <div className="flex flex-col gap-2">
      {available ? null : requested ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip chip-accent">
            {DECISION_TEXT[requested.decision]}
          </span>
          {autoApproved && <span className="chip">Auto-approved</span>}
        </div>
      ) : !isDeliverableMedia(target) ? (
        <p className="text-xs text-muted">
          Browse only — Whisparr has no metadata source for a TPDB scene.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void request()}
          >
            {busy ? "Requesting…" : "Request this title"}
          </button>
          {error && (
            <span className="text-sm text-danger" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      {availability?.outcome === "available" && availability.watchUrl && (
        <a
          className="btn btn-accent"
          href={availability.watchUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="play" /> Play on Jellyfin
        </a>
      )}
    </div>
  );
}

/** Tag filters accept UUID ids only; mirrors the server's UUID_RE. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function DetailBody({
  payload,
  target,
  onNavigate,
  onBrowse,
  onRefetch,
}: {
  payload: DetailPayload;
  target: DetailTarget;
  onNavigate: (r: CatalogReference) => void;
  onBrowse: (filter: BrowseFilter) => void;
  onRefetch: () => void;
}) {
  const d = payload.detail;
  const mediaKind = asMediaKind(target.kind);
  // A provider-supplied studio reference (kind "studio") becomes a real
  // control; without one the studio stays plain text.
  const studioRef =
    d.studio?.reference && d.studio.reference.kind === "studio"
      ? d.studio.reference
      : null;
  // Availability is a media-target concept: no fetch for performer/studio.
  const mediaTarget =
    mediaKind !== null
      ? { provider: target.provider, kind: mediaKind, id: target.id }
      : null;
  const availability = useAvailability(mediaTarget);
  // Year filtering exists on TPDB movie lists only; StashDB has no
  // year or date filter (the route rejects it), so its dates stay plain.
  const releaseYear =
    mediaKind === "movie" && target.provider === "tpdb"
      ? (d.releaseDate?.slice(0, 4) ?? null)
      : null;
  const posterClass =
    target.kind === "performer" ? "cat-poster cat-poster-square" : "cat-poster";
  const backdrop = imgSrc(d.imageUrl);
  return (
    <>
      <header
        className="cat-hero"
        style={backdrop ? { backgroundImage: `url("${backdrop}")` } : undefined}
      >
        <div className="cat-hero-scrim" aria-hidden="true" />
        <div className="cat-hero-inner">
          <div className={posterClass}>
            <ItemImage
              name={d.title}
              src={imgSrc(d.imageUrl)}
              className="cat-poster-img"
            />
          </div>
          <div className="cat-hero-copy">
            <div className="cat-hero-meta">
              <span className="chip">
                {providerLabel(target.provider)} · {target.kind}
              </span>
              {/* Year filter on TPDB movie lists only; StashDB has
                  no year or date filter, so its dates stay plain text. */}
              {d.releaseDate &&
                (releaseYear ? (
                  <button
                    type="button"
                    className="chip"
                    title={`Show TPDB movies from ${releaseYear}`}
                    onClick={() =>
                      onBrowse({
                        param: "year",
                        provider: target.provider,
                        id: releaseYear,
                      })
                    }
                  >
                    {d.releaseDate}
                  </button>
                ) : (
                  <span className="chip">{d.releaseDate}</span>
                ))}
              {/* Duration stays plain text: no provider offers a duration filter. */}
              {duration(d.durationSeconds) && (
                <span className="chip">{duration(d.durationSeconds)}</span>
              )}
            </div>
            {availability?.outcome === "available" && (
              <span className="cat-badge cat-badge-available">Available</span>
            )}
            {availability?.outcome === "denied" && (
              <span className="cat-badge">No playback access</span>
            )}
            <h1 className="cat-hero-title">
              {d.title}
              {d.releaseDate?.slice(0, 4) ? (
                <>
                  {" "}
                  <span className="cat-hero-year">
                    ({d.releaseDate.slice(0, 4)})
                  </span>
                </>
              ) : null}
            </h1>
            {d.studio && (
              <p className="cat-hero-sub">
                {studioRef ? (
                  <>
                    {/* The hero name lands on the studio's titles — a studio
                        has no detail body worth a page; the aside chip does
                        the same thing lower down. */}
                    <button
                      type="button"
                      className="cat-hero-studio"
                      title={`Browse titles from ${d.studio?.name}`}
                      aria-label={`Browse titles from ${d.studio?.name}`}
                      onClick={() =>
                        onBrowse({
                          param:
                            studioRef.provider === "tpdb"
                              ? "studioTpdb"
                              : "studioStashdb",
                          provider: studioRef.provider,
                          id: studioRef.id,
                        })
                      }
                    >
                      {d.studio?.name}
                    </button>
                  </>
                ) : (
                  d.studio.name
                )}
              </p>
            )}
            {(payload.acquisition || availability?.outcome === "available") && (
              <div className="cat-hero-facts">
                {payload.acquisition && (
                  <span>{acquisitionText(payload.acquisition)}</span>
                )}
                {availability?.outcome === "available" && (
                  <FileFacts item={availability.item} />
                )}
              </div>
            )}
          </div>
          {mediaKind && (
            <div className="cat-hero-actions">
              <MediaActions
                target={{
                  provider: target.provider,
                  kind: mediaKind,
                  id: target.id,
                }}
                mine={payload.myRequest}
                availability={availability}
                onRefetch={onRefetch}
              />
            </div>
          )}
        </div>
      </header>

      <DetailSections
        payload={payload}
        target={target}
        onNavigate={onNavigate}
        onBrowse={onBrowse}
      />
    </>
  );
}

/** Detail sections after the hero (Overview/Tags/Cast, aside,
 * RelatedTitles), shared with the library item detail page. */
export function DetailSections({
  payload,
  target,
  onNavigate,
  onBrowse,
}: {
  payload: DetailPayload;
  target: DetailTarget;
  onNavigate: (r: CatalogReference) => void;
  onBrowse: (filter: BrowseFilter) => void;
}) {
  const d = payload.detail;
  const mediaKind = asMediaKind(target.kind);
  const linked = "linked" in payload.link ? payload.link.linked : undefined;
  // A provider-supplied studio reference (kind "studio") becomes a real
  // control; without one the studio stays plain text.
  const studioRef =
    d.studio?.reference && d.studio.reference.kind === "studio"
      ? d.studio.reference
      : null;
  // Tag chips become include constraints on media details — the unified
  // browse takes provider-scoped tags on every kind. Performer and studio
  // details keep their tags as plain text rather than dead controls.
  const tagBrowse = mediaKind !== null;
  const showSourceUrl =
    d.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : null;
  // Remember studio/tag names so browse chips can label the ids the URL
  // carries — details are where names are known.
  useEffect(() => {
    seedDetail(d, studioRef, tagBrowse);
  }, [studioRef, tagBrowse, d, target.provider]);
  return (
    <>
      <div className="cat-cols">
        <div>
          {(d.description || d.aliases.length > 0) && (
            <section
              className={mediaKind ? "cat-section" : undefined}
              aria-label="Overview"
            >
              <h2 className="cat-section-title">Overview</h2>
              {d.description && (
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {d.description}
                </p>
              )}
              {d.aliases.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Also known as: {d.aliases.join(", ")}
                </p>
              )}
            </section>
          )}

          {d.tags.length > 0 && (
            <section className="cat-section" aria-label="Tags">
              <h2 className="cat-section-title">Tags</h2>
              <div className="mt-2 flex flex-wrap gap-1">
                {[...d.tags]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) =>
                    // TPDB sometimes emits numeric-string tag ids that the
                    // filter layer rejects with 400 — those stay plain text.
                    tagBrowse && UUID_RE.test(t.id) ? (
                      <button
                        key={t.id}
                        type="button"
                        className="chip"
                        onClick={() =>
                          onBrowse({
                            param: "include",
                            provider: target.provider,
                            id: t.id,
                            tag:
                              target.provider === "tpdb"
                                ? { name: t.name, tpdb: t.id }
                                : { name: t.name, stashdb: t.id },
                          })
                        }
                      >
                        {t.name}
                      </button>
                    ) : (
                      <span key={t.id} className="chip">
                        {t.name}
                      </span>
                    ),
                  )}
              </div>
            </section>
          )}

          {d.credits.length > 0 && (
            <section className="cat-section cat-cast" aria-label="Performers">
              <h2 className="cat-section-title">Cast</h2>
              <div className="cat-people mt-2">
                {d.credits.map((c) => {
                  // Same binary provider split useBrowseTo applies to the
                  // browse type: TPDB credits filter movies, StashDB scenes.
                  // At click time her counterpart identity is resolved, so
                  // the linked jump adds BOTH ids and lands on browse All
                  // (movies and scenes in one grid).
                  const param =
                    c.reference.provider === "stashdb"
                      ? "performerStashdb"
                      : "performerTpdb";
                  return (
                    <div
                      key={`${c.reference.provider}:${c.reference.id}`}
                      className="cat-person"
                    >
                      <button
                        type="button"
                        className="cat-person-main"
                        onClick={() => onNavigate(c.reference)}
                      >
                        <ItemImage
                          name={c.name}
                          src={imgSrc(c.imageUrl)}
                          className="cat-person-img"
                        />
                        <span className="cat-person-name">{c.name}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-accent cat-person-filter"
                        title={`Filter by ${c.name}`}
                        aria-label={`Filter by ${c.name}`}
                        onClick={() => {
                          void performerCounterpart(c.reference).then(
                            (counterpart) =>
                              onBrowse({
                                param,
                                provider: c.reference.provider,
                                id: c.reference.id,
                                ...(counterpart ? { counterpart } : {}),
                              }),
                          );
                        }}
                      >
                        <Icon name="plus" /> Filter
                      </button>
                    </div>
                  );
                })}
              </div>
              {target.kind === "movie" && target.provider === "tpdb" && (
                <p className="mt-2 text-xs text-muted">
                  On TPDB a performer filter opens their whole filmography — it
                  replaces other filters rather than combining with them.
                </p>
              )}
            </section>
          )}
        </div>

        <aside>
          {studioRef && (
            <section className="cat-section" aria-label="Studio">
              <h2 className="cat-section-title">Studio</h2>
              <button
                type="button"
                className="chip mt-2"
                title={`Filter ${
                  studioRef.provider === "tpdb" ? "movies" : "scenes"
                } by this studio`}
                aria-label={`Filter ${
                  studioRef.provider === "tpdb" ? "movies" : "scenes"
                } by ${d.studio?.name}`}
                onClick={() =>
                  onBrowse({
                    param:
                      studioRef.provider === "tpdb"
                        ? "studioTpdb"
                        : "studioStashdb",
                    provider: studioRef.provider,
                    id: studioRef.id,
                  })
                }
              >
                {d.studio?.name}
              </button>
            </section>
          )}

          <section className="cat-section" aria-label="Cross-provider link">
            <h2 className="cat-section-title">Cross-provider link</h2>
            {linked ? (
              <button
                type="button"
                className="chip chip-accent mt-2"
                onClick={() => onNavigate(linked)}
              >
                Open the linked {providerLabel(linked.provider)} record
              </button>
            ) : (
              <p className="mt-2 text-xs text-muted">
                {"unlinkedReason" in payload.link
                  ? payload.link.unlinkedReason
                  : "No cross-provider link."}
              </p>
            )}
          </section>

          {(d.links.length > 0 || showSourceUrl) && (
            <section className="cat-section" aria-label="Links">
              <h2 className="cat-section-title">Links</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.links.map((l, i) => (
                  <a
                    key={i}
                    className="chip"
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {l.label ?? providerLabel(target.provider)}
                  </a>
                ))}
                {showSourceUrl && (
                  <a
                    className="chip"
                    href={showSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source · {providerLabel(target.provider)}
                  </a>
                )}
              </div>
            </section>
          )}

          {d.related.length > 0 && (
            <section className="cat-section" aria-label="Related">
              <h2 className="cat-section-title">
                {target.kind === "movie"
                  ? "Scenes in this movie (as supplied by the provider)"
                  : "Related"}
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.related.map((r, i) => (
                  <button
                    key={`${r.provider}:${r.kind}:${r.id}:${i}`}
                    type="button"
                    className="chip"
                    onClick={() => onNavigate(r)}
                  >
                    {providerLabel(r.provider)} · {r.kind} · {r.id.slice(0, 8)}…
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      {/* Fetched separately from the detail payload, so the related reads
          never delay playback or request actions above. */}
      {mediaKind && (
        <RelatedTitles
          target={{ provider: target.provider, kind: mediaKind, id: target.id }}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

/** Separately fetched similar titles for a movie/scene: real shared-tag
 * candidates from the providers, ranked deterministically; the optional Jev
 * pass only reranks those same candidates — it can never add titles. The
 * provider-supplied related references in the aside stay a distinct block. */
export function RelatedTitles({
  target,
  onNavigate,
}: {
  target: { provider: CatalogProvider; kind: MediaKind; id: string };
  onNavigate: (r: CatalogReference) => void;
}) {
  const [rank, setRank] = useState<"tags" | "jev">("tags");
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useApiGet<{
    items: CatalogDetail[];
    ranking: "tags" | "jev";
    canRank: boolean;
    errors: { provider: CatalogProvider; code: string; message: string }[];
  }>(
    `/api/catalog/${target.provider}/${target.kind}/${encodeURIComponent(target.id)}/related?rank=${rank}`,
    [target.provider, target.kind, target.id, rank, reload],
  );
  return (
    <section className="cat-section" aria-label="Similar titles">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="cat-section-title">Similar titles</h2>
        {data?.canRank === true && rank === "tags" && (
          <button type="button" className="btn" onClick={() => setRank("jev")}>
            Refine with Jev
          </button>
        )}
      </div>
      <p className="cat-note">
        {data?.ranking === "jev"
          ? "Jev reranked the same provider candidates by metadata similarity — it never adds titles."
          : "Matched by shared provider tags; a title with no tags has no candidates."}
      </p>
      {error !== null ? (
        <p className="cat-note" role="alert">
          Similar titles failed: {error}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : loading ? (
        <p className="cat-note" aria-live="polite">
          Loading similar titles…
        </p>
      ) : data === null ? null : data.errors.length > 0 ? (
        <p className="cat-note" role="alert">
          {data.errors
            .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
            .join(" · ")}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : data.items.length === 0 ? (
        <p className="cat-note">No shared tags — nothing similar yet.</p>
      ) : (
        <div className="poster-grid mt-3">
          {data.items.map((it) =>
            it.reference.kind === "scene" ? (
              <SceneCard
                key={`${it.reference.provider}:${it.reference.id}`}
                item={it}
                onOpen={onNavigate}
              />
            ) : (
              <MovieCard
                key={`${it.reference.provider}:${it.reference.id}`}
                item={it}
                onOpen={onNavigate}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** The open catalog detail: provider + kind + id URL params, rendered as a
 * full page inside app main — top search and sidebar stay usable. Returns
 * null when closed; mounted by the unified titles view so any surface can
 * open it. The browse grid behind it stays mounted but hidden, so returning
 * is instant and never refetches. Exported for the app shell's mounting. */
export function CatalogDetailView({
  browseTo,
}: {
  browseTo: (filter: BrowseFilter) => void;
}) {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const target = detailTarget(params);
  const pageRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [reload, setReload] = useState(0);
  const provider = target?.provider;
  const kind = target?.kind;
  const id = target?.id;
  const refKey = provider && kind && id ? `${provider}:${kind}:${id}` : null;
  const detail = useApiGet<DetailPayload>(
    provider && kind && id
      ? `/api/catalog/${provider}/${kind}/${encodeURIComponent(id)}`
      : null,
    [provider, kind, id, reload],
  );
  // 404 catalog_not_found is authoritative absence, not an outage: it gets its
  // own panel and no retry, so it must not reach the error string.
  const notFound = detail.err?.status === 404;
  const error = notFound ? null : detail.error;
  // Blank while a read is in flight, so a new target never renders the
  // previous item's body under the new key.
  const payload = detail.loading ? null : detail.data;

  // Closing clears only the detail target. `provider` is also the browse
  // source, so clearing it silently switched a StashDB browse back to TPDB.
  const close = useCallback(() => setP({ kind: null, id: null }), [setP]);

  // Escape closes; focus moves in on open and is restored on close.
  const open = refKey !== null;
  // Runs once per open/close — in-page navigation must not re-capture or
  // restore focus; only closing does.
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prevFocus.current?.focus();
    };
  }, [open, close]);
  // Moves focus to the page on open and whenever the target changes.
  useEffect(() => {
    if (open) pageRef.current?.focus();
  }, [open, refKey]);
  // Scroll: the position behind the detail is saved under the browse state
  // (URL minus provider/kind/id/tab) when it opens and restored when it
  // closes — Escape, Back to browse and Back all close it. Deliberate
  // filter changes never open the detail, so they never cause a jump.
  useEffect(() => {
    if (refKey === null) {
      if (wasOpen.current) {
        wasOpen.current = false;
        restoreScroll(browseKeyOf(params));
      }
      return;
    }
    if (!wasOpen.current) {
      wasOpen.current = true;
      saveScroll(browseKeyOf(params));
      window.scrollTo(0, 0);
    }
  });

  if (!target) return null;
  return (
    <div
      ref={pageRef}
      className="cat-detail"
      tabIndex={-1}
      aria-label={
        payload ? `${payload.detail.title} details` : "Catalog details"
      }
    >
      <div className="cat-topline">
        <button type="button" className="btn" onClick={close}>
          <Icon name="chevron-left" /> Back to browse
        </button>
      </div>
      {notFound ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">Not in the provider catalog</h3>
          <p className="mt-2 text-sm text-muted">
            {providerLabel(target.provider)} no longer has this record. It may
            have been removed at the source.
          </p>
        </div>
      ) : error ? (
        <ErrorPanel
          title="Catalog unavailable"
          message={error}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : !payload ? (
        <DetailSkeleton />
      ) : (
        <DetailBody
          key={refKey}
          payload={payload}
          target={target}
          onNavigate={(r) =>
            // Detail navigation is in-page over the unified view, and a
            // surface change: it pushes, so Back walks the trail.
            setP(detailParams(r), { push: true })
          }
          onBrowse={browseTo}
          onRefetch={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}
