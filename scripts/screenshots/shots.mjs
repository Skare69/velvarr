#!/usr/bin/env node
// Rebuilds the landing-page screenshots in site/shots from the current app
// build. See scripts/screenshots/README.md for the concept and the art set.
//
//   bun run build && bun run shots [-- --only discover,prose] [--art dir]
//
// The script starts `next start` on a throwaway data dir, opens each screen
// in Chromium with every /api/* call answered from scripts/screenshots/demo.mjs
// and the screen's own handler, then writes the WebP at the exact size the
// landing page declares for it.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { ART, ART_HOST, NOW, commonApi } from "./demo.mjs";

const SCREENS = [
  "discover",
  "discover-mobile",
  "browse-filters",
  "prose",
  "performer",
  "requests",
  "detail-movie",
];

const { values: args } = parseArgs({
  options: {
    art: { type: "string", default: "scripts/screenshots/art" },
    out: { type: "string", default: "site/shots" },
    only: { type: "string" },
    port: { type: "string", default: "16760" },
    "allow-font-fallback": { type: "boolean", default: false },
    // The checkout whose build the shots show: the latest release, not main.
    app: { type: "string", default: "." },
    "allow-untagged": { type: "boolean", default: false },
  },
});

const fail = (message) => {
  console.error(`shots: ${message}`);
  process.exit(1);
};

const appDir = resolve(args.app);
if (!existsSync(join(appDir, ".next/BUILD_ID")))
  fail(`no production build in ${appDir}. Run \`bun run build\` there first.`);

// The landing page links the latest release, so the shots must show its UI.
const git = (...a) =>
  execFileSync("git", ["-C", appDir, ...a], { encoding: "utf8" }).trim();
const latest = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0];
const headTags = git("tag", "--points-at", "HEAD", "--list", "v*").split("\n");
if (!headTags.includes(latest) && !args["allow-untagged"])
  fail(
    `${appDir} is not at the latest release ${latest}. Check out ${latest} ` +
      "(`git fetch --tags` first), build it, and pass --app <dir>. " +
      "Use --allow-untagged for a test run.",
  );

const artDir = resolve(args.art);
const artFiles = new Map();
if (existsSync(artDir))
  for (const f of readdirSync(artDir)) {
    const ext = extname(f).toLowerCase();
    if ([".webp", ".png", ".jpg", ".jpeg"].includes(ext))
      artFiles.set(f.slice(0, -ext.length), join(artDir, f));
  }
const missing = Object.keys(ART).filter((name) => !artFiles.has(name));
if (missing.length)
  fail(
    `${missing.length} art file(s) missing in ${artDir}:\n` +
      missing.map((n) => `  ${n}  (${ART[n]})`).join("\n") +
      "\nSee scripts/screenshots/README.md.",
  );

// An empty or broken file would only show as a letter fallback in a card.
const broken = [];
for (const [name, file] of artFiles)
  if (name in ART)
    await sharp(file)
      .stats()
      .catch((e) => broken.push(`  ${file}: ${e.message}`));
if (broken.length) fail(`art file(s) do not decode:\n${broken.join("\n")}`);

const names = args.only ? args.only.split(",") : SCREENS;
for (const n of names)
  if (!SCREENS.includes(n)) fail(`unknown screen "${n}"; known: ${SCREENS}`);

const contentType = { ".webp": "image/webp", ".png": "image/png" };
function artResponse(url) {
  const name = url.startsWith(ART_HOST) ? url.slice(ART_HOST.length) : null;
  const file = name && artFiles.get(name);
  if (!file) return null;
  return {
    status: 200,
    contentType: contentType[extname(file).toLowerCase()] ?? "image/jpeg",
    body: readFileSync(file),
  };
}

const origin = `http://127.0.0.1:${args.port}`;
// Another server on the port would answer our fetches and end up in the
// shots, so the port must be free before our own server takes it.
await new Promise((done) => {
  const probe = createServer()
    .once("error", (e) =>
      fail(`port ${args.port} is not free (${e.code}). Use --port.`),
    )
    .listen(Number(args.port), "127.0.0.1", () => probe.close(done));
});
let stopping = false;
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    args.port,
  ],
  {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: appDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      VELVARR_DATA_DIR: mkdtempSync(join(tmpdir(), "velvarr-shots-")),
      VELVARR_SECRET_KEY: randomBytes(32).toString("hex"),
      VELVARR_SETUP_SECRET: randomBytes(32).toString("hex"),
    },
  },
);
server.once("exit", (code) => {
  if (!stopping) fail(`next start exited (code ${code}).`);
});
const stopServer = () => {
  stopping = true;
  if (server.exitCode === null) server.kill("SIGTERM");
};
process.on("exit", stopServer);

/** Resolves when our own `next start` prints its ready line; a server that
 * exits first (for example on EADDRINUSE) fails the run in the exit hook. */
function waitForServer() {
  return new Promise((ready) => {
    const timer = setTimeout(
      () => fail(`next start was not ready after 60 s.`),
      60_000,
    );
    let log = "";
    server.stdout.on("data", (chunk) => {
      if (log === null) return;
      log += chunk;
      if (/Ready in/.test(log)) {
        log = null;
        clearTimeout(timer);
        ready();
      }
    });
  });
}

/** Routes every /api/* call: the art proxy, then the shared answers, then
 * the screen's own. An unanswered call fails the shot, so a new endpoint in
 * the app shows up here instead of as a silently broken picture. */
