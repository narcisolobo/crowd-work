# Moderator Listing Edit — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-06-archive-status-rls-gap-design.md](2026-09-06-archive-status-rls-gap-design.md), [2026-09-04-listing-submission-design.md](2026-09-04-listing-submission-design.md), [src/pages/listings/[id]/report.astro](../../../src/pages/listings/[id]/report.astro), [src/pages/admin/listings/new/index.astro](../../../src/pages/admin/listings/new/index.astro)

## Summary

The direct-add success page (`/admin/listings/new`) currently offers "Edit this listing," which links to `/listings/[id]/report?context=moderator` — the public "Report a problem" page, reused with a `context` query param that only swaps copy. That page has no auth check at all (confirmed: `Astro.locals.user`/`supabase` are only populated for `/admin/*` paths by `src/middleware.ts`, so they're always `null` there), so the "moderator" framing is spoofable by anyone who appends the query param, and a submitted correction lands in `moderation_queue` as `pending` — reviewed later like any public report, not applied immediately.

This phase gives moderators a real, auth-gated edit surface: a new `/admin/listings/edit/[id]` page that writes directly to the listing, self-approved, with a full audit trail — the same governance shape already established for creation (`directAddListing`) and archiving (`archiveListing`): single-moderator, immediate, no propose/confirm ceremony. It also retires the spoofable path entirely rather than leaving it as an unused alternate route.

## Goals

- Give moderators an auth-gated way to edit any published listing's fields directly, applied immediately with a required reason, recorded in the existing Moderation Archive audit trail.
- Make the new page reachable from both the direct-add success card and a per-row link on `/admin/listings`.
- Retire the spoofable `context=moderator` reuse of the public report form.
- Share the actual field-write logic with the existing queue-approval path (`approveListingUpdate`) rather than duplicating it, matching how listing creation already shares `createListingFromFields` between its direct and queue-approved paths.

## Non-goals (this phase)

- **Second-moderator confirmation.** Per the existing approve/reject asymmetry (already established for archiving), editing is closer to an approval than a rejection — reversible, moderator-initiated, low ceremony. Unilateral, like creation and archiving.
- **Editing an archived listing.** Every entry point to the new page (`/admin/listings`, the direct-add success card) only surfaces published listings. A moderator who navigates to the edit URL for an archived listing directly isn't blocked, but `directUpdateListing` never touches `listings.status`, so nothing about a listing's archived state changes as a side effect — this is a known gap, not a goal to close here (see Known Limitations).
- **Diffing or previewing changes before saving.** Unlike a queue review page (which exists specifically to inspect a proposal before deciding), this is a direct edit of a listing the moderator already has open — no review step, matching the direct-add form's shape.
- **A general-purpose listings CRUD UI.** `/admin/listings` continues to exist to host the Archive and (now) Edit entry points, not to grow into a full management surface.

## Architecture Overview

One migration (a new `moderation_queue` INSERT policy — no enum or table changes needed, since `update` is already a valid `change_type` and `origin` is a free-text column), changes to existing write-through logic in `src/lib/data/moderation.ts`, one new admin page, one small edit to `/admin/listings`, and a simplification (not an addition) to `report.astro`.

## Data Model

The existing authenticated INSERT policy on `moderation_queue` for direct-add (`20260904182818_listing_submission_policies.sql`) is scoped to `change_type = 'new' and origin = 'moderator_direct_add'` — a direct-edit insert (`change_type = 'update'`) won't match it and RLS will reject it, the same wall the archive feature hit and solved with its own dedicated policy (`20260907030344_archive_listing_queue_insert_policy.sql`). This needs the same treatment:

```sql
-- Moderators have only ever inserted a pre-approved queue row for a
-- moderator_direct_add 'new' listing or a moderator_archive/system_recovery
-- 'archive' entry. Direct editing needs its own equivalent permissive INSERT
-- policy — without one, no permissive policy on moderation_queue covers an
-- 'update'-shaped row inserted (rather than transitioned from pending) by an
-- authenticated moderator.
create policy "moderators can directly insert a pre-approved update entry"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'update'
    and origin = 'moderator_direct_edit'
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
    and proposed_data is null
    and approved_data is not null
    and listing_id is not null
  );
```

No RLS change is needed on `listings` or `recurrence_rules`: editing never touches `listings.status`, so it never triggers the SELECT-vs-UPDATE-result mismatch that blocked archiving (the only `SELECT` policy on `listings` requires `status = 'published'`, and edits leave that column untouched).

An `update` queue entry inserted by `directUpdateListing`:

- `listing_id` — the edited listing (never null).
- `proposed_data` — always `null`, same reasoning as `archiveListing`'s entries: nothing is "proposed" here, it's already decided.
- `correction_note` — always `null` (belongs to public-report-originated entries).
- `origin` — `"moderator_direct_edit"`.
- `status` — always inserted directly as `"approved"`.
- `approved_data` — the submitted fields, same shape `approveListingUpdate` already produces for the queue-review path.
- `approved_by` — the acting moderator's id.
- `approval_note` — the required reason.
- `decided_at` — `now()` at insert time.

`QueueChangeType` is unchanged (`"new" | "update" | "cancellation" | "archive"`) — `"update"` already exists and the Moderation Archive page's existing `CHANGE_TYPE_LABEL`/preview logic for `"update"` entries already handles an `approved` entry with populated `approvedData` correctly (no page changes needed there beyond the origin label below).

## Write-Through Changes

**Extract shared field-write logic.** `approveListingUpdate`'s current body (the `listings.update(...)` call and the conditional `recurrence_rules.upsert(...)`) becomes a standalone function:

```ts
async function applyListingFields(
  client: SupabaseClient<Database>,
  listingId: string,
  fields: ProposedListingFields,
): Promise<{ venueId: string | null }> {
  const { venueId } = await resolveVenueId(client, fields);

  const { error: listingError } = await client
    .from("listings")
    .update({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: venueId,
      start_time: fields.startTime,
      one_off_date: fields.oneOffDate,
      sign_up_method: fields.signUpMethod,
      cost_to_perform: fields.costToPerform,
      ticket_price: fields.ticketPrice,
      ticket_url: fields.ticketUrl,
    })
    .eq("id", listingId);

  if (listingError)
    throw new Error(`Failed to update listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .upsert(
        {
          listing_id: listingId,
          frequency: fields.recurrence.frequency,
          day_of_week: fields.recurrence.dayOfWeek,
          week_of_month: fields.recurrence.weekOfMonth,
        },
        { onConflict: "listing_id" },
      );
    if (recurrenceError)
      throw new Error(
        `Failed to update recurrence rule: ${recurrenceError.message}`,
      );
  }

  return { venueId };
}
```

`approveListingUpdate` is refactored to call it, then proceeds exactly as before (building `approvedData` and calling `markApproved`) — a pure refactor, no behavior change.

**New direct-edit function**, modeled on `directAddListing`/`archiveListing`:

```ts
export async function directUpdateListing(
  client: SupabaseClient<Database>,
  listingId: string,
  formData: FormData,
): Promise<void> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const fields = parseProposedListingFields(formData);
  const missing = [
    ...findMissingRequiredFields(fields),
    ...findMissingReason(formData),
  ];
  if (missing.length > 0) throw new MissingRequiredFieldsError(missing);
  const approvalNote = parseApprovalNote(formData);

  const { venueId } = await applyListingFields(client, listingId, fields);
  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };

  const { error } = await client.from("moderation_queue").insert({
    change_type: "update",
    listing_id: listingId,
    proposed_data: null,
    correction_note: null,
    origin: "moderator_direct_edit",
    status: "approved",
    approved_by: user.id,
    approved_data: approvedData as unknown as Json,
    approval_note: approvalNote,
    decided_at: new Date().toISOString(),
  });

  if (error)
    throw new Error(`Listing was updated, but the audit record failed to save: ${error.message}`);
}
```

The queue insert failing after the listing update succeeds is an acceptable, honestly-reported edge case — same pattern `archiveListing` already established.

**Shared prefill mapping.** `getPrefillForEntry`'s fallback branch (moderation.ts:792-809, mapping a live `listings` row into `ProposedListingFields` when a report-form update has no structured `proposedData`) is extracted into `listingToProposedFields(listing: Listing): ProposedListingFields`, called from both `getPrefillForEntry` and the new edit page — avoiding a third inline copy of this mapping.

**`moderation-labels.ts`:** add `moderator_direct_edit: "Direct edit"` to `ORIGIN_LABEL`.

## Pages

**`/admin/listings/edit/[id]`** — new. Auth-gated for free by the existing `/admin` middleware (no page-level auth code needed). Loads `getListingById(id)` via `Astro.locals.supabase`; redirects to `/admin/listings` if the listing doesn't exist (admin context — back to the list, not the public `/404`).

Renders `ListingFieldsFields` with `prefill={listingToProposedFields(listing)}`, plus the same "Approval" reason section (`FormSelect`/`FormTextarea`, `APPROVAL_REASON_OPTIONS`/`APPROVAL_REASON_HINT`) `/admin/listings/new` already uses, and a submit `Button` labeled "Save changes."

POST calls `directUpdateListing(supabase, id, formData)`. A thrown `MissingRequiredFieldsError` populates `fieldErrors` exactly as `/admin/listings/new` does. Any other error shows a general error banner. On success, redirects to `/admin/listings/edit/${id}?updated=1`, which renders the same form (freshly reloaded and prefilled from the now-updated listing) with a small "Saved." banner above it — the moderator stays on the page rather than bouncing to a separate confirmation view, since there's no title-spoofing concern here (the listing stays published, so a fresh `getListingById` lookup after redirect is always safe to trust, same reasoning `/admin/listings/new`'s `added` param already relies on).

Title: `Edit — ${listing.title} — Crowd Work admin`. `AdminUtilityBar backHref="/admin/listings"`.

**`/admin/listings/new/index.astro`** — the success card's "Edit this listing" button href changes from `/listings/${added.listingId}/report?context=moderator` to `/admin/listings/edit/${added.listingId}`.

**`/admin/listings`** — each row gains an "Edit" link (outline `Button`, alongside the existing "Archive" disclosure trigger) to `/admin/listings/edit/${listing.id}`.

**`/listings/[id]/report.astro`** — simplified, not extended: `isModeratorContext` and every copy branch keyed on it (title, heading, body copy, button label, success copy) are removed. The page goes back to being exactly one thing — the public "Report a problem" form — with no query-param-driven identity.

## Testing

Per this project's existing testing priorities (automate the state-transition/governance logic; verify UI manually at this scale):

- New `moderation-direct-edit.test.ts` (mirroring `moderation-direct-add.test.ts`): `directUpdateListing` writes the listing's fields, upserts a recurrence rule when present, inserts a `moderation_queue` row shaped exactly as described above (`change_type: "update"`, `status: "approved"`, correct `origin`/`approved_by`/`approved_data`/`approval_note`/`decided_at`); throws `MissingRequiredFieldsError` when required fields are missing; returns a validation failure when the reason is missing.
- `moderation-approve.test.ts`'s existing `approveListingUpdate` coverage must keep passing unchanged after the `applyListingFields` extraction — this is a pure refactor, not a behavior change.
- RLS: an authenticated moderator inserting a correctly-shaped `moderator_direct_edit` row succeeds; a row missing `approved_by = auth.uid()` or with `status != 'approved'` is rejected — mirroring the archive feature's insert-policy test.
- `listingToProposedFields()`: given a `Listing`, returns the same shape `getPrefillForEntry`'s current inline fallback produces (regression coverage for the extraction).
- Page-level (`/admin/listings/edit/[id]`, the repointed success-card link, the new `/admin/listings` row link, and the simplified `report.astro`): manual verification, consistent with how prior admin pages in this project were treated.

## Known Limitations / Edge Cases

- A moderator who navigates directly to `/admin/listings/edit/[id]` for an archived listing isn't blocked by the page itself, only by the absence of any UI path that would surface that URL. `directUpdateListing` never touches `listings.status`, so this can't silently republish an archived listing — the field values would just be edited in place while the listing stays archived. Worth a guard later if this ever becomes reachable in practice, but not required for this phase's actual entry points.
- Like `archiveListing`, if the `moderation_queue` insert fails after the listing/recurrence writes succeed, the edit has still taken effect but leaves no audit trail — surfaced to the caller as an error rather than silently swallowed.
- Removing `isModeratorContext` from `report.astro` means any existing bookmarked or shared `?context=moderator` links stop showing moderator-flavored copy (they simply become ordinary "Report a problem" links) — acceptable since that framing was never authenticated or trustworthy in the first place.
