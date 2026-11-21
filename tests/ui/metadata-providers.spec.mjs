import { expect } from "@playwright/test";
import {
  selectAi,
  aiOption,
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
// Contract move: AI-assisted matching and Natural-language search left
// Metadata providers for their own AI tab (operator request, 2026-11-19).
async function showAi(page) {
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Smarter library matching",
      exact: true,
    }),
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
      await expect(own.getByLabel(new RegExp("^" + row.label))).toBeFocused();
      await expect(save(own)).toBeDisabled();
      await own
        .getByLabel(new RegExp("^" + row.label))
        .fill("synthetic-new-credential");
      await edit(peer).click();
      await peer.locator('input[type="password"]').fill("synthetic-peer-draft");
      await expect(badge(own)).toHaveText("Unsaved changes");
      await expect(check(own)).toBeEnabled();
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
      await expect(check(own)).toBeEnabled();
      await expect(edit(own)).toHaveCount(0);
      await save(own).click();
      await expect(
        own.getByText(`Enter a ${row.label}.`, { exact: true }),
      ).toBeVisible();
      await expect(own.locator("form")).toContainText(`Enter a ${row.label}.`);
      await expect(own.getByLabel(new RegExp("^" + row.label))).toBeVisible();
      expect(patches(await control({}))).toHaveLength(0);
    },
  );

  scenario(
    `${row.name}: rejected probes and failed saves preserve the session, draft and saved diagnosis`,
    async (h) => {
      const { page, edit, save, cancel, check, badge, control } = h;
      await openMetadata(h, { [row.id + "Fail"]: true });
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Connection failed");
      await expect(own.getByRole("alert")).toContainText(
        "credential was rejected",
      );
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible();
      await edit(own).click();
      await own.getByLabel(new RegExp("^" + row.label)).fill("synthetic-retry");
      await expect(badge(own)).toHaveText("Unsaved changes");
      await expect(own.getByRole("alert")).toHaveCount(0);
      await control({ patchFail: true });
      await save(own).click();
      await expect(own.getByRole("alert")).toContainText(
        `Saving ${row.name} credential failed`,
      );
      await expect(own.getByLabel(new RegExp("^" + row.label))).toHaveValue(
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
        .getByLabel(new RegExp("^" + row.label))
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
      await expect(own.getByLabel(new RegExp("^" + row.label))).toHaveValue(
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
  "Metadata probe progress announces the result and leaves peers editable",
  async (h) => {
    const { page, edit, check, badge, control } = h;
    await openMetadata(h, { stashdbFail: true, tpdbFail: true });
    const tpdb = card(page, "tpdb"),
      stash = card(page, "stashdb");
    await control({ holdProbe: true });
    await check(stash).click();
    await expect(badge(stash)).toHaveText("Checking…");
    await expect(check(stash)).toBeDisabled();
    await expect(
      stash.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeVisible();
    // A probe holds only its own card (VELV-181): the peer stays editable
    // and re-checkable while this check waits.
    await expect(check(tpdb)).toBeEnabled();
    await expect(edit(tpdb)).toBeEnabled();
    await expect(
      stash.locator(".settings-service-status .text-muted"),
    ).toHaveCount(0);
    await control({ holdProbe: false, stashdbFail: false });
    await expect(badge(stash)).toHaveText("Connected");
    await expect(check(tpdb)).toBeEnabled();
  },
);

scenario(
  "Smarter library matching explains its effects and privacy with Exact names only",
  async (h) => {
    const { page, edit } = h;
    await h.fresh();
    await showAi(page);
    const ai = aiCard(page);
    await expect(ai.locator("form")).toHaveCount(0);
    for (const exactNamesOnly of [false, true]) {
      if (exactNamesOnly) {
        await edit(ai).click();
        await selectAi(ai, "none");
        await expect(
          ai.getByText(
            "Only exact names match, without calls to an AI service.",
          ),
        ).toBeVisible();
      }
      for (const explanation of [
        /possible matches between requested titles and differently named titles in your Jellyfin library for administrator review/,
        /sorts similar titles on detail pages/,
        /suggests up to three real tags for search terms/,
        /AI never marks a title as available/,
        /Titles with different years never match/,
        /Titles and catalog details go to the selected AI service for matching and similar-title sorting/,
        /Tag suggestions also send member search terms after you save the TypeSafe key or Ollama choice in Settings/,
        /Hosted TypeSafe is a third party/,
        /A local Ollama server keeps this data on your network/,
        /Natural-language search has its own card/,
        /Exact names only does not turn it off/,
      ]) {
        await expect(ai.getByText(explanation)).toBeVisible();
      }
      await expect(
        page.getByRole("heading", {
          name: "Natural-language search",
          exact: true,
        }),
      ).toBeVisible();
    }
  },
);

scenario(
  "No-AI mode preserves credentials and later TypeSafe selection checks saved settings",
  async (h) => {
    const { page, edit, save, badge, control } = h;
    await openMetadata(h);
    await showAi(page);
    const ai = aiCard(page);
    const before = (await control({})).config;
    await edit(ai).click();
    await selectAi(ai, "none");
    await expect(ai.getByLabel(/^TypeSafe API key/)).toHaveCount(0);
    await expect(ai.getByLabel("Ollama URL", { exact: true })).toHaveCount(0);
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Exact names only", { exact: true }),
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
    await selectAi(ai, "typesafe");
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
    await showAi(page);
    const ai = aiCard(page);
    await edit(ai).click();
    await ai.getByLabel(/^TypeSafe API key/).fill("synthetic-typesafe-key");
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
    await expect(ai.getByLabel(/^TypeSafe API key/)).toHaveValue("");
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
    // Contract move: Check lives in the open editor.
    await edit(ai).click();
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
    await showAi(page);
    const ai = aiCard(page);
    const providers = (await control({})).config.providers;
    await edit(ai).click();
    await selectAi(ai, "ollama");
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
    // Contract move: Check lives in the open editor.
    await edit(ai).click();
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
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
    await showAi(page);
    const ai = aiCard(page);
    // Contract move: Check lives in the open editor (a closed card offers
    // it only as the retry after a failed check).
    await edit(ai).click();
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await selectAi(ai, "ollama");
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
    await expect(aiOption(ai, "typesafe")).toHaveAttribute(
      "aria-pressed",
      "true",
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
    // Contract move: the AI cards sit on their own tab; each tab shows only
    // its own headings.
    expect(
      await page.getByRole("heading", { level: 2 }).allTextContents(),
    ).toEqual(["TPDB", "StashDB"]);
    await showAi(page);
    const prose = proseCard(page);
    await edit(prose).click();
    const ai = aiCard(page);
    await edit(ai).click();
    await expect(aiOption(ai, "typesafe")).toBeFocused();
    expect(await page.locator("form form").count()).toBe(0);
    expect(await page.locator("button:not([type])").count()).toBe(0);
    expect(
      await page.getByRole("heading", { level: 2 }).allTextContents(),
    ).toEqual(["Smarter library matching", "Natural-language search"]);
    const ids = await page
      .locator("[id]")
      .evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await cancel(prose).click();
    await expect(edit(prose)).toBeFocused();
    await cancel(ai).click();
    await expect(edit(ai)).toBeFocused();
    await showMetadata(page);
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
    const { page, edit, check, badge, control } = h;
    await openMetadata(h);
    const stash = card(page, "stashdb"),
      ai = aiCard(page);
    await edit(stash).click();
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
    // Contract move: the AI card is on the AI tab, and its Check lives in
    // the open editor (the closed card offers it only as a retry).
    await showAi(page);
    await edit(ai).click();
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
  "Connection and metadata cards align title indicators and bottom actions",
  async (h) => {
    const { page, jf, w, fresh, edit, check, badge } = h;
    await fresh();
    const metrics = async (own) =>
      own.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const indicator = node.querySelector(
          ".settings-service-status .connection-state",
        );
        // Contract move: a closed card's actions sit at the top right of
        // its heading (.settings-service-action), not in a foot row.
        const actions = node.querySelector(".settings-service-action");
        return {
          titleRow:
            indicator.parentElement.parentElement.classList.contains(
              "settings-title-row",
            ),
          indicatorGap: Math.round(
            indicator.getBoundingClientRect().left -
              node.querySelector("h2").getBoundingClientRect().right,
          ),
          actionsRight: bounds.right - actions.getBoundingClientRect().right,
          indicatorDot: getComputedStyle(indicator, "::before").width,
          announcement: indicator.parentElement.getAttribute("aria-live"),
          label: indicator.textContent,
        };
      });
    const baseline = await metrics(jf);
    expect(await metrics(w)).toEqual(baseline);
    await showAi(page);
    const ai = aiCard(page);
    // Its check now runs from the open editor; Cancel keeps the result.
    await edit(ai).click();
    await check(ai).click();
    await expect(badge(ai)).toHaveText("Connected");
    await h.cancel(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(badge(ai)).toHaveText("Connected");
    for (const own of [ai]) expect(await metrics(own)).toEqual(baseline);
    await showMetadata(page);
    for (const own of [card(page, "tpdb"), card(page, "stashdb")])
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
    // Contract move: the AI card is on its own tab; drafts on hidden tabs
    // stay mounted.
    await showAi(page);
    const ai = aiCard(page);
    await edit(ai).click();
    await selectAi(ai, "ollama");
    await ai
      .getByLabel("Ollama URL")
      .fill("http://draft-ollama.example.test:11434");
    await ai.getByLabel("Decision model").fill("draft-model");

    await control({ holdPatch: true });
    await showMetadata(page);
    await save(provider).click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(save(jf)).toBeDisabled();
    await expect(check(w)).toHaveCount(0);
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
    await showAi(page);
    await expect(aiOption(ai, "ollama")).toHaveAttribute(
      "aria-pressed",
      "true",
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
    await showAi(page);
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
    await showAi(page);
    const ai = aiCard(page);
    await edit(ai).click();
    await ai.getByLabel(/^TypeSafe API key/).fill("synthetic-first-key");
    await control({ patchFail: true });
    await save(ai).click();
    await expectSaveFeedbackNearActions(ai);
    await ai.getByLabel(/^TypeSafe API key/).fill("synthetic-corrected-key");
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
    await showAi(page);
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

for (const row of rows) {
  scenario(
    `${row.name}: draft rejection never clears the saved key or changes its diagnosis`,
    async (h) => {
      const { page, edit, cancel, check, badge, control } = h;
      await openMetadata(h);
      const own = card(page, row.id);
      const before = (await control({})).config;
      await expect(check(own)).toHaveCount(0);
      await edit(own).click();
      await own.locator('input[type="password"]').fill("synthetic-draft");
      await control({ [row.id + "DraftFail"]: true });
      await check(own).click();
      await expect(own.getByRole("alert")).toContainText(
        "draft credential was rejected",
      );
      await expect(badge(own)).toHaveText("Unsaved changes");
      expect((await control({})).config).toEqual(before);
      await own.locator('input[type="password"]').fill("synthetic-corrected");
      await expect(own.getByRole("alert")).toHaveCount(0);
      await control({ [row.id + "DraftFail"]: false });
      await check(own).click();
      await expect(
        own.getByText("Connection works: Review account", { exact: true }),
      ).toBeVisible();
      const state = await control({});
      expect(state.requests.filter((r) => r.method === "PATCH")).toHaveLength(
        0,
      );
      const probes = state.requests.filter(
        (r) => r.path === `/api/admin/providers/${row.id}/test`,
      );
      expect(probes).toHaveLength(2);
      expect(probes[1].body).toEqual({ key: "synthetic-corrected" });
      await cancel(own).click();
      await expect(badge(own)).toHaveText("Connected");
      await expect(
        own.getByText("Connection works: Review account", { exact: true }),
      ).toHaveCount(0);
    },
  );
  scenario(
    `${row.name}: proven saved-key rejection clears the stored override once`,
    async (h) => {
      const { page, badge, control } = h;
      await openMetadata(h);
      await control({ [row.id + "Reject"]: true });
      await page.reload();
      await showMetadata(page);
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Not configured");
      await expect(own.locator('input[type="password"]')).toBeVisible();
      await expect(own.getByText(/so Velvarr deleted it/)).toBeVisible();
      const state = await control({});
      expect(patches(state).map((r) => r.body)).toEqual([
        {
          [row.field]: "",
          [row.field + "Expect"]: "synthetic-" + row.id + "-stored-key",
        },
      ]);
      expect(state.config.providers[row.id]).toEqual({
        configured: false,
        source: "environment",
      });
      expect(state.config.providers[row.peer]).toEqual({
        configured: true,
        source: "stored",
      });
    },
  );
  scenario(
    `${row.name}: rejecting an environment key never writes or deletes credentials`,
    async (h) => {
      const { page, badge, control } = h;
      await openMetadata(h);
      const state = await control({});
      state.config.providers[row.id].source = "environment";
      await control({ config: state.config, [row.id + "Reject"]: true });
      await page.reload();
      await showMetadata(page);
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Connection failed");
      await expect(own.getByRole("alert")).toContainText(
        "stored credential was rejected",
      );
      await expect(own.locator('input[type="password"]')).toBeVisible();
      expect(patches(await control({}))).toHaveLength(0);
    },
  );
}

for (const row of rows) {
  scenario(
    `${row.name}: a rejected stale key cannot delete its replacement or replay on a peer save`,
    async (h) => {
      const { page, control, edit, save } = h;
      await openMetadata(h);
      await control({
        [row.id + "Reject"]: true,
        [row.id + "KeyMismatch"]: true,
      });
      await page.reload();
      await showMetadata(page);
      const own = card(page, row.id);
      await expect(
        own.getByText(
          "The stored key changed since its check failed; it was not deleted.",
          { exact: true },
        ),
      ).toBeVisible();
      let state = await control({});
      expect(patches(state).map((r) => r.body)).toEqual([
        {
          [row.field]: "",
          [row.field + "Expect"]: "synthetic-" + row.id + "-stored-key",
        },
      ]);
      expect(state.config.providers[row.id]).toEqual({
        configured: true,
        source: "stored",
      });
      const peer = card(page, row.peer);
      await edit(peer).click();
      await peer
        .locator('input[type="password"]')
        .fill("synthetic-peer-replacement");
      await save(peer).click();
      await expect(edit(peer)).toBeEnabled();
      state = await control({});
      expect(patches(state)).toHaveLength(2);
      expect(patches(state).filter((r) => row.field in r.body)).toHaveLength(1);
      expect(state.config.providers[row.id]).toEqual({
        configured: true,
        source: "stored",
      });
    },
  );
  scenario(
    `${row.name}: a rejection without a stored-key fingerprint never auto-clears`,
    async (h) => {
      const { page, control, badge, edit, save } = h;
      await openMetadata(h);
      await control({
        [row.id + "Reject"]: true,
        [row.id + "NoFingerprint"]: true,
      });
      await page.reload();
      await showMetadata(page);
      const own = card(page, row.id);
      await expect(badge(own)).toHaveText("Connection failed");
      await expect(own.getByRole("alert")).toContainText(
        "stored credential was rejected",
      );
      expect(patches(await control({}))).toHaveLength(0);
      const peer = card(page, row.peer);
      await edit(peer).click();
      await peer
        .locator('input[type="password"]')
        .fill("synthetic-peer-replacement");
      await save(peer).click();
      await expect(edit(peer)).toBeEnabled();
      const state = await control({});
      expect(patches(state)).toHaveLength(1);
      expect(patches(state).filter((r) => row.field in r.body)).toHaveLength(0);
      expect(state.config.providers[row.id]).toEqual({
        configured: true,
        source: "stored",
      });
    },
  );
  scenario(
    `${row.name}: a direct settings link reveals and focuses the correct provider`,
    async ({ page, control }) => {
      await control({ reset: true, holdConfig: true });
      await page.goto(`/?view=settings#provider-heading-${row.id}`);
      await expect(
        page.getByRole("button", { name: "Metadata providers", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const heading = page.getByRole("heading", {
        name: row.name,
        exact: true,
      });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await control({ holdConfig: false });
      await expect(
        card(page, row.id).getByRole("button", { name: "Edit", exact: true }),
      ).toBeEnabled();
      await expect(heading).toBeFocused();
    },
  );
}

const proseCard = (page) =>
  page.locator('section[aria-labelledby="prose-heading"]');
// Contract move: the Off/On segments became one switch named by the
// "Natural-language search" label; a click toggles it. `enabled` names the
// state the caller wants, so the call sites read as before.
const proseSwitch = (own, _enabled) =>
  own.getByRole("switch", { name: "Natural-language search", exact: true });
// Contract move: a configured natural-language search card checks its saved
// connection once when Settings opens (the free model list). The opener
// waits for that one check; savedChecks counts only the checks after it.
const proseChecks = (state) =>
  state.requests.filter((r) => r.path === "/api/admin/prose/check");
const savedChecks = (state) => proseChecks(state).slice(1);

async function openConfiguredProse(h) {
  await openMetadata(h);
  const state = await h.control({});
  state.config.proseChat = {
    enabled: true,
    url: "https://chat.example.test/v1",
    model: "review-chat",
    keyStored: true,
    configured: true,
  };
  await h.control({ config: state.config });
  await h.page.reload();
  await showAi(h.page);
  const own = proseCard(h.page);
  await expect(h.edit(own)).toBeEnabled();
  await expect
    .poll(async () => proseChecks(await h.control({})).length)
    .toBe(1);
  return own;
}
scenario(
  "Natural-language search validates On, saves independently and probes saved settings without exposing a key",
  async (h) => {
    const { page, edit, save, check, badge, control } = h;
    await openMetadata(h);
    const own = proseCard(page),
      peer = card(page, "tpdb");
    await expect(own.getByText("Off", { exact: true })).toBeHidden();
    await edit(peer).click();
    await peer.locator('input[type="password"]').fill("synthetic-peer-draft");
    await showAi(page);
    await expect(own.getByText("Off", { exact: true })).toBeVisible();
    // Contract move: a closed card offers Check connection only as the
    // retry after a failed saved check.
    await expect(check(own)).toHaveCount(0);
    await edit(own).click();
    await expect(proseSwitch(own, false)).toBeFocused();
    await proseSwitch(own, true).click();
    await expect(save(own)).toBeDisabled();
    await own
      .getByLabel("Server URL", { exact: true })
      .fill("https://chat.example.test/v1");
    await expect(save(own)).toBeDisabled();
    await own.getByLabel("Model", { exact: true }).fill("review-chat");
    await own
      .getByLabel("API key (optional)", { exact: true })
      .fill("synthetic-chat-key");
    await expect(badge(own)).toHaveText("Unsaved changes");
    // Contract move: the editor's Check tests the typed values
    // (/api/admin/prose/test), so unsaved values can be checked.
    await expect(check(own)).toBeEnabled();
    await save(own).click();
    await expect(edit(own)).toBeEnabled();
    await expect(badge(own)).toHaveText("Connected");
    await expect(
      own.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(peer.locator('input[type="password"]')).toHaveValue(
      "synthetic-peer-draft",
    );
    const state = await control({});
    expect(patches(state).map((r) => r.body)).toEqual([
      {
        proseChatEnabled: true,
        proseChatUrl: "https://chat.example.test/v1",
        proseChatModel: "review-chat",
        proseChatApiKey: "synthetic-chat-key",
      },
    ]);
    const probe = state.requests.filter(
      (r) => r.path === "/api/admin/prose/check",
    );
    expect(probe).toHaveLength(1);
    expect(probe[0].started).toBeGreaterThanOrEqual(patches(state)[0].finished);
    expect(await page.locator("body").innerText()).not.toContain(
      "synthetic-chat-key",
    );
    await edit(own).click();
    await expect(
      own.getByLabel("API key (optional)", { exact: true }),
    ).toHaveValue("");
  },
);
scenario(
  "Natural-language search keeps failed checks separate from saves and clears obsolete save feedback on edits",
  async (h) => {
    const { edit, save, cancel, badge, control } = h;
    const own = await openConfiguredProse(h);
    await edit(own).click();
    await own.getByLabel("Model", { exact: true }).fill("saved-chat");
    await control({ proseFail: true });
    await save(own).click();
    await expect(edit(own)).toBeEnabled();
    await expect(badge(own)).toHaveText("Connection failed");
    await expect(
      own.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await edit(own).click();
    await expect(own.getByText("Settings saved.", { exact: true })).toHaveCount(
      0,
    );
    await own.getByLabel("Model", { exact: true }).fill("unsaved-chat");
    await control({ patchFail: true });
    await save(own).click();
    await expectSaveFeedbackNearActions(own);
    await expect(own.getByLabel("Model", { exact: true })).toHaveValue(
      "unsaved-chat",
    );
    for (const [label, value] of [
      ["Model", "corrected-chat"],
      ["Server URL", "https://corrected-chat.example.test/v1"],
      ["API key (optional)", "synthetic-corrected-key"],
    ]) {
      await own.getByLabel(label, { exact: true }).fill(value);
      await expect(own.locator("form").getByRole("alert")).toHaveCount(0);
      await save(own).click();
      await expectSaveFeedbackNearActions(own);
    }
    await proseSwitch(own, false).click();
    await expect(own.locator("form").getByRole("alert")).toHaveCount(0);
    await cancel(own).click();
    await expect(edit(own)).toBeFocused();
    await expect(badge(own)).toHaveText("Connection failed");
  },
);
scenario(
  "Natural-language search does not claim a filter draft after a saved check",
  async (h) => {
    const { edit, save, badge } = h;
    const own = await openConfiguredProse(h);
    await edit(own).click();
    await save(own).click();
    await expect(edit(own)).toBeEnabled();
    // Contract move: quieter checks (71e3799) show success in the chip and
    // render a line only for a failure, and no state claims a filter draft
    // the model-list check cannot prove.
    await expect(badge(own)).toHaveText("Connected");
    await expect(own.locator("p.judgment-check")).toHaveCount(0);
    await expect(own.getByText("filter draft")).toHaveCount(0);
  },
);
scenario(
  "Natural-language search and AI matching switch independently and Off preserves chat settings",
  async (h) => {
    const { page, edit, save, control } = h;
    const own = await openConfiguredProse(h),
      ai = aiCard(page);
    const before = (await control({})).config;
    await edit(ai).click();
    await selectAi(ai, "none");
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    expect((await control({})).config.proseChat).toEqual(before.proseChat);
    await edit(own).click();
    await proseSwitch(own, false).click();
    await save(own).click();
    await expect(edit(own)).toBeEnabled();
    await expect(own.getByText("Off", { exact: true })).toBeVisible();
    const state = await control({});
    expect(state.config.proseChat).toEqual({
      ...before.proseChat,
      enabled: false,
      configured: false,
    });
    expect(state.config.providers).toEqual(before.providers);
    expect(state.config.judgment.provider).toBe("none");
    expect(savedChecks(state)).toHaveLength(0);
    await edit(own).click();
    await own
      .getByRole("button", { name: "Clear stored credential", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Clear credential", exact: true })
      .click();
    await expect(edit(own)).toBeEnabled();
    await expect(own.getByText("Off", { exact: true })).toBeVisible();
    const cleared = await control({});
    expect(cleared.config.proseChat).toEqual({
      ...state.config.proseChat,
      keyStored: false,
    });
    expect(savedChecks(cleared)).toHaveLength(0);
  },
);
for (const proseFail of [false, true])
  scenario(
    `Natural-language search credential clearing confirms, preserves settings and rechecks (${proseFail ? "rejected" : "connected"})`,
    async (h) => {
      const { page, edit, check, badge, control } = h;
      const own = await openConfiguredProse(h);
      // Contract move: Check connection lives in the open editor and tests
      // the typed values; the closed card offers it only as a retry.
      await edit(own).click();
      await check(own).click();
      await expect(badge(own)).toHaveText("Connected");
      const before = (await control({})).config;
      await own
        .getByLabel("API key (optional)", { exact: true })
        .fill("synthetic-unsaved-key");
      const clear = own.getByRole("button", {
        name: "Clear stored credential",
        exact: true,
      });
      await clear.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveAccessibleName(
        "Clear the stored natural-language search credential?",
      );
      await dialog
        .getByRole("button", { name: "Keep credential", exact: true })
        .click();
      await expect(
        own.getByLabel("API key (optional)", { exact: true }),
      ).toHaveValue("synthetic-unsaved-key");
      expect(patches(await control({}))).toHaveLength(0);
      await control({ holdPatch: true, proseFail });
      await clear.click();
      await dialog
        .getByRole("button", { name: "Clear credential", exact: true })
        .click();
      await expect(h.save(own)).toBeDisabled();
      await expect(clear).toBeDisabled();
      await expect(badge(own)).toHaveText("Unsaved changes");
      await expect.poll(async () => patches(await control({})).length).toBe(1);
      // Contract move: the editor's check went to /api/admin/prose/test
      // (typed values); the saved check runs only after the clear lands.
      expect(savedChecks(await control({}))).toHaveLength(0);
      await control({ holdPatch: false });
      await expect(edit(own)).toBeEnabled();
      await expect(badge(own)).toHaveText(
        proseFail ? "Connection failed" : "Connected",
      );
      const state = await control({});
      expect(patches(state).map((r) => r.body)).toEqual([
        { proseChatApiKey: "" },
      ]);
      expect(state.config.proseChat).toEqual({
        ...before.proseChat,
        keyStored: false,
      });
      expect(state.config.providers).toEqual(before.providers);
      const probes = savedChecks(state);
      expect(probes).toHaveLength(1);
      expect(probes[0].started).toBeGreaterThanOrEqual(
        patches(state)[0].finished,
      );
      await expect(
        own.getByText("Stored natural-language search credential cleared.", {
          exact: true,
        }),
      ).toBeVisible();
    },
  );
scenario(
  "Natural-language search failed credential clearing keeps its diagnosis and key without probing",
  async (h) => {
    const { page, edit, check, badge, control } = h;
    const own = await openConfiguredProse(h);
    await edit(own).click();
    await check(own).click();
    await expect(badge(own)).toHaveText("Connected");
    await control({ patchFail: true });
    await own
      .getByRole("button", { name: "Clear stored credential", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Clear credential", exact: true })
      .click();
    await expectSaveFeedbackNearActions(own);
    await expect(badge(own)).toHaveText("Connected");
    await expect(
      own.getByRole("button", { name: "Clear stored credential", exact: true }),
    ).toBeEnabled();
    const state = await control({});
    expect(state.config.proseChat.keyStored).toBe(true);
    // Contract move: the earlier check was the editor's draft check
    // (/api/admin/prose/test); the failed clear starts no saved check.
    expect(savedChecks(state)).toHaveLength(0);
    await expect(
      own.getByText("Stored natural-language search credential cleared.", {
        exact: true,
      }),
    ).toHaveCount(0);
  },
);
scenario(
  "Natural-language search shares the Connections operation queue and keeps drafts across tab switches",
  async (h) => {
    const { page, jf, fresh, edit, save, control } = h;
    await fresh();
    await edit(jf).click();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://queued.example.test");
    await showAi(page);
    const own = proseCard(page);
    await edit(own).click();
    await proseSwitch(own, true).click();
    await own
      .getByLabel("Server URL", { exact: true })
      .fill("https://chat.example.test/v1");
    await own.getByLabel("Model", { exact: true }).fill("draft-chat");
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    const queuedStart = (await control({ holdPatch: true })).requests.length;
    await save(jf).click();
    await showAi(page);
    await expect(save(own)).toBeDisabled();
    await expect(own.getByLabel("Model", { exact: true })).toHaveValue(
      "draft-chat",
    );
    await control({ holdPatch: false });
    await expect(save(own)).toBeEnabled();
    await save(own).click();
    await expect(edit(own)).toBeEnabled();
    const state = await control({});
    // Model-list reads bypass the save queue.
    const operations = state.requests
      .slice(queuedStart)
      .filter(
        (r) =>
          r.method === "PATCH" ||
          r.path === "/api/admin/prose/check" ||
          r.path === "/api/admin/jellyfin",
      );
    expect(operations.map((r) => [r.method, r.path])).toEqual([
      ["PATCH", "/api/admin/integrations"],
      ["GET", "/api/admin/jellyfin"],
      ["PATCH", "/api/admin/integrations"],
      ["POST", "/api/admin/prose/check"],
    ]);
    for (let i = 1; i < operations.length; i++)
      expect(operations[i].started).toBeGreaterThanOrEqual(
        operations[i - 1].finished,
      );
  },
);
scenario(
  "Natural-language search deep links focus its card and configuration retry restores editing",
  async ({ page, control, edit }) => {
    await control({ reset: true, configFail: true });
    await page.goto("/?view=settings#prose-heading");
    // Contract move: the prose card lives on the AI tab.
    await expect(
      page.getByRole("button", { name: "AI", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const heading = page.getByRole("heading", {
      name: "Natural-language search",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    const own = proseCard(page);
    await expect(edit(own)).toBeDisabled();
    await control({ configFail: false });
    await page
      .getByRole("alert")
      .filter({ hasText: "AI configuration read failed" })
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(edit(own)).toBeEnabled();
  },
);
scenario(
  "Natural-language search administrator denial keeps the settings session and disables its controls",
  async (h) => {
    const { page, check, edit, control } = h;
    const own = await openConfiguredProse(h);
    await control({ prose403: true });
    await edit(own).click();
    await check(own).click();
    await expect(
      own.getByText(
        "An administrator account is required to configure natural-language search.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(check(own)).toBeDisabled();
    // The open editor's Save is the restricted control now (no Edit while
    // the editor is open).
    await expect(h.save(own)).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await showMetadata(page);
    await expect(edit(card(page, "tpdb"))).toBeEnabled();
  },
);
