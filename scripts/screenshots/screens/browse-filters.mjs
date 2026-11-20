// Browse (Titles, Scenes tab) with the filter drawer open: two performers
// matched by "any", a Lingerie-or-Velvet tag group, a free-text tag and a
// release filter. The shot is the right 777.5 x 900 CSS px of a 1440 x 900
// desktop at 2x: the drawer plus a slice of the dimmed grid.
import { PERFORMERS, SCENES, TAGS } from "../demo.mjs";

// Both performers carry a StashDB id, so the scenes side filters by both
// and the real server would send no "not filtered by" notice.
const performers = [
  {
    name: PERFORMERS.aria.name,
    tpdb: PERFORMERS.aria.reference.id,
    stashdb: "5ce0e000-0000-4000-8000-000000000901",
  },
  { name: PERFORMERS.sasha.name, stashdb: PERFORMERS.sasha.reference.id },
];
const tag = (t) => ({ name: t.name, stashdb: t.id });
const include = [
  [tag(TAGS.lingerie), tag(TAGS.velvet)],
  { name: "neon light" },
];

// Six active: 2 performers + 2 include rows + year + date. A year beside a
// one-sided date is a legal server query (src/server/browse.ts).
const state = new URLSearchParams({
  view: "titles",
  type: "scene",
  performers: JSON.stringify(performers),
  performerMode: "any",
  include: JSON.stringify(include),
  year: "2026",
  date: "2026-06-01",
  date_operation: ">=",
});

export default {
  width: 1555,
  height: 1800,
  viewport: { width: 1440, height: 900 },
  scale: 2,
  mobile: false,
  url: `/?${state}`,
  clip: "#shots-crop",
  api({ method, path, query }) {
    if (method !== "GET" || path !== "/api/browse") return undefined;
    const page = Number(query.get("page") ?? "1");
    const items = page === 1 ? SCENES.map((s) => s.detail) : [];
    return {
      items,
      page,
      perPage: Number(query.get("perPage") ?? "24"),
      hasMore: false,
      total: SCENES.length,
      totalCountKnown: true,
      errors: [],
      notices: [],
      hiddenTagCount: 0,
    };
  },
  async prepare(page) {
    await page
      .getByLabel(`View details for ${SCENES[0].detail.title}`)
      .waitFor();
    await page.getByRole("button", { name: "Filters, 6 active" }).click();
    await page.getByRole("heading", { name: "Filters · 6 active" }).waitFor();
    await page.getByText("Lingerie or Velvet").last().waitFor();
    // The runner clips to an element, so a fixed box marks the right edge.
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "shots-crop";
      box.style.cssText =
        "position:fixed;top:0;right:0;width:777.5px;height:100vh;pointer-events:none";
      document.body.append(box);
    });
  },
};
