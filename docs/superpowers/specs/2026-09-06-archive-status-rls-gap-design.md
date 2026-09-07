# Archive Status RLS Gap — Design

**Status:** Approved for implementation planning
**Related:** [notes/archive-status-rls-gap.md](../../../notes/archive-status-rls-gap.md), [2026-09-03-moderation-archive-design.md](2026-09-03-moderation-archive-design.md), [2026-09-04-listing-submission-design.md](2026-09-04-listing-submission-design.md), [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md)

## Summary

`listings.status` has had an `archived` value since the original schema, but no code path has ever been able to set it: the only `SELECT` policy on `listings` requires `status = 'published'`, and Postgres requires an `UPDATE`'s resulting row to satisfy the table's `SELECT` policy, not just the `UPDATE` policy's own `WITH CHECK`. This surfaced as a real bug — a defensive fallback in `createListingFromFields()` that tries to archive a listing when its `recurrence_rules` insert fails right after creation cannot actually succeed, and silently would have kept failing had the note not caught it first.

Closing the RLS gap on its own would fix that one fallback but leave `archived` otherwise unreachable and unauditable — there'd be no in-app way to archive a listing on purpose, and no record of why one was archived if the fallback ever fires. This phase does both: fixes the RLS gap, and builds the minimal moderator-facing archive feature on top of it, routed through `moderation_queue` so it inherits the same audit trail (who/what/why/when) every other change type already gets from the Moderation Archive.

## Goals

- Fix the RLS gap so a row can actually transition to `status = 'archived'`.
- Give moderators an in-app way to archive a published listing, with a required reason.
- Make every archive event — moderator-initiated or the automatic recovery fallback — show up in the existing Moderation Archive (`/admin/archive`) for free, with a real actor and reason recorded.
- Replace the existing fallback's silent, unaudited `.update()` with the same audited path, so a recurrence-insert failure during listing creation leaves a visible record instead of a mystery-archived listing.

## Non-goals (this phase)

- **Unarchive / republish.** Archiving today is a one-way door in the UI (the row itself is never mutated destructively, so this is recoverable manually if it ever matters, e.g. via Supabase Studio). A symmetric "republish" action can reuse the same `change_type`/queue machinery later without redesign.
- **Second-moderator confirmation for archiving.** Per the existing approve/reject asymmetry (approving/correcting is easy, silently dropping a contribution is not), archiving is closer to an approval than a rejection — reversible, moderator-initiated, low ceremony.
- **Bulk archive**, and **archived-listing visibility/filtering** in the new listings index beyond what's needed to pick a listing to archive.
- **A general admin listings-management UI.** The new `/admin/listings` page exists to give the archive action a home, not to become a full CRUD surface.

## Architecture Overview

No new services. One migration (RLS policy + enum value), one new admin page (`/admin/listings`), and changes to existing write-through logic in `src/lib/data/moderation.ts`. The existing Moderation Archive page and its label/preview helpers gain a new `change_type` to render; no new page is needed for the audit trail itself.

## Data Model

```sql
-- Closes the RLS gap. Scoped to real moderators, not every `authenticated`
-- principal — `source_check_agents` are also `authenticated` (see
-- 20260906052058_source_check_agent.sql) and have no legitimate need to read
-- archived listings, so this deliberately doesn't use a blanket `using (true)`.
create policy "moderators can view archived listings"
  on listings for select
  to authenticated
  using (auth.uid() in (select id from moderators));

alter type moderation_change_type add value 'archive';
```

`QueueChangeType` (`src/lib/data/moderation.ts`) becomes `"new" | "update" | "cancellation" | "archive"`.

An `archive` queue entry:

