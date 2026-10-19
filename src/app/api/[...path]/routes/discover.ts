import { type AuthContext, json } from "../admission.ts";
import { PROVIDER_UUID } from "../parse.ts";
import type {
  CatalogDetail,
  CatalogProvider,
  CatalogReference,
  CatalogTagSelection,
  ContentPreferences,
  DiscoverShelfId,
  FacetItem,
  Shelf,
  ShelfError,
  ShelfItems,
  ShelfMorePreview,
  SourceError,
} from "../../../../lib/contracts.ts";
import { normalizeFacetName } from "../../../../lib/contracts.ts";
import {
  getContentPreferences,
  listFollows,
  listFollowsByProvider,
} from "../../../../server/storage.ts";
import {
  cachedReleases,
  cachedTrending,
  cachedFollowed,
} from "../../../../server/discovery.ts";
import { AppError, shelfError, sourceError } from "../../../../server/http.ts";
import { listRecentlyAddedItems } from "../../../../server/jellyfin.ts";
import {
  getCatalogDetail,
  listCatalogTags,
  searchCatalog,
  studioCounterpart,
  tagCounterpart,
} from "../../../../server/providers.ts";
import {
  browseTitles,
  parseBrowseQuery,
  type BrowsePage,
} from "../../../../server/browse.ts";
import { isHiddenTitle } from "../../../../server/catalog-visibility.ts";

// One named entry per provider, first group wins: the partial-failure wire
// shape browse pages and followedShelf already speak, and the UI keys error
// rows by provider.
function mergeErrors(...groups: SourceError[][]): SourceError[] {
  const seen = new Set<string>();
  return groups.flat().filter((error) => {
    if (seen.has(error.provider)) return false;
    seen.add(error.provider);
    return true;
  });
}

export const SHELF_ITEMS = 28;
export const MORE_PREVIEWS = 4;
export const FOLLOWED_PAGE = 12;
export const SEARCH_PER_PAGE = 6;
export const FOLLOW_SHELF_PERFORMERS = 5;

/** The rail keeps the first SHELF_ITEMS candidates; the See More card
 * previews the next MORE_PREVIEWS — omitted, never empty, when the
 * source had nothing past the rail. */
function railOf<T>(
  items: T[],
  preview: (item: T) => ShelfMorePreview,
): { items: T[]; more?: ShelfMorePreview[] } {
  const tail = items
    .slice(SHELF_ITEMS, SHELF_ITEMS + MORE_PREVIEWS)
    .map(preview);
  return {
    items: items.slice(0, SHELF_ITEMS),
    ...(tail.length > 0 ? { more: tail } : {}),
  };
}

const catalogPreview = (item: CatalogDetail): ShelfMorePreview => ({
  name: item.title,
  ...(item.imageUrl !== undefined ? { imageUrl: item.imageUrl } : {}),
});

