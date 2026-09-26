"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiError,
  api,
  duration,
  ErrorPanel,
  GridSkeleton,
  detailParams,
  Icon,
  imgSrc,
  intOr,
  ItemImage,
  messageOf,
  MovieCard,
  PerformerCard,
  providerLabel,
  SceneCard,
  useApiGet,
  useParamsSetter,
  useSession,
} from "./shared";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  PerformerFollow,
} from "../lib/contracts";
import { mergeTagCounts } from "../lib/contracts";
import { REQUESTS_CHANGED } from "../lib/approvals";
import "./views.css";

/* ---------- Local shapes ---------- */

type DetailPayload = {
  detail: CatalogDetail;
  link: { linked?: CatalogReference } | { unlinkedReason?: string };
};

type SearchPage = {
  page: number;
  perPage: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  items: CatalogDetail[];
};

/* ---------- Small helpers (same conventions as catalog.tsx) ---------- */

/** Opening another record leaves this page for that record's own surface;
 * the per-kind page keys are dropped because page 3 of one performer's
 * movies is meaningless on the next. */
function openParams(r: CatalogReference) {
  return { ...detailParams(r), moviePage: null, scenePage: null };
}

/* ---------- Fetch hooks: a live flag makes stale in-flight responses inert ---------- */

/** The view tells three failures apart — provider not configured, a 404 that
 * means "gone at the source", and an outage that deserves a retry — so this
 * read needs the ApiError, not just its message. */
function usePerformerDetail(
  provider: CatalogProvider,
  id: string,
  enabled: boolean,
  reload: number,
): { payload: DetailPayload | null; err: ApiError | null; loading: boolean } {
  const { data, error, err, loading } = useApiGet<DetailPayload>(
    enabled
      ? `/api/catalog/${provider}/performer/${encodeURIComponent(id)}`
      : null,
    [provider, id, reload],
  );
  return {
    payload: data,
    // A non-ApiError failure still has to reach the retry panel, not fall
    // through to a skeleton that never resolves.
    err: err ?? (error === null ? null : new ApiError(0, "network", error)),
    loading,
  };
}

function usePerformerListing(
  provider: CatalogProvider,
  kind: "movie" | "scene",
  performerId: string,
  page: number,
  perPage: number,
  reload: number,
): { data: SearchPage | null; error: string | null; loading: boolean } {
  const qs = new URLSearchParams({
    provider,
    kind,
    performer: performerId,
    page: String(page),
    perPage: String(perPage),
  });
  // An outage is an error with retry, never an empty page.
  return useApiGet<SearchPage>(`/api/catalog/search?${qs.toString()}`, [
    provider,
    kind,
    performerId,
    page,
    perPage,
    reload,
  ]);
}

/* ---------- Cards: the established treatments ---------- */

/* ---------- Panels, skeleton, paging ---------- */

function HeaderSkeleton() {
  return (
    <div
      className="performer-hero relative flex flex-col gap-5 p-5 sm:flex-row sm:p-6"
      aria-label="Loading performer"
      aria-busy="true"
    >
      <div className="skel aspect-[2/3] w-40 shrink-0 self-center sm:w-48 sm:self-start" />
      <div className="min-w-0 flex-1 space-y-3 pt-1">
        <div className="skel h-7 w-1/2" />
        <div className="skel h-4 w-1/4" />
        <div className="skel h-4 w-full" />
        <div className="skel h-4 w-2/3" />
      </div>
    </div>
  );
}

function Paging({
  page,
  hasMore,
  total,
  totalCountKnown,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  total?: number;
  totalCountKnown: boolean;
  onPage: (p: number) => void;
}) {
  const go = (p: number) => {
    onPage(p);
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <div className="text-sm text-muted">
        {/* A capped total is never rendered as a catalog size. */}
        {totalCountKnown && total != null ? `${total} results · ` : ""}Page{" "}
        {page}
      </div>
      {/* Same chevron treatment as the overview rails: icon-only arrows with
          honest disabled edges; the page contract (moviePage/scenePage keys,
          Previous/Next semantics) is unchanged. */}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          <Icon name="chevron-left" />
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Next page"
          disabled={!hasMore}
          onClick={() => go(page + 1)}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
    </div>
  );
}

/* ---------- One paged listing: one kind from the provider that has it ---------- */

/** Each kind pages independently, so paging her movies never resets her
 * scenes; both keys live in the URL, so a reload or Back restores both. */