- `listing_id` — the archived listing (never null, unlike `new`).
- `proposed_data` — always `null`. Nothing about the listing's fields is being proposed or changed; the only state change is `status`, which already lives on `listings` itself.
- `correction_note` — always `null` (that field belongs to public-report-originated entries).
- `origin` — `"moderator_archive"` for the manual admin action; `"system_recovery"` for the automatic recovery fallback (see Write-Through Changes).
- `status` — always inserted directly as `"approved"`, never `"pending"` — see Non-goals above on why archiving skips the propose/confirm ceremony.
- `approved_data` — always `null`, for the same reason as `proposed_data`: no field values changed.
- `approved_by` — the acting user's id. For `system_recovery`, this is still the moderator whose direct-add action triggered the recovery, since it's their authenticated `UPDATE` that RLS is evaluating — the origin field, not `approved_by`, is what tells the archive reader "this wasn't a deliberate click."
- `approval_note` — the reason. Moderator-supplied text for `moderator_archive`; a fixed, descriptive string for `system_recovery` (see below).
- `decided_at` — set to `now()` at insert time, same as direct-add.

No new columns anywhere — `moderation_queue` already has everything an `archive` entry needs.

## Write-Through Changes

New function in `src/lib/data/moderation.ts`, modeled directly on `directAddListing`:

```ts
export async function archiveListing(
  client: SupabaseClient<Database>,
  listingId: string,
  reason: string,
  origin: "moderator_archive" | "system_recovery" = "moderator_archive",
): Promise<void> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error: listingError } = await client
    .from("listings")
    .update({ status: "archived" })
    .eq("id", listingId);
  if (listingError)
    throw new Error(`Failed to archive listing: ${listingError.message}`);

  const { error: queueError } = await client.from("moderation_queue").insert({
    change_type: "archive",
    listing_id: listingId,
    proposed_data: null,
    correction_note: null,
    origin,
    status: "approved",
    approved_by: user.id,
    approved_data: null,
    approval_note: reason,
    decided_at: new Date().toISOString(),
  });
  if (queueError)
    throw new Error(
      `Listing was archived, but the audit record failed to save: ${queueError.message}`,
    );
}
```

