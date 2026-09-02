# Future Considerations

Ideas beyond the MVP directory, noted for context but not designed yet. See [crowd-work-vision.md](./crowd-work-vision.md) for the MVP itself.

## High priority

- **Map view** — a "view as map" toggle on the directory, showing listings as pins (as an alternative to the filterable list view). Deferred from MVP because it adds real scope (geocoding every venue, a mapping library/API, pin clustering, a second layout), but the data model doesn't foreclose it — venues already carry addresses. Flagged as high priority for the first post-MVP phase.

- **Ratings/reviews on listings** — attendees leaving reviews on a mic or show (seen on a competitor's detail pages). A real trust signal, but a new moderation surface — public reviews are exactly the kind of feature that could reopen the personal-dispute-as-public-drama risk this project's governance model is designed to avoid. Requires site-wide user auth (accounts for regular visitors, not just moderators), which the MVP doesn't have. Deferred post-MVP.

## Later-stage product ideas

- **Crowd Work Pass** — a subscription or digital ticket badge for frequent comedy-goers, giving discounted or priority entry at local clubs. Needs venue buy-in and enough traffic to be worth a club's while — a phase-2-or-later idea once the directory has real usage.

- **Crowd Work HQ / Pro** — a backend portal for venue owners, hosts, and producers to manage their own show listings, drop-in slots, and check-ins directly. This is likely the most important long-term piece (it would make listings self-updating instead of agent/community-maintained), but it's a two-sided marketplace problem requiring venue adoption.

- **The Green Room by Crowd Work** — a comedian-facing content section: open-mic etiquette guides, venue reviews, host contact info. Relatively cheap to build (just content, no new data model) — could be added alongside the MVP or once there's traffic to justify it.

- **Crowd Work Pulse** — a weekly landing-page brief on trending mics, hot drop-ins, or featured lineups per city. Makes the most sense once there's enough listing data and history to make a "trending this week" story true.
