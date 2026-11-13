import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  scenario,
  expectNoHorizontalOverflow,
  expectSaveFeedbackNearActions,
} from "./settings-harness.mjs";

scenario(
  "Compact cards share Metadata headings, actions and badge positions",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await expect(edit(jf)).toBeEnabled();
    await expect(edit(w)).toBeEnabled();
    assert.equal(
      await page.getByRole("button", { name: "Save integrations" }).count(),
      0,
    );
    for (const card of [jf, w]) {
      assert.equal(await card.locator(".settings-service-summary").count(), 1);
      assert.equal(
        await card
          .locator(".settings-service-status .connection-state.is-ok")
          .count(),
        1,
      );
      assert.equal(await card.locator("form").count(), 0);
      assert.equal(
        await card
          .locator(".connection-state")
          .evaluate((node) => getComputedStyle(node, "::before").width),
        "6px",
      );
    }

    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    assert.equal(
      await provider.locator(".settings-service-summary").count(),
      1,
    );
    expect(
      await page.getByRole("heading", { level: 2 }).allTextContents(),
    ).toEqual(["TPDB", "StashDB", "AI-assisted matching"]);
    await expect(badge(provider)).toHaveText("Connected");
  },
);
scenario(
  "Jellyfin saves preserve Whisparr drafts and omit blank credentials",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(jf).click();
    await expect(jf.getByLabel("Jellyfin URL", { exact: true })).toBeFocused();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://watch.example.test/new");
    await edit(w).click();
    await expect(w.getByLabel("Whisparr URL", { exact: true })).toBeFocused();
    await w
      .getByLabel("Root folder", { exact: true })
      .selectOption("/data/alt");
    await expect(badge(jf)).toHaveText("Unsaved changes");
    await expect(badge(w)).toHaveText("Unsaved changes");
    await expect(check(jf)).toBeDisabled();
    await expect(check(w)).toBeDisabled();
    await save(jf).click();
    await expect(edit(jf)).toBeEnabled();
    await expect(badge(jf)).toHaveText("Connected");
    await expect(w.getByLabel("Root folder", { exact: true })).toHaveValue(
      "/data/alt",
    );
    await expect(
      jf.getByText("Jellyfin settings saved.", { exact: true }),
    ).toBeFocused();
    const data = await control({});
    const patches = data.requests.filter((r) => r.method === "PATCH");
    assert.equal(
      data.requests.filter((r) => r.path === "/api/admin/whisparr").length,
      1,
      "unrelated card must not remount after Save",
    );
    assert.equal(
      data.requests.filter(
        (r) => r.path === "/api/admin/integrations" && r.method === "GET",
      ).length,
      2,
      "Save uses its response, without a failure-prone config reload",
    );
    assert.deepEqual(
      patches.map((r) => r.body),
      [
        {
          jellyfinUrl: "http://jellyfin.review:8096",
          jellyfinExternalUrl: "https://watch.example.test/new",
        },
      ],
    );
    await cancel(w).click();
    await expect(edit(w)).toBeFocused();
    await edit(w).click();
    await expect(w.getByLabel("Root folder", { exact: true })).toHaveValue(
      "/data/media",
    );
  },
);
scenario(
  "Whisparr saves preserve Jellyfin drafts and retain delivery controls",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(jf).click();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://draft.example.test");
    await edit(w).click();
    await w.getByLabel("Quality profile", { exact: true }).selectOption("2");
    await w.getByLabel("Jellyfin prefix", { exact: true }).fill("/new-media");
    await save(w).click();
    await expect(edit(w)).toBeEnabled();
    await expect(badge(w)).toHaveText("Connected");
    await expect(jf.getByLabel("Jellyfin external URL")).toHaveValue(
      "https://draft.example.test",
    );
    const data = await control({});
    const body = data.requests.find((r) => r.method === "PATCH").body;
    assert.equal("jellyfinUrl" in body, false);
    assert.equal("jellyfinApiKey" in body, false);
    assert.equal("whisparrApiKey" in body, false);
    assert.equal(body.delivery.qualityProfileId, 2);
    assert.equal(body.pathMappings[0].jellyfinPrefix, "/new-media");
    assert.equal(
      data.config.jellyfin.externalUrl,
      "https://media.example.test",
    );
  },
);
scenario(
  "Blank unchanged Save gives feedback and Cancel restores focus",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(jf).click();
    await save(jf).click();
    await expect(
      jf.getByText("No changes to save.", { exact: true }),
    ).toBeVisible();
    await expect(cancel(jf)).toBeVisible();
    assert.equal(
      (await control({})).requests.filter((r) => r.method === "PATCH").length,
      0,
    );
    await cancel(jf).click();
    await expect(edit(jf)).toBeFocused();
  },
);
scenario(
  "Save failures retain drafts and recover on retry",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(w).click();
    await w.getByLabel("Whisparr API key").fill("synthetic-replacement");
    await control({ patchFail: true });
    await save(w).click();
    await expect(
      w.getByText("Saving Whisparr settings failed", { exact: true }),
    ).toBeVisible();
    await expectSaveFeedbackNearActions(w);
    await expect(w.getByLabel("Whisparr API key")).toHaveValue(
      "synthetic-replacement",
    );
    assert.equal(
      (await page.locator("body").innerText()).includes(
        "synthetic-replacement",
      ),
      false,
    );
    await control({ patchFail: false });
    await save(w).click();
    await expect(edit(w)).toBeEnabled();
    await expect(
      w.getByText("Whisparr settings saved.", { exact: true }),
    ).toBeVisible();
  },
);
scenario(
  "Failed post-save checks remain separate from successful persistence",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(jf).click();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://saved.example.test");
    await control({ jellyfinFail: true });
    await save(jf).click();
    await expect(edit(jf)).toBeEnabled();
    await expect(
      jf.getByText("Jellyfin settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(badge(jf)).toHaveText("Connection failed");
    await edit(jf).click();
    await cancel(jf).click();
    await expect(badge(jf)).toHaveText("Connection failed");
    await expect(edit(jf)).toBeFocused();
    await control({ jellyfinFail: false });
    await check(jf).click();
    await expect(badge(jf)).toHaveText("Connected");
    await control({ jellyfinHttpFail: true });
    await check(jf).click();
    await expect(badge(jf)).toHaveText("Connection failed");
    await expect(
      jf.getByText("The review status endpoint is unavailable.", {
        exact: true,
      }),
    ).toBeVisible();
  },
);
scenario(
  "Configuration read failures leave service checks available and retry restores editing",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh({ configFail: true });
    await expect(edit(jf)).toBeDisabled();
    await expect(check(jf)).toBeEnabled();
    await check(jf).click();
    await expect(badge(jf)).toHaveText("Connected");
    await control({ configFail: false });
    await page
      .getByRole("alert")
      .filter({ hasText: "Connection configuration read failed" })
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(edit(jf)).toBeEnabled();
    await edit(jf).click();
    await expect(jf.getByLabel("Jellyfin URL", { exact: true })).toHaveValue(
      "http://jellyfin.review:8096",
    );
  },
);
scenario(
  "Incomplete mappings cannot save and a blank URL cannot remove Whisparr",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(w).click();
    await w.getByRole("button", { name: "Add mapping", exact: true }).click();
    await w
      .getByLabel("Whisparr prefix", { exact: true })
      .nth(1)
      .fill("/incomplete");
    await save(w).click();
    await expect(
      w.getByText(
        "Each path mapping needs both a Whisparr prefix and a Jellyfin prefix.",
        { exact: true },
      ),
    ).toBeVisible();
    assert.equal(
      (await control({})).requests.filter((r) => r.method === "PATCH").length,
      0,
    );
    await w.getByLabel("Whisparr URL", { exact: true }).fill("");
    await save(w).click();
    await expect(
      w.getByText(
        "Enter a Whisparr URL, or use Remove connection to remove it.",
        { exact: true },
      ),
    ).toBeVisible();
    assert.equal(
      (await control({})).config.whisparr.url,
      "http://whisparr.review:6969",
    );
  },
);
scenario(
  "Whisparr removal requires confirmation and a new connection can be saved without delivery",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(w).click();
    await w
      .getByRole("button", { name: "Remove connection", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Keep connection", exact: true })
      .click();
    assert.equal(
      (await control({})).requests.filter((r) => r.method === "PATCH").length,
      0,
    );
    await w
      .getByRole("button", { name: "Remove connection", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove connection", exact: true })
      .click();
    await expect(badge(w)).toHaveText("Not configured");
    await expect(check(w)).toBeDisabled();
    await expect(edit(w)).toBeEnabled();
    const removed = await control({});
    assert.equal(removed.config.whisparr, null);
    assert.equal(removed.config.jellyfin.url, "http://jellyfin.review:8096");
    await edit(w).click();
    await w
      .getByLabel("Whisparr URL", { exact: true })
      .fill("https://whisparr-new.example.test");
    await w.getByLabel("Whisparr API key").fill("synthetic-new-key");
    await save(w).click();
    await expect(badge(w)).toHaveText("Connected");
    await expect(edit(w)).toBeEnabled();
    const added = await control({});
    assert.equal(
      added.config.whisparr.url,
      "https://whisparr-new.example.test",
    );
    const body = added.requests.filter((r) => r.method === "PATCH").at(-1).body;
    assert.equal("delivery" in body, false);
  },
);
scenario(
  "Cross-tab saves and checks wait for persistence without losing provider drafts",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    await edit(provider).click();
    await provider
      .getByLabel("TPDB API token")
      .fill("synthetic-provider-draft");
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await edit(jf).click();
    await jf
      .getByLabel("Jellyfin external URL")
      .fill("https://queued.example.test");
    await control({ holdPatch: true });
    await save(jf).click();
    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    await expect(save(provider)).toBeDisabled();
    await expect(check(provider)).toBeDisabled();
    await control({ holdPatch: false });
    await expect(save(provider)).toBeEnabled();
    await expect(provider.getByLabel("TPDB API token")).toHaveValue(
      "synthetic-provider-draft",
    );
    await save(provider).click();
    await expect(edit(provider)).toBeEnabled();
    const data = await control({});
    const patches = data.requests.filter((r) => r.method === "PATCH");
    assert.equal(patches.length, 2);
    const operations = data.requests.filter(
      (r) =>
        r.method === "PATCH" ||
        r.path === "/api/admin/jellyfin" ||
        r.path === "/api/admin/whisparr" ||
        r.path.startsWith("/api/admin/providers/"),
    );
    for (let i = 1; i < operations.length; i++)
      assert.ok(
        operations[i].started >= operations[i - 1].finished,
        "overlapping settings operations",
      );
  },
);
scenario(
  "Desktop and mobile editors have sibling forms, named controls and no overflow",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(jf).click();
    await edit(w).click();
    assert.deepEqual(
      await page.getByRole("heading", { level: 2 }).allTextContents(),
      ["Jellyfin", "Whisparr"],
    );
    assert.equal(
      await page.locator(".settings-page div[aria-label]:not([role])").count(),
      0,
    );
    assert.equal(await page.locator("form form").count(), 0);
    assert.equal(await page.locator("button:not([type])").count(), 0);
    const ids = await page
      .locator("[id]")
      .evaluateAll((nodes) => nodes.map((n) => n.id));
    assert.equal(ids.length, new Set(ids).size);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expectNoHorizontalOverflow(page);

    await cancel(w).click();
    await cancel(jf).click();

    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    await expectNoHorizontalOverflow(page);
  },
);
scenario(
  "Root folder and quality profile arrows have inset spacing and remain labeled native pickers",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await edit(w).click();
    for (const label of ["Root folder", "Quality profile"]) {
      const select = w.getByLabel(label, { exact: true });
      const metrics = await select.evaluate((node) => ({
        appearance: getComputedStyle(node).appearance,
        padding: getComputedStyle(node).paddingRight,
        wrapper: node.parentElement.classList.contains("settings-select"),
        arrowInset: getComputedStyle(node.parentElement, "::after").right,
        pointerEvents: getComputedStyle(node.parentElement, "::after")
          .pointerEvents,
      }));
      assert.deepEqual(metrics, {
        appearance: "none",
        padding: "40px",
        wrapper: true,
        arrowInset: "14px",
        pointerEvents: "none",
      });
    }
    const profile = w.getByLabel("Quality profile", { exact: true });
    await profile.focus();
    await expect(profile).toBeFocused();
    await profile.selectOption("2");
    await expect(profile).toHaveValue("2");
    await profile.selectOption("1");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expectNoHorizontalOverflow(page);
  },
);
scenario(
  "Connection status stays mounted during delayed configuration loading",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh({ holdConfig: true });
    await expect(edit(jf)).toBeDisabled();
    await expect(check(jf)).toBeEnabled();
    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    await expect(edit(provider)).toBeDisabled();
    await expect(check(provider)).toBeEnabled();
    await expect(badge(provider)).toHaveText("Connected");
    await control({ holdConfig: false });
    await expect(edit(provider)).toBeEnabled();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(edit(jf)).toBeEnabled();
    await expect(edit(w)).toBeEnabled();
    const data = await control({});
    assert.equal(
      data.requests.filter((r) => r.path === "/api/admin/jellyfin").length,
      1,
    );
    assert.equal(
      data.requests.filter((r) => r.path === "/api/admin/whisparr").length,
      1,
    );
  },
);
scenario(
  "Unconfigured AI saves retain a nonempty notice and skip the persisted probe",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    const data = await control({});
    data.config.providers.typesafe.configured = false;
    data.config.judgment = {
      ...data.config.judgment,
      provider: "typesafe",
      configured: false,
      stored: false,
    };
    await control({ config: data.config });
    await page.reload();
    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    const ai = page.locator('section[aria-labelledby="judgment-heading"]');
    await edit(ai).click();
    await expect(ai.getByLabel("Provider", { exact: true })).toBeFocused();
    await ai.getByLabel("Provider", { exact: true }).selectOption("typesafe");
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(
      ai.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(badge(ai)).toHaveText("Not configured");
    assert.equal(
      (await control({})).requests.filter(
        (r) => r.path === "/api/admin/judgment/check",
      ).length,
      0,
    );
  },
);
scenario(
  "AI normalization preserves a failed post-save result across configuration sync and Cancel",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await page
      .getByRole("button", { name: "Metadata providers", exact: true })
      .click();
    const ai = page.locator('section[aria-labelledby="judgment-heading"]');
    await edit(ai).click();
    await ai.getByLabel("Provider", { exact: true }).selectOption("ollama");
    await ai
      .getByLabel("Ollama URL", { exact: true })
      .fill("http://localhost:11434");
    await ai.getByLabel("Decision model", { exact: true }).fill("review-model");
    await control({ judgmentFail: true });
    await save(ai).click();
    await expect(edit(ai)).toBeEnabled();
    await expect(badge(ai)).toHaveText("Connection failed");
    await expect(
      ai.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await edit(ai).click();
    await cancel(ai).click();
    await expect(badge(ai)).toHaveText("Connection failed");
  },
);
scenario(
  "Administrator denial replaces the connection editor",
  async ({
    page,
    jf,
    w,
    provider,
    fresh,
    control,
    edit,
    save,
    cancel,
    badge,
    check,
  }) => {
    await fresh();
    await control({ jellyfin403: true });
    await check(jf).click();
    await expect(
      page.getByRole("heading", { name: "403 · Administrators only" }),
    ).toBeVisible();
  },
);

