import { expect } from "@playwright/test";
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

for (const mobile of [false, true]) {
  scenario(
    `${mobile ? "More" : "Collapsed sidebar"} opens Preferences in place and restores focus`,
    async ({ page }) => {
      await memberPage(page);
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(filteredBrowse);
      const more = page.getByRole("button", { name: "More", exact: true });
      if (mobile) await more.press("Enter");
      else await page.getByRole("button", { name: "Collapse sidebar" }).click();
      const nav = page.getByRole("navigation", {
        name: mobile ? "Mobile navigation" : "Main",
        exact: true,
      });
      const preferences = nav.getByRole("button", {
        name: "Preferences",
        exact: true,
      });
      await preferences.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Your preferences" });
      await expect(
        dialog.getByRole("heading", { name: "Discover shelf order" }),
      ).toBeVisible();
      await expect(page).toHaveURL(browseWithMovieFilter);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(mobile ? more : preferences).toBeFocused();
      if (mobile) {
        await more.click();
        await nav.getByRole("link", { name: "Studios" }).click();
        await expect(page).toHaveURL(studiosUrl);
        await expect(nav).not.toBeVisible();
      }
      const account = page.getByLabel("Account menu", { exact: true });
      await account.click();
      await page
        .locator(".account-menu")
        .getByRole("button", { name: "Preferences" })
        .click();
      await dialog.getByRole("button", { name: "Close preferences" }).click();
      await expect(account).toBeFocused();
    },
  );
}
