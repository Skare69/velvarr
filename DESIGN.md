---
name: Velvarr
description: Seerr-style media request app in a midnight-lobby dark theme
colors:
  marquee-magenta: "#ef3483"
  marquee-magenta-hover: "oklch(70% 0.21 1.08)"
  marquee-magenta-ink: "oklch(20% 0.06 1.08)"
  marquee-magenta-text: "oklch(82% 0.13 1.08)"
  marquee-magenta-soft: "oklch(33% 0.085 1.08)"
  plum-canvas: "oklch(17% 0.022 325)"
  plum-panel: "oklch(22.5% 0.028 325)"
  plum-raised: "oklch(27.5% 0.034 325)"
  plum-edge: "oklch(38% 0.04 325)"
  parchment-ink: "oklch(96.5% 0.006 325)"
  plum-muted: "oklch(80% 0.022 325)"
  mint-result: "oklch(86% 0.14 159.2)"
  mint-result-fill: "oklch(45% 0.12 159.2)"
  ember-danger: "oklch(80% 0.14 30)"
  signal-info: "oklch(80% 0.12 250)"
typography:
  body:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
  ui:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
  label:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 600
rounded:
  sm: "5px"
  md: "7px"
  lg: "10px"
spacing:
  sm: "0.5rem"
  md: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.marquee-magenta}"
    textColor: "{colors.marquee-magenta-ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.95rem"
  button-primary-hover:
    backgroundColor: "{colors.marquee-magenta-hover}"
  button-secondary:
    backgroundColor: "{colors.plum-raised}"
    textColor: "{colors.parchment-ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.95rem"
  button-danger:
    backgroundColor: "{colors.plum-raised}"
    textColor: "{colors.ember-danger}"
    borderColor: "color-mix(in srgb, {colors.ember-danger} 45%, {colors.plum-edge})"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.95rem"
  input:
    backgroundColor: "oklch(18.4% 0.024 325)"
    textColor: "{colors.parchment-ink}"
    rounded: "{rounded.md}"
    padding: "0.55rem 0.75rem"
  card:
    backgroundColor: "{colors.plum-panel}"
    textColor: "{colors.parchment-ink}"
    rounded: "{rounded.lg}"
  chip:
    backgroundColor: "{colors.plum-raised}"
    textColor: "{colors.plum-muted}"
    rounded: "{rounded.sm}"
    padding: "0.15rem 0.55rem"
  segmented:
    backgroundColor: "{colors.plum-raised}"
    textColor: "{colors.parchment-ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.95rem"
  segmented-selected:
    backgroundColor: "{colors.marquee-magenta-soft}"
    textColor: "{colors.marquee-magenta-text}"
---

# Design System: Velvarr

## Overview

**Creative North Star: "The Midnight Lobby."** Velvarr is a plum-dark room where the only light comes from the artwork on the walls. The magenta marquee marks every action; UI is architecture — quiet panels, measured tones, nothing brighter than the posters. Chrome chroma stays under 0.04 on hue 325 so artwork, not the interface, carries the color.

The system is Material-3 in its science and Seerr in its grammar: every color is a tone of one key color (`#ef3483` = oklch(63.7% 0.226 1.08)), lightness distances are the contrast mechanism (tone gap 50 for small text, 40 for large), and every pair is measured against WCAG (ink/canvas 17.3:1, muted/canvas 10.2:1, accent-text/canvas 10.0:1, accent/canvas 5.0:1 as shape, accent-ink/accent 4.8:1 as text). Neutrals rotate off the key hue to 325 because at the key's own hue a dark neutral reads brown, not plum.

## Colors

- **Marquee Magenta** `{colors.marquee-magenta}` — the one voice. Intent only: primary actions, focus rings, hover borders, selection. Its family: hover (lighter tone), ink (text on the fill), text (magenta for small text on dark, since the raw key is 4.1:1 — fine for shapes, short of text), soft (tinted surface).
- **Plum ramp** `{colors.plum-canvas}` → `{colors.plum-panel}` → `{colors.plum-raised}` → `{colors.plum-edge}` — the architecture: page, surface, raised control, 1px edge. Separation is tone distance plus the edge hairline, never shadow.
- **Parchment Ink** `{colors.parchment-ink}` / **Plum Muted** `{colors.plum-muted}` — text and secondary text.
- Status hues, spoken only by status: **Mint Result** (`ok`, availability/approval, with darker `ok-fill`), **Signal Info** (`info`, work in flight), **Ember Danger** (`danger`). Request statuses (requested/approved/available/declined/processing/paused) derive from these families so the poster badge and the request chip can never drift apart.

