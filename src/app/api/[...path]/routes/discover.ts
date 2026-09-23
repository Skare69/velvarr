// Moved verbatim from route.ts (v0.24.1) — pure move, no logic edits.
import {
  readJson,
  fieldText,
  fieldUrl,
  fieldBool,
  fieldRole,
  fieldIds,
  optionalText,
  requireId,
  optionalBool,
  queryInt,
  parseCatalogProvider,
  parseCatalogKind,
  parseCatalogReference,
  isMediaReference,
  parseMediaReference,
  sameMedia,
  PROVIDER_UUID,
} from "../parse.ts";
import { type AuthContext, json } from "../admission.ts";
import { createHash } from "node:crypto";
import type {
  Account,
  AdminAccount,
  CatalogDetail,
  CatalogKind,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
  ExternalUser,
  IntegrationConfig,
  Library,
  LibraryItem,
  MediaKind,
  MediaReference,
  ProviderStatus,
  RequestListItem,
  RequestRecord,
  Role,
  WhisparrDelivery,
  WhisparrPathMapping,
} from "../../../../lib/contracts.ts";
import {
  isDeliverableMedia,
  isRemovalLevel,
  normalizeFacetName,
  UNDELIVERABLE_REASON,
} from "../../../../lib/contracts.ts";
import {
  approveRemovalRequest,
  bootstrap,
  cancelRemovalRequest,
  cancelRequest,
  countRequestsByAccount,
  createRemovalRequest,
  createRequest,
  createSession,
  decideRequest,
  declineRemovalRequest,
  followPerformer,
  getAcquisitionByReference,
  getAccount,
  getConfig,
  getContentPreferences,
  getSession,
  hasAuthoritativeAbsence,
  importAccounts,
  isInitialized,
  isObservationStale,
  listAccounts,
  listFollows,
  listFollowsByProvider,
  listRequests,
  listRemovalRequests,
  revokeSession,
  saveConfig,
  saveContentPreferences,
  linkFollows,
  unfollowPerformer,
  updateAccount,
  upsertCatalogRecord,
} from "../../../../server/storage.ts";
import {
  consumeLoginAttempt,
  guardMutation,
  readSessionToken,
  sessionCookie,
  isSecureRequest,
  verifySetupSecret,
} from "../../../../server/security.ts";
import { AppError, validateBaseUrl } from "../../../../server/http.ts";
import {
  authenticate,
  getLibraryImage,
  getLibraryItem,
  getServer,
  getUserImage,
  listLibraries,
  listLibraryItems,
  listRecentlyAddedItems,
  listUsers,
  resolvePlaybackAccess,
  validateUser,
  getJellyfinStatus,
} from "../../../../server/jellyfin.ts";
import {
  crossProviderLink,
  fetchProviderArtwork,
  getCatalogDetail,
  getProviderStatus,
  isProviderImageUrl,
  listCatalogTags,
  searchCatalog,
  searchCatalogTags,
  studioCounterpart,
  tagCounterpart,
  type CatalogSearchQuery,
  type CatalogSortDirection,
  type CatalogSortKey,
  type ReleaseDateOperation,
} from "../../../../server/providers.ts";
import { suggestTags } from "../../../../server/judgment.ts";
import {
  findWhisparrItem,
  getWhisparrStatus,
} from "../../../../server/whisparr.ts";
import {
  browseTitles,
  isHiddenTitle,
  parseBrowseQuery,
  searchBrowseTags,
  searchVisibleCatalog,
  type BrowsePage,
  type SourceError,
} from "../../../../server/browse.ts";
import {
  relatedPerformers,
  relatedTitles,
} from "../../../../server/related.ts";

export interface ShelfError {
  code: string;
  message: string;
}

// One tile of a unified Studios/Genres rail. `provider`+`id` are native to
// the snapshot side the tile came from — the grid a tile opens queries each
// side with its own id, so one rail mixes TPDB movies and StashDB scenes.
// `linked` is the counterpart on the other provider, present only when it
// genuinely resolved: a studio link the providers themselves published, or
// exact normalized-name tag equality (a label matched to a label — the one
// documented deterministic pairing, never a name guess).
export interface FacetItem {
  facet: "studio" | "tag";
  provider: CatalogProvider;
  id: string;
  name: string;
  imageUrl?: string;
  /** Studio brand mark only — never the poster under another name. */
  logoUrl?: string;
  linked?: { provider: CatalogProvider; id: string };
}