// First page of each followed performer's title filmography, merged within
// ONE provider and capped at FOLLOW_SHELF_PERFORMERS * FOLLOWED_PAGE. Partial
// failure is reported, not
// dropped: the first failed page rides back as `failure` beside the
// survivors, so the shelf can name the provider. Throwing is reserved for a
// side with nothing to show — every page failed.
export async function followedTitles(
  accountId: string,
  provider: CatalogProvider,
): Promise<{ items: CatalogDetail[]; failure?: unknown }> {
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
            perPage: FOLLOWED_PAGE,
          })
        : searchCatalog({
            provider: "stashdb",
            kind: "scene",
            performer: follow.reference.id,
            sort: "date",
            direction: "desc",
            page: 1,
            perPage: FOLLOWED_PAGE,
          })
      ).then((page) => page.items),
    ),
  );
  const items: CatalogDetail[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.status === "rejected") {
      continue;
    }
    for (const item of page.value) {
      // Two followed performers can share a title; keep one copy.
      if (seen.has(item.reference.id)) continue;
      seen.add(item.reference.id);
      items.push(item);
    }
  }
  const firstFailure = pages.find(
    (p): p is PromiseRejectedResult => p.status === "rejected",
  );
  if (items.length === 0 && firstFailure) throw firstFailure.reason;
  return {
    items: items.slice(0, FOLLOW_SHELF_PERFORMERS * FOLLOWED_PAGE),
    ...(firstFailure ? { failure: firstFailure.reason } : {}),
  };
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
        ...side.value.items.filter((item) => !isHiddenTitle(item, hiddenTags)),
      );
      // A partial side keeps its survivors and still names the provider.
      if (side.value.failure !== undefined) {
        errors.push(sourceError(provider, side.value.failure));
      }
    } else errors.push(sourceError(provider, side.reason));
  });
  if (merged.length === 0 && errors.length === 0) return null;
  const base = FOLLOWED_SHELF_BASE;
  if (merged.length === 0) {
    // Every side the account actually follows failed, or a partial side's
    // survivors are all hidden: the error-only shape carries the collected
    // failure — never a rejected-sides-only lookup, which misses a
    // fulfilled side's page failure and degrades to a generic error.
    // errors is non-empty here, else we returned null above.
    const first = errors[0]!;
    return { ...base, error: { code: first.code, message: first.message } };
  }
  return {
    ...base,
    ...railOf(dedupeTitles(merged), catalogPreview),
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

export function shelfOf(
  base: Omit<Shelf, "items" | "error">,
  result: PromiseSettledResult<{
    items: ShelfItems;
    more?: ShelfMorePreview[];
  }>,
): Shelf {
  return result.status === "fulfilled"
    ? { ...base, ...result.value }
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
  const rail = railOf(page.items, catalogPreview);
  return {
    ...base,
    items: rail.items,
    ...(rail.more ? { more: rail.more } : {}),
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
// ponytail: bounded recent/trending snapshot (SHELF_ITEMS + MORE_PREVIEWS
// unique ids, no popularity invented); a full directory listing only if a
// browse surface ever needs one.
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
  return [...names]
    .slice(0, SHELF_ITEMS + MORE_PREVIEWS)
    .map(([id, name], i) => {
      const carriers = art.get(id) ?? [];
      const imageUrl =
        carriers.length > 0 ? carriers[i % carriers.length] : undefined;
      return { id, name, ...(imageUrl !== undefined ? { imageUrl } : {}) };
    });
}

export function studioFacets(
  provider: CatalogProvider,
  items: CatalogDetail[],
  // The directory passes Infinity and lists every studio; the shelf
  // enriches rail depth plus the preview tail.
  cap: number = SHELF_ITEMS + MORE_PREVIEWS,
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
    [...known.values()].slice(0, cap).map(({ reference, name }) =>
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
  let pageErrors: SourceError[] = [];
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
    pageErrors = page.errors;
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
    facetShelf("studios", sources, pageErrors),
    facetShelf("genres", sources, pageErrors),
  ]);
}

/** Cross-provider studio dedupe: a TPDB tile dies only when a StashDB tile
 * published that exact studio as its counterpart — never by name: two
 * same-named studios without a published link stay two tiles. Survivors get
 * their own counterparts resolved (settled); rejected lookups ride back as
 * named errors beside the survivors. */
async function dedupePublishedStudios(
  tiles: FacetItem[],
): Promise<{ tiles: FacetItem[]; errors: SourceError[] }> {
  const stashTiles = tiles.filter((tile) => tile.provider === "stashdb");
  const pairingErrors = await resolveLinked(stashTiles);
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
  const survivorErrors = await resolveLinked(survivors);
  return {
    tiles: survivors,
    errors: mergeErrors(pairingErrors, survivorErrors),
  };
}

export async function facetShelf(
  shelf: "studios" | "genres",
  sources: { provider: CatalogProvider; items: CatalogDetail[] }[],
  // The browse page's own per-source failures: the dead side contributed no
  // rows, so its outage must ride beside the survivor's tiles.
  pageErrors: SourceError[] = [],
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
  // Alternate the providers' tiles so the rail leaves room for both sides.
  const candidates: FacetItem[] = [];
  for (let i = 0; i < SHELF_ITEMS + MORE_PREVIEWS; i++) {
    for (const { tiles } of perSource) {
      const tile = tiles[i];
      if (tile !== undefined) candidates.push(tile);
    }
  }
  const emitted = candidates.slice(0, SHELF_ITEMS + MORE_PREVIEWS);
  let items = emitted;
  let linkedErrors: SourceError[] = [];
  if (shelf === "studios") {
    const deduped = await dedupePublishedStudios(emitted);
    items = deduped.tiles;
    linkedErrors = deduped.errors;
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
    linkedErrors = await resolveLinked(items);
  }
  // Partial success stays named: a dead page side and rejected counterpart
  // lookups both speak, deduped to the one-entry-per-provider shape.
  const errors = mergeErrors(pageErrors, linkedErrors);
  return {
    id: shelf,
    title: shelf === "studios" ? "Studios" : "Genres",
    source: "velvarr",
    kind: "facets",
    ...railOf(items, facetPreview),
    browse: { view: "facets", params: { kind: shelf } },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** A facet tile previews as the art it renders: a studio's brand mark over
 * its poster, a genre's artwork. A deduped or unenriched tile may have
 * neither — the preview then names the facet, never faking art. */
function facetPreview(tile: FacetItem): ShelfMorePreview {
  const art =
    tile.facet === "studio" ? (tile.logoUrl ?? tile.imageUrl) : tile.imageUrl;
  return {
    name: tile.name,
    ...(art !== undefined ? { imageUrl: art } : {}),
  };
}

// Resolves each tile's cross-provider counterpart, settled: a rejection or
// an absent counterpart just leaves `linked` off the tile — and a rejection
// is returned as the OTHER side's named outage, never read as absence
// (tagCounterpart throws on upstream failure for exactly this).
export async function resolveLinked(
  tiles: FacetItem[],
): Promise<SourceError[]> {
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
  const errors: SourceError[] = [];
  settled.forEach((result, i) => {
    const tile = missing[i];
    if (tile === undefined) return;
    if (result.status === "rejected") {
      errors.push(
        sourceError(
          tile.provider === "tpdb" ? "stashdb" : "tpdb",
          result.reason,
        ),
      );
      return;
    }
    const ref = result.value;
    if (ref === undefined) return;
    if ("native" in ref) {
      // Tag reference: a uuid-less exact-label match carries no id — the
      // label exists on the other provider, but there is nothing to link.
      if (ref.native) {
        tile.linked = { provider: ref.provider, id: ref.id };
      }
      return;
    }
    tile.linked = { provider: ref.provider, id: ref.id };
  });
  return errors;
}

// The facet directory behind the discover shelf headline arrows. Genres:
// each provider's real tag listing — TPDB publishes a directory; StashDB's
// empty-term tag search refuses on some key tiers, and that upstream refusal
// surfaces as that side's error, never a fabricated list. Studios: no
// provider publishes a studio directory, so the overview derives from the
// same new-releases page the discover shelf reads, uncapped — the page
// reports its own breadth and a failed side's error instead of claiming
// "all studios ever".
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
      tiles: (await studioFacets(provider, items, Infinity)).map(
        (detail): FacetItem => ({
          facet: "studio",
          provider,
          id: detail.reference.id,
          name: detail.title,
          ...(detail.logoUrl !== undefined ? { logoUrl: detail.logoUrl } : {}),
          ...(detail.imageUrl !== undefined
            ? { imageUrl: detail.imageUrl }
            : {}),
        }),
      ),
    })),
  );
  const { tiles, errors: linkedErrors } = await dedupePublishedStudios(
    perSource.flatMap((s) => s.tiles),
  );
  tiles.sort((a, b) => a.name.localeCompare(b.name));
  return json({ kind, tiles, errors: mergeErrors(page.errors, linkedErrors) });
}

