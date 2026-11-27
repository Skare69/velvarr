import { expect, test } from "@playwright/test";
import { scenario } from "./settings-harness.mjs";

// Four unrequested movies, two per page. Page 2 is held, so the request
// below lands between two pages of a Requested = No browse.
const titles = ["Alpha", "Bravo", "Charlie", "Delta"].map((title, i) => ({
  id: `00000000-0000-4000-8000-00000000030${i + 1}`,
  title: `${title} Movie`,
}));

scenario(
  "a request between pages reloads a Requested = No grid, so no title is skipped",
  async ({ page, control }) => {
    await control({
      reset: true,
      browse: { titles, pageSize: 2 },
      holdBrowseMore: true,
    });
    await page.goto("/?view=titles&requested=no");
    const card = (title) =>
      page.getByRole("link", { name: `View details for ${title}` });
    await expect(card("Alpha Movie")).toBeVisible();
    await expect(card("Bravo Movie")).toBeVisible();

    await card("Alpha Movie").hover();
    await page.getByRole("button", { name: "Request: Alpha Movie" }).click();
    // The requested title leaves the filtered grid, and the reload from
    // page 1 brings the next unrequested title in instead of skipping it.
    await expect(card("Alpha Movie")).toHaveCount(0);
    await expect(card("Charlie Movie")).toBeVisible();

    await control({ holdBrowseMore: false });
    await expect(card("Delta Movie")).toBeVisible();
    await expect(card("Bravo Movie")).toHaveCount(1);
    await expect(card("Charlie Movie")).toHaveCount(1);
    await expect(card("Alpha Movie")).toHaveCount(0);
  },
);

