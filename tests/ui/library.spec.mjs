import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { scenario } from "./settings-harness.mjs";

// A page whose items all repeat the first page (the library changed between
// two reads) must end automatic pagination exactly once per stall, with a
// visible way to continue — the Library twin of the browse grid's guard.
const firstPage = Array.from({ length: 12 }, (_, i) => ({
  id: `stall-a-${i + 1}`,
  name: `Stall A ${i + 1}`,
  kind: "movie",
  canPlay: true,
}));

scenario(
  "Library grid stops paging when a page adds no new items",
  async ({ page, control }) => {
    await control({
      reset: true,
      // total 40 > 12 shown, so the grid believes more pages exist.
      library: { total: 40, page0: firstPage, pageN: firstPage },
    });
    await page.goto("/?view=library");
    await expect(
      page.getByRole("button", { name: /Stall A 1\b/ }),
    ).toBeVisible();

    const libraryRequests = async () => {
      const data = await page.request
        .get("/__settings_test")
        .then((r) => r.json());
      return data.requests.filter((r) => r.path === "/api/library");
    };
    const stalledOffsets = async () =>
      (await libraryRequests()).filter((r) => r.query.start !== "0").length;
    const topLoads = async () =>
      (await libraryRequests()).filter((r) => r.query.start === "0").length;

    // The sentinel fires once, the repeated page stalls the grid, and the
    // stalled offset is requested at most once.
    await expect
      .poll(stalledOffsets, { message: "stalled offset requests" })
      .toBe(1);
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Stall A 1\b/ }),
    ).toBeVisible();
    await page.waitForTimeout(1000);
    assert.equal(
      await stalledOffsets(),
      1,
      "a settled stall must not re-request its offset",
    );

    // Retry restarts the grid from the top instead of the moved window.
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(topLoads, { message: "loads from the top" })
      .toBeGreaterThan(1);
    await expect(
      page.getByRole("button", { name: /Stall A 1\b/ }),
    ).toBeVisible();
  },
);