## Typography

System Segoe UI Variable stack — the platform voice, honest for an operator's tool. Body 15px/1.5; UI controls 0.875rem/600; labels 0.8rem/600 in muted. Headings balance with `text-wrap: balance`. No display face, no mono as costume: monospace appears only for code, data, or measurement.

## Layout

App shell: fixed sidebar (`--sidebar-width: 232px`), topbar (`--topbar-height: 76px`) with global search, main content area. Mobile: bottom nav bar plus a More sheet (native `<dialog>`); no hamburger. Breakpoints: ≤600px phone, ≤1023px shell collapses, ≥1800px widens. Detail pages anchor `scroll-padding-top` below the topbar. The URL is the state (`?view=…`).

## Elevation & Depth

**Earned Depth Rule:** flat by default, shadow on touch. Panels and cards separate by tone + 1px edge; shadows appear only on interaction (poster-card hover pop `0 6px 20px -4px rgb(0 0 0 / 0.5)`) or on true overlays (sheets/modals: `rgb(0 0 0 / 0.66)` backdrop on the More sheet and the preferences dialog, while the catalog drawer and the bulk/user dialogs use a canvas-toned scrim, `color-mix(in srgb, var(--color-canvas) 72%, transparent)`; 8px blur on the fixed footer bar). Nothing floats unbidden; depth is earned by touch. `::backdrop` + native dialog semantics carry the modal layer.

**Motion** is feedback, never decoration. Every transition uses the shared tokens in `:root`: `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`), `--dur-fast` (160ms, control feedback) and `--dur-base` (220ms, reveals and sheets). The skeleton sweep is the one linear loop. The global `prefers-reduced-motion` clamp shortens every animation and transition.

## Shapes

Quietly rounded, never pill-exuberant: chips and status badges 5px, buttons/inputs (the global search field too) 7px, panels/cards/dialogs/sheets 10px, skeleton 9px, icon buttons 8px. Form language is hairline borders on filled surfaces; focus is a 2px accent outline at 4px offset (`:focus-visible` only). Known exception: Discover's dense grids pull the offset in — 3px on the browse icon, 2px on tiles, scroll buttons, and shelf cards (`src/components/discover.css`) — so the outline survives the clipped tiles. Radius scale is small by design — the posters carry the drama, corners stay calm.

## Components

