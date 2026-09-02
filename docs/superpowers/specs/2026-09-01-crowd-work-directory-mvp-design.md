# Crowd Work — Directory MVP Design

**Status:** Approved for implementation planning
**Related:** [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md), [notes/future-considerations.md](../../../notes/future-considerations.md)

## Summary

Crowd Work's MVP is a directory of Los Angeles open mics and comedy shows, serving two audiences (comics looking for stage time, general audiences looking for shows) from one shared dataset. Listings are sourced two ways — a daily AI-assisted agent that checks a curated list of sources for changes, and a public submission form — both converging on a single, accountable moderation queue before anything publishes. The design is deliberately built around a specific failure mode: a prior community-maintained LA open mic list collapsed when its sole maintainer left and its successor became a point of community conflict. Nothing here should depend on one person's unilateral judgment or availability.

## Goals

- Prove there's real usage for an accurate, actively-maintained LA open mic/show directory.
- Source listings without requiring venue partnerships from day one.
- Build moderation governance that survives a maintainer stepping away, and that no single moderator can unilaterally control.
- Stay on free or near-free infrastructure, with the one exception being a small LLM API budget (~$2-5/month) for the sourcing agent.

## Non-goals (MVP)

Deferred to [future-considerations.md](../../../notes/future-considerations.md): Crowd Work Pass, Crowd Work HQ/Pro, The Green Room, Crowd Work Pulse, a map view, and ratings/reviews on listings (which requires site-wide visitor auth the MVP doesn't have).

## Architecture Overview

- **Astro**, deployed on **Vercel**, serves the public directory site: browse/search listings, view a listing's detail page, and submit a new listing or correction. No login required for any public-facing page.
- **Supabase (Postgres)** is the single source of truth for all data — venues, listings, recurrence rules, sources, and the moderation queue. Its auto-generated REST API is what makes the backend consumer-agnostic: a future mobile app can read the same data without a new API layer.
- **A daily scheduled Supabase Edge Function** checks each seed source for changes and writes proposed changes into the moderation queue.
- **A small authenticated admin area**, part of the same Astro site and gated by Supabase Auth, is where the site owner and volunteer comic moderators review the queue.
- **The public submission form** writes into the same moderation queue as the agent, so both paths go through identical review.
- **Local development** happens against the Supabase CLI's local stack, with schema changes tracked as versioned SQL migrations (`supabase db push`) rather than made through the dashboard — appropriate given the schema has real structural complexity (recurrence, exceptions, moderation state) worth keeping in version control.

## Data Model

### `venues`
Name, address, neighborhood, Google Maps link.

### `neighborhoods` / `areas`
`neighborhoods` is a fixed, hand-maintained list (Los Feliz, Silver Lake, Echo Park, etc.) — not free text, so it stays typo-free and filterable. Each neighborhood maps to one broader `area` (Eastside, Westside, Valley, South Bay, etc.). This mapping is curated by the site owner, not inferred algorithmically — LA neighborhood boundaries are genuinely contested, and treating this as a controlled vocabulary (like the seed source list) avoids the ambiguity of trying to fuzzy-match a region name to specific places.

### `listings`
The core entity. Fields:
- `type`: `mic` or `show`
- `title`, `host`, `description`
- `venue_id` (references `venues`)
- Mic-specific: sign-up method, cost to perform
- Show-specific: ticket price/link, lineup (if known)
- `status`: `published` or `archived`
- `source_id`: which `sources` row this came from, nullable for user-submitted listings

Recurring listings (weekly/monthly) reference a `recurrence_rules` row; one-off shows carry a specific date directly on the listing instead.

### `recurrence_rules`
One row per recurring listing: `frequency` (`weekly`/`monthly`), day-of-week, and for monthly patterns, the nth-weekday needed to express things like "last Thursday of the month" (the same concept as an iCal RRULE's `BYDAY`/`BYSETPOS`, rather than inventing a bespoke pattern language).

### `occurrence_exceptions`
Handles one-off deviations from a recurring listing without touching the recurring rule itself:
- `listing_id`, `original_date` (which occurrence this overrides)
- `type`: `cancelled` or `modified`
- For `modified`: override fields — `new_date`, `new_start_time`, optionally `new_venue_id`
- `note` (optional, e.g. "moved for Labor Day")

Resolving "what's happening on date X" means checking `occurrence_exceptions` first and falling back to the `recurrence_rules` pattern if no exception exists for that date.

### `sources`
The daily agent's seed list: name, URL, source type (venue site, Instagram, etc.), `trust_level` (`unverified` → `trusted`), and a running count of clean approvals. A source graduates to `trusted` after enough approved changes in a row, at which point its future proposals auto-publish instead of queuing for review (see Moderation below). Instagram sources are flagged distinctly — see Known Limitations.

### `moderation_queue`
The single table both the agent and the public submission form write into:
- Proposed listing data (new or updated fields)
- `change_type`: `new`, `update`, or `cancellation`
- `origin`: which `source_id` this came from, or "user submission" (user-submitted entries never accrue source trust — see Moderation)
- `status`: `pending` → `approved` | `rejection_proposed` → `rejected`
- `proposed_by` / `confirmed_by` (moderator identities involved in a rejection)
- Rejected entries are never deleted — the table itself is the permanent archive/audit trail.

## Data Flow

### Path 1 — Agent-discovered changes
Once daily, a scheduled Edge Function reads `sources`, fetches each source's current content, and passes it to **Claude Haiku 4.5** with a defined JSON schema to extract structured listing data (day, time, venue, host, cost, sign-up method). Haiku is the right model tier here: this is a narrow, well-defined extraction task, cost matters at this budget scale, and every result still passes through the moderation queue (or the trust-gated auto-publish path) rather than being trusted blindly.

Fetching itself uses Anthropic's built-in `web_fetch` server tool rather than a hand-rolled scraper or an MCP server — the task is "read this URL's content," which doesn't need tool orchestration beyond that. (MCP was considered and explicitly ruled out for this job: it doesn't solve the actual blocker for hard-to-reach sources like Instagram, which is access, not tooling — see Known Limitations.)

Before writing a `new` entry, the function checks for an existing listing at the same venue/day/time; a near-match is filed as an `update` instead, to avoid flooding the queue with near-duplicates whenever a source's page structure shifts slightly.

### Path 2 — User submissions
The public form writes directly into `moderation_queue`, tagged as user-submitted. Anti-abuse for the login-free form: a honeypot field plus basic IP rate-limiting is sufficient for MVP; a CAPTCHA is a fallback if spam becomes an actual problem, not a day-one requirement.

### Moderation
Both paths converge on one shared queue, worked by the site owner and volunteer comic moderators in the authenticated admin area.

**Approval** (single moderator): writes/updates the corresponding `listings` row (and `recurrence_rules`/`occurrence_exceptions` as needed); if the entry came from a source, increments that source's approval streak, which may cross the threshold into `trusted`.

**Rejection requires two moderators**: one proposes rejection (with a reason, status → `rejection_proposed`); a *different* moderator must confirm before it moves to `rejected`. This asymmetry is deliberate — approving is easy to correct later (edit or unpublish), but rejecting silently drops someone's contribution, and no single moderator should be able to do that unilaterally. If the second moderator disagrees, the entry returns to `pending`.

**Trust escalation applies only to `sources`, never to user submissions.** Anonymous form submissions have no persistent identity to accumulate trust against, so every single one is human-reviewed, regardless of submission history. Once a source is `trusted`, the agent still writes to `moderation_queue` for the audit trail, but those entries auto-transition to `approved` and publish immediately.

**Post-publish corrections**: a "report a problem" link on each listing detail page feeds back into the same moderation queue as a correction — no separate mechanism needed. Trust demotion (manually knocking a `trusted` source back to requiring review) is included as a field now even though the automatic "demote after N bad ones" logic isn't needed until it's actually observed.

## Notifications

Moderators need to know when something's waiting without having to remember to check the admin dashboard. Two triggers, both via **Resend**:

- **Daily digest**: right after the agent's daily run, an Edge Function queries all still-pending `moderation_queue` entries and sends one summary email. This is the reliable fallback — it always catches anything outstanding, including anything a real-time alert may have missed.
- **Real-time urgent alerts**: a database webhook on `moderation_queue` insert checks whether the entry is time-sensitive — a `cancellation` or `modified` occurrence exception affecting a date within the next 2-3 days — and if so, sends an immediate email rather than waiting for the next digest. A brand-new listing or a change to a distant-future date is not urgent and only appears in the digest.

## Geographic Filtering

The directory filters by specific `neighborhood` and by broader `area` (see Data Model). Given LA's sprawl, "what's happening on the Eastside tonight" needs to work without the user knowing whether a given mic is technically in Los Feliz or Silver Lake.

## Key Pages / Components

**Public (Astro):**
- **Directory/browse page** — the core page. Filterable by type (mic/show), day of week, and neighborhood/area. Computed from `recurrence_rules` + `occurrence_exceptions` for "what's happening this week," not a raw dump of `listings`. The type/day/neighborhood filters cover the "this week vs. all listings" need without a separate toggle.
- **Listing detail page** — one per listing, own URL, for SEO and shareability. Links out to Google Maps for directions; no embedded map (see future-considerations.md for a possible map view).
- **Submission form** — public, no login, for new listings and corrections to existing ones.

**Admin (Astro, gated by Supabase Auth):**
- **Moderation queue** — shared work list; approve/edit/propose-reject actions and the second-reviewer confirmation step for rejections.
- **Sources management** — view seed sources, trust level, approval streak; add sources manually.

No visitor accounts/profiles exist in the MVP — browsing and submitting require no login.

## Known Limitations / Edge Cases

- **Instagram sources**: the LLM extraction step solves parsing messy content, not fetching it — Instagram remains hard to reach reliably regardless of what reads the content afterward (auth walls, rate limits, ToS). Instagram-only sources stay manually-checked or rely on user submissions for now; revisit only if a legitimate access path (official Graph API, a paid data provider) becomes available.
- **Source failures**: if the daily agent can't reach a source, it logs the failure against that `sources` row rather than failing silently. Real alerting isn't needed at MVP scale — a status flag the site owner checks periodically is enough.
- **Conflicting proposals**: if two pending queue entries touch the same listing (e.g., the agent and a user both flag the same change), a moderator resolves it by approving one and rejecting the other as duplicate — no special merge logic needed.
- **Failure modes beyond these are hard to predict in advance** — the moderation queue's "report a problem" path is the general-purpose safety net for whatever surfaces once real usage starts.

## Testing

Automated testing is concentrated where bugs are costly and non-obvious; everything else is reasonable to verify manually at MVP scale:

- **Recurrence + exception resolution** ("what's happening on date X") — the highest-value target for unit tests. A subtle bug here (e.g., miscalculating "last Thursday of the month," or an exception not correctly overriding its rule) silently shows wrong information to real people trying to find a mic.
- **Moderation queue state transitions** — pending → rejection_proposed → rejected requiring a *different* second reviewer, and approval correctly writing through to `listings`. This is the governance mechanism the whole design is built around, so it should be verified to actually enforce what it's meant to enforce.
- **Duplicate detection** on the agent's write path — a few targeted tests, since it's the difference between a usable queue and a flooded one.
- UI/pages: manual testing is reasonable at this scale; no e2e infrastructure needed yet.

## Tech Stack Summary

| Layer | Choice |
|---|---|
| Frontend | Astro, deployed on Vercel |
| Backend/data | Supabase (Postgres), auto-generated REST API |
| Scheduled agent | Supabase Edge Function, daily |
| LLM extraction | Claude Haiku 4.5 via the Messages API, `web_fetch` server tool |
| Auth | Supabase Auth (moderators only — no visitor accounts) |
| Email | Resend (daily digest + real-time urgent alerts) |
| Local development | Supabase CLI, versioned SQL migrations |

## Open Items for the Implementation Plan

These don't require further design discussion, just decisions made during implementation:
- Exact Supabase Row Level Security policies per table (public read on `listings`/`venues`; moderator-only read/write on `moderation_queue` and `sources`).
- Moderator account provisioning (site owner manually inviting comic-friend moderators vs. any self-serve flow — likely manual invite only, given the trust model).
- Astro project folder structure and environment variable/config conventions for the Vercel deployment.
