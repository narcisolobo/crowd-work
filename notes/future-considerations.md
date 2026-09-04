# Future Considerations

Ideas beyond the MVP directory, noted for context but not designed yet. See [crowd-work-vision.md](./crowd-work-vision.md) for the MVP itself.

## High priority

- **Map view** — a "view as map" toggle on the directory, showing listings as pins (as an alternative to the filterable list view). Deferred from MVP because it adds real scope (geocoding every venue, a mapping library/API, pin clustering, a second layout), but the data model doesn't foreclose it — venues already carry addresses. Flagged as high priority for the first post-MVP phase.

- **Ratings/reviews on listings** — attendees leaving reviews on a mic or show (seen on a competitor's detail pages). A real trust signal, but a new moderation surface — public reviews are exactly the kind of feature that could reopen the personal-dispute-as-public-drama risk this project's governance model is designed to avoid. Requires site-wide user auth (accounts for regular visitors, not just moderators), which the MVP doesn't have. Deferred post-MVP.

## Near-term follow-ups

- **Expand areas and neighborhoods** — the current taxonomy is a fixed, moderator-managed set (no self-serve way to add one). Raised while designing [2026-09-04-listing-submission-design.md](../docs/superpowers/specs/2026-09-04-listing-submission-design.md), which deliberately scoped new-venue proposals to *existing* neighborhoods only. Worth revisiting once real submissions start naming areas/neighborhoods the current set doesn't cover.

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
