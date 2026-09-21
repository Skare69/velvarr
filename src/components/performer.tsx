"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiError,
  api,
  duration,
  ErrorPanel,
  GridSkeleton,
  Icon,
  imgSrc,
  intOr,
  ItemImage,
  messageOf,
  MovieCard,
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
      <div className="flex gap-2">
        <button
          type="button"
          className="btn"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasMore}
          onClick={() => go(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/* ---------- One paged listing: the provider's only kind ---------- */

function Listing({
  provider,
  kind,
  performerId,
  performerName,
  page,
  perPage,
}: {
  provider: CatalogProvider;
  kind: "movie" | "scene";
  performerId: string;
  performerName: string;
  page: number;
  perPage: number;
}) {
  const setP = useParamsSetter();
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
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
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

/* ---------- The performer page ---------- */

export function PerformerView({ reference }: { reference: CatalogReference }) {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const { providers } = useSession();
  // URL-driven: page survives reload and Back.
  const page = Math.max(1, intOr(params.get("page"), 1));
  const perPage = Math.min(100, Math.max(1, intOr(params.get("perPage"), 24)));
  const notConfigured = providers?.[reference.provider] === "not_configured";
  const [reload, setReload] = useState(0);
  // One metadata source per provider: TPDB performers only have movies,
  // StashDB performers only have scenes.
  const kind: "movie" | "scene" =
    reference.provider === "tpdb" ? "movie" : "scene";

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

  // Opening a title leaves the performer page for a detail: push, so Back
  // returns here. Replacing overwrote the performer entry, and Back jumped
  // all the way to whatever preceded it.
  const open = useCallback(
    (r: CatalogReference) =>
      setP({ provider: r.provider, kind: r.kind, id: r.id }, { push: true }),
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
                  <span className="chip">
                    {providerLabel(reference.provider)} · performer
                  </span>
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

                <div className="mt-4">
                  <div className="label">Cross-provider link</div>
                  {linked ? (
                    <button
                      type="button"
                      className="chip chip-accent mt-1"
                      onClick={() => open(linked)}
                    >
                      Open the linked {providerLabel(linked.provider)} record
                    </button>
                  ) : (
                    <p className="mt-1 text-xs text-muted">
                      {unlinkedReason
                        ? unlinkedReason
                        : "No cross-provider link is recorded, so the other provider’s catalog cannot be shown for this performer."}
                    </p>
                  )}
                </div>

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

          <div className="mt-8">
            <Listing
              key={kind}
              provider={reference.provider}
              kind={kind}
              performerId={reference.id}
              performerName={d.title}
              page={page}
              perPage={perPage}
            />
          </div>
        </>
      )}
    </section>
  );
}
