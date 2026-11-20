// Demo data for the landing-page screenshots (scripts/screenshots/README.md).
// Every name, title and studio is invented and safe for work. Pictures come
// from the art folder: `art(name)` gives the provider-style URL that the
// app passes through its own image proxy, and the runner answers the proxy
// with the matching art file. Shapes follow src/lib/contracts.ts.

/** Every art file the screens use: name -> what the picture shows. The
 * README lists the same set; the runner refuses to start without all of
 * them. Posters are portrait 2:3, portraits 3:4, the avatar square. */
export const ART = {
  "scene-city-lace":
    "poster 2:3 - woman in black lace at a window over a night city",
  "scene-bath": "poster 2:3 - couple in a pink-lit bathtub under a chandelier",
  "scene-pool":
    "poster 2:3 - woman in a purple bikini and sunglasses by a pool",
  "scene-fireplace":
    "poster 2:3 - woman in a magenta velvet robe in a leather armchair",
  "scene-club": "poster 2:3 - couple dancing in a purple neon club",
  "scene-beach":
    "poster 2:3 - woman in a sheer dress, windblown hair, dusk sea",
  "scene-yoga": "poster 2:3 - woman in a sports top doing yoga in a pink room",
  "scene-lounge": "poster 2:3 - woman in a velvet dress on a lounge sofa",
  "scene-neon": "poster 2:3 - room washed in pink neon light",
  "scene-boudoir": "poster 2:3 - woman in a dressing room with a lit mirror",
  "movie-lisbon":
    "poster 2:3 - couple embracing on a rooftop over a night city",
  "movie-motel":
    "poster 2:3 - woman in a purple dress at a vintage car, motel neon behind",
  "movie-corset": "poster 2:3 - woman in a black corset before a red curtain",
  "movie-robes": "poster 2:3 - couple in velvet and white bathrobes",
  "movie-beach": "poster 2:3 - woman walking along a beach at sunset",
  "movie-sofa": "poster 2:3 - two women laughing on a velvet sofa",
  "movie-street": "poster 2:3 - woman in a purple coat on a rainy night street",
  "performer-aria-vale": "portrait 3:4 - auburn-haired woman, satin top",
  "performer-dane-mercer": "portrait 3:4 - dark-haired man in a suit",
  "performer-sasha-bloom": "portrait 3:4 - blonde woman, soft studio light",
  "avatar-admin": "square - avatar of the signed-in admin",
};

export const ART_HOST = "https://art.velvarr.test/";
export const art = (name) => {
  if (!(name in ART)) throw new Error(`Unknown art name: ${name}`);
  return `${ART_HOST}${name}`;
};

/** The fixed "now" for every screen, so relative times never drift. */
export const NOW = Date.parse("2026-11-16T18:00:00Z");
export const HOUR = 3_600_000;

export const ACCOUNT = {
  id: "demo-admin",
  name: "Mara",
  role: "admin",
  enabled: true,
  libraryIds: ["demo-library"],
  isOwner: true,
  autoApprove: true,
  proseSearch: true,
  joinedAt: NOW - 400 * 24 * HOUR,
};

export const STUDIOS = {
  plum: {
    name: "Plum Street Pictures",
    provider: "stashdb",
    id: "c0ffee00-0000-4000-8000-00000000a001",
  },
  velvet: { name: "Velvet Hour", provider: "tpdb", id: "velvet-hour" },
};

