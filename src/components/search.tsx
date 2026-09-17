"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type {
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
} from "../lib/contracts.ts";
import {
  api,
  ErrorPanel,
  GridSkeleton,
  messageOf,
  MovieCard,
  PerformerCard,
  SceneCard,
  providerLabel,
  useParamsSetter,
} from "./shared.tsx";
import "./views.css";

/* ---------- API shape (GET /api/search) ---------- */

type SearchCategory = {
  id: string;
  provider: CatalogProvider;
  kind: CatalogKind;
  items: CatalogDetail[];
  error?: { code: string; message: string };
};

type SearchPayload = { query: string; categories: SearchCategory[] };

/* ---------- Small helpers ---------- */

const KIND_LABEL: Record<CatalogKind, string> = {
  movie: "Movies",
  scene: "Scenes",
  performer: "Performers",
  studio: "Studios",
};

/* ---------- Cards ---------- */

// Studios are text-first: a name and a blurb, never a fake poster crop.
function StudioCard({
  item,
  onOpen,
}: {
  item: CatalogDetail;
  onOpen: (r: CatalogReference) => void;
}) {
  return (
    <button
      type="button"
      className="card p-3 text-left"
      onClick={() => onOpen(item.reference)}
    >
      <div className="truncate text-sm font-medium">{item.title}</div>
      {item.description && (
        <div className="mt-1 line-clamp-2 text-xs text-muted">
          {item.description}
        </div>
      )}
    </button>
  );
}

/* ---------- One source category ---------- */