function Listing({
  provider,
  kind,
  performerId,
  performerName,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  performerName: string;
}) {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const pageParam = kind === "movie" ? "moviePage" : "scenePage";
  const page = Math.max(1, intOr(params.get(pageParam), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const [reload, setReload] = useState(0);
  const { data, error, loading } = usePerformerListing(
    provider,
    kind,
    performerId,
    page,
    perPage,
    reload,
  );
  // Same as the performer page: a detail is another surface, so it pushes.
  const open = useCallback(
    (r: CatalogReference) => setP(openParams(r), { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ [pageParam]: p > 1 ? String(p) : null }),
    [setP, pageParam],
  );
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const kindLabel = kind === "movie" ? "movies" : "scenes";
  return (
    <div>
      <h3 className="font-semibold">
        {performerName}&rsquo;s {kindLabel}
      </h3>
      {error ? (
        <ErrorPanel
          title={`${providerLabel(provider)} unavailable`}
          message={error}
          onRetry={retry}
        />
      ) : loading || !data ? (
        <GridSkeleton
          aspect="aspect-[2/3]"
          cols="poster-grid"
          count={kind === "movie" ? 10 : 6}
        />
      ) : data.items.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">
          {providerLabel(provider)} returned no {kindLabel} for {performerName}.
        </div>
      ) : (
        <>
          <BulkRequest
            key={performerId}
            provider={provider}
            kind={kind}
            performerId={performerId}
            performerName={performerName}
          />
          <div className="poster-grid">
            {data.items.map((it) =>
              kind === "movie" ? (
                <MovieCard key={it.reference.id} item={it} onOpen={open} />
              ) : (
                <SceneCard key={it.reference.id} item={it} onOpen={open} />
              ),
            )}
          </div>
          <Paging
            page={page}
            hasMore={data.hasMore}
            total={data.total}
            totalCountKnown={data.totalCountKnown}
            onPage={onPage}
          />
        </>
      )}
    </div>
  );
}

/* ---------- Bulk "request everything" ---------- */

/* Only fields the response contained are rendered — a missing count is never
 * shown as 0. */
type BulkResponse = {
  requested?: number;
  skipped?: number;
  autoApproved?: number;
  failed?: { id: string; code: string }[];
  scanned?: number;
  capped?: boolean;
};

function BulkRequest({
  provider,
  kind,
  performerId,
  performerName,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  performerName: string;
}) {
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResponse | null>(null);
  const noun = kind === "movie" ? "movie" : "scene";

  const run = async () => {
    confirmRef.current?.close();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<BulkResponse>("/api/requests/bulk", {
          method: "POST",
          body: JSON.stringify({
            performer: { provider, kind: "performer", id: performerId },
            kind,
          }),
        }),
      );
      window.dispatchEvent(new Event(REQUESTS_CHANGED));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const counts = result
    ? [
        typeof result.requested === "number"
          ? `${result.requested} requested`
          : null,
        typeof result.autoApproved === "number"
          ? `${result.autoApproved} auto-approved`
          : null,
        typeof result.skipped === "number" && result.skipped > 0
          ? `${result.skipped} skipped (already requested)`
          : null,
        result.failed ? `${result.failed.length} failed` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="mb-4">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setError(null);
          confirmRef.current?.showModal();
        }}
      >
        Request every {noun}
      </button>
      {counts.length > 0 && (
        <p className="mt-2 text-sm" role="status">
          {counts.join(" · ")}
          {result?.capped
            ? " — more titles remain; press again to continue where this stopped."
            : "."}
        </p>
      )}
      {error && (
        <p className="bulk-error mt-2 text-sm" role="alert">
          The bulk request did not run: {error}
        </p>
      )}
      <dialog
        ref={confirmRef}
        className="bulk-dialog"
        aria-labelledby="bulk-request-title"
      >
        <div className="p-5">
          <h3 id="bulk-request-title" className="font-semibold">
            Request every {noun}?
          </h3>
          <p className="mt-2 text-sm text-muted">
            A request is filed for each {noun} {performerName} appears in on{" "}
            {providerLabel(provider)}. Titles you already requested are skipped.
            At most 100 titles are processed per press.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => confirmRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void run()}
            >
              File the requests
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/* ---------- Follow / unfollow the performer on this page ---------- */

/** There is deliberately no per-performer status endpoint: the whole follow
 * list is read and matched here. A follow covers both providers, so this page
 * counts as followed when either side of the stored pair names it. State only
 * moves after the server confirms — never an optimistic flip. If the list
 * cannot be read, the button says so and pressing it retries; it never
 * guesses "not following". */