scenario(
  "Request all that empties a Requested = No grid keeps its result line",
  async ({ page, control }) => {
    await control({
      reset: true,
      browse: { titles: titles.slice(0, 2), pageSize: 4 },
    });
    await page.goto("/?view=titles&requested=no");
    await expect(
      page.getByRole("link", { name: "View details for Bravo Movie" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Request all (2)" }).click();
    await page.getByRole("button", { name: "File the requests" }).click();
    // Both titles leave the filtered grid; the run's count stays said.
    await expect(page.getByText(/No titles match your filters/)).toBeVisible();
    await expect(page.getByText("2 requested.")).toBeVisible();
  },
);

const tag = (name, n) => ({
  name,
  tpdb: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  stashdb: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
});
const amber = tag("Amber", 1);
const blue = { name: "Blue", tpdb: tag("Blue", 2).tpdb };
const coral = { name: "Coral", stashdb: tag("Coral", 3).stashdb };
const dune = tag("Dune", 4);
const elm = tag("Elm", 5);
const offeredTags = [amber, blue, coral, dune, elm];

function browseUrl(include = []) {
  const params = new URLSearchParams({ view: "titles" });
  if (include.length > 0) params.set("include", JSON.stringify(include));
  return `/?${params}`;
}

function queryList(url, key = "include") {
  const value = new URL(url).searchParams.get(key);
  return value === null ? [] : JSON.parse(value);
}

async function tagBrowse(page, control, include = [], tags = offeredTags) {
  await control({ reset: true, browse: { titles: [], pageSize: 4 } });
  let preferences = { hiddenTags: [], discoverOrder: [] };
  await page.route("**/api/me/preferences", async (route) => {
    if (route.request().method() === "PATCH")
      preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
  // The fixture has no tag-search handler. These published-looking ids are
  // synthetic, and no provider or model receives a request.
  await page.route("**/api/browse/tags?*", (route) =>
    route.fulfill({ json: { tags, errors: [] } }),
  );
  const browseRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/browse")
      browseRequests.push(request.url());
  });
  await page.goto(browseUrl(include));
  await expectInclude(page, browseRequests, include);
  return browseRequests;
}

async function expectInclude(page, requests, include) {
  await expect.poll(() => queryList(page.url())).toEqual(include);
  await expect
    .poll(() => (requests.length > 0 ? queryList(requests.at(-1)) : null))
    .toEqual(include);
}

async function openFilters(page) {
  await page.getByRole("button", { name: /^Filters(?:,|$)/ }).click();
  const drawer = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

function nextTag(drawer, mode) {
  return drawer
    .getByRole("group", { name: "Add next tag", exact: true })
    .getByRole("button", { name: mode, exact: true });
}

function addOr(drawer, target) {
  const text = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return drawer.getByRole("button", {
    name: new RegExp(`^Add OR.*${text}`, "i"),
  });
}

function tagOption(surface, selection) {
  const sources = [
    selection.tpdb !== undefined && "Movies",
    selection.stashdb !== undefined && "Scenes",
  ]
    .filter(Boolean)
    .join(", ");
  return surface.getByRole("option", {
    name: `${selection.name} ${sources}`,
    exact: true,
  });
}

async function pickTag(
  surface,
  selection,
  label = "Must have",
  keyboard = false,
) {
  const input = surface.getByRole("combobox", { name: label, exact: true });
  await input.fill(selection.name);
  const option = tagOption(surface, selection);
  await expect(option).toBeVisible();
  if (keyboard) {
    await expect(option).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
  } else {
    await option.click();
  }
}

scenario(
  "Must have AND adds separate terms to the URL and Browse request",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control);
    const drawer = await openFilters(page);
    await expect(nextTag(drawer, "AND")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(nextTag(drawer, "OR")).toBeDisabled();
    await pickTag(drawer, amber);
    await expectInclude(page, requests, [amber]);
    await nextTag(drawer, "AND").click();
    await pickTag(drawer, blue, "Must have", true);
    await expectInclude(page, requests, [amber, blue]);
    await expect(
      drawer
        .getByRole("list", { name: "Selected Must have", exact: true })
        .getByRole("button", { name: /Remove tag:/ }),
    ).toHaveCount(2);
  },
);

scenario(
  "Must have OR creates a group from a singleton and consumes one pick",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control, [amber]);
    const drawer = await openFilters(page);
    const before = page.url();
    await nextTag(drawer, "OR").click();
    await expect(page).toHaveURL(before);
    await expect(nextTag(drawer, "OR")).toHaveAttribute("aria-pressed", "true");
    await pickTag(drawer, blue);
    await expectInclude(page, requests, [[amber, blue]]);
    await expect(nextTag(drawer, "AND")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pickTag(drawer, coral);
    await expectInclude(page, requests, [[amber, blue], coral]);
  },
);

scenario(
  "Add OR targets independent terms instead of always the last term",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control);
    const drawer = await openFilters(page);
    await pickTag(drawer, amber);
    await pickTag(drawer, coral);
    await expectInclude(page, requests, [amber, coral]);
    const firstAction = addOr(drawer, "Amber");
    await expect(firstAction).toHaveText("Add OR");
    await firstAction.click();
    await pickTag(drawer, blue);
    await expectInclude(page, requests, [[amber, blue], coral]);
    await addOr(drawer, "Coral").click();
    await pickTag(drawer, dune);
    await expectInclude(page, requests, [
      [amber, blue],
      [coral, dune],
    ]);
    await page.reload();
    await expectInclude(page, requests, [
      [amber, blue],
      [coral, dune],
    ]);
    const restored = await openFilters(page);
    await expect(addOr(restored, "Amber or Blue")).toBeVisible();
    await expect(addOr(restored, "Coral or Dune")).toBeVisible();
  },
);

scenario(
  "AND cancels an Add OR target without a URL change",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control, [amber, coral]);
    const drawer = await openFilters(page);
    const before = page.url();
    await addOr(drawer, "Amber").click();
    await expect(page).toHaveURL(before);
    await nextTag(drawer, "AND").click();
    await expect(page).toHaveURL(before);
    await expect(nextTag(drawer, "AND")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pickTag(drawer, blue);
    await expectInclude(page, requests, [amber, coral, blue]);
  },
);

scenario(
  "Back cannot redirect a stale OR target to the term at its old index",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control, [amber, coral]);
    const drawer = await openFilters(page);
    await drawer
      .getByRole("button", { name: "Remove tag: Amber", exact: true })
      .click();
    await expectInclude(page, requests, [coral]);
    await addOr(drawer, "Coral").click();
    await page.goBack();
    await expectInclude(page, requests, [amber, coral]);
    await expect(nextTag(drawer, "AND")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pickTag(drawer, dune);
    await expectInclude(page, requests, [amber, coral, dune]);
  },
);

