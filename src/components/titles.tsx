"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { CatalogDetail, CatalogReference } from "../lib/contracts.ts";
import { filterNames } from "./catalog.tsx";
import {
  detailParams,
  ErrorPanel,
  GridSkeleton,
  Icon,
  intOr,
  MovieCard,
  SceneCard,
  useApiGet,
  useParamsSetter,
} from "./shared.tsx";

/* The unified titles surface: one grid holding a facet's TPDB movies AND
 * StashDB scenes together, told apart by the MOVIE/SCENE badges the cards
 * already render. Reached only through facet links (Studios/Genres rails),
 * never a nav entry.
 *
 * Wire shape mirrors the server's search response; kept local like
 * discover.tsx — contracts.ts stays domain records. */
type CatalogSearchPage = {
  provider: string;
  kind: string;
  page: number;
  perPage: number;
  hasMore: boolean;
  items: CatalogDetail[];
};

const POSTER_GRID = "poster-grid";
const PER_PAGE = 12;

/** A facet tile means one studio/category across both providers: the tpdb id
 * drives a movie search, the stashdb id a scene search. A side with no id in
 * the URL simply isn't fetched (null path) — a facet that exists on only one
 * provider degrades to that one source, never to an error. */
export function TitlesView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const rawFacet = params.get("facet");
  const facet = rawFacet === "studio" || rawFacet === "tag" ? rawFacet : null;
  const tpdbId = params.get("tpdb") ?? "";
  const stashdbId = params.get("stashdb") ?? "";
  const page = Math.max(1, intOr(params.get("page"), 1));
  const complete = facet !== null && (tpdbId !== "" || stashdbId !== "");

  const facetKey = facet === "studio" ? "studio" : "tags";
  // `studioMode=withChildren` on StashDB studios: a studio is often a parent
  // label whose scenes live under child studios (Brazzers: 48 children, 0
  // direct scenes); withChildren is the documented upstream criterion for
  // "everything from this studio".
  const tpdbPath =
    complete && tpdbId
      ? `/api/catalog/search?${new URLSearchParams({
          provider: "tpdb",
          kind: "movie",
          [facetKey]: tpdbId,
          page: String(page),
          perPage: String(PER_PAGE),
        })}`
      : null;
  const stashdbPath =
    complete && stashdbId
      ? `/api/catalog/search?${new URLSearchParams({
          provider: "stashdb",
          kind: "scene",
          [facetKey]: stashdbId,
          ...(facet === "studio" ? { studioMode: "withChildren" } : {}),
          page: String(page),
          perPage: String(PER_PAGE),
        })}`
      : null;

  const tpdb = useApiGet<CatalogSearchPage>(tpdbPath, [tpdbPath]);
  const stashdb = useApiGet<CatalogSearchPage>(stashdbPath, [stashdbPath]);

  // Display-only merge: order the current page by releaseDate descending,
  // undated last. Sort is stable, so ties keep source order.
  // ponytail: this orders the fetched page, not a global cross-provider
  // sort — each source pages independently under one shared page number, so
  // page 2 can repeat a date from page 1. A server-side merge endpoint is
  // the upgrade if a true global order ever matters.
  const merged = useMemo(() => {
    const rows = [...(tpdb.data?.items ?? []), ...(stashdb.data?.items ?? [])];
    rows.sort((a, b) => {
      const da = a.releaseDate ?? "";
      const db = b.releaseDate ?? "";
      if (da === db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? 1 : -1;
    });
    return rows;
  }, [tpdb.data, stashdb.data]);

  const openDetail = useCallback(
    (r: CatalogReference) => setP(detailParams(r), { push: true }),
    [setP],
  );
  const onPage = useCallback(
    (p: number) => setP({ page: p > 1 ? String(p) : null }),
    [setP],
  );

  if (!complete) {
    return (
      <section className="panel p-8 text-center" aria-label="Titles">
        <h2 className="page-title">Incomplete link</h2>
        <p className="mt-2 text-sm text-muted">
          This link does not name a studio or category on either provider, so
          there is nothing to list.
        </p>
        <div className="mt-4">
          <Link href="/" className="btn">
            Back to Discover
          </Link>
        </div>
      </section>
    );
  }

  // `name` is display-only (never queried), so a forged label can mislabel
  // the heading but never change results. Falls back to a name captured in
  // filterNames, then the raw id — never an invented name.
  const label =
    params.get("name") ||
    (tpdbId ? filterNames.get(`tpdb:${facet}:${tpdbId}`) : undefined) ||
    (stashdbId
      ? filterNames.get(`stashdb:${facet}:${stashdbId}`)
      : undefined) ||
    tpdbId ||
    stashdbId;
  const both = tpdbId !== "" && stashdbId !== "";
  const sources = [
    tpdbId ? "TPDB movies" : null,
    stashdbId ? "StashDB scenes" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tpdbFailed = tpdbId !== "" && tpdb.error !== null;
  const stashdbFailed = stashdbId !== "" && stashdb.error !== null;
  const anyLoading =
    (tpdbPath !== null && tpdb.loading) ||
    (stashdbPath !== null && stashdb.loading);
  // An empty claim is only honest when every present source actually
  // answered: a failed source never counts as "nothing".
  const honestlyEmpty =
    !anyLoading && !tpdbFailed && !stashdbFailed && merged.length === 0;

  return (
    <section aria-label={`Titles for ${label}`}>
      <div className="page-heading">
        <div className="min-w-0">
          <h2 className="page-title">{label}</h2>
          <p className="page-description">{sources}</p>
        </div>
        <div className="page-toolbar">
          <Link href="/" className="btn">
            <Icon name="chevron-left" />
            Discover
          </Link>
        </div>
      </div>

      {tpdbFailed && stashdbFailed ? (
        <ErrorPanel
          title="Both sources failed"
          message={`${tpdb.error} — ${stashdb.error}`}
          onRetry={() => {
            tpdb.reload();
            stashdb.reload();
          }}
        />
      ) : (
        <>
          {tpdbFailed && (
            <ErrorPanel
              title="TPDB movies unavailable"
              message={tpdb.error ?? ""}
              onRetry={tpdb.reload}
            />
          )}
          {stashdbFailed && (
            <ErrorPanel
              title="StashDB scenes unavailable"
              message={stashdb.error ?? ""}
              onRetry={stashdb.reload}
            />
          )}
        </>
      )}

      <div className="mt-4">
        {anyLoading && merged.length === 0 ? (
          <GridSkeleton
            aspect="aspect-[2/3]"
            cols={POSTER_GRID}
            count={PER_PAGE}
          />
        ) : honestlyEmpty ? (
          <div className="panel p-8 text-center text-sm text-muted">
            {both
              ? `Nothing on either source for this ${facet === "studio" ? "studio" : "category"}.`
              : `Nothing on ${sources} for this ${facet === "studio" ? "studio" : "category"}.`}
          </div>
        ) : (
          merged.length > 0 && (
            <>
              <div className={POSTER_GRID}>
                {merged.map((it) =>
                  // Kind comes from each row's own reference — a TPDB row is
                  // a movie, a StashDB row is a scene, never relabelled.
                  it.reference.kind === "scene" ? (
                    <SceneCard
                      key={`${it.reference.provider}:${it.reference.id}`}
                      item={it}
                      onOpen={openDetail}
                    />
                  ) : (
                    <MovieCard
                      key={`${it.reference.provider}:${it.reference.id}`}
                      item={it}
                      onOpen={openDetail}
                    />
                  ),
                )}
              </div>
              <div className="mt-6 flex items-center justify-between gap-3">
                <div className="text-sm text-muted">
                  Page {page}
                  {both ? " · advances both sources" : ""}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn"
                    disabled={page <= 1}
                    onClick={() => {
                      onPage(page - 1);
                      window.scrollTo({ top: 0 });
                    }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      !(tpdb.data?.hasMore || stashdb.data?.hasMore || false)
                    }
                    onClick={() => {
                      onPage(page + 1);
                      window.scrollTo({ top: 0 });
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )
        )}
      </div>
    </section>
  );
}