scenario(
  "First-time Whisparr setup validates credentials and supports manual delivery fields",
  async ({ page, w, fresh, control, edit, save, badge, check }) => {
    await fresh();
    const state = await control({});
    state.config.whisparr = null;
    await control({ config: state.config });
    await page.reload();
    await expect(badge(w)).toHaveText("Not configured");
    await expect(check(w)).toBeDisabled();
    await edit(w).click();
    await save(w).click();
    await expect(w.getByRole("alert")).toContainText(
      "Enter a Whisparr URL and API key",
    );
    await w
      .getByLabel("Whisparr URL", { exact: true })
      .fill("https://new-whisparr.example.test");
    await save(w).click();
    await expect(w.getByRole("alert")).toContainText(
      "A Whisparr API key is required",
    );
    expect(
      (await control({})).requests.filter(
        (request) => request.method === "PATCH",
      ),
    ).toHaveLength(0);
    await w
      .getByLabel("Whisparr API key", { exact: true })
      .fill("synthetic-key");
    await w
      .getByRole("checkbox", {
        name: "Send approved requests to Whisparr",
        exact: true,
      })
      .check();
    await w.getByLabel("Root folder", { exact: true }).fill("/data/new-root");
    await w.getByLabel("Quality profile", { exact: true }).fill("2");
    await save(w).click();
    await expect(edit(w)).toBeEnabled();
    await expect(badge(w)).toHaveText("Connected");
    const patch = (await control({})).requests.find(
      (request) => request.method === "PATCH",
    ).body;
    expect(patch.delivery).toEqual({
      enabled: true,
      rootFolderPath: "/data/new-root",
      qualityProfileId: 2,
      searchOnAdd: true,
    });
    await edit(w).click();
    await expect(w.getByLabel("Root folder", { exact: true })).toHaveValue(
      "/data/new-root",
    );
  },
);