scenario(
  "Back invalidates an OR target when the same group's members change",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control, [[amber, blue], coral]);
    const drawer = await openFilters(page);
    await addOr(drawer, "Amber or Blue").click();
    await pickTag(drawer, dune);
    await expectInclude(page, requests, [[amber, blue, dune], coral]);
    await addOr(drawer, "Amber or Blue or Dune").click();
    await page.goBack();
    await expectInclude(page, requests, [[amber, blue], coral]);
    await pickTag(drawer, elm);
    await expectInclude(page, requests, [[amber, blue], coral, elm]);
  },
);

scenario(
  "removal cancels an OR target before a new tag enters the list",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control, [[amber, blue], coral]);
    const drawer = await openFilters(page);
    await addOr(drawer, "Amber or Blue").click();
    await drawer
      .getByRole("button", {
        name: "Remove tag group: Amber OR Blue",
        exact: true,
      })
      .click();
    await expectInclude(page, requests, [coral]);
    await pickTag(drawer, dune);
    await expectInclude(page, requests, [coral, dune]);
  },
);

scenario(
  "a synthetic enhanced-search result stays editable with provider ids",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control);
    await page.route("**/api/me", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), proseSearchStatus: "ready" },
      });
    });
    // This is the mapped response contract, not evidence of live model output.
    // prose-map.test.ts checks the AND-of-OR mapping and provider resolution.
    const searchInclude = [[amber, blue], coral];
    await page.route("**/api/browse/prose", (route) =>
      route.fulfill({
        json: {
          params: { include: JSON.stringify(searchInclude), name: null },
          notes: [],
        },
      }),
    );
    await page.reload();
    const search = page.getByRole("search", {
      name: "Natural-language search",
    });
    await search
      .getByRole("textbox", { name: "Describe", exact: true })
      .fill("Amber or Blue, and Coral");
    const submitted = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/browse/prose",
    );
    await search.getByRole("button", { name: "Search", exact: true }).click();
    expect((await submitted).postDataJSON()).toEqual({
      text: "Amber or Blue, and Coral",
      type: "all",
    });
    await expectInclude(page, requests, searchInclude);
    const drawer = await openFilters(page);
    await expect(addOr(drawer, "Amber or Blue")).toBeVisible();
    await addOr(drawer, "Amber or Blue").click();
    await pickTag(drawer, dune);
    await expectInclude(page, requests, [[amber, blue, dune], coral]);
    await pickTag(drawer, elm);
    await expectInclude(page, requests, [[amber, blue, dune], coral, elm]);
    await page.goBack();
    await expectInclude(page, requests, [[amber, blue, dune], coral]);
    await page.goBack();
    await expectInclude(page, requests, searchInclude);
    // Recreate the same shape through the real picker, then compare the wire data.
    await page.goto(browseUrl());
    const manual = await openFilters(page);
    await pickTag(manual, amber);
    await nextTag(manual, "OR").click();
    await pickTag(manual, blue);
    await pickTag(manual, coral);
    await expectInclude(page, requests, searchInclude);
  },
);

