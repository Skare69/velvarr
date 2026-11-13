import { expect } from "@playwright/test";
import {
  scenario,
  expectNoHorizontalOverflow,
  expectSaveFeedbackNearActions,
} from "./settings-harness.mjs";

const rows = [
  {
    id: "tpdb",
    name: "TPDB",
    field: "tpdbApiToken",
    label: "TPDB API token",
    peer: "stashdb",
  },
  {
    id: "stashdb",
    name: "StashDB",
    field: "stashdbApiKey",
    label: "StashDB API key",
    peer: "tpdb",
  },
];
const card = (page, id) =>
  page.locator(`section[aria-labelledby="provider-heading-${id}"]`);
const aiCard = (page) =>
  page.locator('section[aria-labelledby="judgment-heading"]');
const patches = (state) =>
  state.requests.filter((request) => request.method === "PATCH");
async function showMetadata(page) {
  await page
    .getByRole("button", { name: "Metadata providers", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "TPDB", exact: true }),
  ).toBeVisible();
}
async function openMetadata(h, mode = {}) {
  await h.fresh(mode);
  await showMetadata(h.page);
}

for (const row of rows) {
  scenario(
    `${row.name}: independent save preserves another provider's draft and blank saved keys`,
    async (h) => {
      const { page, edit, save, cancel, check, badge, control } = h;
      await openMetadata(h);
      const own = card(page, row.id),
        peer = card(page, row.peer);
      await edit(own).click();
      await expect(own.getByLabel(row.label, { exact: true })).toBeFocused();
      await expect(save(own)).toBeDisabled();
      await own
        .getByLabel(row.label, { exact: true })
        .fill("synthetic-new-credential");
      await edit(peer).click();
      await peer.locator('input[type="password"]').fill("synthetic-peer-draft");
      await expect(badge(own)).toHaveText("Unsaved changes");
      await expect(check(own)).toBeDisabled();
      await save(own).click();
      await expect(edit(own)).toBeEnabled();
      await expect(badge(own)).toHaveText("Connected");
      await expect(
        own.getByText("Credential saved.", { exact: true }),
      ).toBeVisible();
      await expect(peer.locator('input[type="password"]')).toHaveValue(
        "synthetic-peer-draft",
      );
      expect(patches(await control({})).map((request) => request.body)).toEqual(
        [{ [row.field]: "synthetic-new-credential" }],
      );
      expect(await page.locator("body").innerText()).not.toContain(
        "synthetic-new-credential",
      );
      await cancel(peer).click();
      await expect(edit(peer)).toBeFocused();
      await edit(peer).click();
      await expect(peer.locator('input[type="password"]')).toHaveValue("");
      await expect(save(peer)).toBeDisabled();
    },
  );

  scenario(
    `${row.name}: a blank first-time Save names the missing credential without writing`,
    async (h) => {
      const { page, edit, save, check, badge, control } = h;
      await openMetadata(h);
      const state = await control({});
      state.config.providers[row.id] = {
        configured: false,
        source: "environment",
      };
      await control({ config: state.config });
      await page.reload();
      await showMetadata(page);
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Not configured");
      await expect(check(own)).toBeDisabled();
      await edit(own).click();
      await save(own).click();
      await expect(own.getByRole("status")).toContainText(
        `Enter a ${row.label}.`,
      );
      await expect(own.getByLabel(row.label, { exact: true })).toBeVisible();
      expect(patches(await control({}))).toHaveLength(0);
    },
  );

  scenario(
    `${row.name}: rejected probes and failed saves preserve the session, draft and saved diagnosis`,
    async (h) => {
      const { page, edit, save, cancel, check, badge, control } = h;
      await openMetadata(h);
      const own = card(page, row.id);
      await control({ [row.id + "Fail"]: true });
      await check(own).click();
      await expect(badge(own)).toHaveText("Connection failed");
      await expect(own.getByRole("alert")).toContainText(
        "credential was rejected",
      );
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await edit(own).click();
      await own.getByLabel(row.label, { exact: true }).fill("synthetic-retry");
      await expect(badge(own)).toHaveText("Unsaved changes");
      await expect(own.getByRole("alert")).toHaveCount(0);
      await control({ patchFail: true });
      await save(own).click();
      await expect(own.getByRole("alert")).toContainText(
        `Saving ${row.name} credential failed`,
      );
      await expect(own.getByLabel(row.label, { exact: true })).toHaveValue(
        "synthetic-retry",
      );
      await expectSaveFeedbackNearActions(own);
      await control({ patchFail: false });
      await save(own).click();
      await expect(edit(own)).toBeEnabled();
      await expect(
        own.getByText("Credential saved.", { exact: true }),
      ).toBeVisible();
      await expect(badge(own)).toHaveText("Connection failed");
      await edit(own).click();
      await cancel(own).click();
      await expect(badge(own)).toHaveText("Connection failed");
      await control({ [row.id + "Fail"]: false, [row.id + "HttpFail"]: true });
      await check(own).click();
      await expect(own.getByRole("alert")).toContainText(
        "status endpoint is unavailable",
      );
      await control({ [row.id + "HttpFail"]: false });
      await check(own).click();
      await expect(badge(own)).toHaveText("Connected");
    },
  );

  scenario(
    `${row.name}: credential removal requires confirmation and verifies its environment fallback`,
    async (h) => {
      const { page, edit, check, badge, control } = h;
      await openMetadata(h, { environmentProviders: { [row.id]: true } });
      const own = card(page, row.id);
      const original = (await control({})).config;
      await edit(own).click();
      await own
        .getByLabel(row.label, { exact: true })
        .fill("synthetic-discarded-draft");
      await own
        .getByRole("button", { name: "Clear stored credential", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveAccessibleName(
        `Clear the stored ${row.name} credential?`,
      );
      await dialog
        .getByRole("button", { name: "Keep credential", exact: true })
        .click();
      await expect(own.getByLabel(row.label, { exact: true })).toHaveValue(
        "synthetic-discarded-draft",
      );
      expect(patches(await control({}))).toHaveLength(0);
      await own
        .getByRole("button", { name: "Clear stored credential", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Clear credential", exact: true })
        .click();
      await expect(edit(own)).toBeEnabled();
      await expect(badge(own)).toHaveText("Connected");
      await expect(
        own.getByText("From environment", { exact: true }),
      ).toBeVisible();
      const state = await control({});
      expect(patches(state).map((request) => request.body)).toEqual([
        { [row.field]: "" },
      ]);
      expect(state.config.providers[row.peer]).toEqual(
        original.providers[row.peer],
      );
      await edit(own).click();
      await expect(
        own.getByRole("button", {
          name: "Clear stored credential",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(check(own)).toBeEnabled();
    },
  );
}

scenario(
  "Metadata configuration failure keeps both probes available and Retry restores editing",
  async (h) => {
    const { page, edit, check, badge, control } = h;
    await openMetadata(h, { configFail: true });
    for (const row of rows) {
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Connected");
      await expect(edit(own)).toBeDisabled();
      await expect(check(own)).toBeEnabled();
    }
    await control({ configFail: false });
    await page
      .getByRole("alert")
      .filter({ hasText: "Provider configuration read failed" })
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    for (const row of rows)
      await expect(edit(card(page, row.id))).toBeEnabled();
    const state = await control({});
    for (const row of rows)
      expect(
        state.requests.filter(
          (request) => request.path === `/api/admin/providers/${row.id}`,
        ),
      ).toHaveLength(1);
  },
);

scenario(
  "Metadata probe progress blocks peer controls and announces the final result",
  async (h) => {
    const { page, edit, check, badge, control } = h;
    await openMetadata(h);
    const tpdb = card(page, "tpdb"),
      stash = card(page, "stashdb");
    await control({ holdProbe: true });
    await check(stash).click();
    await expect(badge(stash)).toHaveText("Checking…");
    await expect(check(stash)).toBeDisabled();
    await expect(
      stash.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeVisible();
    await expect(check(tpdb)).toBeDisabled();
    await expect(edit(tpdb)).toBeDisabled();
    await expect(
      stash.locator(".settings-service-status .text-muted"),
    ).toHaveCount(0);
    await control({ holdProbe: false });
    await expect(badge(stash)).toHaveText("Connected");
    await expect(check(tpdb)).toBeEnabled();
  },
);

scenario(
  "No-AI mode preserves credentials and later TypeSafe selection checks saved settings",
  async (h) => {
    const { page, edit, save, badge, control } = h;
    await openMetadata(h);
    const ai = aiCard(page);
    const before = (await control({})).config;
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("none");
    await expect(
      ai.getByLabel("TypeSafe API key", { exact: true }),
    ).toHaveCount(0);
    await expect(ai.getByLabel("Ollama URL", { exact: true })).toHaveCount(0);
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Standard matching (no AI)", { exact: true }),
    ).toBeVisible();
    const disabled = await control({});
    expect(disabled.config.providers).toEqual(before.providers);
    expect(disabled.config.judgment.url).toBe(before.judgment.url);
    expect(disabled.config.judgment.model).toBe(before.judgment.model);
    expect(
      disabled.requests.filter(
        (request) => request.path === "/api/admin/judgment/check",
      ),
    ).toHaveLength(0);
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("typesafe");
    await save(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await expect(edit(ai)).toBeEnabled();
    expect(
      (await control({})).requests.filter(
        (request) => request.path === "/api/admin/judgment/check",
      ),
    ).toHaveLength(1);
  },
);

scenario(
  "TypeSafe replacement and confirmed clearing preserve the selected backend and environment key",
  async (h) => {
    const { page, edit, save, cancel, check, badge, control } = h;
    await openMetadata(h, { environmentProviders: { typesafe: true } });
    const ai = aiCard(page);
    await edit(ai).click();
    await ai
      .getByLabel("TypeSafe API key", { exact: true })
      .fill("synthetic-typesafe-key");
    await save(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await expect(edit(ai)).toBeEnabled();
    expect(patches(await control({}))[0].body).toEqual({
      judgmentProvider: "typesafe",
      typesafeApiKey: "synthetic-typesafe-key",
    });
    expect(await page.locator("body").innerText()).not.toContain(
      "synthetic-typesafe-key",
    );
    await edit(ai).click();
    await expect(
      ai.getByLabel("TypeSafe API key", { exact: true }),
    ).toHaveValue("");
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    expect(patches(await control({})).at(-1).body).toEqual({
      judgmentProvider: "typesafe",
    });
    await edit(ai).click();
    await cancel(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await edit(ai).click();
    await ai
      .getByRole("button", { name: "Clear stored credential", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Keep credential", exact: true })
      .click();
    expect(patches(await control({}))).toHaveLength(2);
    await ai
      .getByRole("button", { name: "Clear stored credential", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Clear credential", exact: true })
      .click();
    await expect(edit(ai)).toBeEnabled();
    const state = await control({});
    expect(patches(state).at(-1).body).toEqual({ typesafeApiKey: "" });
    expect(state.config.judgment.provider).toBe("typesafe");
    expect(state.config.providers.typesafe).toEqual({
      configured: true,
      source: "environment",
    });
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
  },
);

scenario(
  "AI environment reset confirms separately, preserves drafts on Cancel, and keeps credentials",
  async (h) => {
    const { page, edit, check, badge, control } = h;
    await openMetadata(h, {
      environmentJudgment: {
        provider: "ollama",
        url: "http://environment-ollama.test:11434",
        model: "environment-model",
      },
    });
    const ai = aiCard(page);
    const providers = (await control({})).config.providers;
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("ollama");
    await ai
      .getByLabel("Ollama URL", { exact: true })
      .fill("http://draft-ollama.test:11434");
    await ai
      .getByRole("button", { name: "Use environment settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Keep AI settings", exact: true })
      .click();
    await expect(ai.getByLabel("Ollama URL", { exact: true })).toHaveValue(
      "http://draft-ollama.test:11434",
    );
    expect(patches(await control({}))).toHaveLength(0);
    await ai
      .getByRole("button", { name: "Use environment settings", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Use environment settings", exact: true })
      .click();
    await expect(edit(ai)).toBeEnabled();
    const state = await control({});
    expect(patches(state).map((request) => request.body)).toEqual([
      { judgmentProvider: "", ollamaUrl: "", ollamaModel: "" },
    ]);
    expect(state.config.providers).toEqual(providers);
    expect(state.config.judgment.stored).toBe(false);
    await expect(
      ai.getByText("http://environment-ollama.test:11434 · environment-model", {
        exact: true,
      }),
    ).toBeVisible();
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await edit(ai).click();
    await expect(
      ai.getByRole("button", { name: "Use environment settings", exact: true }),
    ).toHaveCount(0);
  },
);

scenario(
  "Ollama validation and failed saves retain drafts while Cancel restores the saved backend",
  async (h) => {
    const { page, edit, save, cancel, check, badge, control } = h;
    await openMetadata(h);
    const ai = aiCard(page);
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("ollama");
    await ai.getByLabel("Ollama URL", { exact: true }).fill("");
    await expect(save(ai)).toBeDisabled();
    await ai
      .getByLabel("Ollama URL", { exact: true })
      .fill("http://saved-ollama.test:11434");
    await ai.getByLabel("Decision model", { exact: true }).fill("saved-model");
    await control({ patchFail: true });
    await save(ai).click();
    await expect(ai.getByRole("alert")).toContainText(
      "Saving AI settings failed",
    );
    await expect(ai.getByLabel("Decision model", { exact: true })).toHaveValue(
      "saved-model",
    );
    await expectSaveFeedbackNearActions(ai);
    await ai
      .getByLabel("Decision model", { exact: true })
      .fill("corrected-model");
    await expect(ai.locator("form").getByRole("alert")).toHaveCount(0);
    await save(ai).click();
    await expectSaveFeedbackNearActions(ai);
    await ai
      .getByLabel("Ollama URL", { exact: true })
      .fill("http://corrected-ollama.test:11434");
    await expect(ai.locator("form").getByRole("alert")).toHaveCount(0);
    await cancel(ai).click();
    await expect(edit(ai)).toBeFocused();
    await expect(badge(ai)).toHaveText("Connected");
    await control({ patchFail: false });
    await edit(ai).click();
    await expect(ai.getByLabel("Provider", { exact: true })).toHaveValue(
      "typesafe",
    );
    await cancel(ai).click();
  },
);

scenario(
  "Metadata editors retain labels, sibling forms, focus return and mobile layout",
  async (h) => {
    const { page, edit, cancel } = h;
    await openMetadata(h);
    for (const row of rows) await edit(card(page, row.id)).click();
    const ai = aiCard(page);
    await edit(ai).click();
    await expect(ai.getByLabel("Provider", { exact: true })).toBeFocused();
    expect(await page.locator("form form").count()).toBe(0);
    expect(await page.locator("button:not([type])").count()).toBe(0);
    expect(
      await page.getByRole("heading", { level: 2 }).allTextContents(),
    ).toEqual(["TPDB", "StashDB", "AI-assisted matching"]);
    const ids = await page
      .locator("[id]")
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await cancel(ai).click();
    await expect(edit(ai)).toBeFocused();
    for (const row of rows) {
      const own = card(page, row.id);
      await cancel(own).click();
      await expect(edit(own)).toBeFocused();
    }
  },
);

scenario(
  "Metadata and AI permission failures retain the session and disable restricted actions",
  async (h) => {
    const { page, check, badge, control } = h;
    await openMetadata(h);
    const stash = card(page, "stashdb"),
      ai = aiCard(page);
    await control({ stashdb403: true });
    await check(stash).click();
    await expect(
      stash.getByText(
        "An administrator account is required to edit and verify credentials.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(check(stash)).toBeDisabled();
    await control({ judgment403: true });
    await check(ai).click();
    await expect(
      ai.getByText(
        "An administrator account is required to configure the model.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(check(ai)).toBeDisabled();
    await expect(badge(ai)).toHaveText("Connection failed");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
  },
);

scenario(
  "Connection and metadata cards align their Connected indicators and header actions",
  async (h) => {
    const { page, jf, w, fresh, edit, check, badge } = h;
    await fresh();
    const metrics = async (own) =>
      own.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const indicator = node.querySelector(
          ".settings-service-status .connection-state",
        );
        const actions = node.querySelector(
          ".settings-service-summary .settings-service-buttons",
        );
        return {
          indicatorLeft: indicator.getBoundingClientRect().left - bounds.left,
          actionsRight: bounds.right - actions.getBoundingClientRect().right,
          indicatorDot: getComputedStyle(indicator, "::before").width,
          announcement: indicator.parentElement.getAttribute("aria-live"),
          label: indicator.textContent,
        };
      });
    const baseline = await metrics(jf);
    expect(await metrics(w)).toEqual(baseline);
    await showMetadata(page);
    const ai = aiCard(page);
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await expect(edit(ai)).toBeEnabled();
    for (const own of [card(page, "tpdb"), card(page, "stashdb"), ai])
      expect(await metrics(own)).toEqual(baseline);
  },
);

scenario(
  "Metadata saves share the queue with Connections and tab switches preserve both editors",
  async (h) => {
    const { page, jf, w, provider, fresh, control, edit, save, cancel, check } =
      h;
    await fresh();
    const configReads = (state) =>
      state.requests.filter(
        (request) =>
          request.method === "GET" &&
          request.path === "/api/admin/integrations",
      ).length;
    const initialReads = configReads(await control({}));
    await edit(jf).click();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://draft.example.test");
    await showMetadata(page);
    await edit(provider).click();
    await provider.getByLabel("TPDB API token").fill("synthetic-metadata-save");
    const ai = aiCard(page);
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("ollama");
    await ai
      .getByLabel("Ollama URL")
      .fill("http://draft-ollama.example.test:11434");
    await ai.getByLabel("Decision model").fill("draft-model");

    await control({ holdPatch: true });
    await save(provider).click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(save(jf)).toBeDisabled();
    await expect(check(w)).toBeDisabled();
    await expect(edit(w)).toBeDisabled();
    await expect(jf.getByLabel("Jellyfin external URL")).toHaveValue(
      "https://draft.example.test",
    );
    await control({ holdPatch: false });
    await expect(save(jf)).toBeEnabled();
    await showMetadata(page);
    await expect(edit(provider)).toBeEnabled();
    await expect(
      provider.getByText("Credential saved.", { exact: true }),
    ).toBeVisible();
    await expect(ai.getByLabel("Provider", { exact: true })).toHaveValue(
      "ollama",
    );
    await expect(ai.getByLabel("Ollama URL")).toHaveValue(
      "http://draft-ollama.example.test:11434",
    );
    await expect(ai.getByLabel("Decision model")).toHaveValue("draft-model");
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(jf.getByLabel("Jellyfin external URL")).toHaveValue(
      "https://draft.example.test",
    );
    await cancel(jf).click();
    await expect(edit(jf)).toBeFocused();
    await showMetadata(page);
    await cancel(ai).click();
    await expect(edit(ai)).toBeFocused();
    const state = await control({});
    expect(configReads(state)).toBe(initialReads);
    expect(patches(state).map((request) => request.body)).toEqual([
      { tpdbApiToken: "synthetic-metadata-save" },
    ]);
  },
);

scenario(
  "Correcting a TypeSafe draft clears its save error beside the actions",
  async (h) => {
    const { page, edit, save, control } = h;
    await openMetadata(h);
    const ai = aiCard(page);
    await edit(ai).click();
    await ai
      .getByLabel("TypeSafe API key", { exact: true })
      .fill("synthetic-first-key");
    await control({ patchFail: true });
    await save(ai).click();
    await expectSaveFeedbackNearActions(ai);
    await ai
      .getByLabel("TypeSafe API key", { exact: true })
      .fill("synthetic-corrected-key");
    await expect(ai.locator("form").getByRole("alert")).toHaveCount(0);
    await control({ patchFail: false });
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
  },
);

scenario(
  "A failed AI save never reuses an earlier successful save notice",
  async (h) => {
    const { page, edit, save, control } = h;
    await openMetadata(h);
    const ai = aiCard(page);
    await edit(ai).click();
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await edit(ai).click();
    await expect(ai.getByText("Settings saved.", { exact: true })).toHaveCount(
      0,
    );
    await control({ patchFail: true });
    await save(ai).click();
    await expectSaveFeedbackNearActions(ai);
    await expect(ai.getByText("Settings saved.", { exact: true })).toHaveCount(
      0,
    );
    await control({ patchFail: false });
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
  },
);