// Discover wire split: GET /api/discover returns ordered STUBS only (id,
// title, source, kind, description?, browse?) — no items, no errors, and no
// upstream provider calls. GET /api/discover/shelf?id=… builds exactly the
// one shelf discover() used to build for that id and returns
// { shelf: Shelf | null }; null only for followed-titles with nothing to
// show. Unknown or not-present ids fail with 404 unknown_shelf.
type ShelfStub = Pick<Shelf, "id" | "title" | "source" | "kind"> &
  Partial<Pick<Shelf, "description" | "browse">>;

export async function discover(ctx: AuthContext): Promise<Response> {
  const stubs = await shelfStubs(ctx);
  return json({ shelves: stubs });
}

// The followed rail's shared identity: the stub list and followedShelf's
// built shelf must carry the same title/browse, so both read this one base.
const FOLLOWED_SHELF_BASE: ShelfStub = {
  id: "followed-titles",
  title: "From performers you follow",
  source: "velvarr",
  kind: "catalog",
  browse: { view: "following", params: {} },
};

// One base per shelf id, keyed for both consumers: the stub list renders it
// before the shelf loads, buildShelf spreads its items/errors onto it after
// — a title or browse link can never drift between the two. new-releases
// carries the shared UTC "today" cutoff, so the table is a function.
function shelfBases(
  today: string,
): Record<Exclude<DiscoverShelfId, "followed-titles">, ShelfStub> {
  return {
    "new-releases": {
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
    trending: {
      id: "trending",
      title: "Trending",
      description: "Scene trends from StashDB",
      source: "stashdb",
      kind: "catalog",
      browse: {
        view: "titles",
        params: { type: "scene", sort: "trending", direction: "desc" },
      },
    },
    "jellyfin-recent": {
      id: "jellyfin-recent",
      title: "Recently added",
      source: "jellyfin",
      kind: "library",
      browse: { view: "library", params: { sort: "dateAdded" } },
    },
    "velvarr-requests": {
      id: "velvarr-requests",
      title: "Recent requests",
      source: "velvarr",
      kind: "requests",
      browse: { view: "requests", params: {} },
    },
    studios: {
      id: "studios",
      title: "Studios",
      source: "velvarr",
      kind: "facets",
      browse: { view: "facets", params: { kind: "studios" } },
    },
    genres: {
      id: "genres",
      title: "Genres",
      source: "velvarr",
      kind: "facets",
      browse: { view: "facets", params: { kind: "genres" } },
    },
  };
}

// Static per id plus today's UTC date: stubs never touch providers or
// Jellyfin. Presence: followed-titles only when the account follows someone.
export async function shelfStubs(ctx: AuthContext): Promise<ShelfStub[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { discoverOrder } = getContentPreferences(ctx.account.id);
  const bases = shelfBases(today);
  const stubs: ShelfStub[] = [
    bases["new-releases"],
    bases.trending,
    bases["jellyfin-recent"],
    bases["velvarr-requests"],
    bases.studios,
    bases.genres,
    ...(listFollows(ctx.account.id).length > 0 ? [FOLLOWED_SHELF_BASE] : []),
  ];
  // Per-account order over the PRESENT shelves only: a shelf the account
  // cannot fill (no follows) stays absent — never a fake rail, and the
  // saved order itself is untouched. Array#sort is stable, so any id the
  // saved order does not know (a shelf newer than this account's stored
  // order) keeps its assembled position after the ranked ones.
  const rank = new Map<string, number>(
    discoverOrder.map((id, i) => [id, i] as const),
  );
  stubs.sort(
    (a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size),
  );
  return stubs;
}

// One branch per shelf id; each returns exactly the shelf the old
// single-request discover() built for that id (same items, errors, and
// error semantics). Cached provider reads come from server/discovery.ts;
// Jellyfin-recent and requests stay live (local NAS / local DB).
export async function buildShelf(
  id: DiscoverShelfId,
  ctx: AuthContext,
  prefs: ContentPreferences,
  today: string,
): Promise<Shelf | null> {
  const { hiddenTags } = prefs;
  // followedShelf builds its own shelf from the shared base above; null
  // means an empty filmography (the rail disappears, as the stub list's
  // presence rule anticipated).
  if (id === "followed-titles") {
    return cachedFollowed(ctx.account.id, hiddenTags);
  }
  const base = shelfBases(today)[id];
  switch (id) {
    case "new-releases":
      return browseShelf(base, await cachedReleases(hiddenTags, today));
    case "trending":
      // Single source, so a failure is the shelf's own rejection — the
      // settled-result shape preserves the old error semantics. The cache
      // holds the raw candidates; the rail cap and See More preview apply
      // per build.
      return shelfOf(
        base,
        await Promise.allSettled([
          Promise.resolve()
            .then(() => cachedTrending(hiddenTags))
            .then((items) => railOf(items, catalogPreview)),
        ]).then((r) => r[0]!),
      );
    case "jellyfin-recent":
      return shelfOf(
        base,
        await Promise.allSettled([
          listRecentlyAddedItems(
            ctx.config,
            ctx.token,
            ctx.account,
            SHELF_ITEMS + MORE_PREVIEWS,
          ).then((items) =>
            railOf(items, (it) => ({
              name: it.name,
              ...(it.image ? { imageUrl: it.image } : {}),
            })),
          ),
        ]).then((r) => r[0]!),
      );
    case "velvarr-requests":
      // storage is sync; deferred so its failures settle like the rest.
      return shelfOf(
        base,
        await Promise.allSettled([
          Promise.resolve().then(() =>
            railOf(listRequestItems(ctx), (r) => ({ media: r.media })),
          ),
        ]).then((r) => r[0]!),
      );
    case "studios":
    case "genres": {
      // facetShelves yields the error-only shelves when both sides of the
      // browse page failed, preserving the old shape. Each facet rebuilds
      // studio enrichment from the provider detail cache; acceptable —
      // cachedReleases joins concurrent builds.
      const shelves = await facetShelves(
        await cachedReleases(hiddenTags, today),
      );
      return shelves.find((s) => s.id === id)!;
    }
  }
}

export async function discoverShelf(
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  const present = await shelfStubs(ctx);
  // The stub list only ever carries registry ids, so presence proves the
  // cast; Shelf.id is a plain string on the wire.
  const stub = present.find((s) => s.id === id);
  if (id === null || stub === undefined) {
    throw new AppError(404, "unknown_shelf", "Unknown discover shelf.");
  }
  const prefs = getContentPreferences(ctx.account.id);
  const today = new Date().toISOString().slice(0, 10);
  return json({
    shelf: await buildShelf(id as DiscoverShelfId, ctx, prefs, today),
  });
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
    segments: ["discover", "shelf"],
    auth: "session",
    run: async (ctx, request) => discoverShelf(request, ctx),
  },
  {
    method: "GET",
    segments: ["discovery", "facets"],
    auth: "session",
    run: async (ctx, request) => discoveryFacets(request, ctx),
  },
];