const uuid = (n) => `5ce0e000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const PERFORMERS = {
  aria: {
    reference: { provider: "tpdb", kind: "performer", id: "aria-vale" },
    name: "Aria Vale",
    imageUrl: art("performer-aria-vale"),
  },
  dane: {
    reference: { provider: "tpdb", kind: "performer", id: "dane-mercer" },
    name: "Dane Mercer",
    imageUrl: art("performer-dane-mercer"),
  },
  sasha: {
    reference: { provider: "stashdb", kind: "performer", id: uuid(900) },
    name: "Sasha Bloom",
    imageUrl: art("performer-sasha-bloom"),
  },
};
const credit = (p) => ({ ...p, links: [] });

export const TAGS = {
  lingerie: { id: uuid(801), name: "Lingerie" },
  velvet: { id: uuid(802), name: "Velvet" },
  poolside: { id: uuid(803), name: "Poolside" },
  romance: { id: uuid(804), name: "Romance" },
  neon: { id: uuid(805), name: "Neon" },
};

/** Card status names map to the envelope facts that src/lib/status.ts reads:
 * requested = pending request, approved = approved request, processing =
 * downloading, available = playable in Jellyfin, declined = declined request. */
function item(n, kind, title, artName, opts = {}) {
  const scene = kind === "scene";
  const studio = opts.studio ?? (scene ? STUDIOS.plum : STUDIOS.velvet);
  return {
    status: opts.status ?? null,
    detail: {
      reference: scene
        ? { provider: "stashdb", kind, id: uuid(n) }
        : { provider: "tpdb", kind, id: `movie-${n}` },
      title,
      description: opts.description,
      releaseDate:
        opts.releaseDate ??
        `2026-${String(11 - (n % 10)).padStart(2, "0")}-0${(n % 9) + 1}`,
      durationSeconds:
        opts.durationSeconds ?? (scene ? (25 + 2 * (n % 10)) * 60 : 90 * 60),
      imageUrl: art(artName),
      studio: {
        name: studio.name,
        reference: { provider: studio.provider, kind: "studio", id: studio.id },
      },
      credits: (opts.credits ?? [PERFORMERS.aria]).map(credit),
      tags: opts.tags ?? [TAGS.lingerie, TAGS.romance],
      related: [],
      links: [],
      aliases: [],
    },
  };
}

export const SCENES = [
  item(1, "scene", "Blue Hour Above the City", "scene-city-lace", {
    status: "requested",
  }),
  item(2, "scene", "Bubbles at Midnight", "scene-bath", {
    credits: [PERFORMERS.sasha, PERFORMERS.dane],
  }),
  item(3, "scene", "Poolside Afternoon", "scene-pool", {
    status: "available",
    tags: [TAGS.poolside],
  }),
  item(4, "scene", "By the Fireplace", "scene-fireplace", {
    status: "processing",
    tags: [TAGS.velvet],
  }),
  item(5, "scene", "Neon Dance Floor", "scene-club", {
    credits: [PERFORMERS.sasha, PERFORMERS.dane],
    tags: [TAGS.neon],
  }),
  item(6, "scene", "Salt in the Air", "scene-beach", { status: "declined" }),
  item(7, "scene", "Slow Stretch", "scene-yoga", {
    credits: [PERFORMERS.sasha],
  }),
  item(8, "scene", "Velvet Lounge", "scene-lounge", {
    status: "available",
    tags: [TAGS.velvet],
  }),
  item(9, "scene", "Pink Neon Room", "scene-neon", { tags: [TAGS.neon] }),
  item(10, "scene", "Mirror, Mirror", "scene-boudoir", { status: "available" }),
];

export const MOVIES = [
  item(11, "movie", "After Midnight in Lisbon", "movie-lisbon", {
    status: "available",
    releaseDate: "2026-10-03",
    description:
      "Two strangers share one long night in Lisbon, from a rooftop bar to a hotel suite at sunrise.",
    credits: [PERFORMERS.aria, PERFORMERS.dane],
    tags: [TAGS.lingerie, TAGS.poolside, TAGS.romance],
  }),
  item(12, "movie", "The Pink Motel", "movie-motel", {
    status: "requested",
    studio: STUDIOS.plum,
  }),
  item(13, "movie", "Curtain Call", "movie-corset"),
  item(14, "movie", "Room Service", "movie-robes", {
    status: "approved",
    credits: [PERFORMERS.aria, PERFORMERS.dane],
  }),
  item(15, "movie", "Tide Lines", "movie-beach", { status: "available" }),
  item(16, "movie", "Velvet Sisters", "movie-sofa", {
    credits: [PERFORMERS.aria, PERFORMERS.sasha],
  }),
  item(17, "movie", "Rain on Rua Augusta", "movie-street"),
];

export const CATALOG = [...SCENES, ...MOVIES];
const byPath = new Map(
  CATALOG.map((c) => [
    `${c.detail.reference.provider}/${c.detail.reference.kind}/${c.detail.reference.id}`,
    c,
  ]),
);

/** The Jellyfin item behind an "available" title. */
export function libraryItem(c) {
  const d = c.detail;
  return {
    id: `jf-${d.reference.id}`,
    name: d.title,
    kind: d.reference.kind === "movie" ? "Movie" : "Video",
    year: Number(d.releaseDate.slice(0, 4)),
    overview: d.description,
    durationTicks: d.durationSeconds * 10_000_000,
    file: {
      sizeBytes: 6_195_000_000,
      container: "mkv",
      resolution: "2160p",
      videoCodec: "hevc",
    },
    // Jellyfin images are same-origin paths: the tile skips the proxy helper.
    image: `/api/catalog/image?url=${encodeURIComponent(d.imageUrl)}`,
    canPlay: true,
    watchUrl: `https://media.example.test/web/#/details?id=jf-${d.reference.id}`,
    catalog: d.reference,
  };
}