test.describe("phone filter bounds", () => {
  test.use({
    viewport: { width: 375, height: 900 },
    isMobile: true,
    hasTouch: true,
  });

  scenario(
    "scene OR groups and their controls fit a 375px phone viewport",
    async ({ page, control }) => {
      // Keep the populated scene fixture and provider ids from the phone proof.
      // An empty grid without type=scene did not reproduce the page overflow.
      const { SCENES, catalogResponse } =
        await import("../../scripts/screenshots/demo.mjs");
      const uuid = (n) =>
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const selections = ["Velvet", "Lingerie", "Poolside", "Neon light"].map(
        (name, i) => ({
          name,
          tpdb: uuid(101 + i),
          stashdb: uuid(201 + i),
        }),
      );
      const [velvet, lingerie, poolside, neon] = selections;
      const longTag = tag(
        "Evening reflections beside the pool under a very long ribbon of neon light",
        900,
      );
      const rows = [
        { names: [velvet.name, poolside.name], title: "Velvet by the pool" },
        { names: [lingerie.name, neon.name], title: "Lingerie in neon light" },
        { names: [velvet.name], title: "Velvet evening" },
        { names: [poolside.name], title: "Poolside afternoon" },
      ].map((row, i) => ({
        status: null,
        detail: {
          ...SCENES[i].detail,
          title: row.title,
          imageUrl: undefined,
          tags: row.names.map((name) => ({
            name,
            id: selections.find((selection) => selection.name === name).stashdb,
          })),
        },
      }));
      const requests = await tagBrowse(
        page,
        control,
        [],
        [...selections, longTag],
      );
      await page.route("**/api/browse/tags?*", (route) => {
        const query =
          new URL(route.request().url()).searchParams.get("q") ?? "";
        return route.fulfill({
          json: {
            tags: [...selections, longTag].filter((selection) =>
              selection.name.toLowerCase().includes(query.toLowerCase()),
            ),
            errors: [],
          },
        });
      });
      await page.route("**/api/browse?*", (route) => {
        const include = queryList(route.request().url());
        const items = rows
          .filter((row) =>
            include.every((term) =>
              (Array.isArray(term) ? term : [term]).some((selection) =>
                row.detail.tags.some(
                  (actual) => actual.name === selection.name,
                ),
              ),
            ),
          )
          .map((row) => row.detail);
        return route.fulfill({
          json: {
            items,
            page: 1,
            perPage: 24,
            hasMore: false,
            total: items.length,
            totalCountKnown: true,
            errors: [],
            notices: [],
            hiddenTagCount: 0,
          },
        });
      });
      await page.route("**/api/catalog/stashdb/scene/*", (route) => {
        const row = rows.find((candidate) =>
          route.request().url().endsWith(candidate.detail.reference.id),
        );
        expect(row).toBeDefined();
        return route.fulfill({ json: catalogResponse(row) });
      });
      const include = [
        [velvet, lingerie],
        [poolside, neon],
      ];
      const params = new URLSearchParams({
        view: "titles",
        type: "scene",
        perPage: "24",
        include: JSON.stringify(include),
      });
      await page.setViewportSize({ width: 375, height: 900 });
      await page.goto(`/?${params}`);
      await expectInclude(page, requests, include);
      await expect(
        page.getByRole("link", { name: "View details for Velvet by the pool" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: "View details for Lingerie in neon light",
        }),
      ).toBeVisible();
      const drawer = await openFilters(page);
      await addOr(drawer, "Poolside OR Neon light").focus();
      await addOr(drawer, "Poolside OR Neon light").press("Enter");

      const expectPhoneBounds = async () => {
        // Compare with the configured width, never the expanded innerWidth.
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual(375);
        const box = await drawer.boundingBox();
        expect(box).not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375);
        expect(
          await drawer.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        const controls = drawer
          .locator(".cat-drawer-head, .cat-drawer-foot")
          .getByRole("button", { name: "Close filters", exact: true })
          .or(drawer.getByRole("button", { name: /^Add OR/ }))
          .or(
            drawer
              .getByRole("group", { name: "Add next tag" })
              .getByRole("button"),
          );
        expect(await controls.count()).toBe(6);
        for (const button of await controls.all()) {
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeVisible();
          const bounds = await button.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
          expect(bounds.y).toBeGreaterThanOrEqual(0);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
          expect(bounds.width).toBeGreaterThanOrEqual(44);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
      };
      await expectPhoneBounds();
      await pickTag(drawer, longTag, "Must have", true);
      await expectInclude(page, requests, [
        [velvet, lingerie],
        [poolside, neon, longTag],
      ]);
      await addOr(drawer, `Poolside OR Neon light OR ${longTag.name}`).focus();
      await addOr(drawer, `Poolside OR Neon light OR ${longTag.name}`).press(
        "Enter",
      );
      const longGroup = drawer
        .getByRole("list", { name: "Selected Must have", exact: true })
        .getByRole("button", {
          name: `Remove tag group: Poolside OR Neon light OR ${longTag.name}`,
          exact: true,
        });
      await expect(longGroup.locator(".tag-term-name")).toContainText(
        longTag.name,
      );
      await longGroup.scrollIntoViewIfNeeded();
      await expect(longGroup).toBeVisible();
      const longGroupBounds = await longGroup.boundingBox();
      expect(longGroupBounds).not.toBeNull();
      expect(longGroupBounds.x).toBeGreaterThanOrEqual(0);
      expect(longGroupBounds.x + longGroupBounds.width).toBeLessThanOrEqual(
        375,
      );
      await expectPhoneBounds();
      await drawer
        .locator(".cat-drawer-foot")
        .getByRole("button", { name: "Close filters", exact: true })
        .click();
      await expect(drawer).not.toBeVisible();
    },
  );
});

scenario(
  "duplicates inside an OR group never appear as new tag options",
  async ({ page, control }) => {
    const include = [[amber, blue], coral];
    const requests = await tagBrowse(page, control, include);
    const drawer = await openFilters(page);
    await addOr(drawer, "Amber or Blue").click();
    await drawer
      .getByRole("combobox", { name: "Must have", exact: true })
      .fill("AMBER");
    await expect(tagOption(drawer, dune)).toBeVisible();
    await expect(tagOption(drawer, amber)).toHaveCount(0);
    await expect(tagOption(drawer, blue)).toHaveCount(0);
    await expect(
      drawer.getByRole("option", { name: "AMBER Free text", exact: true }),
    ).toHaveCount(0);
    await expectInclude(page, requests, include);
    await tagOption(drawer, dune).click();
    await expectInclude(page, requests, [[amber, blue, dune], coral]);
  },
);

scenario(
  "the 25-tag cap counts OR members and removal restores add actions",
  async ({ page, control }) => {
    const group = Array.from({ length: 23 }, (_, i) =>
      tag(`Cap ${i + 1}`, i + 100),
    );
    const last = tag("Cap last", 200);
    const requests = await tagBrowse(
      page,
      control,
      [group, amber],
      [last, blue],
    );
    const drawer = await openFilters(page);
    await addOr(
      drawer,
      group.map((selection) => selection.name).join(" or "),
    ).click();
    await pickTag(drawer, last);
    await expectInclude(page, requests, [[...group, last], amber]);
    await expect(
      drawer.getByRole("combobox", { name: "Must have", exact: true }),
    ).toBeDisabled();
    await expect(nextTag(drawer, "OR")).toBeDisabled();
    await expect(
      drawer
        .getByRole("button", { name: /^Add OR/ })
        .and(drawer.locator("button:enabled")),
    ).toHaveCount(0);
    await drawer
      .getByRole("button", { name: "Remove tag: Amber", exact: true })
      .click();
    await expectInclude(page, requests, [[...group, last]]);
    await expect(
      drawer.getByRole("combobox", { name: "Must have", exact: true }),
    ).toBeEnabled();
    await expect(nextTag(drawer, "OR")).toBeEnabled();
    await pickTag(drawer, blue);
    await expectInclude(page, requests, [[...group, last], blue]);
  },
);

scenario(
  "exclude and hidden tag pickers keep flat lists without group actions",
  async ({ page, control }) => {
    const requests = await tagBrowse(page, control);
    const drawer = await openFilters(page);
    await pickTag(drawer, amber, "Must not have");
    await pickTag(drawer, blue, "Must not have");
    await expect
      .poll(() => queryList(page.url(), "exclude"))
      .toEqual([amber, blue]);
    await expect
      .poll(() => queryList(requests.at(-1), "exclude"))
      .toEqual([amber, blue]);
    const excluded = drawer.getByRole("list", {
      name: "Selected Must not have",
      exact: true,
    });
    await expect(excluded.getByRole("button", { name: /Add OR/ })).toHaveCount(
      0,
    );
    await expect(
      drawer.getByRole("group", { name: "Add next tag", exact: true }),
    ).toHaveCount(1);
    await drawer
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    const preferences = page.getByRole("dialog", { name: "Your preferences" });
    await pickTag(preferences, coral, "Hidden tags");
    await pickTag(preferences, dune, "Hidden tags");
    await expect(
      preferences.getByRole("group", { name: "Add next tag" }),
    ).toHaveCount(0);
    await expect(
      preferences.getByRole("button", { name: /Add OR/ }),
    ).toHaveCount(0);
    const saved = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/me/preferences" &&
        request.method() === "PATCH",
    );
    await preferences
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    expect((await saved).postDataJSON().hiddenTags).toEqual([coral, dune]);
  },
);
