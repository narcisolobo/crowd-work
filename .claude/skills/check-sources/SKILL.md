---
name: check-sources
description: Manually check registered venue-website sources for listing changes and file findings into crowd-work's moderation queue. Use when asked to check sources, check a venue's website for updates, or run /check-sources.
---

Checks one or more registered venue-website sources against crowd-work's existing listings, and files anything new or changed as a pending `moderation_queue` entry for later review in `/admin`. Read [docs/superpowers/specs/2026-09-05-source-check-agent-design.md](../../../docs/superpowers/specs/2026-09-05-source-check-agent-design.md) for the full design if anything here is unclear.

## Invocation

`/check-sources` — check every registered source.
`/check-sources <venue-name>` — check only the source(s) for a venue whose name matches (case-insensitive substring match).

## Steps

1. **Read the sources to check.** Use the Supabase MCP tools to query the `sources` table, joined with the venue name (`sources.venue_id -> venues.name`). If a venue-name argument was given, filter to sources whose venue name contains it (case-insensitive); report and stop if nothing matches. This step is read-only — it doesn't need the scoped agent account.

2. **For each source, fetch its page.** Use `WebFetch` on `sources.url`. If the fetch fails, times out, or the content is clearly not renderable as plain content (e.g., a near-empty shell that's obviously JS-rendered), report that source as **skipped** and move on to the next one — one bad source must never abort the run.

3. **Read that venue's existing listings.** Query `listings` (plus `recurrence_rules` for recurring ones) filtered to the source's `venue_id`, via the Supabase MCP tools.

4. **Compare and reason.** Look at what the fetched page describes (day/time, title, host, sign-up method, cost, etc. for mics; day/time, ticket price/URL for shows) against the existing listings for that venue. Decide, for each distinct listing on the page:
   - **New** — nothing in the existing listings resembles it (different day/time or clearly a different show/mic entirely).
   - **Update** — it clearly corresponds to an existing listing, but one or more fields differ (time changed, host changed, sign-up method changed, etc.).
   - **No change** — matches an existing listing with nothing different. Don't file anything for these.

   Do not attempt to detect cancellations (a listing that seems to have disappeared from the page) — that's out of scope for this phase; a missing listing is not evidence of anything by itself and should be left alone.

5. **Show a summary before filing anything.** List what you found per source: how many new, how many updates, and a one-line description of each. This is a courtesy, not a gate — findings still get filed as pending regardless, but you should see them before they're written.

6. **File each finding.** For each new/update finding, write a JSON file matching this shape (see `scripts/submit-source-finding.mjs` for the authoritative shape):

   ```json
   {
     "sourceId": "<the source's id>",
     "changeType": "new" | "update",
     "listingId": "<existing listing id, or null for a new finding>",
     "fields": {
       "type": "mic" | "show",
       "title": "string",
       "host": "string or null",
       "description": "string or null",
       "venueId": "<the source's venue_id>",
       "newVenue": null,
       "startTime": "HH:MM",
       "signUpMethod": "bucket_lotto" | "first_come" | "curated" | "slotted_online" | "hybrid_other" | null,
       "signUpUrl": "string or null",
       "signUpOtherNote": "string or null",
       "signUpOpensAt": "HH:MM or null",
       "costToPerform": "string or null",
       "ticketPrice": "string or null",
       "ticketUrl": "string or null",
       "recurrence": { "frequency": "weekly" | "monthly", "dayOfWeek": 0-6, "weekOfMonth": -1 to 4 or null } or null,
       "oneOffDate": "YYYY-MM-DD or null"
     },
     "note": "One sentence: what changed and where you saw it, e.g. 'Start time now reads 8:30pm on the venue's Tuesday mic page.'"
   }
   ```

   Classifying `signUpMethod` from what the page says: `bucket_lotto` (names drawn from a bucket/hat/lottery), `first_come` (no list, arrive early), `curated` (host books performers, no public sign-up), `slotted_online` (a link like slotted.co — put it in `signUpUrl`), `hybrid_other` (doesn't fit cleanly — explain in `signUpOtherNote`). If the page states a specific time the list/bucket opens, put it in `signUpOpensAt`.

   `newVenue` is always `null` in this phase — sources only ever propose changes to listings at their own already-registered venue, never a new venue. Then run:

   ```bash
   node scripts/submit-source-finding.mjs <path-to-the-json-file>
   ```

7. **Report a final summary.** Sources checked, sources skipped (and why), findings filed, and a pointer to `/admin` to review them.
