import { expect, test } from "@playwright/test";
import fc from "fast-check";
import { scenario } from "./settings-harness.mjs";

const studiosUrl = "/?view=facets&kind=studios";
const filteredBrowse = "/?view=titles&type=movie";
// Browse may normalize its page size when collapsing the sidebar changes the grid width.
const browseWithMovieFilter = /\/\?view=titles&type=movie(?:&perPage=\d+)?$/;

async function memberPage(page) {
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.account.role = "requester";
    session.account.isOwner = false;
    await route.fulfill({ json: session });
  });
  await page.route("**/api/me/preferences", (route) =>
    route.fulfill({ json: { hiddenTags: [], discoverOrder: [] } }),
  );
  await page.route("**/api/browse?*", (route) =>
    route.fulfill({
      json: {
        items: [],
        page: 1,
        hasMore: false,
        total: 0,
        totalCountKnown: true,
        errors: [],
      },
    }),
  );
  await page.route("**/api/discovery/facets?*", (route) =>
    route.fulfill({
      json: {
        tiles: [],
        errors: [],
        kind: new URL(route.request().url()).searchParams.get("kind"),
      },
    }),
  );
}

scenario(
  "Studios links to its directory and Back restores filtered Browse",
  async ({ page }) => {
    await memberPage(page);
    await page.goto(filteredBrowse);
    const nav = page.getByRole("navigation", { name: "Main", exact: true });
    const studios = nav.getByRole("link", { name: "Studios" });
    await expect(studios).toHaveAttribute("href", studiosUrl);
    await studios.press("Enter");
    await expect(page).toHaveURL(studiosUrl);
    await expect(
      page.getByRole("heading", { name: "Studios", exact: true }),
    ).toBeVisible();
    await expect(studios).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(page).toHaveURL(browseWithMovieFilter);
    await page.goto("/?view=facets&kind=genres");
    await expect(page.getByRole("heading", { name: "Genres" })).toBeVisible();
    await expect(studios).not.toHaveAttribute("aria-current", "page");
  },
);

scenario("Navigation clears arbitrary query keys as data", async ({ page }) => {
  test.setTimeout(180_000);
  await memberPage(page);
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.tuple(
          fc.oneof(
            fc.constantFrom(
              "__proto__",
              "constructor",
              "prototype",
              "toString",
            ),
            fc.string().map((key) => `extra-${key}`),
          ),
          fc.string(),
        ),
        { maxLength: 12 },
      ),
      async (entries) => {
        const params = new URLSearchParams([
          ["view", "facets"],
          ["kind", "studios"],
          ...entries,
        ]);
        await page.goto(`/?${params}`);
        await page
          .getByRole("navigation", { name: "Main", exact: true })
          .getByRole("link", { name: "Studios", exact: true })
          .press("Enter");
        await expect(page).toHaveURL(studiosUrl);
      },
    ),
    { seed: 42, numRuns: 200, examples: [[[["__proto__", ""]]]] },
  );
});

for (const submit of [false, true]) {
  scenario(
    `${submit ? "Submitted" : "Live"} search clears prototype-named query keys`,
    async ({ page }) => {
      await memberPage(page);
      await page.route("**/api/search?*", (route) =>
        route.fulfill({ json: { query: "example", categories: [] } }),
      );
      await page.goto(
        `${filteredBrowse}&__proto__=old&__proto__=again&constructor=old&prototype=old`,
      );
      const search = page.getByRole("searchbox", {
        name: "Search all sources",
      });
      await search.fill("example");
      if (submit) await search.press("Enter");
      await expect(page).toHaveURL("/?view=search&q=example");
      await expect(
        page.getByRole("heading", { name: "Results for “example”" }),
      ).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(
        /\/\?view=titles&type=movie&__proto__=old&__proto__=again&constructor=old&prototype=old(?:&perPage=\d+)?$/,
      );
    },
  );
}

// Preferences is a personal utility, so it lives only in the account menu
// (Seerr's user dropdown), not among the sidebar or More destinations.
for (const mobile of [false, true]) {
  scenario(
    `${mobile ? "Phone" : "Desktop"} opens Preferences from the account menu in place and restores focus`,
    async ({ page }) => {
      await memberPage(page);
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(filteredBrowse);
      const more = page.getByRole("button", { name: "More", exact: true });
      if (mobile) await more.click();
      const nav = page.getByRole("navigation", {
        name: mobile ? "Mobile navigation" : "Main",
        exact: true,
      });
      await expect(nav.getByRole("link", { name: "Studios" })).toBeVisible();
      await expect(
        nav.getByRole("button", { name: "Preferences", exact: true }),
      ).toHaveCount(0);
      if (mobile) {
        await nav.getByRole("link", { name: "Studios" }).click();
        await expect(page).toHaveURL(studiosUrl);
        await expect(nav).not.toBeVisible();
        await page.goBack();
      }
      const account = page.getByLabel("Account menu", { exact: true });
      await account.click();
      await page
        .locator(".account-menu")
        .getByRole("button", { name: "Preferences" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Your preferences" });
      await expect(
        dialog.getByRole("heading", { name: "Discover shelf order" }),
      ).toBeVisible();
      await expect(page).toHaveURL(browseWithMovieFilter);
      await dialog.getByRole("button", { name: "Close preferences" }).click();
      await expect(dialog).not.toBeVisible();
      await expect(account).toBeFocused();
    },
  );
}
