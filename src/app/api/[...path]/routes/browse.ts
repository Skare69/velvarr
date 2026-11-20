import { type AuthContext, json } from "../admission.ts";
import { parseMediaReference, readJson } from "../parse.ts";
import type {
  CatalogDetail,
  CatalogKind,
  MediaReference,
  ShelfError,
} from "../../../../lib/contracts.ts";
import {
  getAcquisitionByReference,
  getContentPreferences,
  hasAuthoritativeAbsence,
  isObservationStale,
} from "../../../../server/storage.ts";
import { AppError, shelfError } from "../../../../server/http.ts";
import { resolvePlaybackAccess } from "../../../../server/jellyfin.ts";
import { findWhisparrPathByIdentity } from "../../../../server/whisparr.ts";
import {
  getCatalogDetail,
  searchCatalog,
  type CatalogSearchPage,
} from "../../../../server/providers.ts";
import { searchVisibleCatalog } from "../../../../server/browse.ts";
import { proseSearchStatus } from "../../../../server/prose-chat.ts";
import { runProseSearch } from "../../../../server/prose-search.ts";
import { PROSE_TEXT_MAX } from "../../../../lib/prose-draft.ts";
import type { BrowseTab } from "../../../../lib/browse-entities.ts";

// Year and performer reach the same-work judgment only through a title
// hint: candidatesMayMatch returns before any ask without one, and
// titleYearSimilar needs the title too. So the provider detail read waits
// for a title hint and carries both facts in one round-trip; an outage or
// an absent record degrades to exact matching, exactly as before.
async function identityHints(
  media: MediaReference,
  title: string | null | undefined,
): Promise<{ performer?: string; year?: number }> {
  if (!title) return {};
  try {
    const detail = await getCatalogDetail(media);
    const year = Number.parseInt((detail?.releaseDate ?? "").slice(0, 4), 10);
    const credit = detail?.credits.find(
      (c) => c.reference.kind === "performer",
    );
    return {
      ...(credit ? { performer: credit.name } : {}),
      ...(Number.isInteger(year) && year > 0 ? { year } : {}),
    };
  } catch {
    return {};
  }
}

// Per-user playback verdict for one external identity. Runs under THIS
// caller's Jellyfin token; hints are the validated reference plus the
// shared acquisition's persisted Whisparr facts when present. Without a
// Velvarr acquisition (a title grabbed in Whisparr directly), the folder
// comes from Whisparr's cached movie list: one shared read per 30 s window.
export async function availability(
  ctx: AuthContext,
  providerRaw: string,
  kindRaw: string,
  idRaw: string,
): Promise<Response> {
  const media = parseMediaReference(providerRaw, kindRaw, idRaw);
  const acquisition = getAcquisitionByReference(media);
  const whisparrPath =
    acquisition?.whisparrPath ?? (await whisparrFolderOf(ctx, media));
  const verdict = await resolvePlaybackAccess(
    ctx.config,
    ctx.token,
    ctx.account,
    {
      provider: media.provider,
      kind: media.kind,
      id: media.id,
      ...(whisparrPath ? { whisparrPath } : {}),
      ...(acquisition?.whisparrTitle
        ? { title: acquisition.whisparrTitle }
        : {}),
      ...(acquisition?.state === "imported" ? { imported: true } : {}),
      ...(await identityHints(media, acquisition?.whisparrTitle)),
    },
    // The one cache-eligible caller: repeated badge calls share one sweep.
    { cachedSweep: true },
  );
  // Scan lag (hazard 9): Whisparr has imported the item but Jellyfin's fresh
  // check under this caller's token found no authorized match — the library
  // simply has not caught up. A proven Whisparr absence demotes back to
  // missing; outages stay unavailable and per-user denials stay denied
  // because they never reach this branch.
  if (
    verdict.outcome === "missing" &&
    acquisition !== null &&
    acquisition.state === "imported" &&
    !hasAuthoritativeAbsence(acquisition)
  ) {
    return json({
      outcome: "awaiting_scan",
      reason: "Imported on Whisparr; the media server has not matched it yet.",
      observationStale: isObservationStale(acquisition),
    });
  }
  return json(verdict);
}

