# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro, deployed on Vercel. Supabase (Postgres) as the single source of truth via its auto-generated REST API, with Supabase Auth gating the admin area and Supabase Edge Functions running the daily sourcing agent. Resend for moderator email notifications. Already scaffolded in this codebase — not an open decision.

## Users

Two audiences sharing one dataset, filtered differently:

- **LA comics** looking for open mics to perform at — need performer-facing fields (sign-up method, cost to perform, host).
- **General LA comedy audiences** looking for shows to attend — need audience-facing fields (ticket price, lineup).

## Product Purpose

Crowd Work aggregates listings of Los Angeles open mics and comedy shows, kept accurate through automated source-checking plus community submissions rather than one person's spreadsheet. It exists to fill a gap left when a prior community-maintained LA open mic list collapsed after its sole maintainer stepped away and its successor became a point of community conflict. Success means the list survives a maintainer stepping away, because no single person's judgment or availability is load-bearing.

## Positioning

The differentiating mechanism is governance, not a feature list. A single shared moderation queue receives listings from both a daily automated sourcing agent and public submissions. Approval is single-moderator, but rejection requires a *second, different* moderator to confirm, and every rejected entry is permanently archived rather than deleted. This asymmetry — easy to correct an approval later, but no one person can unilaterally silence a submission — is the specific fix for the failure mode that killed the prior list. A neighboring directory could copy the listings UI; it could not truthfully copy this accountability structure without adopting the same governance.

## Operating Context

- **Public site** (no login required): browse/filter the directory by type (mic/show), day of week, and neighborhood or broader area (e.g. "Eastside"); view a listing's own detail page; submit a new listing or a correction via a public form (honeypot + IP rate-limiting for anti-abuse, no CAPTCHA at MVP).
- **Recurrence-aware listings**: weekly/monthly patterns (including "last Thursday of the month" style rules) with one-off exceptions for cancellations, date changes, or venue changes, resolved against a date range rather than stored as raw future dates.
- **Daily sourcing agent**: a scheduled Supabase Edge Function checks each seed source (venue sites, Instagram, etc.) for changes, using Claude Haiku 4.5 with a defined JSON schema to extract structured listing data. Sources start `unverified` and graduate to `trusted` after enough clean approvals in a row, at which point their future proposals auto-publish (still logged for audit).
- **Moderation** (authenticated admin area, Supabase Auth): the site owner and volunteer comic moderators work the shared queue — approve, edit, or propose-and-confirm rejection. User submissions never accrue trust and are always human-reviewed regardless of history.
- **Post-publish corrections**: a "report a problem" link on each listing detail page feeds back into the same moderation queue.
- **Notifications**: Resend-powered daily digest of pending queue items, plus a real-time alert for time-sensitive changes (a cancellation or modification within 2-3 days).

## Capabilities and Constraints

- Budget constraint: free or near-free infrastructure, with one exception — a small LLM API budget (~$2-5/month) for the sourcing agent.
- No visitor accounts/profiles in the MVP — browsing and submitting require no login. Auth exists only for moderators.
- Instagram sources are hard to reach reliably (auth walls, rate limits, ToS) regardless of extraction quality; they stay manually-checked or rely on user submissions rather than automated fetching, until a legitimate access path exists.
- Deferred, not in scope for MVP design work: map view, ratings/reviews on listings, Crowd Work Pass, Crowd Work HQ/Pro, The Green Room, Crowd Work Pulse (see notes/future-considerations.md).

## Brand Commitments

Product name is "Crowd Work." No visual identity (logo, palette, typography) is established yet — only the default Astro favicon exists in `public/`.

## Evidence on Hand

- `notes/crowd-work-vision.md` and `docs/superpowers/specs/2026-09-01-crowd-work-directory-mvp-design.md` are the authoritative product/design source docs.
- `competitors/` holds screenshots of existing LA open mic list competitors/predecessors, for competitive reference only — not usable brand assets.
- `drama/drama-context.md` documents the real community conflict that motivated the two-reviewer moderation model; treat as sensitive background context, not content to surface or name in the product.
- No real listings, venues, or testimonial content exist yet — `supabase/seed.sql` is sample data for local development only, not evidence to present as real in any design.

## Product Principles

- No single moderator's judgment or availability should ever be load-bearing for the list's accuracy or survival.
- Every rejection is accountable: a second, different reviewer confirms it, and nothing rejected is ever deleted from the record.
- Automated sourcing earns trust incrementally per source; it is never assumed, and user submissions never inherit it.
- Serve both audiences (performers and attendees) from one dataset rather than maintaining parallel lists.
- Stay on free/near-free infrastructure; scope (e.g. Instagram access, map view) follows what's actually reachable and needed, not what's technically possible.

## Accessibility & Inclusion

No formal standard required yet; no specific user need has been established beyond general good practice.
