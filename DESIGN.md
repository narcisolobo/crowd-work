---
name: Crowd Work
description: A printed classifieds page lit by one marquee bulb — analog, dense, and honest about what's showing tonight.
colors:
  paper: "oklch(0.937 0.013 95)"
  paper-shadow: "oklch(0.898 0.018 88)"
  ink: "oklch(0.224 0.011 80)"
  ink-soft: "oklch(0.433 0.028 88)"
  rule: "oklch(0.807 0.024 85)"
  marquee-gold: "oklch(0.643 0.126 76)"
  marquee-gold-ink: "oklch(0.525 0.104 76)"
  cancellation-red: "oklch(0.474 0.162 18)"
typography:
  display:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "clamp(2.4rem, 8vw, 3.6rem)"
    fontWeight: 900
    lineHeight: 0.9
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "1.28rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: "IBM Plex Sans, -apple-system, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Sans, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.65rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.05em"
  mono:
    fontFamily: "IBM Plex Mono, SF Mono, monospace"
    fontSize: "0.92rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "normal"
rounded:
  sm: "4px"
  full: "9999px"
components:
  filter-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "7px 16px"
  filter-tab-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "7px 16px"
  type-tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  ticket-stub:
    backgroundColor: "{colors.paper-shadow}"
    rounded: "{rounded.sm}"
    padding: "6px 2px"
  area-select:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 28px 7px 10px"
  theme-toggle:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.full}"
    padding: "5px 12px 5px 8px"
---

# Design System: Crowd Work

## Overview

**Creative North Star: "The Newsprint Marquee"**

Crowd Work is a printed classifieds page lit by one marquee bulb. In daylight it reads as warm newsprint — paper, ink, hairline rules, the alt-weekly listings page this scene lost when its predecessor collapsed. After dark, the same page doesn't invert to a generic "dark mode"; the house lights go down and the marquee stays lit, so the gold accent brightens to actually glow against near-black instead of the whole page just flipping polarity.

The voice throughout is deliberate, unhurried, and matter-of-fact. Nothing on this page is trying to create urgency or manufacture excitement — it presents real listing data (day, time, venue, cost) at real density and trusts the reader to scan it, the way a person actually reads a classifieds page. This is a conscious rejection of default SaaS visual language: no cards, no drop shadows, no neon gradients, no rounded-corner tiles floating on colored backgrounds. Rows and rules instead of cards and shadows.

**Key Characteristics:**
- Warm paper-and-ink palette in light mode; true near-black with the same warm undertone in dark mode — not an inverted palette
- Exactly one saturated accent color (marquee gold) doing all non-error signaling work
- Condensed poster/marquee display type paired with a legible small-size body face
- A narrow monospace column reserved for one job: aligning times
- Flat throughout — depth comes from a background tint and hairline rules, never a box-shadow

## Colors

Warm, low-saturation neutrals carry almost the entire page; a single gold accent is the only color allowed to mean something when it appears.

### Primary
- **Marquee Gold** (`oklch(0.643 0.126 76)` light / `oklch(0.788 0.141 81)` dark — CSS var `--gold`): the on-air bulb. Used for accent fills — the ticket stub's "this week" edge, the "This week" flag dot, active-state signaling — and nowhere decoratively.
- **Marquee Gold Ink** (`oklch(0.525 0.104 76)` light / `oklch(0.796 0.131 81)` dark — CSS var `--gold-ink`): the same gold family tuned for text-on-paper contrast. Used for links, the listing-count number, and the "This week" label text.

### Neutral
- **Paper** (`oklch(0.937 0.013 95)` light / `oklch(0.184 0.011 80)` dark — CSS var `--paper`): page background in both themes.
- **Paper Shadow** (`oklch(0.898 0.018 88)` light / `oklch(0.234 0.017 79)` dark — CSS var `--paper-shadow`): the ticket stub's fill and the system's only elevation device — a tonal shift, never a box-shadow.
- **Ink** (`oklch(0.224 0.011 80)` light / `oklch(0.929 0.017 83)` dark — CSS var `--ink`): primary text, and the fill color for an active filter tab.
- **Ink Soft** (`oklch(0.433 0.028 88)` light / `oklch(0.750 0.031 85)` dark — CSS var `--ink-soft`): secondary text and metadata — venue meta lines, timestamps, inactive tab labels.
- **Rule** (`oklch(0.807 0.024 85)` light / `oklch(0.325 0.023 81)` dark — CSS var `--rule`): every hairline divider and default border. The only border color in the system outside active/focus states.

### Reserved (status-only, never decorative)
- **Cancellation Red** (`oklch(0.474 0.162 18)` light / `oklch(0.631 0.180 18)` dark — CSS var `--red`): reserved exclusively for cancellation and urgent-change flags. Not yet consumed anywhere in the shipped UI — no cancellation feature exists yet — but the token exists precisely so that when one is built, it doesn't reach for gold or invent a new color.