- **Buttons** (`.btn`): 38px min-height, secondary = raised on edge hairline; `.btn-accent` = marquee magenta fill with magenta-ink text; hover lightens via `color-mix`; active nudges down 1px; disabled at 0.45 opacity. **One accent per surface:** a screen, card group or dialog shows at most one filled button at a time. An action that repeats per row (Approve) stays secondary. Every request action speaks one language: accent fill plus the `plus` mark — the tile's Request, "Request this title", and "Request every movie/scene", which is the one decision of its own listing section (it confirms in a dialog first). A credential Save turns accent only while its input holds text. A pending action reads "Saving…" or "Requesting…" with `aria-busy`.
- **Destructive actions** (`.btn-danger`): Ember Danger as text on the raised fill, edge mixed 45% toward danger, hover tints the surface 12% toward danger. They never sit in the Save row: they live in their own row (`.settings-destructive-row`) below the content, and every press opens a confirmation `<dialog>` (`.bulk-dialog`) whose title names the object and whose buttons name both outcomes ("Keep credential" / "Clear credential", "Keep request" / "Cancel request"). Clear stored credential shows whenever a stored key exists, without Edit first.
- **Cards** (`.card`, `.media-card`): panel tone, 1px edge, 10px radius; hover turns the edge magenta and lifts the poster with shadow; the whole card is the click target (Seerr-style).
- **Inputs** (`.input`): canvas/panel mix fill, edge hairline; on focus the edge itself turns magenta and thickens to 2px (an inset ring), with no extra offset outline, so a field never shows two rings. Placeholders mixed from muted at 78%. A field error sits directly under its field with `aria-invalid` + `aria-describedby`, and `.input[aria-invalid="true"]` takes the danger edge. A form-level alert carries only server or network errors. Optional fields say "(optional)" in the muted label style; URL fields use `type="url"`.
- **Segmented choice** (`.segmented`): the control for 2–5 exclusive options, in place of a short dropdown. A `role="group"` of `aria-pressed` buttons under a visible label; an inline grid of `1fr` columns makes every segment as wide as the widest label; a narrow strip scrolls and never cuts a label. Selected = magenta-soft fill with magenta-text and weight 600. Longer option lists keep a labelled `<select>`.
- **Chips** (`.chip`): 5px radius labels. A passive state (Owner, Active, Not configured, a filter count) is the neutral chip; `.chip-accent` is only for intent. Request decisions use the status palette (`.state-badge[data-state]`).
- **Panels** (`.panel`): the generic surface; `.panel-error` mixes danger into the edge.
- **Missing or rejected keys:** one pattern everywhere (`NotConfiguredLine` in `src/components/discover.tsx`). A neutral "Not configured" chip, then "{Provider} has no API key on this server, so {consequence}: a missing credential, not an outage.", then for admins an underlined accent link "Add the key in Settings →" to `/?view=settings#provider-heading-{provider}`, and for others "Ask an administrator to add it in Settings." Partial failures above a filled rail (`.discovery-source-notes`) are slim rows with 0.875rem before the rail: the chip names the state ("Key rejected", "Unavailable"), the server message names the provider, and the action follows inline (Replace the key link, or Retry for a transient error).
- **Provider key cards** (Settings → Metadata providers): with no key, the editor stays open, offers no Cancel, and the heading carries one help line with an external link where the key comes from (opens in a new tab). With a key, the link hides and Edit opens the editor. A stored key that the provider rejects (HTTP 401 on a connection check) is deleted at once and the card says so in its status notice; environment keys are never deleted from the UI.
- **Settings card actions** (`.settings-card-actions`, every service card): the header carries no buttons and no second "Connection status" heading. Fields stay hidden until Edit; a card shows its fields without Edit only when it has nothing configured yet or a field error to fix. Everyday actions sit in one right-aligned row at the card's foot, below a hairline: Edit, or Save and Cancel while editing, then Check connection last. The reason a button is disabled sits right under the row. Destructive actions keep their own row below it.
- **Button icons** (settings card rows): every button carries a 1rem house icon before its label, never an icon alone: Edit = pencil (`edit`), Save = `check`, Cancel = `close`, Check connection = `refresh`, Clear stored credential = `trash`, Use environment settings = `undo`. One icon means one action everywhere; the icon side gets 0.75rem padding so the pair reads centered.
- **Filter drawer** (Browse → Filters): three groups with short uppercase titles and a hairline between them: Search (Title, Performer, Studio scope), Tags (Must have, Must not have, the hidden-tags note), Release (Year, Release date). Every search field leads with an icon that names what it searches (`.input-lead`): search, performer, `plus` for Must have, `minus` for Must not have. Selected tags use the same `.filter-chip` as the active-filter row (see below): `.is-include` with a mint "+" mark, `.is-exclude` with a "−" mark and a dashed edge, never color alone. The tag text is never struck through, because it must stay readable. Starred is the "Any performer / Starred only" segmented choice under the performer field. Long matching rules fold behind a "How matching works" disclosure (`.cat-help`) after the chips. An action inside running text is an underlined link-style button (`.cat-inline-link`), and a segment group that is too wide wraps into rows (`.segmented-wrap`). Detail-page tags, the studio, external links and related records use the same chip without a remove target.
- **Active filter chips** (above Browse results, `.filter-chips`): grouped by kind. Each group (`.filter-group`, panel tone, 10px radius) shows its name once in small uppercase (Title, Release, Performer, Studio, Tags, Sort), followed by value chips (`.filter-chip`, raised, 5px). Each chip is one remove button: a leading mark when it has one (★ for Starred, mint `plus` for must have, `minus` with a dashed edge for must not have), the value, then an × in its own small target. The accessible label names the full filter ("Remove filter: Tags: anal (must have)"). A "Clear all" link-style button ends the row.
- **Cast tiles** (detail page, `.cat-person` in `.performer-grid`): the same size, surface and hover as a poster tile: a 2:3 photo, a 1px light ring, a 1.04 zoom and a pop-out shadow on hover. The name sits inside the tile at the top on a darkening scrim, on one line with an ellipsis (the full name stays the button text and its tooltip). The Filter button appears at the foot like a poster's request action: on hover or keyboard focus, and on touch after the first tap (the shared tap reveal). On a detail page every tile grid uses one fixed 150px track, so cast and title tiles match exactly.
- **Performer hero** (`.performer-hero`): three columns on wide screens: the 2:3 photo (click to enlarge); the identity (name, a muted provenance line such as "TPDB and StashDB, linked by the providers", Follow, "Also known as", the bio clamped to two lines with "Read more", link chips); and the facts in their own panel (`.hero-facts`, shared with the title hero: canvas mix + 1px edge, 10px radius, label/value rows). When the providers link two records, the hero merges them TPDB first (`mergePerformerDetails`): one photo, unions of aliases and links, grouped facts never mixed. Below `lg` the facts drop under the identity; below `sm` everything stacks. Link chip text comes from `linkLabel` (`src/lib/links.ts`): a generic "Studio profile" shows its site ("elegantangel.com"), two links under one label show what differs ("onlyfans.com/jewelzblu"), and every other label stays as published. Section titles below the hero use the shelf title (`.discovery-shelf-title`) with the shelf rhythm (2.25rem). Tags show as columns of chips, name left and count right-aligned, the 30 most frequent first, with a "Most frequent / A–Z" choice (A–Z lists every tag) and "Show all N tags". Listings load whole grid rows and grow with "Show more". Sections load in parallel with the hero.
- **Connection status** (every service card: Jellyfin, Whisparr, TPDB, StashDB, AI matching): the `ConnectionState` chip sits beside the card title — Checking…, Connected (mint), Connection failed (danger), Not configured (neutral). Jellyfin and Whisparr add their server name and version in muted text while connected. A provider key card shows no account name and no "Stored credential" badge (a connected key is stored by default); only "From environment" is named, because it explains why no Clear button shows. A failure adds its ErrorPanel below, without a second Retry: "Check connection" in the editor is the retry.
- **Loading**: skeletons (`.skel`) stay invisible for the first second, then fade in, so a fast load shows nothing. Non-skeleton placeholders use `.delayed-reveal` for the same timing. Slow remote content shows a skeleton in its own shape (`RailSkeleton` for rails).
- **Navigation**: `.nav-btn` with `[aria-current="page"]` state; approval work shows as a real count badge, never an unnumbered dot, absent when empty, and "?" (named "Approval count unavailable") when the count could not be read. Settings tabs and mobile bottom-bar items share their strip in equal columns.
- **Sidebar collapse** (desktop): a quiet "Collapse" row (chevron + label) at the sidebar's foot, above the credit, toggles a 76px icon-only rail (`.app-shell.is-collapsed` sets `--sidebar-width`). A click on empty sidebar space toggles too; the button (`aria-expanded`) is the keyboard path. Collapsed, each nav item keeps its label for assistive tech and as its tooltip, the brand keeps its mark, the approval badge pins to the icon's corner, and the credit shows only the version (still linked to its release). The state is remembered per device.
- **Status**: one shared palette (`src/lib/status.ts` + `globals.css` status tokens) drives both poster badges and request chips.
- **Empty states** say why the area is empty and offer the next step ("Browse titles" to `/?view=titles`).

## Do's and Don'ts

**Do**

- Do express separation as tone distance + 1px edge (`color-mix` for blends).
- Do keep chrome chroma ≤ 0.04; let artwork be the only saturated thing.
- Do spend magenta only on intent: actions, focus, hover, selection — and at most one filled button per surface.
- Do underline links inside running text; color alone does not mark a link.
- Do keep prose to about 75ch (`max-width: 75ch`), and format visible counts with `Intl.NumberFormat`.
- Do measure contrast when touching color; the incumbents are documented pairs.
- Do respect `prefers-reduced-motion` (the global clamp stops shimmer and rises).

**Don't**

- Don't fake status, data, or availability — honesty is the product (`src/lib/status.ts` is the single source).
- Don't introduce a second accent hue or gradient text.
- Don't add ambient shadows under resting surfaces; depth is earned by touch.
- Don't replace the credit (bold Velvarr → repo, version → release) or the More-sheet mobile navigation.
- Don't use colored left/right borders above 1px, glass blur as decoration, or emoji as icons. The two blur exceptions are functional chrome, not decoration: the fixed topbar (`backdrop-filter: blur(12px)`) and the fixed footer bar (8px) blur scrolling artwork so their text stays legible.
