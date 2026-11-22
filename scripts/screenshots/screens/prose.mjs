// Browse (Scenes) after a natural-language search: the describe field holds
// the sentence, the notes sit under the toolbar, the drafted filters show as
// chips above the scene grid. The real UI posts the sentence and applies the
// answer, so the chips come from the URL patch exactly as in the app.
import { SCENES, TAGS } from "../demo.mjs";

const SENTENCE =
  "Aria Vale in lingerie or velvet under neon light this year, something cozy, no pool";
const NOT_APPLIED = "Not applied: “something cozy” (not a filter).";

// Aria Vale's StashDB id: the Scenes tab filters the StashDB side.
const ARIA_STASHDB = "5ce0e000-0000-4000-8000-000000000901";
const stashTag = (t) => ({ name: t.name, stashdb: t.id });

/** POST /api/browse/prose answer (ProseSearchResult): a patch that replaces
 * every browse filter, the way src/lib/prose-map.ts writes it. */
const PROSE_RESULT = {
  params: {
    q: null,
    include: JSON.stringify([
      [stashTag(TAGS.lingerie), stashTag(TAGS.velvet)],
      { name: "neon light" },
    ]),
    exclude: JSON.stringify([stashTag(TAGS.poolside)]),
    studios: null,
    studioTpdb: null,
    studioStashdb: null,
    performers: JSON.stringify([{ name: "Aria Vale", stashdb: ARIA_STASHDB }]),
    performerMode: null,
    performerTpdb: null,
    performerStashdb: null,
    performerStarred: null,
    studioMode: null,
    year: null,
    yearTo: null,
    date: "2026-01-01",
    date_operation: ">=",
    dateTo: null,
    sort: "date",
    direction: "desc",
    name: null,
  },
  // The same note shape as the server's readAs (src/lib/prose-map.ts).
  notes: [
    {
      code: "read_as",
      message: "Read 'this year' as on or after 2026-01-01",
      read: { from: "this year", to: "on or after 2026-01-01" },
    },
    { code: "not_a_filter", message: NOT_APPLIED },
  ],
};

// The drafted filters exclude Poolside, so the grid must not show those scenes.
const RESULTS = SCENES.map((s) => s.detail).filter(
  (d) => !d.tags.some((t) => t.id === TAGS.poolside.id),
);

/** GET /api/browse: one complete page of the matching demo scenes. */
const browsePage = (query) => ({
  items: RESULTS,
  page: Number(query.get("page") ?? 1),
  perPage: Number(query.get("perPage") ?? 24),
  hasMore: false,
  total: RESULTS.length,
  totalCountKnown: true,
  errors: [],
  notices: [],
  hiddenTagCount: 0,
});

export default {
  width: 1800,
  height: 957,
  // Main column = 1440 - 200px sidebar = 1240 CSS px, scaled to 1800 px.
  viewport: { width: 1440, height: 1100 },
  scale: 1800 / 1240,
  mobile: false,
  url: "/?view=titles&type=scene",
  clip: "main#main-content",
  api({ method, path, query }) {
    if (method === "GET" && path === "/api/browse") return browsePage(query);
    if (method === "POST" && path === "/api/browse/prose") return PROSE_RESULT;
    return undefined;
  },
  async prepare(page) {
    // The fixed top bar would cover the clipped main column: drop it and the
    // space main reserves for it.
    await page.addStyleTag({
      content:
        ".app-topbar { display: none; } .app-main { padding-top: var(--page-gutter); }",
    });
    const form = page.locator('form[aria-label="Natural-language search"]');
    const input = form.locator("input");
    await input.fill(SENTENCE);
    // Enter only submits once the Search button is enabled; submitting from
    // the field keeps the focus (and its accent ring) there afterwards.
    await form.locator('button[type="submit"]:not([disabled])').waitFor();
    await input.press("Enter");
    await page.getByText(NOT_APPLIED).waitFor();
    await page.locator(".filter-chips").getByText("Clear all").waitFor();
    await page
      .locator('p[role="status"]', { hasText: `${RESULTS.length} titles` })
      .waitFor();
  },
};