/** The Whisparr folder of one identity, or undefined. A Whisparr failure only
 * costs the hint (the verdict then stands on Jellyfin's own IDs, as before);
 * it is logged, never shown as a match or a miss of its own. */
async function whisparrFolderOf(
  ctx: AuthContext,
  media: MediaReference,
): Promise<string | undefined> {
  // A best-effort hint must not stretch a badge out to the 15 s list
  // timeout: a short ceiling bounds a slow Whisparr. The loser read keeps
  // running and lands in the list cache, so the next badge inside the TTL
  // hints instantly.
  const FOLDER_HINT_TIMEOUT_MS = 2_000;
  const deadline = Promise.withResolvers<never>();
  const hintTimer = setTimeout(
    () =>
      deadline.reject(
        new AppError(
          504,
          "upstream_timeout",
          `Whisparr folder hint exceeded ${FOLDER_HINT_TIMEOUT_MS} ms.`,
        ),
      ),
    FOLDER_HINT_TIMEOUT_MS,
  );
  try {
    const path = await Promise.race([
      findWhisparrPathByIdentity(ctx.config, media),
      deadline.promise,
    ]);
    return path ?? undefined;
  } catch (e) {
    console.error(
      `[velvarr:availability] Whisparr folder lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  } finally {
    clearTimeout(hintTimer);
  }
}

// Real provider verification for the admin UI: configured:false stays
// honest, and an outage or auth failure throws rather than masquerading as
// an empty or unverified catalog.
export interface SearchCategory {
  id: string;
  provider: "tpdb" | "stashdb";
  kind: CatalogKind;
  items: CatalogDetail[];
  /** Provider-attested exact total; absent when the count is unknown. */
  total?: number;
  totalCountKnown: boolean;
  /** More results exist behind this first page. */
  hasMore: boolean;
  error?: ShelfError;
}

// AppError codes pass through verbatim so "not configured" stays distinct
// from "unavailable" at the UI; anything unknown is a bare internal error.
export function categoryOf(
  id: string,
  provider: "tpdb" | "stashdb",
  kind: CatalogKind,
  result: PromiseSettledResult<CatalogSearchPage>,
): SearchCategory {
  return result.status === "fulfilled"
    ? {
        id,
        provider,
        kind,
        items: result.value.items,
        ...(result.value.total !== undefined
          ? { total: result.value.total }
          : {}),
        totalCountKnown: result.value.totalCountKnown,
        hasMore: result.value.hasMore,
      }
    : {
        id,
        provider,
        kind,
        items: [],
        totalCountKnown: false,
        hasMore: false,
        error: shelfError(result.reason),
      };
}

export async function globalSearch(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").trim();
  if (term.length < 2) {
    throw new AppError(
      400,
      "invalid_query",
      "Enter at least 2 characters to search.",
    );
  }
  // Media categories honor the caller's hidden tags; performer and studio
  // categories stay raw — hidden tags remove titles, never entities.
  const hiddenTags = getContentPreferences(ctx.account.id).hiddenTags;
  const [
    tpdbMovies,
    stashdbScenes,
    tpdbPerformers,
    stashdbPerformers,
    tpdbStudios,
    stashdbStudios,
  ] = await Promise.allSettled([
    searchVisibleCatalog(
      {
        provider: "tpdb",
        kind: "movie",
        query: term,
        page: 1,
        perPage: SEARCH_PER_PAGE,
      },
      hiddenTags,
    ),
    searchVisibleCatalog(
      {
        provider: "stashdb",
        kind: "scene",
        query: term,
        page: 1,
        perPage: SEARCH_PER_PAGE,
      },
      hiddenTags,
    ),
    searchCatalog({
      provider: "tpdb",
      kind: "performer",
      query: term,
      page: 1,
      perPage: SEARCH_PER_PAGE,
    }),
    searchCatalog({
      provider: "stashdb",
      kind: "performer",
      query: term,
    }),
    searchCatalog({
      provider: "tpdb",
      kind: "studio",
      query: term,
      page: 1,
      perPage: SEARCH_PER_PAGE,
    }),
    searchCatalog({
      provider: "stashdb",
      kind: "studio",
      query: term,
    }),
  ]);
  // Six source-labeled categories, never merged across providers. Each is
  // the provider's own search order — no global ranking is computed here.
  return json({
    query: term,
    categories: [
      categoryOf("tpdb-movies", "tpdb", "movie", tpdbMovies),
      categoryOf("stashdb-scenes", "stashdb", "scene", stashdbScenes),
      categoryOf("tpdb-performers", "tpdb", "performer", tpdbPerformers),
      categoryOf(
        "stashdb-performers",
        "stashdb",
        "performer",
        stashdbPerformers,
      ),
      categoryOf("tpdb-studios", "tpdb", "studio", tpdbStudios),
      categoryOf("stashdb-studios", "stashdb", "studio", stashdbStudios),
    ],
  });
}

// One natural-language search in flight per account: each one costs a chat
// call plus provider lookups, so a second submit is refused until it ends.
const proseInFlight = new Set<string>();

export async function proseSearchRoute(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const status = proseSearchStatus(ctx.account, ctx.config.providers);
  if (status === "not_configured") {
    throw new AppError(
      503,
      "prose_search_not_configured",
      "Natural-language search is not set up.",
    );
  }
  if (status === "not_granted") {
    throw new AppError(
      403,
      "forbidden",
      "Natural-language search is not turned on for this account.",
    );
  }
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 2 || text.length > PROSE_TEXT_MAX) {
    throw new AppError(400, "invalid_query", "Enter 2 to 300 characters.");
  }
  const type = body.type;
  if (type !== "all" && type !== "movie" && type !== "scene") {
    throw new AppError(
      400,
      "invalid_query",
      "type must be all, movie, or scene.",
    );
  }
  const accountId = ctx.account.id;
  if (proseInFlight.has(accountId)) {
    throw new AppError(
      429,
      "prose_search_busy",
      "A search for this account is still running.",
    );
  }
  proseInFlight.add(accountId);
  try {
    const tab: BrowseTab = type;
    return json(
      await runProseSearch({ text, tab, providers: ctx.config.providers }),
    );
  } finally {
    proseInFlight.delete(accountId);
  }
}

/** A matched route: what to run, and the admission it needs. The auth level
 * is part of the shape, so a new branch cannot ship without declaring one;
 * the previous table enforced "remember requireSession here" by discipline. */
import { SEARCH_PER_PAGE } from "./discover.ts";
import { browseRoute, browseTagsRoute } from "./catalog.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["browse"],
    auth: "session",
    run: async (ctx, request) => browseRoute(request, ctx),
  },
  {
    method: "GET",
    segments: ["browse", "tags"],
    auth: "session",
    run: async (_ctx, request) => browseTagsRoute(request),
  },
  {
    // Card preload: the second call every RequestableCard fires after page
    // load (see the catalog detail route). Charges the preload lane, not
    // dispatch — a page of cards must not drain the API budget. The route's
    // only provider read is identityHints' title-hint detail, shared with
    // the card's detail call through the meta cache; the lane bounds
    // distinct-id loops through either route.
    method: "GET",
    segments: ["availability", ":provider", ":kind", ":id"],
    auth: "session",
    lane: "preload",
    run: async (ctx, _request, p) =>
      availability(ctx, p.provider!, p.kind!, p.id!),
  },
  {
    method: "POST",
    segments: ["browse", "prose"],
    auth: "session",
    run: async (ctx, request) => proseSearchRoute(request, ctx),
  },
  {
    method: "GET",
    segments: ["search"],
    auth: "session",
    run: async (ctx, request) => globalSearch(request, ctx),
  },
];