The queue insert failing after the listing update succeeds is an acceptable, honestly-reported edge case (matching this codebase's existing style of degrading honestly rather than pretending) — the listing is still correctly archived either way.

**Unifying the recovery fallback.** The existing block in `createListingFromFields()`:

```ts
const { error: archiveError } = await client
  .from("listings")
  .update({ status: "archived" })
  .eq("id", listing.id);
```

is replaced with a call to `archiveListing(client, listing.id, "Recurrence schedule failed to save during creation", "system_recovery")`, wrapped in the same try/catch shape so the existing error-message branches (archive succeeded vs. archive also failed) are preserved. This is the exact code path the source note started from — fixing it in place, rather than leaving a second, unaudited way to flip `status`, is in scope here rather than being incidental cleanup.

**New admin action.** `/admin/listings` (see Pages) calls `archiveListing(client, listingId, reason, "moderator_archive")` directly from a POST handler — no queue "propose" step, matching direct-add's shape.

## Pages

**`/admin/listings`** — new. Lists currently-published listings only (`getPublishedListings()`, already filters `.eq("status", "published")` — no new data function needed for the list itself), showing title, venue, and type, in this system's standard row/rule layout (no cards).

Each row's "Archive" control is a native `<details>/<summary>` disclosure — the same mechanism the Account Menu already uses — rather than a modal or a dedicated per-listing page. Two reasons: nothing about the listing's data needs reviewing (unlike an approve flow, which is why those get a full page), and this system has no modal anywhere to begin with — a row-level disclosure reflows in place with the rest of the single-column layout instead of needing overlay/positioning logic, which matters concretely for the moderator who works at 400%+ zoom (Accessibility & Inclusion, `PRODUCT.md`). Opening it reveals the existing `APPROVAL_REASON_OPTIONS`/`APPROVAL_REASON_HINT` pattern from `moderation-labels.ts` (canned reasons + "Other…" free text) via a `FormSelect`/`FormTextarea` pair, exactly as `/admin/listings/new` already presents it, plus a submit `Button`. No new color or button variant: the "Archive" trigger and submit button use the existing `outline`/`primary` `Button` variants, matching how "propose rejection" — an existing action at least as consequential — is already styled. Cancellation Red is reserved by the Red Line Rule for an actual cancellation or urgent time-sensitive change on public-facing content; archiving a listing is an admin-only action outside that rule's scope, not a case for it.

Submitting posts to the page, calls `archiveListing()`, and redirects to `/admin/listings?archived=1`. Unlike direct-add's `?added=<id>` pattern, the confirmation is a generic "Listing archived." banner with no title interpolated — direct-add can safely re-verify its success message with a fresh, filtered lookup by id (`getListingById` finds a *published* listing), but that same lookup is guaranteed to find nothing for a listing that was just archived, so there's no safe way to reconfirm which title to show without either trusting an unverified query param or querying without the status filter. A generic banner avoids both.

- `/admin` (existing queue list) gains a nav link to `/admin/listings`, alongside the existing link to `/admin/archive`.

**`/admin/archive`** (existing page) — updated, not replaced:

- `moderation-labels.ts`: add `archive: "Archive"` to `CHANGE_TYPE_LABEL`; add `moderator_archive: "Archived by moderator"` and `system_recovery: "Automatic (recovery)"` to `ORIGIN_LABEL`.
- New batch lookup `getListingTitles(client, ids)` in `src/lib/data/listings.ts`, shaped exactly like the existing `getModeratorEmails(client, ids)` in `src/lib/data/moderators.ts` (dedupe ids, single `in()` query, return an `id -> title` record). `archive` entries have no `proposedData`/`approvedData` carrying a title (nothing about the listing's fields changed), so the page needs a title from somewhere other than the JSON blob every other change type uses.
- `previewFor()` (or the archive page's `whatFor()`, whichever ends up owning this — see Open Items) gains an `archive` branch: `` `Archived: ${title}` ``, falling back to a listing-id reference if the title lookup somehow comes back empty (deleted venue reference, etc. — should not happen in practice since listings are never deleted, only archived).
- `whoFor()` already handles this correctly with no changes: archive entries are always `status = "approved"`, so it already renders "Approved by \<moderator\>" — accurate for `moderator_archive`; slightly misleading-but-not-wrong for `system_recovery` (the recorded actor genuinely did perform the authenticated action, even though they didn't click "archive" on purpose). The `origin` label next to it ("Automatic (recovery)") is what disambiguates the two cases for a reader.

## Testing

Per this project's existing testing priorities (automate the state-transition/governance logic; verify UI manually at this scale):

- The new RLS policy: an authenticated moderator can update a listing's `status` to `archived` and have it succeed (the exact repro from the source note, now expected to pass); a `source_check_agents` account performing the same update still succeeds at the `UPDATE` (unaffected — its restrictive policies already block it from updating listings at all) — this test exists to confirm the new `SELECT` policy alone doesn't accidentally widen what the agent can write, since RLS policy interactions are exactly what caused this gap in the first place.
- `archiveListing()`: sets `listings.status` to `archived`, inserts a `moderation_queue` row with `change_type: "archive"`, `status: "approved"`, correct `origin`/`approved_by`/`approval_note`/`decided_at`.
- The refactored recovery fallback in `createListingFromFields()`: on a simulated `recurrence_rules` insert failure, the listing is archived, a queue entry with `origin: "system_recovery"` exists, and the existing error-message behavior (including the "archive also failed" branch) is unchanged.
- `getArchiveEntries()` / the archive page: an `archive` entry renders with the correct change-type label, origin label, and "Archived: \<title\>" preview.
- The admin listings page: manual verification, consistent with how `/admin/listings/new` was treated in the prior phase.

## Known Limitations / Edge Cases

- `system_recovery` archive entries record the acting moderator as `approved_by` even though they didn't intend to archive anything — accepted per the Write-Through Changes note above; the `origin` field is the source of truth for "was this deliberate."
- If `archiveListing()`'s queue insert fails after the listing update succeeds, the listing is correctly archived but leaves no audit trail — surfaced to the caller as an error, not silently swallowed, matching this codebase's existing degrade-honestly style for the two-step-insert problem.
- No pagination/search on `/admin/listings` — same reasoning as the existing Moderation Archive's deferred pagination; revisit if listing volume ever makes it necessary.

## Open Items for the Implementation Plan

- Whether the `archive` preview branch belongs in the shared `previewFor()` helper (which `whatFor()` on the archive page already delegates to) or is archive-page-specific — `previewFor()` currently takes a `Pick<QueueEntry, ...>` with no listing-title parameter, so adding one changes its signature; the plan should settle the cleanest way to thread `getListingTitles()`'s result through.
