import { expect } from "@playwright/test";
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
