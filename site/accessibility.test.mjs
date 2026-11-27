import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The Pages deploy bakes the newest release into the badge (pages.yml). The
// test serves the page with the same bake applied and fixture values that
// match the mocked clock, so the same-day shine renders deterministically on
// any checkout, not only on a same-day deploy.
const badgeTag = "v0.0.0-test";
const badgePublished = "2026-11-21T09:00:00Z";
const contentTypes = {
  ".html": "text/html",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
};
const loopNames = ["beam-rot", "breathe", "shimmer"];
const storageKey = "velvarr-animations-paused";
let browser;
let landingUrl;
let server;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
  if (process.env.LANDING_PAGE_URL) {
    landingUrl = process.env.LANDING_PAGE_URL;
    return;
  }
  const root = path.resolve(fileURLToPath(new URL("./", import.meta.url)));
  server = http.createServer(async (request, response) => {
    const urlPath = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    const filePath = path.resolve(
      root,
      urlPath === "/" ? "index.html" : urlPath.slice(1),
    );
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      let body = await readFile(filePath);
      if (filePath.endsWith("index.html")) {
        body = Buffer.from(
          String(body).replace(
            'data-tag="" data-published=""',
            `data-tag="${badgeTag}" data-published="${badgePublished}"`,
          ),
        );
      }
      response.writeHead(200, {
        "content-type":
          contentTypes[path.extname(filePath)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  landingUrl = `http://127.0.0.1:${server.address().port}/index.html`;
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openPage(
  t,
  { reducedMotion = "no-preference" } = {},
) {
  const context = await browser.newContext({
    reducedMotion,
    timezoneId: "UTC",
  });
  t.after(async () => {
    await context.close();
  });
  await context.addInitScript(() => {
    const NativeDate = Date;
    const now = NativeDate.parse("2026-11-21T12:00:00Z");
    globalThis.Date = class extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    };
  });
  const page = await context.newPage();
  await page.goto(landingUrl, { waitUntil: "domcontentloaded" });
  return { page, context };
}

async function pauseButton(page) {
  const button = page.getByRole("button", {
    name: "Pause animations",
    exact: true,
  });
  assert.equal(
    await button.count(),
    1,
    "The landing page must expose one native Pause animations button",
  );
  assert.equal(await button.evaluate((element) => element.tagName), "BUTTON");
  return button;
}

async function loops(page) {
  return page.evaluate(
    (names) =>
      document
        .getAnimations()
        .filter((animation) => names.includes(animation.animationName))
        .map((animation) => ({
          name: animation.animationName,
          state: animation.playState,
        })),
    loopNames,
  );
}

async function assertLoops(page, state) {
  await expect
    .poll(async () => {
      const animations = await loops(page);
      return {
        names: [
          ...new Set(animations.map((animation) => animation.name)),
        ].sort(),
        states: [...new Set(animations.map((animation) => animation.state))],
      };
    })
    .toEqual({ names: loopNames, states: [state] });
}

async function assertSaved(page, button, paused) {
  await expect(button).toHaveAttribute("aria-pressed", String(paused));
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
    String(paused),
  );
  assert.equal(
    await page
      .locator("html")
      .evaluate((element) => element.classList.contains("animations-paused")),
    paused,
  );
}

test("Keyboard pause and resume control every persistent loop and survive reload", async (t) => {
  const { page } = await openPage(t);
  const button = await pauseButton(page);
  await assertLoops(page, "running");
  for (
    let count = 0;
    count < 30 &&
    !(await button.evaluate((element) => element === document.activeElement));
    count++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(button).toBeFocused();
  assert.equal(
    await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.matches(":focus-visible") &&
        ((style.outlineStyle !== "none" &&
          parseFloat(style.outlineWidth) > 0) ||
          style.boxShadow !== "none")
      );
    }),
    true,
    "Keyboard focus must have a visible indicator",
  );
  await page.keyboard.press("Enter");
  await assertSaved(page, button, true);
  await assertLoops(page, "paused");
  await expect(page.locator("#release .shine")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("#release .shine")
        .evaluate((element) =>
          element.getAnimations().map((animation) => animation.playState),
        ),
    )
    .toEqual(["paused"]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertSaved(page, button, true);
  await assertLoops(page, "paused");
  await button.focus();
  await page.keyboard.press("Space");
  await assertSaved(page, button, false);
  await assertLoops(page, "running");
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertSaved(page, button, false);
  await assertLoops(page, "running");
});

test("Reduced motion stays static after Resume", async (t) => {
  const { page } = await openPage(t, { reducedMotion: "reduce" });
  const button = await pauseButton(page);
  await expect(page.locator("#release .shine")).toBeVisible();
  assert.deepEqual(await loops(page), []);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await assertSaved(page, button, false);
  assert.deepEqual(
    await loops(page),
    [],
    "Resume must not override the reduced-motion preference",
  );
});

async function copyControls(page) {
  const status = page.locator("#copy-status");
  assert.equal(
    await status.count(),
    1,
    "Copy must have a stable, separate #copy-status region before activation",
  );
  assert.equal(await status.getAttribute("role"), "status");
  assert.equal(await status.textContent(), "");
  assert.equal(
    await status.evaluate((element) => element.closest("#copy") === null),
    true,
  );
  const copy = page.locator("#copy");
  await copy.evaluate(() => {
    globalThis.copyAnnouncements = [];
    const region = document.getElementById("copy-status");
    new MutationObserver(() => {
      globalThis.copyAnnouncements.push(region.textContent);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
  return { copy, status };
}

async function mask(copy) {
  return copy.evaluate(
    (element) => getComputedStyle(element, "::before").maskImage,
  );
}

for (const denied of [false, true]) {
  test(`Copy ${denied ? "denial" : "success"} reports status and keeps its icon and focus`, async (t) => {
    const { page, context } = await openPage(t);
    const { copy, status } = await copyControls(page);
    const originalMask = await mask(copy);
    assert.notEqual(
      originalMask,
      "none",
      "The Copy icon must use its ::before mask",
    );
    let realClipboard = false;
    if (!denied) {
      // File URLs and some Chromium builds do not expose a usable clipboard.
      try {
        if (new URL(landingUrl).protocol !== "file:") {
          await context.grantPermissions(
            ["clipboard-read", "clipboard-write"],
            { origin: new URL(landingUrl).origin },
          );
        }
        realClipboard = await page.evaluate(async () => {
          if (!navigator.clipboard?.writeText || !navigator.clipboard?.readText)
            return false;
          await navigator.clipboard.writeText("clipboard capability probe");
          return (
            (await navigator.clipboard.readText()) ===
            "clipboard capability probe"
          );
        });
      } catch (error) {
        t.diagnostic(`Platform clipboard unavailable: ${error.message}`);
      }
    }
    if (denied || !realClipboard) {
      if (!denied)
        t.diagnostic(
          "Platform clipboard stub only: capture writeText because the browser clipboard is unavailable.",
        );
      await page.evaluate((fail) => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            async writeText(text) {
              if (fail)
                throw new DOMException(
                  "Clipboard access denied",
                  "NotAllowedError",
                );
              globalThis.clipboardText = text;
            },
          },
        });
      }, denied);
    }
    await page.clock.install({ time: new Date("2026-11-21T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-11-21T12:00:00Z"));
    const originalRegion = await status.elementHandle();
    for (const tabName of ["Windows", "Linux and macOS"]) {
      await page.getByRole("tab", { name: tabName, exact: true }).click();
      const expectedText = await page
        .locator('pre[role="tabpanel"]:visible')
        .innerText();
      const announcementCount = await page.evaluate(
        () => globalThis.copyAnnouncements.length,
      );
      await copy.focus();
      await page.keyboard.press("Enter");
      await page.clock.runFor(50);
      await expect(status).toHaveText(
        denied
          ? /fail|denied|unable|could not|cannot|select.*copy/i
          : /copied/i,
      );
      await expect
        .poll(() =>
          page.evaluate(
            (start) =>
              globalThis.copyAnnouncements
                .slice(start)
                .some((text) => text.trim().length > 0),
            announcementCount,
          ),
        )
        .toBe(true);
      if (tabName === "Linux and macOS") {
        assert.equal(
          await page.evaluate(
            (start) => globalThis.copyAnnouncements.slice(start).includes(""),
            announcementCount,
          ),
          true,
          "A repeated Copy action must clear the old announcement first",
        );
      }
      await expect(copy).toBeFocused();
      assert.equal(
        await originalRegion.evaluate(
          (element) => element === document.getElementById("copy-status"),
        ),
        true,
      );
      const currentMask = await mask(copy);
      assert.notEqual(currentMask, "none");
      if (denied) {
        assert.equal(
          currentMask,
          originalMask,
          "Failure must keep the Copy icon",
        );
      } else {
        assert.notEqual(
          currentMask,
          originalMask,
          "Success must replace the Copy mask with a check",
        );
        const copiedText = await page.evaluate(
          (real) =>
            real ? navigator.clipboard.readText() : globalThis.clipboardText,
          realClipboard,
        );
        assert.equal(
          copiedText,
          expectedText,
          "Copy must use the visible operating-system panel",
        );
      }
      if (tabName === "Windows") await page.clock.runFor(1000);
    }
    await page.clock.runFor(900);
    await expect(copy).toHaveText(denied ? /select.*copy/i : /copied/i);
  });
}
