# Modified Occurrence Moderation — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-01-crowd-work-directory-mvp-design.md](2026-09-01-crowd-work-directory-mvp-design.md), [2026-09-06-moderator-listing-edit-design.md](2026-09-06-moderator-listing-edit-design.md), [src/lib/utils/recurrence.ts](../../../src/lib/utils/recurrence.ts), [src/pages/listings/[id]/report.astro](../../../src/pages/listings/[id]/report.astro)

## Summary

`occurrence_exceptions` already supports a `type: 'modified'` row — a single occurrence of a recurring listing overridden with a different date, start time, and/or venue, without touching the recurring rule itself — and `recurrence.ts`'s resolution logic already honors it. But nothing in the moderation system can ever create one: `approveListingUpdate` only ever writes through to the permanent `listings`/`recurrence_rules` rows, so there is currently no way to say "just this Thursday, it's at a different venue" without either permanently changing the recurrence or leaving the wrong info published until the exception passes.

This phase adds the missing authoring path: a new `moderation_queue` change type, `'modification'`, mirroring the existing `'cancellation'` flow end to end (public report → queue entry → moderator approval → `occurrence_exceptions` row).

While designing this, a second, related gap surfaced: the existing cancellation report path never actually asks the reporter which date is being cancelled — `report.astro` always inserts `proposed_data: { originalDate: null }`, and a moderator fills in the real date later, during approval. A modification report has the identical "which occurrence?" problem. Rather than solve it twice, this phase also adds a date field to the report form itself, fixing both paths at once.

## Goals

- Let a moderator record that a single occurrence of a recurring listing is different (new date, new time, and/or new venue) from its recurring pattern, without editing the recurring rule.
- Let the public "report a problem" form be the entry point for both cancellation and modification reports, each tagged with the specific occurrence date at submission time — not left for the moderator to track down later.
- Reuse the existing cancellation flow's shape (queue change type, approval-time structured fields, `occurrence_exceptions` write) rather than inventing a parallel pattern.

## Non-goals (this phase)

- **A moderator direct-create shortcut**, bypassing the queue. Cancellations have no such shortcut today either (only `approveCancellation`, reached from a queue entry) — modification stays symmetric with that, queue-only.
- **Structured modification fields on the public report form.** The reporter supplies a date and a free-text note, same as cancellation; the moderator translates that into the structured `new_date`/`new_start_time`/`new_venue_id` fields at approval time.
- **Retrofitting `/check-sources`** to detect or file modifications. That skill explicitly treats a changed listing as an `update` to the permanent record today; whether a source-detected change should ever become a single-occurrence exception instead of a permanent edit is a separate question, out of scope here.
- **Real-time or digest notifications** built on top of this. A future notifications phase may use `occurrence_exceptions`/`moderation_queue` data this phase produces, but is designed separately.

## Architecture Overview