function CategorySection({
  cat,
  q,
  onRetry,
  onOpen,
}: {
  cat: SearchCategory;
  q: string;
  onRetry: () => void;
  onOpen: (r: CatalogReference) => void;
}) {
  const label = `${providerLabel(cat.provider)} ${KIND_LABEL[cat.kind]}`;
  const headingId = `search-cat-${cat.id}`;
  // A count is shown only when it is actually known — a failed source has
  // none, and none is invented for it.
  const count = cat.error ? null : cat.items.length;
  return (
    <section
      aria-labelledby={headingId}
      className="search-section mt-10 first:mt-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-lg font-semibold tracking-tight">
          {label}
        </h3>
        {count !== null && <span className="chip">{count}</span>}
      </div>
      <p className="mt-1 text-xs text-muted">
        {providerLabel(cat.provider)}’s own result set — never merged with other
        sources and never globally ranked.
      </p>
      <div className="mt-3">
        {cat.error ? (
          cat.error.code === "provider_not_configured" ? (
            // A missing key is a missing key: no retry, never an outage.
            <div className="panel p-4" role="note">
              <div className="font-medium">{label} is not configured</div>
              <p className="mt-1 text-sm text-muted">
                No API key is present for {providerLabel(cat.provider)}, so this
                section has nothing to search. That is a missing key, not an
                outage; add it under Settings.
              </p>
            </div>
          ) : (
            <ErrorPanel
              title={`${label} unavailable`}
              message={cat.error.message}
              onRetry={onRetry}
            />
          )
        ) : cat.items.length === 0 ? (
          <div className="panel p-4 text-sm text-muted">
            No {KIND_LABEL[cat.kind].toLowerCase()} results in{" "}
            {providerLabel(cat.provider)} for “{q}”.
          </div>
        ) : cat.kind === "movie" ? (
          <div className="poster-grid">
            {cat.items.map((it) => (
              <MovieCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : cat.kind === "scene" ? (
          <div className="poster-grid">
            {cat.items.map((it) => (
              <SceneCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : cat.kind === "performer" ? (
          <div className="performer-grid">
            {cat.items.map((it) => (
              <PerformerCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <div className="studio-grid">
            {cat.items.map((it) => (
              <StudioCard key={it.reference.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- The surface ---------- */

export function SearchView() {
  const params = useSearchParams();
  const setP = useParamsSetter();
  const q = (params.get("q") ?? "").trim();
  const ready = q.length >= 2;
  const [data, setData] = useState<SearchPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  // Search fires on an explicit URL change only — never on keystrokes.
  useEffect(() => {
    if (!ready) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setError(null);
    setLoading(true);
    api<SearchPayload>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((d) => {
        if (live) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(messageOf(e));
          setLoading(false);
        }
      });
    return () => {
      live = false; // stale in-flight responses are ignored
    };
  }, [q, ready, reload]);

  const open = useCallback(
    (r: CatalogReference) => {
      const clear = {
        q: null,
        year: null,
        performer: null,
        studio: null,
        tags: null,
        tagsAll: null,
        tagsExclude: null,
        sort: null,
        direction: null,
        page: null,
        perPage: null,
        tab: null,
        provider: null,
        kind: null,
        id: null,
      };
      // The reset must come first: spreading it last silently overwrote every
      // destination value, so no result could navigate anywhere.
      if (r.kind === "movie")
        setP({
          ...clear,
          view: "movies",
          provider: r.provider,
          kind: "movie",
          id: r.id,
        });
      else if (r.kind === "scene")
        setP({
          ...clear,
          view: "scenes",
          provider: r.provider,
          kind: "scene",
          id: r.id,
        });
      else if (r.kind === "performer")
        setP({
          ...clear,
          view: "performers",
          provider: r.provider,
          kind: "performer",
          id: r.id,
        });
      else if (r.provider === "stashdb")
        setP({
          ...clear,
          view: "scenes",
          provider: "stashdb",
          kind: "scene",
          studio: r.id,
        });
      else setP({ ...clear, view: "movies", studio: r.id });
    },
    [setP],
  );

  const retry = useCallback(() => setReload((n) => n + 1), []);

  const focusGlobalSearch = useCallback(() => {
    document.getElementById("global-search")?.focus();
  }, []);

  return (
    <section aria-label="Search">
      <div className="page-heading">
        <div className="min-w-0">
          <h2 className="page-title">
            {ready ? (
              <>
                Results for <span className="search-query">“{q}”</span>
              </>
            ) : (
              "Search"
            )}
          </h2>
          <p className="page-description">
            One query, seven separate sections. Each section is that source’s
            own results — nothing is merged across providers and nothing is
            globally ranked.
          </p>
        </div>
      </div>

      <div className="mt-6">
        {!ready ? (
          <div className="panel p-8 text-center" role="note">
            <div className="text-base font-semibold">
              {q.length === 1 ? "Keep typing" : "Search every source at once"}
            </div>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {q.length === 1
                ? "Enter at least 2 characters to search."
                : "Type at least 2 characters in the search box in the top bar and press Enter. Movies, scenes, performers and studios come back per source — never merged, never re-ranked."}
            </p>
            <button
              type="button"
              className="btn btn-accent mt-4"
              onClick={focusGlobalSearch}
            >
              Go to the search box
            </button>
          </div>
        ) : error ? (
          <ErrorPanel title="Search failed" message={error} onRetry={retry} />
        ) : loading || !data ? (
          <GridSkeleton aspect="aspect-[2/3]" cols="poster-grid" count={10} />
        ) : (
          <>
            {data.categories.length > 0 && (
              <nav
                aria-label="Jump to a result section"
                className="mb-2 flex flex-wrap gap-2"
              >
                {data.categories.map((cat) => (
                  <a
                    key={cat.id}
                    className="chip"
                    href={`#search-cat-${cat.id}`}
                  >
                    {providerLabel(cat.provider)} {KIND_LABEL[cat.kind]}
                    <span className="ml-1.5 text-muted">
                      {cat.error ? "unavailable" : String(cat.items.length)}
                    </span>
                  </a>
                ))}
              </nav>
            )}
            {data.categories.map((cat) => (
              <CategorySection
                key={cat.id}
                cat={cat}
                q={data.query}
                onRetry={retry}
                onOpen={open}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