function FollowStar({
  provider,
  id,
  name,
  imageUrl,
}: {
  provider: CatalogProvider;
  id: string;
  name: string;
  imageUrl: string | null;
}) {
  const [status, setStatus] = useState<
    "unknown" | "following" | "notFollowing"
  >("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    let live = true;
    setError(null);
    setStatus("unknown");
    api<{ follows: PerformerFollow[] }>("/api/follows")
      .then((d) => {
        if (!live) return;
        setStatus(
          d.follows.some(
            (f) =>
              (f.reference.provider === provider && f.reference.id === id) ||
              (f.linked?.provider === provider && f.linked.id === id),
          )
            ? "following"
            : "notFollowing",
        );
      })
      .catch((e) => {
        if (live) setError(messageOf(e)); // status stays "unknown"
      });
    return () => {
      live = false;
    };
  }, [provider, id]);
  useEffect(check, [check]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (status === "following") {
        await api(`/api/follows/${provider}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        setStatus("notFollowing");
      } else {
        await api("/api/follows", {
          method: "POST",
          body: JSON.stringify({
            performer: { provider, kind: "performer", id },
            name,
            imageUrl,
          }),
        });
        setStatus("following");
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`btn follow-toggle${status === "following" ? " is-following" : ""}`}
        aria-pressed={
          status === "following"
            ? true
            : status === "notFollowing"
              ? false
              : undefined
        }
        aria-label={
          status === "following"
            ? `Unfollow ${name}`
            : status === "notFollowing"
              ? `Follow ${name}`
              : `Check whether you follow ${name}`
        }
        disabled={busy}
        onClick={() => void (status === "unknown" ? check() : toggle())}
      >
        <Icon name="star" filled={status === "following"} />
        {status === "following"
          ? "Following"
          : status === "notFollowing"
            ? "Follow"
            : "Follow status unavailable"}
      </button>
      {error && (
        <p className="bulk-error mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------- Often appears with ---------- */

/** Co-appearance on published credits — the providers' own filmographies are
 * the only evidence, so the heading says "often appears with", never
 * "similar". The fetch runs after the page renders, so it never delays the
 * follow button or the listings above. Empty evidence renders nothing at
 * all — no similarity is ever invented. */
function RelatedPerformers({
  provider,
  id,
  onOpen,
}: {
  provider: CatalogProvider;
  id: string;
  onOpen: (r: CatalogReference) => void;
}) {
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useApiGet<{
    items: CatalogDetail[];
    errors: { provider: CatalogProvider; code: string; message: string }[];
  }>(`/api/catalog/${provider}/performer/${encodeURIComponent(id)}/related`, [
    provider,
    id,
    reload,
  ]);
  // Empty items with empty errors is "no co-appearance evidence": the whole
  // section, heading included, disappears rather than claiming a similarity.
  if (error === null && !loading && data !== null) {
    if (data.errors.length === 0 && data.items.length === 0) return null;
  }
  return (
    <div>
      <h3 className="font-semibold">Often appears with</h3>
      {error !== null ? (
        <p className="mt-2 text-sm text-muted" role="alert">
          Co-appearance lookup failed: {error}{" "}
          <button
            type="button"
            className="btn"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : loading ? (
        <p className="mt-2 text-sm text-muted" aria-live="polite">
          Looking up shared credits…
        </p>
      ) : data === null ? null : data.errors.length > 0 ? (
        <p className="mt-2 text-sm text-muted" role="alert">
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
      ) : data.items.length === 0 ? null : (
        // Empty items with empty errors is "no co-appearance evidence" —
        // the section disappears entirely rather than claiming a similarity.
        <div className="poster-grid mt-3">
          {data.items.map((it) => (
            <PerformerCard
              key={`${it.reference.provider}:${it.reference.id}`}
              item={it}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Tags overview: counted across her listed titles ---------- */

type TagCounts = {
  tags: { name: string; count: number }[];
  scanned: number;
  capped: boolean;
  errors: { provider: CatalogProvider; code: string; message: string }[];
};

const TAGS_SHOWN = 50;

/** Tag counts from one provider side of her filmography, fetched after the
 * page renders so it never delays the follow button or the listings. Each
 * side reports its own coverage (`scanned`/`capped`) and its own errors — a
 * failed side shrinks the overview and says so, never reads as complete. */
function TagsOverview({
  reference,
  linked,
}: {
  reference: CatalogReference;
  linked?: CatalogReference;
}) {
  const [reload, setReload] = useState(0);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const pathOf = (r: CatalogReference) =>
    `/api/catalog/${r.provider}/performer/${encodeURIComponent(r.id)}/tags`;
  const linkedPath = linked?.kind === "performer" ? pathOf(linked) : null;
  const own = useApiGet<TagCounts>(pathOf(reference), [
    reference.provider,
    reference.id,
    reload,
  ]);
  const other = useApiGet<TagCounts>(linkedPath, [
    linkedPath,
    linked?.id,
    reload,
  ]);
  if (own.loading || (linkedPath !== null && other.loading)) return null;
  const sides = [own.data, other.data].filter(
    (d): d is TagCounts => d !== null,
  );
  // A whole-side fetch failure becomes evidence in the same shape the server
  // reports partial provider errors in.
  const fetchFailures: TagCounts["errors"] = [];
  if (own.data === null && own.error !== null) {
    fetchFailures.push({
      provider: reference.provider,
      code: "error",
      message: own.error,
    });
  }
  if (
    linked !== undefined &&
    linked.kind === "performer" &&
    other.data === null &&
    other.error !== null
  ) {
    fetchFailures.push({
      provider: linked.provider,
      code: "error",
      message: other.error,
    });
  }
  const errors = [...sides.flatMap((d) => d.errors), ...fetchFailures];
  const merged = mergeTagCounts(sides.map((d) => d.tags));
  if (merged.length === 0) {
    // No tags counted and nothing failed: no listed titles carry tags, so
    // the section disappears rather than claiming an overview.
    if (errors.length === 0) return null;
    return (
      <p className="text-sm text-muted" role="alert">
        Tags could not be loaded:{" "}
        {errors
          .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
          .join(" · ")}{" "}
        <button type="button" className="btn" onClick={retry}>
          Retry
        </button>
      </p>
    );
  }
  const shown = merged.slice(0, TAGS_SHOWN);
  const scanned = sides.reduce((n, d) => n + d.scanned, 0);
  const capped = sides.some((d) => d.capped);
  return (
    <section aria-label="Tags overview">
      <h3 className="font-semibold">Tags</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {shown.map((t) => (
          <span key={t.name} className="chip">
            {t.name}
            <span className="ml-1.5 text-muted">{t.count}</span>
          </span>
        ))}
      </div>
      {merged.length > shown.length && (
        <p className="mt-2 text-xs text-muted">
          +{merged.length - shown.length} more
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        Counted across {scanned} of her listed titles
        {capped
          ? " — the first pages each provider returns, not her whole filmography"
          : ""}
        .
      </p>
      {errors.length > 0 && (
        <p className="mt-2 text-xs text-muted" role="alert">
          Partial:{" "}
          {errors
            .map((e) => `${providerLabel(e.provider)}: ${e.message}`)
            .join(" · ")}{" "}
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </p>
      )}
    </section>
  );
}

/* ---------- The performer page ---------- */

export function PerformerView({ reference }: { reference: CatalogReference }) {
  const setP = useParamsSetter();
  const { providers } = useSession();
  const notConfigured = providers?.[reference.provider] === "not_configured";
  const [reload, setReload] = useState(0);

  const { payload, err, loading } = usePerformerDetail(
    reference.provider,
    reference.id,
    !notConfigured,
    reload,
  );
  const linked = payload
    ? "linked" in payload.link
      ? payload.link.linked
      : undefined
    : undefined;
  const unlinkedReason = payload
    ? "unlinkedReason" in payload.link
      ? payload.link.unlinkedReason
      : undefined
    : undefined;

  // One metadata source per kind: TPDB has her movies, StashDB has her scenes.
  // She is one person, so both catalogs belong on her page — the counterpart
  // comes from the link the providers published, never from her name. Movies
  // first either way, so the order does not depend on which side you opened.
  const sides: { provider: CatalogProvider; id: string }[] = [
    { provider: reference.provider, id: reference.id },
    ...(linked?.kind === "performer"
      ? [{ provider: linked.provider, id: linked.id }]
      : []),
  ].sort((a, b) =>
    a.provider === "tpdb" ? -1 : b.provider === "tpdb" ? 1 : 0,
  );
  // The side that is missing, so the page can say which catalog is absent
  // instead of quietly showing half a career.
  const missing = sides.some((s) => s.provider === "tpdb")
    ? sides.some((s) => s.provider === "stashdb")
      ? null
      : "stashdb"
    : "tpdb";

  // Opening a title leaves the performer page for a detail: push, so Back
  // returns here. Replacing overwrote the performer entry, and Back jumped
  // all the way to whatever preceded it.
  const open = useCallback(
    (r: CatalogReference) => setP(openParams(r), { push: true }),
    [setP],
  );

  const d = payload?.detail;
  const sourceUrl =
    d?.sourceUrl && !d.links.some((l) => l.url === d.sourceUrl)
      ? d.sourceUrl
      : undefined;

  // The performer page is entered with a pushed history entry, so Back returns
  // to the results that led here. Shown only when there is somewhere to go
  // back to, so a deep link never offers a control that leaves the app.
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;

  return (
    <section aria-label="Performer">
      {canGoBack && (
        <button
          type="button"
          className="btn mb-3"
          onClick={() => window.history.back()}
        >
          Back to results
        </button>
      )}
      {notConfigured || err?.code === "provider_not_configured" ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">
            {providerLabel(reference.provider)} is not configured
          </h3>
          <p className="mt-2 text-sm text-muted">
            No API key is present for {providerLabel(reference.provider)}, so
            this performer&rsquo;s page cannot be loaded. Ask an administrator
            to add a key in Settings. This is different from a temporary outage
            — an outage would show a retry.
          </p>
        </div>
      ) : err?.status === 404 ? (
        <div className="panel p-6" role="note">
          <h3 className="font-semibold">Not in the provider catalog</h3>
          <p className="mt-2 text-sm text-muted">
            {providerLabel(reference.provider)} no longer has this record. It
            may have been removed at the source.
          </p>
        </div>
      ) : err ? (
        <ErrorPanel
          title={`${providerLabel(reference.provider)} unavailable`}
          message={err.message}
          onRetry={() => setReload((n) => n + 1)}
        />
      ) : loading || !d ? (
        <HeaderSkeleton />
      ) : (
        <>
          <div className="performer-hero">
            {d.imageUrl && (
              <ItemImage
                name=""
                src={imgSrc(d.imageUrl)}
                className="performer-backdrop"
              />
            )}
            <div className="performer-scrim" aria-hidden="true" />
            <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:p-6">
              <div className="relative aspect-[2/3] w-40 shrink-0 self-center overflow-hidden rounded-lg border border-edge bg-raised sm:self-start sm:w-48">
                <ItemImage
                  name={d.title}
                  src={imgSrc(d.imageUrl)}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="page-title">{d.title}</h2>
                <div className="mt-2 flex flex-wrap gap-1">
                  {/* Which sources this page is reading, now that it reads
                      both sides when the providers link them. */}
                  <span className="chip">performer</span>
                  {sides.map((s) => (
                    <span key={s.provider} className="chip">
                      {providerLabel(s.provider)}
                    </span>
                  ))}
                </div>
                <div className="mt-3">
                  <FollowStar
                    key={`${reference.provider}:${reference.id}`}
                    provider={reference.provider}
                    id={reference.id}
                    name={d.title}
                    imageUrl={d.imageUrl ?? null}
                  />
                </div>
                {d.aliases.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    Also known as: {d.aliases.join(", ")}
                  </p>
                )}
                {d.description && (
                  <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
                    {d.description}
                  </p>
                )}

                {(d.links.length > 0 || sourceUrl) && (
                  <div className="mt-4">
                    <div className="label">Links</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {d.links.map((l, i) => (
                        <a
                          key={i}
                          className="chip"
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {l.label ?? providerLabel(reference.provider)}
                        </a>
                      ))}
                      {sourceUrl && (
                        <a
                          className="chip"
                          href={sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Source · {providerLabel(reference.provider)}
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-8 space-y-8">
            <TagsOverview reference={reference} linked={linked} />
            {sides.map((s) => (
              <Listing
                key={s.provider}
                provider={s.provider}
                kind={s.provider === "tpdb" ? "movie" : "scene"}
                performerId={s.id}
                performerName={d.title}
              />
            ))}
            {missing && (
              <div className="panel p-6" role="note">
                <h3 className="font-semibold">
                  {missing === "tpdb"
                    ? `${d.title}’s movies are not shown`
                    : `${d.title}’s scenes are not shown`}
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {unlinkedReason ??
                    `${providerLabel(reference.provider)} publishes no ${providerLabel(missing)} link for this performer, and ${providerLabel(missing)} is the only source for ${missing === "tpdb" ? "movies" : "scenes"}. Velvarr pairs only the records the providers link themselves — it never matches performers by name.`}
                </p>
              </div>
            )}
            <RelatedPerformers
              provider={reference.provider}
              id={reference.id}
              onOpen={open}
            />
          </div>
        </>
      )}
    </section>
  );
}
