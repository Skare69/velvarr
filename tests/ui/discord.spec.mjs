import { expect } from "@playwright/test";
import { scenario, expectNoHorizontalOverflow } from "./settings-harness.mjs";

// These URLs are synthetic fixture inputs, not Discord credentials.
const webhook =
  "https://discord.com/api/webhooks/123456789/synthetic-browser-token";
const replacement =
  "https://discordapp.com/api/webhooks/987654321/synthetic-draft-token";
const card = (page) =>
  page.locator('section[aria-labelledby="discord-heading"]');
const urlField = (own) => own.getByLabel("Webhook URL", { exact: true });
const titles = (own) =>
  own.getByRole("switch", { name: "Include titles", exact: true });
const patches = (state) =>
  state.requests.filter((request) => request.method === "PATCH");
const button = (own, name) => own.getByRole("button", { name, exact: true });
const discordOperations = (state) =>
  state.requests.filter(
    (request) =>
      request.path.startsWith("/api/admin/discord") ||
      request.method === "PATCH",
  );

async function open(h, mode = {}) {
  await h.fresh(mode);
  const own = card(h.page);
  let state = "Connected";
  if (mode.environmentDiscord?.configured === false) state = "Not configured";
  if (mode.discordFail || mode.discordHttpFail) state = "Connection failed";
  await expect(h.badge(own)).toHaveText(state);
  return own;
}

async function storeBoth(h, own) {
  await h.edit(own).click();
  await expect(urlField(own)).toHaveValue("");
  await urlField(own).fill(webhook);
  await titles(own).click();
  await h.save(own).click();
  await expect(h.edit(own)).toBeEnabled();
  await expect(h.badge(own)).toHaveText("Connected");
}

scenario(
  "Discord rejects invalid webhook drafts without a PATCH or probe",
  async (h) => {
    const own = await open(h);
    await h.edit(own).click();
    const field = urlField(own);
    await expect(field).toHaveAttribute("type", "url");
    await expect(field).toHaveValue("");
    for (const invalid of [
      "not a URL",
      webhook.replace("https:", "http:"),
      "https://example.test/api/webhooks/123/synthetic-token",
      `${webhook}?wait=true`,
      `${webhook}#fragment`,
    ]) {
      await field.fill(invalid);
      await h.save(own).click();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toBeFocused();
      await expect(own.getByRole("alert")).toHaveText(
        "Enter an HTTPS Discord webhook URL with no query string or fragment.",
      );
      await h.check(own).click();
      await expect(field).toHaveValue(invalid);
    }
    const state = await h.control({});
    expect(patches(state)).toEqual([]);
    expect(
      state.requests.filter((r) => r.path === "/api/admin/discord/test"),
    ).toEqual([]);
    await field.fill(webhook);
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await expect(own.getByRole("alert")).toHaveCount(0);
  },
);

scenario(
  "Discord saves a webhook without displaying the saved secret",
  async (h) => {
    const own = await open(h);
    await h.edit(own).click();
    await expect(urlField(own)).toHaveValue("");
    await urlField(own).fill(webhook);
    await h.save(own).click();
    await expect(h.edit(own)).toBeEnabled();
    await expect(h.badge(own)).toHaveText("Connected");
    await expect(
      own.getByText("Discord settings saved.", { exact: true }),
    ).toBeVisible();
    const state = await h.control({});
    expect(patches(state).map((r) => r.body)).toEqual([
      { discordWebhookUrl: webhook },
    ]);
    expect(state.config.discord).toEqual({
      configured: true,
      source: "stored",
      includeTitles: false,
      includeTitlesSource: "environment",
      stored: true,
    });
    await h.edit(own).click();
    await expect(urlField(own)).toHaveValue("");
    await titles(own).click();
    await h.save(own).click();
    await expect(h.edit(own)).toBeEnabled();
    expect(patches(await h.control({})).map((r) => r.body)).toEqual([
      { discordWebhookUrl: webhook },
      { discordIncludeTitles: true },
    ]);
    await h.edit(own).click();
    await expect(urlField(own)).toHaveValue("");
    await expect(titles(own)).toBeChecked();
  },
);

