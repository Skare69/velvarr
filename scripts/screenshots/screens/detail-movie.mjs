// Movie detail page: "After Midnight in Lisbon", playable in Jellyfin.
import { MOVIES } from "../demo.mjs";

const movie = MOVIES[0];
const { id } = movie.detail.reference;
const base = `/api/catalog/tpdb/movie/${id}`;
const tagIds = new Set(movie.detail.tags.map((t) => t.id));

export default {
  width: 1800,
  height: 1010,
  // 1400 - 200 px sidebar = a 1200 px main column; x1.5 = 1800 px. The
  // width also keeps the hero's 24rem facts column (1280-1535 px).
  viewport: { width: 1400, height: 1000 },
  scale: 1.5,
  mobile: false,
  // detailHref(movie.detail.reference): the detail opens over the browse view.
  url: `/?view=titles&provider=tpdb&kind=movie&id=${id}`,
  clip: "main",
  api({ method, path, query }) {
    if (method !== "GET") return undefined;
    // The browse grid stays mounted (hidden) under the detail.
    if (path === "/api/browse")
      return {
        items: [],
        page: 1,
        perPage: Number(query.get("perPage")),
        hasMore: false,
        total: 0,
        totalCountKnown: true,
        errors: [],
        notices: [],
        hiddenTagCount: 0,
      };
    if (path === `${base}/duplicates`)
      return {
        selfUrl: `https://theporndb.net/movies/${id}`,
        matches: [],
        incomplete: [],
        errors: [],
      };
    if (path === `${base}/related`)
      return {
        items: MOVIES.slice(1)
          .filter((m) => m.detail.tags.some((t) => tagIds.has(t.id)))
          .map((m) => m.detail),
        ranking: "tags",
        canRank: false,
        canRefine: false,
        errors: [],
      };
    return undefined;
  },
  async prepare(page) {
    await page.getByRole("link", { name: "Play on Jellyfin" }).waitFor();
    // The loading skeleton shares the grid class but is aria-busy.
    await page
      .getByRole("region", { name: "Similar titles" })
      .locator(".poster-grid.mt-3:not([aria-busy])")
      .waitFor();
    await page
      .getByRole("region", { name: "Performers" })
      .getByText("Dane Mercer")
      .waitFor();
    // The shot is the page column alone: no fixed top bar, and the same
    // gutter above the back row as on its sides.
    await page.addStyleTag({
      content:
        ".app-topbar { display: none !important; }" +
        ".app-main { padding-top: var(--page-gutter) !important; }",
    });
  },
};