One enum value addition (`moderation_change_type` gains `'modification'`, added in its own migration per Postgres's same-transaction restriction, exactly as `'archive'`/`'restore'` were added), one RLS policy update, one new write-through function in `moderation.ts` mirroring `approveCancellation`, one new approval-form component mirroring `CancellationApprovalForm`, and a small extension to the existing report form.

## Data Model

No new tables. `occurrence_exceptions` already has everything a `'modified'` row needs (`original_date`, `new_date`, `new_start_time`, `new_venue_id`, `note`).

**Migration 1** — enum value:

```sql
alter type moderation_change_type add value 'modification';
```

**Migration 2** — RLS policy update. The existing anonymous report-form policy:

```sql
create policy "anyone can submit a correction report"
  on moderation_queue for insert
  to anon
  with check (
    change_type in ('update', 'cancellation')
    and origin = 'report_form'
    and listing_id is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and status = 'pending'
  );
```

is replaced with a version that adds `'modification'` to the allowed change types, and — since both occurrence-specific report types now carry a date at submission time — enforces that the date is actually present:

```sql
drop policy "anyone can submit a correction report" on moderation_queue;

create policy "anyone can submit a correction report"
  on moderation_queue for insert
  to anon
  with check (
    change_type in ('update', 'cancellation', 'modification')
    and origin = 'report_form'
    and listing_id is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and status = 'pending'
    and (
      change_type = 'update'
      or (proposed_data ->> 'originalDate') is not null
    )
  );
```

This closes the gap where a cancellation could previously be filed with no date at all — from this phase forward, the database itself refuses one.

`QueueChangeType` (moderation.ts) becomes `"new" | "update" | "cancellation" | "modification" | "archive" | "restore"`. `ProposedCancellation` (`{ originalDate, note? }`) is reused as-is for a `'modification'` entry's `proposed_data` — same shape, no new interface needed at the proposal stage; the structured override fields only exist from approval time onward, directly on the `occurrence_exceptions` row.

## Flow

**Report form** (`report.astro`): a third reason option, `different_this_time` ("It's happening, but something's different this time"), alongside the existing `not_happening` and `something_else`. A date `FormField` is added to the form, initially `hidden`, shown for `not_happening` or `different_this_time` and hidden for `something_else` — toggled by a small inline script listening for `change` on the reason radios, the same pattern `ListingFieldsFields.astro` already uses for its conditional fields. The date is required whenever it's visible.

On submit, both occurrence-specific reasons now insert a populated date:

```ts
const changeType =
  reason === "not_happening" ? "cancellation"
  : reason === "different_this_time" ? "modification"
  : "update";

await supabase.from("moderation_queue").insert({
  listing_id: listing.id,
  change_type: changeType,
  proposed_data: changeType === "update" ? null : { originalDate },
  correction_note: note.trim(),
  origin: "report_form",
  status: "pending",
});
```

`originalDate` is read from the new form field and validated server-side (required, non-empty) whenever `changeType !== "update"`, alongside the existing note/reason validation.

**Admin approval** (`moderation.ts`): a new function, parallel to `approveCancellation`:

```ts
export async function approveModification(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  originalDate: string,
  newDate: string | null,
  newStartTime: string | null,
  newVenueId: string | null,
  note: string | null,
  approvalNote: string | null = null,
): Promise<void> {
  const { error: exceptionError } = await client
    .from("occurrence_exceptions")
    .insert({
      listing_id: listingId,
      original_date: originalDate,
      type: "modified",
      new_date: newDate,
      new_start_time: newStartTime,
      new_venue_id: newVenueId,
      note,
    });

  if (exceptionError)
    throw new Error(`Failed to record modification: ${exceptionError.message}`);

  await markApproved(
    client,
    entryId,
    listingId,
    { originalDate, newDate, newStartTime, newVenueId, note },
    approvalNote,
  );
}
```

`handleQueueReviewAction` gains an `action === "approve_modification"` branch, parsing `originalDate`, `newDate`, `newStartTime`, `newVenueId`, `note`, and the approval reason exactly as the existing `approve_cancellation` branch does, then calling `approveModification`.

## UI

**New `ModificationApprovalForm.astro`**, modeled directly on `CancellationApprovalForm.astro`:

- `originalDate` — prefilled from `proposedCancellation.originalDate` (reusing the same `ProposedCancellation` type), required.
- `newDate` — optional date field.
- `newStartTime` — optional time field.
- `newVenueId` — a `FormSelect` of venues, defaulting to "No change."
- `note` — textarea, prefilled from `entry.correctionNote`, same as cancellation's.
- The existing approval-reason section (`APPROVAL_REASON_OPTIONS`/`APPROVAL_REASON_HINT`, `FormSelect` + conditional "other" `FormTextarea`) — unchanged, reused as-is.
- Submit: hidden `action=approve_modification`, `Button` labeled "Approve modification," `disabled={entry.status !== "pending"}`.

At least one of `newDate`/`newStartTime`/`newVenueId` must be set for the approval to mean anything; this is validated client-side (disable submit / inline message until one is set) rather than at the RLS layer, matching how this project treats moderator-facing form validation elsewhere (RLS enforces the untrusted anonymous surface; authenticated moderator forms validate in the application layer).

**`admin/queue/[id].astro`**: a new branch alongside the existing `entry.changeType === "cancellation"` check, rendering `ModificationApprovalForm` for `entry.changeType === "modification"`.

**`moderation-labels.ts`**:
- `CHANGE_TYPE_LABEL.modification = "Modification"`.
- `previewFor`'s final fallback (currently a bare `"Cancellation"`, reached only when `correctionNote` is empty) becomes `entry.changeType === "modification" ? "Modification" : "Cancellation"` — dead code today given the new RLS requirement guarantees a note, but shouldn't silently mislabel a modification if it's ever reached.

## Testing

Per this project's existing priorities (automate state-transition/governance logic; verify UI manually):

- `approveModification` tests in `moderation-approve.test.ts`, alongside the existing `approveCancellation` coverage: asserts the resulting `occurrence_exceptions` row has `type: 'modified'` with the correct `new_date`/`new_start_time`/`new_venue_id`/`note`, and that the queue entry transitions to `approved` with the expected `approved_data`.
- An RLS test asserting the anon report-form policy **rejects** a `'cancellation'` or `'modification'` insert whose `proposed_data` has no `originalDate`, and accepts one that does — proving the new database-level requirement actually holds, not just the application code above it.
- No changes needed to `recurrence.test.ts` — the resolution side (a `modified` exception overriding its rule) is already covered; this phase only adds the authoring path into that existing table.
- Page-level (`report.astro`'s new reason option and date field, `admin/queue/[id].astro`'s new form branch): manual verification, consistent with how this project treats admin/public page changes elsewhere.

## Known Limitations / Edge Cases

- A modification report's date is reporter-supplied and unverified until a moderator reviews it, same trust level as every other report-form field today — no new risk introduced.
- `/check-sources` still has no path to file a modification (or a cancellation) — both remain public-report-only for now, per Non-goals above.
- If a moderator approves a `'modification'` entry with none of `newDate`/`newStartTime`/`newVenueId` set (bypassing the client-side check, e.g. via a raw form submission), the result is an `occurrence_exceptions` row indistinguishable in effect from "no exception" — a wasted but harmless row. Worth a server-side guard if this is ever observed in practice; not required for this phase given the governance model already trusts authenticated moderators at this level elsewhere (e.g. nothing stops a moderator from approving a `'update'` with unchanged fields either).
