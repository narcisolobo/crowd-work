# Style Guide

Visual identity direction for Crowd Work, developed and reviewed as an interactive mockup before any of it lands in the actual Astro/Tailwind implementation. This document is the token/spec reference; the mockup itself (light and dark, live filters, responsive down to mobile) is the visual source of truth if anything here is ambiguous.

## Concept

**Light:** a printed newsprint page — warm paper, ink, one marquee-gold light source. The layout borrows from alt-weekly classifieds pages, where this scene's mic and show listings used to actually live before the list that did that job died (see [crowd-work-vision.md](./crowd-work-vision.md)).

**Dark:** not a flat inversion. The house lights are down and the marquee is still lit — same warm-black-and-gold logic as the light theme, with the gold accent brightened so it actually glows against near-black instead of reading muddy.

Four working principles carried through both themes:

1. **Newsprint, not neon** — analog, dense, classifieds-style rows and rules, not SaaS cards and shadows.
2. **One warm light source** — marquee-gold is the only saturated color doing signaling work (the "this week" flag, active filters, links). Red is reserved exclusively for cancellations/urgent flags, so it always means something when it appears.
3. **Dense but legible** — real listing data (day, time, venue, cost) at real density, sized and contrasted to read one-handed, on a phone, in a dark room.
4. **No card, no gimmick** — rows and hairline rules, not tiles and drop shadows.

## Color

Colors are specified in OKLCH per token preference, with the sRGB hex used to build the mockup alongside for reference/fallback. Both themes share the same token names — only the values change — so components never hardcode a color, only a token.

### Light theme

| Token | OKLCH | Hex | Role |
|---|---|---|---|
| `--paper` | `oklch(0.937 0.013 95)` | `#EDEAE1` | Page background |
| `--paper-shadow` | `oklch(0.898 0.018 88)` | `#E2DDD0` | Ticket-stub fill, subtle elevation |
| `--ink` | `oklch(0.224 0.011 80)` | `#1E1B16` | Primary text |
| `--ink-soft` | `oklch(0.433 0.028 88)` | `#57503F` | Secondary text, metadata |
| `--rule` | `oklch(0.807 0.024 85)` | `#C7BFAE` | Hairline dividers, borders |
| `--gold` | `oklch(0.643 0.126 76)` | `#B8811E` | Accent fills (bulb dots, tab active state source) |
| `--gold-ink` | `oklch(0.525 0.104 76)` | `#8C6112` | Accent text/links |
| `--red` | `oklch(0.474 0.162 18)` | `#A32438` | Reserved for cancellations/urgent flags only |

### Dark theme

| Token | OKLCH | Hex | Role |
|---|---|---|---|
| `--paper` | `oklch(0.184 0.011 80)` | `#15120D` | Page background |
| `--paper-shadow` | `oklch(0.234 0.017 79)` | `#221D15` | Ticket-stub fill, subtle elevation |
| `--ink` | `oklch(0.929 0.017 83)` | `#EDE7DB` | Primary text |
| `--ink-soft` | `oklch(0.750 0.031 85)` | `#B7AD98` | Secondary text, metadata |
| `--rule` | `oklch(0.325 0.023 81)` | `#3A3327` | Hairline dividers, borders |
| `--gold` | `oklch(0.788 0.141 81)` | `#E8AF3F` | Accent fills — brightened vs. light theme so it glows on near-black |
| `--gold-ink` | `oklch(0.796 0.131 81)` | `#E7B34E` | Accent text/links |
| `--red` | `oklch(0.631 0.180 18)` | `#E1505E` | Reserved for cancellations/urgent flags only |

**Theme mechanics:** default to the system's `prefers-color-scheme`; a manual toggle sets an explicit override (`data-theme="light"` / `data-theme="dark"` on the root element) and persists it in `localStorage`, so an explicit choice survives reload and beats the system setting in either direction. Tokens are declared once for light in the bare `:root`, then redefined under a `prefers-color-scheme: dark` media query guarded against an explicit light override, then redefined again under `[data-theme="dark"]` so the toggle wins over system preference too.