### Named Rules
**The One Voice Rule.** Marquee Gold is the only saturated color permitted to do signaling work — the "this week" flag, active filters, links. If a second accent starts creeping in, that's a violation, not a design choice.

**The Red Line Rule.** Cancellation Red never appears for anything except a cancellation or urgent time-sensitive change. It is never used as a second decorative accent, a hover state, or an error-adjacent convenience color.

**Soft accents mix, they don't add tokens.** Where gold needs to read as present but not shout (the ticket stub's "this week" edge), blend it toward the current background instead of inventing a token: `color-mix(in srgb, var(--gold) 60%, var(--paper) 40%)`. This stays correctly toned down in both themes automatically because it always mixes against whichever `--paper` is currently active.

## Typography

**Display Font:** Big Shoulders Display (with Arial Narrow, sans-serif fallback)
**Body Font:** IBM Plex Sans (with -apple-system, Segoe UI, sans-serif fallback)
**Label/Mono Font:** IBM Plex Mono (with SF Mono, monospace fallback)

**Character:** A condensed, poster/marquee-letterboard display face set against a plain, highly legible body face — the pairing of a hand-set marquee sign and the newsprint column underneath it.

### Hierarchy
- **Display** (900, `clamp(2.4rem, 8vw, 3.6rem)`, line-height 0.9): the wordmark only — the homepage masthead's "Crowd Work."
- **Title** (700, 1.28rem, line-height 1.2): listing titles, and the sticky header's brand name at a smaller size.
- **Body** (400–600, ~0.86–1.02rem, line-height 1.5): descriptions, venue lines, metadata, nav links, form labels. Weight steps up to 600 for emphasis (the listing count, footer's "See something wrong?").
- **Label** (Body face, 600, 0.65rem, letter-spacing 0.05em, uppercase): the type-tag chip and the ticket-stub day/month.
- **Label (Display variant)** (Display face, 700, 0.95rem, letter-spacing 0.025em, uppercase): the filter tabs — the same small-caps *treatment* as Label, but set in the heavier Display face rather than Body, matching their role as the page's most prominent control.
- **Mono** (500–600, ~0.85–1.15rem, tabular-nums): the time column and the ticket-stub date number only.

### Named Rules
**The Mono Discipline Rule.** IBM Plex Mono is used for exactly one job: keeping times and stub dates aligned down a scannable column. It never appears decoratively anywhere else in the system.

**The Marquee Caps Rule.** Small caps are deliberately rare and specific: the ticket stub's day/month, the mic/show type tag, and the type-filter tabs — all styled after physical marquee-letterboard and ticket-stub conventions, which are themselves capitals. Everything else (titles, venue names, body copy, nav links) stays sentence case. A new component reaching for uppercase text needs to justify it against this list, not just "it looks bold."

## Layout

Single content column, `max-width: 720px`, centered, left-aligned throughout — a classifieds-page convention that also happens to be the best default for one-handed scanning on a phone. A persistent sticky header (`position: sticky; top: 0`) sits outside that column at full width; everything else lives inside it.

Listing rows are a 4-column grid (`stub | time | title | price`, track widths `60px 78px 1fr auto`) divided by hairline rules — no cards, no shadows, no rounded corners on the rows themselves. At `≤600px` the grid reflows to `stub | title | price` on top with `stub | time` (time spanning full width) below; price stays pinned level with the title at every width, only time relocates. At `≤480px` the header's "Browse" link hides, "Submit a listing" shortens to "Submit," and the theme switcher's text label hides to just the bulb icon.

Everything is built from relative units (`rem`, `clamp()`) with no fixed-width containers and no absolute positioning, and the listing title column carries `min-width: 0` to avoid the CSS Grid trap where a spanning item forces horizontal overflow. This is a durable product constraint, not a nice-to-have: a moderator on the team navigates at 400%+ browser zoom, and the layout must reflow to a single readable column at that zoom level rather than merely "looking responsive" at a few preset widths.

## Elevation & Depth

Flat throughout. There is no `box-shadow` anywhere in the system — depth and grouping are conveyed entirely through a tonal background shift (`--paper-shadow`, the ticket stub's fill) and hairline `1px` rules, plus one deliberately heavier `3px` ink border under the homepage masthead to anchor it as the page's one structural anchor point.

### Named Rules
**The No Card, No Gimmick Rule.** Rows and hairline rules do the work that cards and drop shadows would do elsewhere. If a new component reaches for a shadow or a rounded card container to show grouping or elevation, that's the wrong tool in this system — reach for a tonal background or a rule instead.

## Shapes

Two shape languages coexist deliberately. Structural controls (filter tabs, the type tag, the area select, the ticket stub) get a small, consistent `4px` radius — present enough to read as a control, not enough to soften the page's flat, printed character. Anything meant to read as a light source or a toggle (the theme-switcher pill, the brand mark's on-air dot, the "this week" flag dot) is fully circular (`border-radius: 9999px` / `50%`). Everything else — rows, dividers, the masthead border — is sharp-edged with no radius at all; the ticket stub's signature device is a `3px` solid (or gold-mixed, when the listing falls within the "this week" window) left border, not a corner treatment.

## Components

Controls throughout are tactile and confident: small in footprint, but state changes are deliberate and legible rather than subtle. An active filter tab doesn't just get a tint — it fully inverts to an ink-filled block, reading as a firm, weighted choice rather than a hover-adjacent hint.

### Buttons / Filter Tabs
- **Shape:** `4px` radius, `1px` border
- **Inactive:** transparent background, `--rule` border, `--ink-soft` text, uppercase Display-face label at 0.95rem
- **Active:** fully inverts — `--ink` background, `--ink` border, `--paper` text. In dark mode this inversion reads as a literal spotlight hitting the selected tab, a side effect of building from tokens rather than hardcoded colors.
- **Progressive enhancement:** tabs are real `<button type="submit">` elements inside a `<form method="get">`, so filtering works via full page reload with no JavaScript; a client script intercepts the click, filters instantly, and syncs the URL via `history.pushState` when JS is available.

### Chips (Type Tag)
- **Style:** transparent background, `--rule` 1px border, `--ink-soft` text, `4px` radius, uppercase label type at 0.65rem
- **State:** static — reads "Mic" or "Show," no interactive states

### Listing Row (this system's container — deliberately not a card)
- **Corner Style:** none; sharp-edged
- **Background:** none — sits directly on `--paper`
- **Shadow Strategy:** none — see Elevation & Depth
- **Border:** a single `1px --rule` line beneath each row; no side or top borders
- **Internal Padding:** `22px` vertical, `18px` column gaps

### Inputs / Fields (Area Select)
- **Style:** `--rule` 1px border, `--paper` background, `4px` radius, native browser `appearance` disabled in favor of a custom `--ink-soft` SVG chevron (the native OS-drawn caret doesn't track this system's theme tokens and can go invisible against an explicit dark override)
- **Focus:** `2px` solid `--gold-ink` outline with `2px` offset, applied consistently to every focusable control via `:focus-visible`

### Navigation
- **Sticky header:** persistent across all pages, `position: sticky; top: 0`, `1px --ink` bottom border. Holds the brand mark + wordmark, primary nav ("Browse," "Submit a listing"), and the theme switcher.
- **Nav links:** Body-face, `--ink-soft`, underline on hover
- **Mobile treatment:** below 480px, "Browse" hides and "Submit a listing" shortens to "Submit"

### Ticket Stub (signature component)
The date block at the left of every listing row — day/date/month stacked, `--paper-shadow` fill, `4px` radius. Gets a gold-mixed left edge (`color-mix(in srgb, var(--gold) 60%, var(--paper) 40%)`) only when the listing's occurrence falls within the next 7 days, computed against the page's actual date range rather than a second, separately-invented threshold. This is the system's most distinctive device — a physical ticket-stub silhouette doing double duty as both a date display and a "how soon" signal.

### Theme Toggle (signature component)
Styled as a bulb pill ("Lights on" / "Lights off") rather than a generic sun/moon icon — a small gold dot that goes `--ink-soft` when dark mode is active, keeping the metaphor inside the marquee vocabulary instead of a borrowed one. Persists an explicit choice to `localStorage`; absent an explicit choice, the page follows system `prefers-color-scheme`.

## Do's and Don'ts

### Do:
- **Do** treat Marquee Gold as the only saturated signaling color (The One Voice Rule).
- **Do** build every new color usage from the `--paper` / `--ink` / `--rule` / `--gold` token set — never a hardcoded hex — so both themes and the "this week" soft-accent mix stay correct automatically.
- **Do** use relative units (`rem`, `clamp()`) with no fixed-width containers on every layout, public or admin — a working moderator navigates at 400%+ zoom.
- **Do** keep every interactive control's `:focus-visible` state a visible `--gold-ink` outline.
- **Do** gate any new transition or animation behind `(prefers-reduced-motion: no-preference)`, matching the one existing row-fade transition.

### Don't:
- **Don't** introduce a card, a rounded tile, or a `box-shadow` for grouping or elevation — use a tonal background (`--paper-shadow`) or a hairline rule instead (The No Card, No Gimmick Rule).
- **Don't** use Cancellation Red for anything other than an actual cancellation or urgent time-sensitive change (The Red Line Rule).
- **Don't** reach for uppercase/small-caps styling outside the confirmed list (ticket-stub day/month, type tag, filter tabs) — see The Marquee Caps Rule.
- **Don't** rely on a native browser control's default appearance (a `<select>` caret, a checkbox) for anything visible in dark mode without checking it actually themes — it may be drawn by the OS/browser chrome, not by this system's tokens.
- **Don't** use IBM Plex Mono anywhere except the time column and ticket-stub date (The Mono Discipline Rule).
