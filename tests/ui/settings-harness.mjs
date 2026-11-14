import { test, expect } from "@playwright/test";

// Shared helpers for both Connections and Metadata providers browser tests.
// One isolated fixture server is shared serially. Every test gets a new
// browser context, resets synthetic data, and fails on page errors.
function harness(page) {
  const jf = page.locator('section[aria-labelledby="jellyfin-heading"]');
  const w = page.locator('section[aria-labelledby="whisparr-heading"]');
  const provider = page.locator(
    'section[aria-labelledby="provider-heading-tpdb"]',
  );
  const control = async (data) => {
    const response = await page.request.post("/__settings_test", { data });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const fresh = async (mode = {}) => {
    await control({ reset: true, ...mode });
    await page.goto("/?view=settings");
    await expect(jf.locator(".connection-state")).toHaveText(
      mode.jellyfinFail ? "Connection failed" : "Connected",
    );
    await expect(w.locator(".connection-state")).toHaveText(
      mode.whisparrFail ? "Connection failed" : "Connected",
    );
    await expect(provider.locator(".connection-state")).toHaveText(
      mode.tpdbFail ? "Connection failed" : "Connected",
    );
    await expect(
      page.locator(
        'section[aria-labelledby="provider-heading-stashdb"] .connection-state',
      ),
    ).toHaveText(mode.stashdbFail ? "Connection failed" : "Connected");
  };
  return {
    page,
    jf,
    w,
    provider,
    control,
    fresh,
    edit: (card) => card.getByRole("button", { name: "Edit", exact: true }),
    save: (card) => card.getByRole("button", { name: /^(Save|Saving…)$/ }),
    cancel: (card) => card.getByRole("button", { name: "Cancel", exact: true }),
    check: (card) =>
      card.getByRole("button", { name: /^(Check connection|Checking…)$/ }),
    badge: (card) => card.locator(".connection-state"),
  };
}
export async function expectNoHorizontalOverflow(page) {
  // Resizing the viewport and applying its media queries can finish on
  // different browser frames. Wait for the layout condition, not a fixed delay.
  await expect
    .poll(
      () =>
        page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      {
        message: "The settled settings layout must fit the viewport",
      },
    )
    .toBeLessThanOrEqual(0);
}

export function scenario(name, run) {
  test(name, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await run(harness(page));
    expect(errors).toEqual([]);
  });
}

export async function expectSaveFeedbackNearActions(card) {
  const alert = card.locator("form").getByRole("alert");
  await expect(alert).toBeVisible();
  const save = await card
    .getByRole("button", { name: /^(Save|Saving…)$/ })
    .boundingBox();
  const feedback = await alert.boundingBox();
  expect(feedback.y - (save.y + save.height)).toBeGreaterThanOrEqual(0);
  expect(feedback.y - (save.y + save.height)).toBeLessThanOrEqual(20);
  const destructive = card.locator(".settings-destructive-row");
  if (await destructive.count()) {
    const bounds = await destructive.boundingBox();
    expect(feedback.y + feedback.height).toBeLessThan(bounds.y);
  }
}

export async function selectAi(card, value) {
  const labels = {
    none: "Standard matching",
    typesafe: "TypeSafe",
    ollama: "Ollama",
  };
  await card
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: labels[value], exact: true })
    .click();
}
export function aiOption(card, value) {
  const labels = {
    none: "Standard matching",
    typesafe: "TypeSafe",
    ollama: "Ollama",
  };
  return card
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: labels[value], exact: true });
}
