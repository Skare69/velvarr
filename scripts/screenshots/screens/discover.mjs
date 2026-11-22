// Discover, desktop: the default shelf list, with the three rails above the
// fold filled from the shared demo catalog. The shelves below the fold get
// real content too, because the lazy rails load 300 px before they scroll in.
import {
  ACCOUNT,
  MOVIES,
  NOW,
  SCENES,
  STUDIOS,
  TAGS,
  art,
  catalogResponse,
  libraryItem,
} from "../demo.mjs";

const today = new Date(NOW).toISOString().slice(0, 10);

// Stub order and fields follow shelfStubs() in routes/discover.ts. The titles
// must equal DISCOVER_SHELVES in src/lib/contracts.ts of the release, because
// the shots show the real UI; stub and built shelf share one base, as there.
const BASES = [
  {
    id: "new-releases",
    title: "New releases",
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
  {
    id: "trending",
    title: "Trending",
    source: "tpdb",
    kind: "catalog",
    browse: {
      view: "titles",
      params: { type: "movie", sort: "trending", direction: "desc" },
    },
  },
  {
    id: "jellyfin-recent",
    title: "Recently added",
    source: "jellyfin",
    kind: "library",
    browse: { view: "library", params: { sort: "dateAdded" } },
  },
  {
    id: "velvarr-requests",
    title: "Recent requests",
    source: "velvarr",
    kind: "requests",
    browse: { view: "requests", params: {} },
  },
  {
    id: "studios",
    title: "Studios",
    source: "velvarr",
    kind: "facets",
    browse: { view: "facets", params: { kind: "studios" } },
  },
  {
    id: "genres",
    title: "Genres",
    source: "velvarr",
    kind: "facets",
    browse: { view: "facets", params: { kind: "genres" } },
  },
];

const byTitle = (title) =>
  [...SCENES, ...MOVIES].find((c) => c.detail.title === title);

// LibraryTile puts `image` straight into <img src>, as the real same-origin
// Jellyfin path; the art URL goes through the proxy path the runner answers.
const library = (title) => {
  const c = byTitle(title);
  return {
    ...libraryItem(c),
    image: `/api/catalog/image?url=${encodeURIComponent(c.detail.imageUrl)}`,
  };
};

// The viewer's own requests (no requestedBy, so the tile shows the own avatar).
const requestItem = (title) => {
  const c = byTitle(title);
  const r = catalogResponse(c);
  return {
    ...r.myRequest,
    accountId: ACCOUNT.id,
    media: c.detail.reference,
    acquisition: r.acquisition,
  };
};

const studio = (s) => ({
  facet: "studio",
  provider: s.provider,
  id: s.id,
  name: s.name,
});
const genre = (tag, artName) => ({
  facet: "tag",
  provider: "stashdb",
  id: tag.id,
  name: tag.name,
  imageUrl: art(artName),
});

const ITEMS = {
  "new-releases": SCENES.map((c) => c.detail),
  trending: MOVIES.map((c) => c.detail),
  "jellyfin-recent": [
    library("After Midnight in Lisbon"),
    library("Velvet Lounge"),
    library("Poolside Afternoon"),
    library("Tide Lines"),
    library("Mirror, Mirror"),
  ],
  "velvarr-requests": [
    "The Pink Motel",
    "Blue Hour Above the City",
    "By the Fireplace",
    "Room Service",
    "Salt in the Air",
  ]
    .map(requestItem)
    .sort((a, b) => b.createdAt - a.createdAt),
  studios: [studio(STUDIOS.plum), studio(STUDIOS.velvet)],
  genres: [
    genre(TAGS.lingerie, "scene-city-lace"),
    genre(TAGS.velvet, "scene-fireplace"),
    genre(TAGS.poolside, "scene-pool"),
    genre(TAGS.romance, "movie-lisbon"),
    genre(TAGS.neon, "scene-club"),
  ],
};

export default {
  width: 2000,
  height: 1250,
  viewport: { width: 1600, height: 1000 },
  scale: 1.25,
  mobile: false,
  url: "/",
  api({ method, path, query }) {
    if (method !== "GET") return undefined;
    // GET /api/discover: ordered stubs only, no items.
    if (path === "/api/discover") return { shelves: BASES };
    if (path === "/api/discover/shelf") {
      const base = BASES.find((b) => b.id === query.get("id"));
      if (!base)
        return {
          __status: 404,
          __body: {
            error: {
              code: "unknown_shelf",
              message: "Unknown discover shelf.",
            },
          },
        };
      return { shelf: { ...base, items: ITEMS[base.id] } };
    }
    return undefined;
  },
  async prepare(page) {
    for (const { title } of BASES.slice(0, 3))
      await page
        .locator(`[aria-label="${title} rail"] .discovery-tile`)
        .first()
        .waitFor();
  },
};
