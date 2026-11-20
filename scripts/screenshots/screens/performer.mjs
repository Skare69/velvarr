// Performer page: Aria Vale on TPDB, linked by the providers to her StashDB
// record, followed, with her tag overview and movie grid.
import {
  HOUR,
  MOVIES,
  NOW,
  PERFORMERS,
  SCENES,
  art,
  availabilityResponse,
  catalogResponse,
} from "../demo.mjs";

const aria = PERFORMERS.aria;
const uuid = (n) => `5ce0e000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STASH_REF = { provider: "stashdb", kind: "performer", id: uuid(901) };

const record = (reference, title) => ({
  id: uuid(950 + (reference.provider === "tpdb" ? 0 : 1)),
  reference,
  title,
  createdAt: NOW - 90 * 24 * HOUR,
  updatedAt: NOW - 2 * HOUR,
});

const TPDB_DETAIL = {
  reference: aria.reference,
  title: aria.name,
  description:
    "Lisbon-born performer known for slow, cinematic features with a romance focus. Active since 2019 across both providers.",
  imageUrl: aria.imageUrl,
  credits: [],
  tags: [],
  related: [],
  links: [{ url: "https://aria-vale.example/", label: "Website" }],
  aliases: ["A. Vale", "Aria V."],
  person: {
    gender: "female",
    birthplace: "Lisbon, Portugal",
    nationality: "Portuguese",
    eyeColor: "Brown",
    hairColor: "Brunette",
    heightCm: 170,
    careerStartYear: 2019,
    tattoos: ["Small star, left wrist"],
  },
};

// The StashDB side only fills gaps; the TPDB record wins every field it has.
const STASH_DETAIL = {
  reference: STASH_REF,
  title: aria.name,
  imageUrl: aria.imageUrl,
  credits: [],
  tags: [],
  related: [],
  links: [],
  aliases: [],
  person: { gender: "Female", heightCm: 170 },
};

const detailResponse = (detail, linked) => ({
  detail,
  link: { linked },
  catalogRecord: record(detail.reference, detail.title),
  myRequest: null,
  acquisition: null,
});

// The heading reads "Showing 8 of 8": the shared set has seven movies.
const EXTRA_MOVIE = {
  status: null,
  detail: {
    ...MOVIES[6].detail,
    reference: { provider: "tpdb", kind: "movie", id: "movie-18" },
    title: "Velvet Encore",
    releaseDate: "2026-02-14",
    imageUrl: art("scene-boudoir"),
  },
};
const ARIA_MOVIES = [...MOVIES, EXTRA_MOVIE];
const ARIA_SCENES = SCENES.filter((c) =>
  c.detail.credits.some((p) => p.reference.id === aria.reference.id),
);

const page = (provider, kind, rows) => ({
  provider,
  kind,
  page: 1,
  perPage: rows.length,
  hasMore: false,
  total: rows.length,
  totalCountKnown: true,
  items: rows.map((c) => c.detail),
});

const TAG_COUNTS = [
  ["Lingerie", 48, 801],
  ["Romance", 44, 804],
  ["Cinematic", 40, 811],
  ["Neon", 36, 805],
  ["Hotel", 32, 812],
  ["Poolside", 28, 803],
  ["Couples", 24, 813],
  ["Glamour", 20, 814],
  ["Night", 16, 815],
  ["Velvet", 12, 802],
].map(([name, count, n]) => ({ name, count, id: uuid(n) }));

const costar = (p) => ({
  reference: p.reference,
  title: p.name,
  imageUrl: p.imageUrl,
  credits: [],
  tags: [],
  related: [],
  links: [],
  aliases: [],
});

const follow = {
  id: "follow-aria-vale",
  reference: aria.reference,
  name: aria.name,
  imageUrl: aria.imageUrl,
  createdAt: NOW - 30 * 24 * HOUR,
  linked: STASH_REF,
};

const TPDB_PATH = `/api/catalog/tpdb/performer/${aria.reference.id}`;
const STASH_PATH = `/api/catalog/stashdb/performer/${STASH_REF.id}`;

export default {
  width: 1800,
  height: 1010,
  // 1400 - 200 px sidebar = a 1200 px main column, x1.5 = 1800 px wide.
  viewport: { width: 1400, height: 1000 },
  scale: 1.5,
  mobile: false,
  url: `/?view=following&provider=tpdb&kind=performer&id=${aria.reference.id}`,
  clip: "main",
  api({ method, path, query }) {
    if (method !== "GET") return undefined;
    if (path === "/api/follows") return { follows: [follow] };
    if (path === TPDB_PATH) return detailResponse(TPDB_DETAIL, STASH_REF);
    if (path === STASH_PATH)
      return detailResponse(STASH_DETAIL, aria.reference);
    if (path === `${TPDB_PATH}/tags`)
      return { tags: TAG_COUNTS, scanned: 96, capped: false, errors: [] };
    if (path === `${STASH_PATH}/tags`)
      return { tags: [], scanned: 0, capped: false, errors: [] };
    if (path === `${TPDB_PATH}/related`)
      return { items: [costar(PERFORMERS.dane)], errors: [] };
    if (path === `${STASH_PATH}/related`)
      return { items: [costar(PERFORMERS.sasha)], errors: [] };
    if (path === "/api/catalog/search") {
      const performer = query.get("performer");
      if (
        query.get("provider") === "tpdb" &&
        query.get("kind") === "movie" &&
        performer === aria.reference.id
      )
        return page("tpdb", "movie", ARIA_MOVIES);
      if (
        query.get("provider") === "stashdb" &&
        query.get("kind") === "scene" &&
        performer === STASH_REF.id
      )
        return page("stashdb", "scene", ARIA_SCENES);
      return undefined;
    }
    const extra = EXTRA_MOVIE.detail.reference;
    if (path === `/api/catalog/tpdb/movie/${extra.id}`)
      return catalogResponse(EXTRA_MOVIE);
    if (path === `/api/availability/tpdb/movie/${extra.id}`)
      return availabilityResponse(EXTRA_MOVIE);
    return undefined;
  },
  async prepare(page) {
    // The main column starts under the fixed top bar; the shot drops both.
    await page.addStyleTag({
      content:
        ".app-topbar { display: none !important; } .app-main { padding-top: var(--page-gutter) !important; }",
    });
    await page.locator(".follow-toggle.is-following").waitFor();
    await page.getByText("TPDB and StashDB, linked by the providers").waitFor();
    await page.getByText("Counted across 96 listed titles").waitFor();
    await page.getByText("Showing 8 of 8").waitFor();
    await page.getByRole("button", { name: /Request every movie/ }).waitFor();
  },
};