scenario(
  "Discord saves Include titles without a configured webhook",
  async (h) => {
    const own = await open(h, {
      environmentDiscord: { configured: false, includeTitles: false },
    });
    await expect(urlField(own)).toHaveValue("");
    await expect(titles(own)).not.toBeChecked();
    await titles(own).click();
    await h.save(own).click();
    await expect(
      own.getByText("Discord settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(h.badge(own)).toHaveText("Not configured");
    await expect(titles(own)).toBeChecked();
    await expect(urlField(own)).toHaveValue("");
    const state = await h.control({});
    expect(patches(state).map((r) => r.body)).toEqual([
      { discordIncludeTitles: true },
    ]);
    expect(state.config.discord).toEqual({
      configured: false,
      source: "environment",
      includeTitles: true,
      includeTitlesSource: "stored",
      stored: true,
    });
    await expect(button(own, "Clear stored credential")).toHaveCount(0);
    await expect(button(own, "Use environment settings")).toBeEnabled();
  },
);

scenario(
  "Discord keeps a saved false title override above environment true",
  async (h) => {
    const own = await open(h, {
      environmentDiscord: { configured: true, includeTitles: true },
    });
    await h.edit(own).click();
    await expect(titles(own)).toBeChecked();
    await titles(own).click();
    await h.save(own).click();
    await expect(h.edit(own)).toBeEnabled();
    expect(patches(await h.control({})).map((r) => r.body)).toEqual([
      { discordIncludeTitles: false },
    ]);
    for (const includeTitles of [false, true]) {
      await h.control({
        environmentDiscord: { configured: true, includeTitles },
      });
      await h.page.reload();
      await expect(h.badge(own)).toHaveText("Connected");
      await h.edit(own).click();
      await expect(titles(own)).not.toBeChecked();
      await expect(urlField(own)).toHaveValue("");
      await h.cancel(own).click();
    }
    expect((await h.control({})).config.discord).toEqual({
      configured: true,
      source: "environment",
      includeTitles: false,
      includeTitlesSource: "stored",
      stored: true,
    });
    await button(own, "Use environment settings").click();
    await button(
      h.page.getByRole("dialog", {
        name: "Use Discord environment settings?",
        exact: true,
      }),
      "Use environment settings",
    ).click();
    await expect(h.edit(own)).toBeEnabled();
    await h.edit(own).click();
    await expect(titles(own)).toBeChecked();
    expect((await h.control({})).config.discord).toEqual({
      configured: true,
      source: "environment",
      includeTitles: true,
      includeTitlesSource: "environment",
      stored: false,
    });
  },
);

scenario(
  "Discord draft checks use POST without a save and Cancel restores values",
  async (h) => {
    const own = await open(h);
    const before = await h.control({});
    await h.edit(own).click();
    await urlField(own).fill(webhook);
    await titles(own).click();
    await h.check(own).click();
    await expect(own.getByRole("status")).toHaveText(
      "Draft connection check passed. No settings were saved.",
    );
    await expect(button(own, "Connected")).toBeEnabled();
    await expect(urlField(own)).toHaveValue(webhook);
    await expect(titles(own)).toBeChecked();
    let state = await h.control({});
    expect(
      discordOperations(state)
        .slice(discordOperations(before).length)
        .map(({ method, path, body }) => ({ method, path, body })),
    ).toEqual([
      {
        method: "POST",
        path: "/api/admin/discord/test",
        body: { webhookUrl: webhook },
      },
    ]);
    expect(state.config).toEqual(before.config);
    await urlField(own).fill(replacement);
    await expect(own.getByRole("status")).toHaveCount(0);
    await expect(h.badge(own)).toHaveText("Unsaved changes");
    await h.cancel(own).click();
    await expect(h.edit(own)).toBeFocused();
    await h.edit(own).click();
    await expect(urlField(own)).toHaveValue("");
    await expect(titles(own)).not.toBeChecked();
    await h.check(own).click();
    await expect(button(own, "Connected")).toBeEnabled();
    state = await h.control({});
    expect(
      state.requests
        .filter((r) => r.path === "/api/admin/discord/test")
        .map((r) => r.body),
    ).toEqual([{ webhookUrl: webhook }, {}]);
    expect(patches(state)).toEqual([]);
    expect(state.config).toEqual(before.config);
  },
);

for (const configured of [true, false]) {
  scenario(
    `Discord clear preserves titles with environment webhook ${configured ? "present" : "absent"}`,
    async (h) => {
      const own = await open(h);
      await storeBoth(h, own);
      await h.control({
        environmentDiscord: { configured, includeTitles: false },
      });
      await h.edit(own).click();
      await expect(titles(own)).toBeChecked();
      await urlField(own).fill(replacement);
      const before = await h.control({});
      await button(own, "Clear stored credential").click();
      const dialog = h.page.getByRole("dialog", {
        name: "Clear the stored Discord credential?",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await button(dialog, "Keep credential").click();
      await expect(dialog).not.toBeVisible();
      await expect(urlField(own)).toHaveValue(replacement);
      await expect(titles(own)).toBeChecked();
      expect(patches(await h.control({}))).toEqual(patches(before));
      expect((await h.control({})).config).toEqual(before.config);
      await button(own, "Clear stored credential").click();
      await button(dialog, "Clear credential").click();
      await expect(dialog).not.toBeVisible();
      await expect(h.badge(own)).toHaveText(
        configured ? "Connected" : "Not configured",
      );
      await expect(button(own, "Clear stored credential")).toHaveCount(0);
      expect(patches(await h.control({})).map((r) => r.body)).toEqual([
        { discordWebhookUrl: webhook, discordIncludeTitles: true },
        { discordWebhookUrl: "" },
      ]);
      expect((await h.control({})).config.discord).toEqual({
        configured,
        source: "environment",
        includeTitles: true,
        includeTitlesSource: "stored",
        stored: true,
      });
      if (configured) {
        await expect(
          own.getByText("From environment", { exact: true }),
        ).toBeVisible();
        await h.edit(own).click();
      }
      await expect(urlField(own)).toHaveValue("");
      await expect(titles(own)).toBeChecked();
    },
  );
}

scenario(
  "Discord environment reset needs confirmation and removes both overrides",
  async (h) => {
    const own = await open(h);
    await storeBoth(h, own);
    await h.control({
      environmentDiscord: { configured: false, includeTitles: false },
    });
    const before = await h.control({});
    await button(own, "Use environment settings").click();
    const dialog = h.page.getByRole("dialog", {
      name: "Use Discord environment settings?",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await button(dialog, "Keep stored settings").click();
    await expect(dialog).not.toBeVisible();
    expect((await h.control({})).config).toEqual(before.config);
    expect(patches(await h.control({}))).toEqual(patches(before));
    await button(own, "Use environment settings").click();
    await button(dialog, "Use environment settings").click();
    await expect(dialog).not.toBeVisible();
    await expect(h.badge(own)).toHaveText("Not configured");
    await expect(urlField(own)).toHaveValue("");
    await expect(titles(own)).not.toBeChecked();
    await expect(button(own, "Clear stored credential")).toHaveCount(0);
    await expect(button(own, "Use environment settings")).toHaveCount(0);
    const state = await h.control({});
    expect(patches(state).map((r) => r.body)).toEqual([
      { discordWebhookUrl: webhook, discordIncludeTitles: true },
      { discordWebhookUrl: "", discordIncludeTitles: null },
    ]);
    expect(state.config.discord).toEqual({
      configured: false,
      source: "environment",
      includeTitles: false,
      includeTitlesSource: "environment",
      stored: false,
    });
  },
);

for (const failure of ["discordFail", "discordHttpFail"]) {
  scenario(
    `Discord saved check retries after ${failure} without a write`,
    async (h) => {
      const own = await open(h, { [failure]: true });
      await expect(
        own.getByText("Saved Discord connection failed", { exact: true }),
      ).toBeVisible();
      await expect(h.edit(own)).toBeEnabled();
      const before = await h.control({});
      await h.control({ [failure]: false });
      await h.check(own).click();
      await expect(h.badge(own)).toHaveText("Connected");
      await expect(
        own.getByText("Saved Discord connection failed", { exact: true }),
      ).toHaveCount(0);
      const state = await h.control({});
      expect(
        discordOperations(state)
          .slice(discordOperations(before).length)
          .map(({ method, path }) => ({ method, path })),
      ).toEqual([{ method: "GET", path: "/api/admin/discord" }]);
      expect(state.config).toEqual(before.config);
      expect(patches(state)).toEqual([]);
    },
  );
}

for (const reopen of [false, true]) {
  scenario(
    `Discord ignores a delayed draft verdict after Cancel${reopen ? " and a new edit" : ""}`,
    async (h) => {
      const own = await open(h);
      await h.edit(own).click();
      await urlField(own).fill(webhook);
      await h.control({
        holdProbe: "/api/admin/discord/test",
        discordDraftFail: true,
      });
      await h.check(own).click();
      await expect(h.badge(own)).toHaveText("Checking…");
      await expect
        .poll(
          async () =>
            (await h.control({})).requests.filter(
              (r) => r.path === "/api/admin/discord/test",
            ).length,
        )
        .toBe(1);
      await h.cancel(own).click();
      await expect(h.edit(own)).toBeEnabled();
      if (reopen) {
        await h.edit(own).click();
        await urlField(own).fill(replacement);
        await titles(own).click();
      }
      const response = h.page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/admin/discord/test",
      );
      await h.control({ holdProbe: false });
      await (await response).finished();
      await expect(h.badge(own)).toHaveText(
        reopen ? "Unsaved changes" : "Connected",
      );
      await expect(own.getByRole("status")).toHaveCount(0);
      await expect(
        own.getByText("Draft Discord connection failed", { exact: true }),
      ).toHaveCount(0);
      if (!reopen) await h.edit(own).click();
      await expect(urlField(own)).toHaveValue(reopen ? replacement : "");
      if (reopen) await expect(titles(own)).toBeChecked();
      else await expect(titles(own)).not.toBeChecked();
      await expect(h.check(own)).toBeEnabled();
      expect(patches(await h.control({}))).toEqual([]);
      await h.control({ discordDraftFail: false });
      await h.check(own).click();
      await expect(button(own, "Connected")).toBeEnabled();
    },
  );
}

scenario(
  "Discord phone editor and confirmation controls fit the viewport",
  async (h) => {
    await h.page.setViewportSize({ width: 375, height: 812 });
    const own = await open(h);
    await storeBoth(h, own);
    await h.edit(own).click();
    await urlField(own).fill(replacement);
    for (const control of [
      urlField(own),
      titles(own),
      h.save(own),
      h.cancel(own),
      h.check(own),
      button(own, "Clear stored credential"),
      button(own, "Use environment settings"),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      await expect(control).toBeInViewport();
      await control.focus();
      await expect(control).toBeFocused();
      await expectNoHorizontalOverflow(h.page);
    }
    for (const [action, name, keep, confirm] of [
      [
        "Clear stored credential",
        "Clear the stored Discord credential?",
        "Keep credential",
        "Clear credential",
      ],
      [
        "Use environment settings",
        "Use Discord environment settings?",
        "Keep stored settings",
        "Use environment settings",
      ],
    ]) {
      await button(own, action).click();
      const dialog = h.page.getByRole("dialog", { name, exact: true });
      await expect(dialog).toBeInViewport();
      for (const label of [keep, confirm]) {
        await expect(button(dialog, label)).toBeEnabled();
        await expect(button(dialog, label)).toBeInViewport();
      }
      await expectNoHorizontalOverflow(h.page);
      await button(dialog, keep).click();
      await expect(dialog).not.toBeVisible();
    }
    await expect(urlField(own)).toHaveValue(replacement);
    expect(patches(await h.control({}))).toHaveLength(1);
  },
);