scenario(
  "Saved roots and profiles absent from the latest check survive later edits",
  async ({ page, w, fresh, control, edit, save }) => {
    await fresh();
    const state = await control({});
    state.config.whisparr.delivery.rootFolderPath = "/saved-root";
    state.config.whisparr.delivery.qualityProfileId = 99;
    await control({ config: state.config });
    await page.reload();
    await edit(w).click();
    await expect(w.getByLabel("Root folder", { exact: true })).toHaveValue(
      "/saved-root",
    );
    await expect(w.getByLabel("Quality profile", { exact: true })).toHaveValue(
      "99",
    );
    await expect(
      w.getByRole("option", { name: "Saved profile #99", exact: true }),
    ).toHaveCount(1);
    await save(w).click();
    await expect(
      w.getByText("No changes to save.", { exact: true }),
    ).toBeVisible();
    expect(
      (await control({})).requests.filter(
        (request) => request.method === "PATCH",
      ),
    ).toHaveLength(0);
    await w
      .getByRole("checkbox", {
        name: "Search Whisparr as soon as a request is sent",
        exact: true,
      })
      .uncheck();
    await save(w).click();
    await expect(edit(w)).toBeEnabled();
    const patch = (await control({})).requests.find(
      (request) => request.method === "PATCH",
    ).body;
    expect(patch.delivery).toEqual({
      enabled: true,
      rootFolderPath: "/saved-root",
      qualityProfileId: 99,
      searchOnAdd: false,
    });
  },
);