**Soft accents:** where gold needs to read as present but not shout (e.g. the ticket stub's "this week" edge), blend it toward the current background rather than introducing a new token: `color-mix(in srgb, var(--gold) 60%, var(--paper) 40%)`. This stays correctly toned down in both themes automatically, since it always mixes against whichever `--paper` is currently active.

## Typography

| Role | Typeface | Notes |
|---|---|---|
| Display — wordmark, section headers, listing titles | **Big Shoulders Display** (weights 600/700/900) | Condensed, poster/marquee character. Used with `text-wrap: balance`. |
| Body — descriptions, metadata, nav, form labels | **IBM Plex Sans** (weights 400/500/600) | Legible at small sizes on a phone in a dark room. |
| Tabular data — the time column only | **IBM Plex Mono** (weights 500/600) | Narrow, deliberate use: keeps times aligned down a scannable column. Not used decoratively anywhere else. |

Loaded via Google Fonts:
```
https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;900&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap
```

**Caps usage is deliberately rare and specific**, not a decorative default: the day/month in a ticket stub (`TUE` / `SEP`), the mic/show type tag, and the type-filter tabs (`MICS` / `SHOWS`) — all styled after physical marquee-letterboard and ticket-stub conventions, which are themselves capitals. Everything else (titles, venue names, body copy, nav links) stays sentence case.

## Layout

- **Content column:** `max-width: 720px`, centered, left-aligned throughout (classifieds convention; also the best default for one-handed scanning on mobile).
- **Listing rows:** a 4-column grid (`stub | time | title | price`) divided by hairline rules — no cards, no shadows, no rounded corners on the rows themselves.
- **Breakpoints:**
  - `≤600px` — rows reflow to `stub | title | price` on top and `stub | time` (spanning full width) below. Price stays pinned level with the title at every width; only `time` relocates.
  - `≤480px` — the "Browse" nav link hides, "Submit a listing" shortens to "Submit," and the theme switcher's text label hides, leaving just the bulb icon.
- **Reflow at high zoom:** built with relative units (`rem`, `clamp()`) throughout, no fixed-width containers, no absolute positioning, and `min-width: 0` on the flexible title column to avoid the CSS Grid trap where a spanning item forces horizontal overflow. This matters concretely: a moderator on the team navigates at 400%+ browser zoom (see `PRODUCT.md`'s Accessibility & Inclusion section) — the layout needs to reflow to a single readable column at that zoom level, not just "look responsive" at a few preset widths.

## Components

**Sticky header** — persistent across all pages (not just the homepage hero), `position: sticky; top: 0`. Holds the logo (mic icon mark + "Crowd Work" wordmark), primary nav ("Browse," "Submit a listing"), and the theme switcher.

**Icon mark** — a simple inline-SVG mic silhouette in `--ink`, with a small `--gold` dot standing in for an "on-air" light. Built from basic shapes (rect, path, circle), not traced artwork, so it stays crisp at favicon scale and re-themes automatically through the same CSS tokens as everything else.

**Theme switcher** — styled as a bulb toggle ("Lights on" / "Lights off") rather than a generic sun/moon icon, keeping it inside the marquee vocabulary instead of a borrowed one.

**Homepage masthead** — the big editorial hero, separate from the persistent header: wordmark at display scale, today's date, a one-line tagline, and a real (not decorative) count of listings found for the current filter — grounds the page in actual data on load rather than marketing copy.

**Ticket stub** — the date block at the left of each listing row (day/date/month stacked, `--paper-shadow` fill). Gets a `--gold`-mixed left edge only when the listing's occurrence date falls inside the same 7-day window the homepage already uses as its default browse range (`rangeStart = today`, `rangeEnd = today + 7`, computed in `src/pages/index.astro`) — this should be a computed condition against that same range in the real implementation, not a second, separately-invented threshold.

**Type tag / filter tabs** — small caps chips (`MIC` / `SHOW` on rows; `ALL` / `MICS` / `SHOWS` as filter tabs). The active filter tab inverts to `--ink` background / `--paper` text — which, in dark mode, reads as a spotlight hitting the selected tab, a side effect of building from tokens rather than hardcoded colors.

## Accessibility notes

- No formal standard adopted yet, but one validated, specific need exists — see `PRODUCT.md`. Design and build against it directly rather than generic best practice alone.
- Visible focus states on all interactive elements (`:focus-visible` outline in `--gold-ink`).
- `prefers-reduced-motion` respected — the one transition in the system (row opacity) is gated behind `(prefers-reduced-motion: no-preference)`.
- Semantic color (the red reserved for cancellations) is kept separate from the accent hue (gold) so state and brand never compete for the same meaning.

## Reference

Live interactive mockup (light/dark, working filters, responsive): see the Crowd Work identity artifact shared earlier in this project's design conversation. Treat it as the rendered reference; this document is the extracted token/spec version of it.