export interface Shelf {
  id: string;
  title: string;
  source: "tpdb" | "stashdb" | "jellyfin" | "velvarr";
  /** Honest one-line provenance, e.g. trending is a StashDB-only signal. */
  description?: string;
  browse?: { view: string; params: Record<string, string> };
  kind: "catalog" | "library" | "requests" | "facets";
  items?: CatalogDetail[] | LibraryItem[] | RequestRecord[] | FacetItem[];
  /** Per-source partial-failure evidence; items may coexist with it. */
  errors?: SourceError[];
  error?: ShelfError;
}

export function shelfError(err: unknown): ShelfError {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  return { code: "internal", message: "Internal server error." };
}

// The partial-source wire shape: the failed provider named on the error,
// its code preserved verbatim.
export function sourceError(
  provider: "tpdb" | "stashdb",
  err: unknown,
): SourceError {
  return { provider, ...shelfError(err) };
}

export const SHELF_ITEMS = 12;
export const SEARCH_PER_PAGE = 6;
export const FOLLOW_SHELF_PERFORMERS = 5;

// First page of each followed performer's title filmography, merged within
// ONE provider and capped at SHELF_ITEMS. Partial failure survives: pages
// that failed are dropped, and the shelf only reports an error when every
// page failed — nothing truthful to show beats a quiet empty list.
export async function followedTitles(
  accountId: string,
  provider: CatalogProvider,
): Promise<CatalogDetail[]> {
  const follows = listFollowsByProvider(
    accountId,
    provider,
    FOLLOW_SHELF_PERFORMERS,
  );
  const pages = await Promise.allSettled(
    follows.map((follow) =>
      (provider === "tpdb"
        ? // TPDB's filmography route is paging-only: no sort exists there.
          searchCatalog({
            provider: "tpdb",
            kind: "movie",
            performer: follow.reference.id,
            page: 1,
            perPage: SHELF_ITEMS,
          })
        : searchCatalog({
            provider: "stashdb",
            kind: "scene",
            performer: follow.reference.id,
            sort: "date",
            direction: "desc",
            page: 1,
            perPage: SHELF_ITEMS,
          })
      ).then((page) => page.items),
    ),
  );
  const items: CatalogDetail[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (const page of pages) {
    if (page.status === "rejected") {
      failed = true;
      continue;
    }
    for (const item of page.value) {
      // Two followed performers can share a title; keep one copy.
      if (seen.has(item.reference.id)) continue;
      seen.add(item.reference.id);
      items.push(item);
    }
  }
  if (items.length === 0 && failed) {
    throw (pages.find((p) => p.status === "rejected") as PromiseRejectedResult)
      .reason;
  }
  return items.slice(0, SHELF_ITEMS);
}

// The one "From performers you follow" rail across BOTH providers. Sides
// settle independently: the surviving side's titles still render beside a
// visible partial-source warning, and the shelf errors only when both sides
// failed. Hidden tags apply here too — a fully hidden filmography leaves
// nothing to show, so the rail disappears. An account that follows nobody
// gets no rail at all.
export async function followedShelf(
  accountId: string,
  hiddenTags: CatalogTagSelection[],
): Promise<Shelf | null> {
  const sides = await Promise.allSettled([
    followedTitles(accountId, "tpdb"),
    followedTitles(accountId, "stashdb"),
  ]);
  const errors: SourceError[] = [];
  const merged: CatalogDetail[] = [];
  sides.forEach((side, i) => {
    const provider = i === 0 ? ("tpdb" as const) : ("stashdb" as const);
    if (side.status === "fulfilled") {
      merged.push(
        ...side.value.filter((item) => !isHiddenTitle(item, hiddenTags)),
      );
    } else errors.push(sourceError(provider, side.reason));
  });
  if (merged.length === 0 && errors.length === 0) return null;
  const base = {
    id: "followed-titles",
    title: "From performers you follow",
    source: "velvarr" as const,
    kind: "catalog" as const,
    browse: { view: "following", params: {} },
  };
  if (merged.length === 0) {
    // Every side the account actually follows failed: the error-only shape,
    // never a quiet empty list.
    const firstFailure = sides.find(
      (side): side is PromiseRejectedResult => side.status === "rejected",
    );
    return { ...base, error: shelfError(firstFailure?.reason) };
  }
  return {
    ...base,
    items: dedupeTitles(merged).slice(0, SHELF_ITEMS),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// Provider-aware dedupe for the merged rail: a title two followed performers
// share appears once. Identity is the provider-native reference itself —
// scenes and movies are never equated across providers, and no name
// matching is ever applied.
export function dedupeTitles(items: CatalogDetail[]): CatalogDetail[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key =
      `${item.reference.provider}:${item.reference.kind}:` +
      item.reference.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ShelfItems =
  CatalogDetail[] | LibraryItem[] | RequestRecord[] | FacetItem[];

export function shelfOf(
  base: Omit<Shelf, "items" | "error">,
  result: PromiseSettledResult<ShelfItems>,
): Shelf {
  return result.status === "fulfilled"
    ? { ...base, items: result.value }
    : // An errored shelf carries no items at all: never an empty list that
      // could render as a quiet success.
      { ...base, error: shelfError(result.reason) };
}

// Mixed-source shelves built from a browse page: items render together with
// per-source error evidence; a page that failed BOTH sources collapses to
// the error-only shape — all-source failure stays visible, never an empty
// success. One source failing with the other merely empty keeps the honest
// errors warning.
export function browseShelf(
  base: Omit<Shelf, "items" | "error" | "errors">,
  result: PromiseSettledResult<BrowsePage>,
): Shelf {
  if (result.status === "rejected")
    return { ...base, error: shelfError(result.reason) };
  const page = result.value;
  if (page.items.length === 0 && page.errors.length > 0) {
    const down = new Set(page.errors.map((error) => error.provider));
    if (down.has("tpdb") && down.has("stashdb")) {
      return {
        ...base,
        error: {
          code: page.errors[0]!.code,
          message: "Neither TPDB nor StashDB could be read.",
        },
      };
    }
  }
  return {
    ...base,
    items: page.items,
    ...(page.errors.length > 0 ? { errors: page.errors } : {}),
  };
}

// Genre facets from one provider's snapshot: unique provider-native tag ids
// in first-seen order, artwork only from an item that carries the tag. Non-
// UUID tag ids are omitted — every tile must survive the route's tag-filter
// validation as a real click-through. Artwork upgrades from later items when
// the first carrier had no image, and each facet takes a different carrier
// (ordinal % carriers) so twelve facets don't all wear the same cover.
// Studio facets resolve through the cached provider detail read so logos
// render; a failed or absent read keeps the known name/reference as a
// name-only tile — never an invented logo, and an enrich failure never sinks
// the shelf.
// ponytail: bounded recent/trending snapshot (SHELF_ITEMS unique ids, no
// popularity invented); a full directory listing only if a browse surface
// ever needs one.
export function genreFacets(
  items: CatalogDetail[],
): Pick<FacetItem, "id" | "name" | "imageUrl">[] {
  const names = new Map<string, string>();
  const art = new Map<string, string[]>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!PROVIDER_UUID.test(tag.id)) continue;
      if (!names.has(tag.id)) {
        names.set(tag.id, tag.name);
        art.set(tag.id, []);
      }
      if (item.imageUrl !== undefined) art.get(tag.id)?.push(item.imageUrl);
    }
  }
  return [...names].slice(0, SHELF_ITEMS).map(([id, name], i) => {
    const carriers = art.get(id) ?? [];
    const imageUrl =
      carriers.length > 0 ? carriers[i % carriers.length] : undefined;
    return { id, name, ...(imageUrl !== undefined ? { imageUrl } : {}) };
  });
}

export function studioFacets(
  provider: CatalogProvider,
  items: CatalogDetail[],
): Promise<CatalogDetail[]> {
  const known = new Map<
    string,
    { reference: CatalogReference; name: string }
  >();
  for (const item of items) {
    const studio = item.studio;
    const reference = studio?.reference;
    if (
      studio !== undefined &&
      reference !== undefined &&
      reference.provider === provider &&
      !known.has(reference.id)
    ) {
      known.set(reference.id, { reference, name: studio.name });
    }
  }
  const nameOnly = (
    reference: CatalogReference,
    name: string,
  ): CatalogDetail => ({
    reference,
    title: name,
    credits: [],
    tags: [],
    related: [],
    links: [],
    aliases: [],
  });
  return Promise.all(
    [...known.values()].slice(0, SHELF_ITEMS).map(({ reference, name }) =>
      getCatalogDetail(reference).then(
        (detail) => detail ?? nameOnly(reference, name),
        // Detail read failed: the name/reference survived the snapshot, the
        // logo did not. Degraded tile, not a shelf error.
        () => nameOnly(reference, name),
      ),
    ),
  );
}

// The two unified facet rails derive from the new-releases browse page —
// which is already hidden-tag filtered, so blocked catalog imagery can never
// reappear as facet art. A side that failed its half of the page simply
// contributes nothing (the page's own errors report the outage); both sides
// failing surfaces one error per facet shelf and no items — never a
// half-filled rail that could read as a quiet success.
export function facetShelves(
  newReleases: PromiseSettledResult<BrowsePage>,
): Promise<Shelf[]> {
  let error: ShelfError | undefined;
  let items: CatalogDetail[] = [];
  if (newReleases.status === "rejected") {
    // shelfError keeps the upstream code (not configured vs outage); the
    // message names the shelf's own truth: no snapshot from either side.
    error = {
      ...shelfError(newReleases.reason),
      message: "Neither TPDB nor StashDB could be read.",
    };
  } else {
    const page = newReleases.value;
    items = page.items;
    if (items.length === 0 && page.errors.length > 0) {
      const down = new Set(page.errors.map((entry) => entry.provider));
      if (down.has("tpdb") && down.has("stashdb")) {
        error = {
          code: page.errors[0]!.code,
          message: "Neither TPDB nor StashDB could be read.",
        };
      }
    }
  }
  if (error !== undefined) {
    return Promise.resolve([
      {
        id: "studios",
        title: "Studios",
        source: "velvarr",
        kind: "facets",
        error,
        browse: { view: "facets", params: { kind: "studios" } },
      },
      {
        id: "genres",
        title: "Genres",
        source: "velvarr",
        kind: "facets",
        error,
        browse: { view: "facets", params: { kind: "genres" } },
      },
    ]);
  }
  const sources = (["tpdb", "stashdb"] as const)
    .map((provider) => ({
      provider,
      items: items.filter((item) => item.reference.provider === provider),
    }))
    .filter((source) => source.items.length > 0);
  return Promise.all([
    facetShelf("studios", sources),
    facetShelf("genres", sources),
  ]);
}

/** Cross-provider studio dedupe: a TPDB tile dies only when a StashDB tile
 * published that exact studio as its counterpart — never by name: two
 * same-named studios without a published link stay two tiles. Survivors get
 * their own counterparts resolved (settled). */
async function dedupePublishedStudios(
  tiles: FacetItem[],
): Promise<FacetItem[]> {
  const stashTiles = tiles.filter((tile) => tile.provider === "stashdb");
  await resolveLinked(stashTiles);
  const publishedTpdb = new Set(
    stashTiles.flatMap((tile) =>
      tile.linked !== undefined ? [tile.linked.id.toLowerCase()] : [],
    ),
  );
  const survivors = publishedTpdb.size
    ? tiles.filter(
        (tile) =>
          tile.provider !== "tpdb" || !publishedTpdb.has(tile.id.toLowerCase()),
      )
    : tiles;
  await resolveLinked(survivors);
  return survivors;
}

export async function facetShelf(
  shelf: "studios" | "genres",
  sources: { provider: CatalogProvider; items: CatalogDetail[] }[],
): Promise<Shelf> {
  const perSource = await Promise.all(
    sources.map(async ({ provider, items }) => ({
      provider,
      tiles:
        shelf === "studios"
          ? (await studioFacets(provider, items)).map((detail): FacetItem => ({
              facet: "studio",
              provider,
              id: detail.reference.id,
              name: detail.title,
              ...(detail.logoUrl !== undefined
                ? { logoUrl: detail.logoUrl }
                : {}),
              ...(detail.imageUrl !== undefined
                ? { imageUrl: detail.imageUrl }
                : {}),
            }))
          : genreFacets(items).map((tile): FacetItem => ({
              facet: "tag",
              provider,
              ...tile,
            })),
    })),
  );
  // Alternate the providers' tiles so the cap leaves room for both sides.
  const candidates: FacetItem[] = [];
  for (let i = 0; i < SHELF_ITEMS; i++) {
    for (const { tiles } of perSource) {
      const tile = tiles[i];
      if (tile !== undefined) candidates.push(tile);
    }
  }
  const emitted = candidates.slice(0, SHELF_ITEMS);
  let items = emitted;
  if (shelf === "studios") {
    items = await dedupePublishedStudios(emitted);
  } else {
    // Categories dedupe by exact normalized name: the first-seen tile stays
    // and the dropped side's id becomes its linked.
    const seen = new Map<string, FacetItem>();
    items = [];
    for (const tile of emitted) {
      const key = normalizeFacetName(tile.name);
      const prior = seen.get(key);
      if (prior === undefined) {
        seen.set(key, tile);
        items.push(tile);
      } else if (prior.linked === undefined) {
        prior.linked = { provider: tile.provider, id: tile.id };
      }
    }
    // Counterparts for everything the local dedupe could not pair.
    await resolveLinked(items);
  }
  return {
    id: shelf,
    title: shelf === "studios" ? "Studios" : "Genres",
    source: "velvarr",
    kind: "facets",
    items,
    browse: { view: "facets", params: { kind: shelf } },
  };
}

// Resolves each tile's cross-provider counterpart, settled: a rejection or
// an absent counterpart just leaves `linked` off the tile.
export async function resolveLinked(tiles: FacetItem[]): Promise<void> {
  const missing = tiles.filter((tile) => tile.linked === undefined);
  const settled = await Promise.allSettled(
    missing.map((tile) =>
      tile.facet === "studio"
        ? studioCounterpart({
            provider: tile.provider,
            kind: "studio",
            id: tile.id,
          })
        : tagCounterpart(tile.provider, tile.name),
    ),
  );
  settled.forEach((result, i) => {
    const tile = missing[i];
    if (tile && result.status === "fulfilled" && result.value !== undefined) {
      tile.linked = {
        provider: result.value.provider,
        id: result.value.id,
      };
    }
  });
}

// The facet directory behind the discover shelf headline arrows. Genres:
// each provider's real tag listing — TPDB publishes a directory; StashDB's
// empty-term tag search refuses on some key tiers, and that upstream refusal
// surfaces as that side's error, never a fabricated list. Studios: no
// provider publishes a studio directory, so the overview derives from the
// same new-releases page the discover shelf reads, uncapped — the page
// reports its own breadth instead of claiming "all studios ever".
export async function discoveryFacets(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "genres" && kind !== "studios") {
    throw new AppError(
      400,
      "invalid_query",
      'kind must be "genres" or "studios".',
    );
  }
  const { hiddenTags } = getContentPreferences(ctx.account.id);
  if (kind === "genres") {
    const providers: CatalogProvider[] = ["tpdb", "stashdb"];
    const settled = await Promise.allSettled(
      providers.map((p) => listCatalogTags(p)),
    );
    const tiles: FacetItem[] = [];
    const errors: SourceError[] = [];
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      const result = settled[i]!;
      if (result.status === "rejected") {
        errors.push(sourceError(provider, result.reason));
        continue;
      }
      for (const tag of [...result.value].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        tiles.push({ facet: "tag", provider, id: tag.id, name: tag.name });
      }
    }
    return json({ kind, tiles, errors });
  }
  const today = new Date().toISOString().slice(0, 10);
  const page = await browseTitles(
    parseBrowseQuery(
      new URLSearchParams({
        type: "all",
        sort: "recency",
        direction: "desc",
        date: today,
        date_operation: "<=",
        page: "1",
        perPage: "48",
      }),
    ),
    hiddenTags,
  );
  const sources = (["tpdb", "stashdb"] as const)
    .map((provider) => ({
      provider,
      items: page.items.filter((item) => item.reference.provider === provider),
    }))
    .filter((source) => source.items.length > 0);
  const perSource = await Promise.all(
    sources.map(async ({ provider, items }) => ({
      provider,
      tiles: (await studioFacets(provider, items)).map((detail): FacetItem => ({
        facet: "studio",
        provider,
        id: detail.reference.id,
        name: detail.title,
        ...(detail.logoUrl !== undefined ? { logoUrl: detail.logoUrl } : {}),
        ...(detail.imageUrl !== undefined ? { imageUrl: detail.imageUrl } : {}),
      })),
    })),
  );
  const tiles = await dedupePublishedStudios(perSource.flatMap((s) => s.tiles));
  tiles.sort((a, b) => a.name.localeCompare(b.name));
  return json({ kind, tiles, errors: [] });
}