scenario(
  "Mapping limits, removal and Cancel preserve the saved mapping list",
  async ({ page, w, fresh, control, edit, cancel }) => {
    await fresh();
    const state = await control({});
    state.config.whisparr.pathMappings = Array.from(
      { length: 50 },
      (_, index) => ({
        whisparrPrefix: "/downloads/" + index,
        jellyfinPrefix: "/media/" + index,
      }),
    );
    await control({ config: state.config });
    await page.reload();
    await edit(w).click();
    const add = w.getByRole("button", { name: "Add mapping", exact: true });
    await expect(add).toBeDisabled();
    await w
      .getByRole("button", { name: "Remove path mapping 50", exact: true })
      .click();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(add).toBeDisabled();
    await expect(
      w.getByLabel("Whisparr prefix", { exact: true }).nth(49),
    ).toHaveValue("");
    await cancel(w).click();
    await expect(edit(w)).toBeFocused();
    await edit(w).click();
    await expect(
      w.getByLabel("Whisparr prefix", { exact: true }).nth(49),
    ).toHaveValue("/downloads/49");
    expect(
      (await control({})).requests.filter(
        (request) => request.method === "PATCH",
      ),
    ).toHaveLength(0);
  },
);

scenario(
  "Configuration and save permission failures replace the editors without extra probes",
  async ({ page, w, fresh, control, edit, save }) => {
    await control({ reset: true, config403: true });
    await page.goto("/?view=settings");
    await expect(
      page.getByRole("heading", {
        name: "403 · Administrators only",
        exact: true,
      }),
    ).toBeVisible();
    await fresh();
    await edit(w).click();
    await w
      .getByLabel("Whisparr API key", { exact: true })
      .fill("synthetic-denied-draft");
    await control({ config403: true });
    await save(w).click();
    await expect(
      page.getByRole("heading", {
        name: "403 · Administrators only",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await control({})).requests.filter(
        (request) => request.path === "/api/admin/whisparr",
      ),
    ).toHaveLength(1);
  },
);

scenario(
  "Pending connection checks announce progress and clear the previous diagnosis",
  async ({ jf, w, fresh, control, edit, check, badge }) => {
    await fresh();
    await control({ holdProbe: true });
    await check(w).click();
    await expect(badge(w)).toHaveText("Checking…");
    await expect(
      w.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeDisabled();
    await expect(edit(w)).toBeDisabled();
    await expect(edit(jf)).toBeDisabled();
    await expect(check(jf)).toBeDisabled();
    expect(
      await w.locator(".settings-service-status .text-muted").count(),
    ).toBe(0);
    await control({ holdProbe: false, whisparrFail: true });
    await expect(badge(w)).toHaveText("Connection failed");
    await expect(w.getByRole("alert")).toBeVisible();
    await control({ whisparrFail: false });
    await check(w).click();
    await expect(badge(w)).toHaveText("Connected");
  },
);