async function routeApi(screen, unanswered, route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/catalog/image") {
    const image = artResponse(url.searchParams.get("url") ?? "");
    if (image) return route.fulfill(image);
  }
  if (url.pathname.startsWith("/api/me/avatar")) {
    const image = artResponse(`${ART_HOST}avatar-admin`);
    return route.fulfill(image);
  }
  const call = {
    method: request.method(),
    path: url.pathname,
    query: url.searchParams,
    body: request.postDataJSON?.() ?? null,
  };
  const answer = screen.api?.(call) ?? commonApi(call);
  if (answer === undefined) {
    unanswered.add(`${call.method} ${url.pathname}${url.search}`);
    return route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "shots_unanswered", message: "No demo answer." },
      }),
    });
  }
  return route.fulfill({
    status: answer.__status ?? 200,
    contentType: "application/json",
    body: JSON.stringify(answer.__body ?? answer),
  });
}

/** Waits for the fonts and for every image in view (a lazy image under the
 * fold never loads), so no shot catches a half-drawn card. */
async function settle(page) {
  await page.waitForLoadState("networkidle");
  const { pending, broken } = await page.evaluate(async () => {
    await document.fonts.ready;
    const inView = (img) => {
      const r = img.getBoundingClientRect();
      return (
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth
      );
    };
    const waiting = [...document.images].filter(
      (img) => !img.complete && (img.loading !== "lazy" || inView(img)),
    );
    const loaded = Promise.all(
      waiting.map((img) => new Promise((r) => (img.onload = img.onerror = r))),
    );
    const timeout = new Promise((r) => setTimeout(r, 15_000));
    await Promise.race([loaded, timeout]);
    // complete with no natural size = a load or decode failure.
    const visible = [...document.images].filter(
      (img) => img.loading !== "lazy" || inView(img),
    );
    return {
      pending: waiting.filter((img) => !img.complete).map((img) => img.src),
      broken: visible
        .filter((img) => img.complete && img.src && img.naturalWidth === 0)
        .map((img) => img.src),
    };
  });
  // Images whose error handler already swapped them for a fallback.
  const failed = await page.evaluate(() => window.__shotsImageErrors);
  if (pending.length)
    throw new Error(
      `images still loading after 15 s:\n  ${pending.join("\n  ")}`,
    );
  const bad = [...new Set([...broken, ...failed])];
  if (bad.length)
    throw new Error(`images failed to load:\n  ${bad.join("\n  ")}`);
  await page.waitForTimeout(300);
}

/** The app has no web font: it asks for "Segoe UI Variable" / "Segoe UI"
 * (Windows) first. Without them, the browser falls back to a host font and
 * every text line changes, so the shot no longer matches the landing page. */
async function checkFont(page) {
  const found = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    const width = (font) => {
      ctx.font = font;
      return ctx.measureText("Velvarr requests 0123456789").width;
    };
    return ['"Segoe UI Variable"', '"Segoe UI"'].some(
      (f) =>
        width(`20px ${f}, monospace`) !== width("20px monospace") ||
        width(`20px ${f}, serif`) !== width("20px serif"),
    );
  });
  if (!found && !args["allow-font-fallback"])
    throw new Error(
      "Segoe UI is not installed, so the text would use a fallback font. " +
        "Run on Windows, or pass --allow-font-fallback for a test run.",
    );
}

async function shoot(browser, name) {
  const screen = (await import(`./screens/${name}.mjs`)).default;
  const context = await browser.newContext({
    viewport: screen.viewport,
    deviceScaleFactor: screen.scale,
    isMobile: Boolean(screen.mobile),
    hasTouch: Boolean(screen.mobile),
    reducedMotion: "reduce",
    colorScheme: "dark",
    // The landing page is English; the host Chrome would otherwise use the OS locale.
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  // Image errors do not bubble, so listen in the capture phase from the start.
  await page.addInitScript(() => {
    window.__shotsImageErrors = [];
    addEventListener(
      "error",
      (e) => {
        if (e.target instanceof HTMLImageElement)
          window.__shotsImageErrors.push(e.target.src);
      },
      true,
    );
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const unanswered = new Set();
  await page.route("**/api/**", (route) => routeApi(screen, unanswered, route));
  await page.goto(origin + screen.url);
  await checkFont(page);
  await screen.prepare?.(page);
  await settle(page);
  const target = screen.clip ? page.locator(screen.clip).first() : page;
  const png = await target.screenshot({ animations: "disabled" });
  await context.close();
  if (unanswered.size)
    throw new Error(
      `${name}: unanswered API calls:\n  ${[...unanswered].join("\n  ")}`,
    );
  if (errors.length)
    throw new Error(`${name}: page errors:\n  ${errors.join("\n  ")}`);
  const file = join(args.out, `${name}.webp`);
  await sharp(png)
    .resize(screen.width, screen.height, { fit: "cover", position: "top" })
    .webp({ quality: 82 })
    .toFile(file);
  console.log(`shots: wrote ${file} (${screen.width}x${screen.height})`);
}

mkdirSync(args.out, { recursive: true });
await waitForServer();
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
});
let failed = false;
try {
  for (const name of names) {
    try {
      await shoot(browser, name);
    } catch (e) {
      failed = true;
      console.error(`shots: ${e instanceof Error ? e.message : e}`);
    }
  }
} finally {
  await browser.close();
  stopServer();
}
process.exit(failed ? 1 : 0);
