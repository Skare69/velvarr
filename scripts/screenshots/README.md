# Landing-page screenshots

The landing page (`site/index.html`) shows seven app screenshots in
`site/shots/`. This script makes them again from the current app, so
the page can show a newer version without manual capture work.

## Concept

- The script captures the real UI. It starts a production build with
  `next start` on a temporary data directory.
- The script makes up all of the data. Chromium sends each `/api/*`
  call to the demo answers in `demo.mjs` and in the screen file in
  `screens/`. The app gets no real server, provider, or Jellyfin data.
- All names, titles, and studios are invented and safe for work.
- The pictures (posters, portraits, and the avatar) are files in the art
  folder. The app loads them through its own image proxy
  (`/api/catalog/image`), so the cards show them as provider art.
- Each screen file sets the view URL, the viewport, the clip, and the
  steps that put the screen in its state (for example, it opens the
  filter drawer).
- Screens that show one page (not the shell) hide the fixed top bar
  with a style tag, so the shot starts at the page heading.
- The script writes each WebP at the size that `site/index.html` sets
  for that image. The file names stay the same.
- The clock is fixed (`NOW` in `demo.mjs`), so relative times such as
  "5 hours ago" do not change between runs.
- A screen fails when the app calls an `/api/*` path that no demo answer
  knows, or when the page throws an error. Thus a new endpoint in the
  app shows as a clear error, not as a broken picture.

| Screen file | Output | Shows |
| --- | --- | --- |
| `discover` | `discover.webp` 2000×1250 | Discover shelves, desktop |
| `discover-mobile` | `discover-mobile.webp` 780×1688 | Discover on a phone |
| `browse-filters` | `browse-filters.webp` 1555×1800 | Browse with the filter drawer open |
| `prose` | `prose.webp` 1800×957 | Natural-language search, applied |
| `performer` | `performer.webp` 1800×1010 | Performer page |
| `requests` | `requests.webp` 1800×1226 | Requests with approvals |
| `detail-movie` | `detail-movie.webp` 1800×1010 | Movie page, available |

## Art files

Put one image for each name in `scripts/screenshots/art/` (WebP, PNG, or
JPEG; the file name is the name plus the extension). Use posters in a
2:3 portrait ratio and portraits in 3:4, at a minimum of 600 px wide.
The script stops and lists each missing name. `ART` in `demo.mjs` is
the full list with a short description of each picture:

- Scenes: `scene-city-lace`, `scene-bath`, `scene-pool`,
  `scene-fireplace`, `scene-club`, `scene-beach`, `scene-yoga`,
  `scene-lounge`, `scene-neon`, `scene-boudoir`
- Movies: `movie-lisbon`, `movie-motel`, `movie-corset`, `movie-robes`,
  `movie-beach`, `movie-sofa`, `movie-street`
- People: `performer-aria-vale`, `performer-dane-mercer`,
  `performer-sasha-bloom`, `avatar-admin`

Use only safe-for-work images that you have the right to publish. The
first set came from ComfyUI (DreamShaper XL Turbo).

## Run

1. Install the dependencies: `bun install --frozen-lockfile`.
2. Use Windows, or a machine with the Segoe UI fonts. The app has no
   web font and asks for Segoe UI first. The script stops when the font
   is missing. For a test run only, add `--allow-font-fallback`.
3. If Playwright has no Chromium, install it with
   `bunx playwright install chromium`. To use an installed Chrome, set
   `PLAYWRIGHT_CHANNEL=chrome`.
4. Build the app: `bun run build`.
5. Make the screenshots: `bun run shots`.

Options (put them after `--`, for example `bun run shots -- --only prose`):

- `--only <names>`: make only these screens (comma-separated).
- `--art <dir>`: read the art from a different folder.
- `--out <dir>`: write the images to a different folder (the default is
  `site/shots`).
- `--port <port>`: the port for `next start` (the default is 16760).
- `--allow-font-fallback`: continue without Segoe UI (test runs only).

## Check the result

1. Compare each new image with the old one, for example with
   `git diff --stat site/shots` and an image viewer.
2. Open `site/index.html` in a browser and look at each image.
3. If the app has a new screen or a changed layout, change the screen
   file or the demo data, and run the script again.
