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

**Earned Depth Rule:** flat by default, shadow on touch. Panels and cards separate by tone + 1px edge; shadows appear only on interaction (poster-card hover pop `0 6px 20px -4px rgb(0 0 0 / 0.5)`) or on true overlays (sheets/modals: `rgb(0 0 0 / 0.66)` backdrop, 8px blur on the fixed footer bar). Nothing floats unbidden; depth is earned by touch. `::backdrop` + native dialog semantics carry the modal layer.

## Shapes

Quietly rounded, never pill-exuberant: chips 5px, buttons/inputs 7px, panels/cards 10px, skeleton 9px, icon buttons 8px. Form language is hairline borders on filled surfaces; focus is a 2px accent outline at 4px offset (`:focus-visible` only). Radius scale is small by design — the posters carry the drama, corners stay calm.

## Components

- **Buttons** (`.btn`): 38px min-height, secondary = raised on edge hairline; `.btn-accent` = marquee magenta fill with magenta-ink text; hover lightens via `color-mix`; active nudges down 1px; disabled at 0.45 opacity.
- **Cards** (`.card`, `.media-card`): panel tone, 1px edge, 10px radius; hover turns the edge magenta and lifts the poster with shadow; the whole card is the click target (Seerr-style).
- **Inputs** (`.input`): canvas/panel mix fill, edge hairline, magenta focus border; placeholders mixed from muted at 78%.
- **Chips** (`.chip`): 5px radius status/label pills; `.chip-accent` on magenta-soft.
- **Panels** (`.panel`): the generic surface; `.panel-error` mixes danger into the edge.
- **Navigation**: `.nav-btn` with `[aria-current="page"]` state; approval work shows as a real count badge, never an unnumbered dot, absent when empty.
- **Status**: one shared palette (`src/lib/status.ts` + `globals.css` status tokens) drives both poster badges and request chips.

## Do's and Don'ts

**Do**

- Do express separation as tone distance + 1px edge (`color-mix` for blends).
- Do keep chrome chroma ≤ 0.04; let artwork be the only saturated thing.
- Do spend magenta only on intent: actions, focus, hover, selection.
- Do measure contrast when touching color; the incumbents are documented pairs.
- Do respect `prefers-reduced-motion` (the global clamp stops shimmer and rises).

**Don't**

- Don't fake status, data, or availability — honesty is the product (`src/lib/status.ts` is the single source).
- Don't introduce a second accent hue or gradient text.
- Don't add ambient shadows under resting surfaces; depth is earned by touch.
- Don't replace the credit (bold Velvarr → repo, version → release) or the More-sheet mobile navigation.
- Don't use colored left/right borders above 1px, glass blur as decoration, or emoji as icons.
