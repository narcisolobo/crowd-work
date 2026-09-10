# Future Considerations

Ideas beyond the MVP directory, noted for context but not designed yet. See [crowd-work-vision.md](./crowd-work-vision.md) for the MVP itself.

## High priority

- **Fully autonomous source-checking agent** — a hosted, continuously-scheduled job (no human trigger) that checks seed sources for changes and files findings into the moderation queue, as originally envisioned in [crowd-work-vision.md](./crowd-work-vision.md). For the MVP, this is done manually instead via the `/check-sources` Claude Code skill — see [2026-09-05-source-check-agent-design.md](../docs/superpowers/specs/2026-09-05-source-check-agent-design.md), which deliberately designed the source registry, write-through function, and RLS model to be reusable by this future version without a redesign. The main remaining work is the discovery layer itself: a hosted script calling the Claude API directly, with no live session or WebFetch tool available.

- **Map view** — a "view as map" toggle on the directory, showing listings as pins (as an alternative to the filterable list view). Deferred from MVP because it adds real scope (geocoding every venue, a mapping library/API, pin clustering, a second layout), but the data model doesn't foreclose it — venues already carry addresses. Flagged as high priority for the first post-MVP phase.

- **Ratings/reviews on listings** — attendees leaving reviews on a mic or show (seen on a competitor's detail pages). A real trust signal, but a new moderation surface — public reviews are exactly the kind of feature that could reopen the personal-dispute-as-public-drama risk this project's governance model is designed to avoid. Requires site-wide user auth (accounts for regular visitors, not just moderators), which the MVP doesn't have. Deferred post-MVP.

## Near-term follow-ups

- **Admin "Sources management" page** — a UI for moderators to view seed sources (trust level, approval streak) and add new ones. Deferred because the source-check agent is currently a manually-triggered skill (`/check-sources`), not yet battle-tested across a variety of venue sources — letting moderators freely add sources on top of an unproven extraction pipeline is more risk than the MVP needs. Sources continue to be registered directly via Supabase Studio in the meantime (see [2026-09-05-source-check-agent-design.md](../docs/superpowers/specs/2026-09-05-source-check-agent-design.md)). This doesn't block getting new mics/shows into the directory — comics and moderators can already add them directly via the existing public submission and moderator direct-add forms. Revisit once `/check-sources` has run against a real variety of sources and proven reliable.

- **Expand areas and neighborhoods** — the current taxonomy is a fixed, moderator-managed set (no self-serve way to add one). Raised while designing [2026-09-04-listing-submission-design.md](../docs/superpowers/specs/2026-09-04-listing-submission-design.md), which deliberately scoped new-venue proposals to *existing* neighborhoods only. Worth revisiting once real submissions start naming areas/neighborhoods the current set doesn't cover.

- **Neighborhood-level filtering on the directory** — a maybe, not a commitment. The MVP filters by broader `area` only (e.g. "Eastside"); each venue's `neighborhoodId` is already loaded per listing, so adding a dedicated neighborhood filter later needs no data model work. Deferred because with a nascent, sparse directory, filtering down to individual neighborhood risks empty or single-result filter states before there's enough listing volume for it to be useful. Revisit once real usage shows area-only filtering isn't precise enough.

- **Google Places Autocomplete on address fields** — smart, debounced address suggestions (e.g. on listing/venue submission forms) instead of freeform text entry. Straightforward to add and would improve data quality (consistent, geocoded addresses), but needs a Cloud Billing account and session-token handling to stay within the free tier (10,000 free autocomplete sessions/month as of 2026, provided each session is properly closed with a Place Details call). Deferred post-MVP as a nice-to-have rather than a blocker.

- **Web-push notifications for moderators** — opt-in browser push, as an alternative to relying on checking email, for the same urgent moderation-queue events the existing email pipeline already classifies (see [2026-09-08-moderation-notifications.md](../docs/superpowers/plans/2026-09-08-moderation-notifications.md)). Additive to email, not a replacement — moderators have no way to opt out of email today, and this shouldn't require building that first. Needs the whole site installable as a PWA (manifest + service worker): iOS Safari only exposes the Push API after a site has been added to the home screen, and since the moderator team's devices are unknown and will change over time, "install first" has to be a real, well-supported path rather than a Chrome/Android-only nice-to-have. Also needs a moderator preferences surface that doesn't exist yet — the `moderators` table is currently just an id→email lookup with no settings/profile page. Deferred until the app's surface area (moderator UI especially) settles down enough that this design won't need a rewrite.

## Later-stage product ideas

- **Crowd Work Pass** — a subscription or digital ticket badge for frequent comedy-goers, giving discounted or priority entry at local clubs. Needs venue buy-in and enough traffic to be worth a club's while — a phase-2-or-later idea once the directory has real usage.

- **Crowd Work HQ / Pro** — a backend portal for venue owners, hosts, and producers to manage their own show listings, drop-in slots, and check-ins directly. This is likely the most important long-term piece (it would make listings self-updating instead of agent/community-maintained), but it's a two-sided marketplace problem requiring venue adoption.

- **The Green Room by Crowd Work** — a comedian-facing content section: open-mic etiquette guides, venue reviews, host contact info. Relatively cheap to build (just content, no new data model) — could be added alongside the MVP or once there's traffic to justify it.

- **Blog/newsletter content** — one of the moderation team is a working writer potentially interested in writing blog/news content about the LA comedy world; other moderators may have similar interest. This is a different kind of content than listings (long-form, not relational — no venue/recurrence/exception structure to preserve) and likely overlaps with or supersedes The Green Room idea above. Whatever authoring solution gets chosen (hand-rolled or third-party) needs to satisfy:
  - A friendly, non-technical authoring interface — contributors are writers, not developers, and shouldn't need to touch code or the database directly.
  - Some editorial review workflow before content goes live — doesn't need the listings queue's two-moderator rejection rule, but should support at least single-reviewer approval so nothing publishes unreviewed.
  - Lives on the same site/domain as the directory, for a consistent reader experience.
  - Fits the project's free/near-free infrastructure goal (see the MVP spec's Goals).
  - Supports multiple contributors over time, not just one writer.

- **Crowd Work Pulse** — a weekly landing-page brief on trending mics, hot drop-ins, or featured lineups per city. Makes the most sense once there's enough listing data and history to make a "trending this week" story true.
