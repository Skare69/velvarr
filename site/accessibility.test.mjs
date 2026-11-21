import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";

const landingUrl =
  process.env.LANDING_PAGE_URL || new URL("./index.html", import.meta.url).href;
const releaseUrl =
  "https://api.github.com/repos/Skare69/velvarr/releases/latest";
const loopNames = ["beam-rot", "breathe", "drift-a", "drift-b", "shimmer"];
const storageKey = "velvarr-animations-paused";
let browser;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
});
after(async () => {
  await browser?.close();
});

async function openPage(
  t,
  { reducedMotion = "no-preference", delayRelease = false } = {},
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
  let release;
  const releaseReady = new Promise((resolve) => {
    release = resolve;
  });
  if (!delayRelease) release();
  const documentUrl = new URL(landingUrl);
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === releaseUrl) {
      await releaseReady;
      await route.fulfill({
        json: {
          tag_name: "v0.0.0-test",
          html_url:
            "https://github.com/Skare69/velvarr/releases/tag/v0.0.0-test",
          published_at: "2026-11-21T09:00:00Z",
        },
      });
      return;
    }
    const target = new URL(url);
    if (
      target.protocol === "file:" ||
      (documentUrl.protocol !== "file:" && target.origin === documentUrl.origin)
    ) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  const page = await context.newPage();
  await page.goto(landingUrl, { waitUntil: "domcontentloaded" });
  return { page, context, release };
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
  const { page, release } = await openPage(t, { delayRelease: true });
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
  release();
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