export async function discover(ctx: AuthContext): Promise<Response> {
  // UTC server date: the shared "today" cutoff for the mixed New releases
  // rail and its browse-all link.
  const today = new Date().toISOString().slice(0, 10);
  // One preferences read feeds both the hidden-tag filter and the shelf
  // order; the shelves themselves assemble in registry order first.
  const { hiddenTags, discoverOrder } = getContentPreferences(ctx.account.id);
  const [newReleases, trending, recentlyAdded, requests] =
    await Promise.allSettled([
      // Built through the browse parser so the rail and its own browse link
      // are provably the same query. Native provider filters carry the date
      // bound; hidden tags apply before anything downstream is derived.
      browseTitles(
        parseBrowseQuery(
          new URLSearchParams({
            type: "all",
            sort: "recency",
            direction: "desc",
            date: today,
            date_operation: "<=",
            page: "1",
            perPage: String(SHELF_ITEMS),
          }),
        ),
        hiddenTags,
      ),
      // Trending is honestly a StashDB-only signal: TPDB publishes no
      // trend data, so nothing pretends otherwise. Single source, so a
      // failure is the shelf's own rejection.
      searchVisibleCatalog(
        {
          provider: "stashdb",
          kind: "scene",
          sort: "trending",
          direction: "desc",
          page: 1,
          perPage: SHELF_ITEMS,
        },
        hiddenTags,
      ).then((page) => page.items),
      listRecentlyAddedItems(ctx.config, ctx.token, ctx.account, SHELF_ITEMS),
      // storage is sync; defer so its failures settle like the rest. Capped
      // like every other shelf: a bulk performer request can file a hundred
      // intents at once, and a rail is not a list view. The rows carry the
      // shared acquisition state so the rail's badge tells the truth.
      Promise.resolve().then(() => listRequestItems(ctx).slice(0, SHELF_ITEMS)),
    ]);
  // Appended only when this account follows someone (or a side failed): an
  // account with no follows gets exactly the standard shelves.
  const followed = await followedShelf(ctx.account.id, hiddenTags);
  const shelves: Shelf[] = [
    browseShelf(
      {
        id: "new-releases",
        title: "New releases",
        description: "Newest TPDB movies and StashDB scenes",
        source: "velvarr",
        kind: "catalog",
        browse: {
          view: "titles",
          params: {
            type: "all",
            sort: "recency",
            direction: "desc",
            date: today,
            date_operation: "<=",
          },
        },
      },
      newReleases,
    ),
    shelfOf(
      {
        id: "trending",
        title: "Trending now",
        description: "Scene trends from StashDB",
        source: "stashdb",
        kind: "catalog",
        browse: {
          view: "titles",
          params: { type: "scene", sort: "trending", direction: "desc" },
        },
      },
      trending,
    ),
    shelfOf(
      {
        id: "jellyfin-recent",
        title: "Recently added in your libraries",
        source: "jellyfin",
        kind: "library",
        browse: { view: "library", params: {} },
      },
      recentlyAdded,
    ),
    shelfOf(
      {
        id: "velvarr-requests",
        title: "Recent requests",
        source: "velvarr",
        kind: "requests",
        browse: { view: "requests", params: {} },
      },
      requests,
    ),
    ...(await facetShelves(newReleases)),
    ...(followed === null ? [] : [followed]),
  ];
  // Per-account order over the PRESENT shelves only: a shelf the account
  // cannot fill (no follows) stays absent — never a fake rail, and the
  // saved order itself is untouched. Array#sort is stable, so any id the
  // saved order does not know (a shelf newer than this account's stored
  // order) keeps its assembled position after the ranked ones.
  const rank = new Map<string, number>(
    discoverOrder.map((id, i) => [id, i] as const),
  );
  shelves.sort(
    (a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size),
  );
  return json({ shelves });
}

import { listRequestItems } from "./requests.ts";
import type { RouteDef } from "../admission.ts";

export const routes: RouteDef[] = [
  {
    method: "GET",
    segments: ["discover"],
    auth: "session",
    run: async (ctx) => discover(ctx),
  },
  {
    method: "GET",
    segments: ["discovery", "facets"],
    auth: "session",
    run: async (ctx, request) => discoveryFacets(request, ctx),
  },
];
