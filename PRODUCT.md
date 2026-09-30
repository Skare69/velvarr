# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The operator (admin) and household members on a homelab LAN. The operator configures providers and accounts, works approval queues, and runs releases. Household members discover, request, and watch. The job: pick something to watch — a movie (TPDB) or a scene (StashDB) — request it, and have it land in Jellyfin without touching download tools.

## Product Purpose

Velvarr is a Seerr-style discovery and request app over TPDB (movies), StashDB (scenes), Whisparr V3 (acquisition), and Jellyfin (identity, library, playback). Success: a request goes from browse to playable in Jellyfin with the operator touching as little as possible, and every status on screen is the real status.

## Positioning

A request app that honestly spans adult + mainstream (StashDB/TPDB; TMDB deliberately excluded by standing permission decision) and refuses to fake data: cross-provider identity comes only from links the providers themselves publish (`crossProviderLink`), never name matching; badges show real state; a failing source degrades with a named error; an id with no known name is shown as an id.

## Operating Context

Self-hosted homelab, always-on. Production: Whisparr `192.168.50.246:6969`, Jellyfin `:8096`, Velvarr `:6699`. Used on desktop and mobile web over LAN. Releases ship via Conventional Commits; the operator triggers releases from Ottr.

## Capabilities and Constraints

- Discovery/browse, catalog detail, requests and approvals, follows, library, settings, admin accounts.
- Removal feature ships flag-disabled (`VELVARR_ENABLE_REMOVAL=1`); never enable without operator fixtures.
- Honesty rules are product law: absent upstream fields are dropped, partial success never reads as complete, status derives from real state (`src/lib/status.ts`).
- Shared logic in `src/lib/` is React-free; UI in `src/components/`; the URL is the state (`?view=…`).
- Mobile navigation is a bottom bar plus a More sheet — no hamburger.

## Brand Commitments

- Name: Velvarr.
- The credit is user-specified and fixed: bold "Velvarr" linking to the repo, then `v{version}` in normal weight linking to that GitHub release; foot of the desktop sidebar and the mobile More sheet; fixed bar only on screens without the shell.
- WCAG 2.1 AA is the standing contrast bar; the incumbent CSS measures and documents its pairs.

## Evidence on Hand

Provider data (artwork, metadata, cross-links) comes live from TPDB/StashDB at runtime; the operator's real library lives in the homelab DB, not the repo. No testimonials, press, or benchmarks exist — future work must not fabricate any.

## Product Principles

- Truth over polish: a real status that looks plain beats a pretty fiction.
- The artwork carries the color; the chrome stays quiet and dark.
- Approve once, watch anywhere: the pipeline (request → Whisparr → Jellyfin) is the product.
- Familiar Seerr grammar, own world: recognizable request-app patterns, honestly filled.

## Accessibility & Inclusion

WCAG 2.1 AA contrast (measured, documented in `globals.css`); visible `:focus-visible` rings; `prefers-reduced-motion` respected; native `<dialog>` semantics for sheets/modals; skip link and landmark focus handling.