const request = (c, decision, ageHours) => ({
  id: `req-${c.detail.reference.id}`,
  accountId: ACCOUNT.id,
  media: c.detail.reference,
  decision,
  createdAt: NOW - ageHours * HOUR,
  decidedAt: decision === "pending" ? null : NOW - (ageHours - 3) * HOUR,
});
const acquisition = (state, progress = null) => ({
  state,
  lastError: null,
  updatedAt: NOW - HOUR,
  observationStale: false,
  monitored: true,
  progress,
});

/** GET /api/catalog/{provider}/{kind}/{id}: the CatalogDetailResponse. */
export function catalogResponse(c) {
  const s = c.status;
  return {
    detail: c.detail,
    link: {
      linked: null,
      unlinkedReason: "The provider publishes no link for this title.",
    },
    catalogRecord: null,
    myRequest:
      s === "requested"
        ? request(c, "pending", 5)
        : s === "declined"
          ? request(c, "declined", 30)
          : s === "approved" || s === "processing" || s === "available"
            ? request(c, "approved", 15)
            : null,
    acquisition:
      s === "processing"
        ? acquisition("downloading", { percent: 62, timeleft: "00:12:40" })
        : s === "approved"
          ? acquisition("monitoring")
          : s === "available"
            ? acquisition("imported")
            : null,
  };
}

/** GET /api/availability/{provider}/{kind}/{id}: the PlaybackAccess. */
export const availabilityResponse = (c) =>
  c.status === "available"
    ? {
        outcome: "available",
        item: libraryItem(c),
        watchUrl: libraryItem(c).watchUrl,
      }
    : { outcome: "missing" };

export const findCatalog = (provider, kind, id) =>
  byPath.get(`${provider}/${kind}/${id}`);

/** Answers shared by every screen. Returns `undefined` for a path it does
 * not own, so the screen's own handler can answer it. */
export function commonApi({ method, path }) {
  if (method !== "GET") return undefined;
  if (path === "/api/status") return { initialized: true, setupReady: true };
  if (path === "/api/me")
    return {
      account: ACCOUNT,
      csrf: "demo",
      providers: { tpdb: "not_verified", stashdb: "not_verified" },
      proseSearchStatus: "ready",
    };
  if (path === "/api/update") return { update: null };
  if (path === "/api/me/preferences")
    return { hiddenTags: [], discoverOrder: [] };
  if (path === "/api/follows") return { follows: [] };
  // The sidebar badge reads `pendingApprovals` from the first page.
  if (path === "/api/requests")
    return { requests: [], nextCursor: null, pendingApprovals: 2 };
  const m = path.match(
    /^\/api\/(catalog|availability)\/(tpdb|stashdb)\/(movie|scene)\/([^/]+)$/,
  );
  if (m) {
    const c = findCatalog(m[2], m[3], decodeURIComponent(m[4]));
    if (c)
      return m[1] === "catalog" ? catalogResponse(c) : availabilityResponse(c);
  }
  return undefined;
}
