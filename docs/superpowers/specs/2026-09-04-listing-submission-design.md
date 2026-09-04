# Listing Submission — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-03-moderation-archive-design.md](2026-09-03-moderation-archive-design.md), [2026-09-03-moderation-queue-admin-review-design.md](2026-09-03-moderation-queue-admin-review-design.md), [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md), [notes/future-considerations.md](../../../notes/future-considerations.md)

## Summary

The moderation archive phase built the audit trail (`approved_by`, `approved_data`, `approval_note`, `decided_at`) specifically so this phase could rely on it, and explicitly deferred both halves of "new listing" creation to land together here: a public submission form and a moderator direct-add path. This phase ships both, plus the ability for either path to introduce a venue that doesn't exist yet — reviewed and created in the same step as the listing that references it.

Both entry points write to the existing `moderation_queue` table. The public form (`/listings/new`, anonymous) always creates a `pending` entry, identical in spirit to the existing report form's correction flow but for `change_type: 'new'`. The moderator direct-add form (`/admin/listings/new`, authenticated) creates a queue entry that is already `approved`, self-attributed, in the same insert — no bypass of the audit record, only of the pending-queue wait, since a trusted moderator acting on their own judgment doesn't need a second set of eyes to publish (the two-moderator rule has only ever applied to confirming *rejections* of someone else's proposal).

## Goals

- Ship the public "submit a new listing" form the vision doc names as a core feature, always human-reviewed via the existing queue.
- Ship moderator direct-add as a queue-entry-based, self-approved insert — reusing `markApproved`'s existing write-through and the audit columns already in place, not a separate untracked write path.
- Let either path propose a venue that isn't in `venues` yet, created atomically alongside the listing when a moderator approves the entry (or, for direct-add, in the same request that creates it).
- Make mic vs. show fields easier to fill out correctly on both forms via conditional show/hide, rather than presenting every field always.

## Non-goals (this phase)

- New areas or neighborhoods — a proposed venue must pick an existing neighborhood from the fixed taxonomy. Flagged in [future-considerations.md](../../../notes/future-considerations.md) as worth revisiting once real submissions run into gaps in the current set.
- Any change to the two-moderator rejection rule — this phase only touches the approval path, which was always single-moderator.
- Rate limiting or CAPTCHA beyond the existing honeypot field pattern (`report.astro`) — a spam submission still only produces a queue entry for a moderator to reject, not a live publish, so the existing mitigation's threat model is unchanged by adding a second form that uses it.
- Editing or withdrawing a submission after the fact, by the public submitter or the moderator who direct-added it — consistent with the project's existing "queue entries aren't mutated by their originator" convention.
- Wrapping the venue-then-listing insert in a database transaction — not supported by the way this project currently uses the Supabase client (see Known Limitations).

## Architecture Overview

No new services. Two new pages (one public, one admin), extensions to the existing `moderation_queue`/`venues` RLS policies and the existing `moderation.ts` write-through/parsing functions, and a new shared Astro component factored out of the fields section already extracted during the moderation-archive-phase's queue-detail-page refactor (`ListingApprovalForm.astro`).

## Data Model

**`ProposedListingFields` gains venue flexibility** (`src/lib/data/moderation.ts`):

```ts
export interface ProposedListingFields {
  type: "mic" | "show";
  title: string;
  host: string | null;
  description: string | null;
  venueId: string | null;         // an existing venue, when chosen
  newVenue: ProposedVenue | null; // a proposed new venue, when chosen instead
  startTime: string;
  signUpMethod: string | null;
  costToPerform: string | null;
  ticketPrice: string | null;
  ticketUrl: string | null;
  recurrence: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
  oneOffDate: string | null;
}

export interface ProposedVenue {
  name: string;
  address: string;
  neighborhoodId: string;
  googleMapsUrl: string | null;
}
```

Exactly one of `venueId` / `newVenue` is populated. This is enforced in the form-parsing/validation layer (`parseProposedListingFields`), not the database — `proposed_data` is already an unchecked `jsonb` blob validated at the write-through layer, and this doesn't change that convention.

**New migration — `venues` gets an `authenticated` INSERT policy** (doesn't exist today; needed because venue creation happens inside the same authenticated client call that approves the listing, for both the queue-approval path and direct-add):

```sql
create policy "moderators can insert venues"
  on venues for insert
  to authenticated
  with check (true);
```

**New migration — `moderation_queue` policy changes:**

1. Extend the anonymous insert policy to also allow a `'new'` listing proposal. The existing "anyone can submit a correction report" `with check` becomes an `or` between the correction shape (unchanged: `update`/`cancellation`, `origin = 'report_form'`, `listing_id is not null`) and a new shape for new-listing proposals:

```sql
(
  change_type = 'new'
  and origin = 'submission_form'
  and listing_id is null
  and proposed_data is not null
  and proposed_by is null
  and proposed_reason is null
  and confirmed_by is null
  and status = 'pending'
)
```

2. A new `authenticated` INSERT policy for direct-add. No authenticated insert can ever land as anything other than already-decided and self-attributed — this is what makes direct-add safe to allow without a second reviewer:

```sql
create policy "moderators can directly insert a pre-approved new listing"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'new'
    and origin = 'moderator_direct_add'
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
  );
```

**`ORIGIN_LABEL`** in `moderation-labels.ts` gains `submission_form: "Public submission"` and `moderator_direct_add: "Direct add"`.

## Write-Through Changes

**`createListingFromFields(client, fields): Promise<string>`** — new, factored out of `approveNewListing`'s existing body. If `fields.newVenue` is set, inserts into `venues` first and uses the returned id; otherwise uses `fields.venueId`. Then inserts the listing and, if `fields.recurrence` is set, the recurrence rule — exactly the sequence `approveNewListing` already runs today, just with the venue-creation step prepended. `approveNewListing` becomes `createListingFromFields` followed by the existing `markApproved` call. `approved_data`/`proposed_data` snapshots record whichever `venueId` was actually used (including a newly minted one), never the original `newVenue` proposal shape — consistent with `approved_data` already meaning "what was actually published."

**`parseProposedListingFields(formData)`** gains a venue branch: reads a `venueId` field whose value may be the sentinel `"__new__"`, in which case it instead reads `newVenueName`/`newVenueAddress`/`newVenueNeighborhoodId`/`newVenueGoogleMapsUrl` into `newVenue` and leaves `venueId` null.

**`submitNewListingProposal(client, formData): Promise<void>`** — new, for the public path. Parses fields via `parseProposedListingFields`, inserts into `moderation_queue` with `change_type: 'new'`, `origin: 'submission_form'`, `status: 'pending'`, `proposed_data: fields`. Uses the anonymous Supabase client, matching `report.astro`'s existing pattern (including the honeypot check ahead of it).

**`directAddListing(client, formData): Promise<void>`** — new, for the moderator path. Parses fields and an approval note (via the existing `parseApprovalNote`), calls `createListingFromFields`, then inserts into `moderation_queue` (not update — there is no existing pending row) with `status: 'approved'`, `approved_by: user.id`, `approved_data: fields`, `approval_note`, `decided_at: now`, `origin: 'moderator_direct_add'`, `change_type: 'new'`, `listing_id` set to the created listing. Satisfies the new authenticated INSERT policy above.

**`getPrefillForEntry(entry)`** gains a case: if `entry.proposedData` has `newVenue` set, the returned prefill carries it through unchanged (rather than only ever exposing `venueId`), so the review form's venue picker can pre-select "Add a new venue…" and pre-fill its reveal fields when reviewing a public submission that proposed one.

**New `getNeighborhoods(): Promise<{ id: string; name: string; areaId: string }[]>`** in `src/lib/data/listings.ts` — doesn't exist today; needed for the new-venue reveal block's neighborhood picker. Mirrors the existing `getAreas()`/`getVenues()` shape.

## Components

**`ListingFieldsFields.astro`** — new, factored out of `ListingApprovalForm.astro`'s existing "Listing details" + "Recurrence" markup (everything between the `<input type="hidden" name="action" .../>` and the "Approval" section). Pure fields, no `<form>` wrapper, no submit button — the three consumers below submit differently. Takes `prefill`, `venueOptions`, `neighborhoodOptions`. Changes from what exists today:

- Mic-only fields (Host, Sign-up method, Cost to perform) and show-only fields (Ticket price, Ticket URL) each get a `data-field-for="mic"` / `data-field-for="show"` wrapper. A shared inline `<script>` toggles `hidden` on these based on the Type `<select>`'s value, on `change` and on load — the same reveal mechanism already used for `data-other-reason`, applied to a new grouping.
- The Venue `FormSelect` gains a trailing `{ value: "__new__", label: "Add a new venue…" }` option. Selecting it reveals a `data-new-venue` block (Name, Address, a `FormSelect` over `neighborhoodOptions`, optional Maps URL) via the same reveal mechanism; selecting any real venue hides it.

**`ListingApprovalForm.astro`** — updated to render `<ListingFieldsFields prefill={prefill} venueOptions={venueOptions} neighborhoodOptions={neighborhoodOptions} />` in place of its current inline fields block. Its own Approval-reason section and submit button are unchanged.

## Pages

**`/listings/new`** (public, anonymous) — same shell as `report.astro` (honeypot field, no-JS-safe `<form method="post">`, thank-you state after success), body swapped for `<ListingFieldsFields>` plus its own submit button (no approval-reason section — that's a moderator-only concept). On POST, calls `submitNewListingProposal`. `SiteHeader.astro`'s "Submit a listing" nav link already exists as a `href="#"` placeholder — this phase points it at `/listings/new`.

**`/admin/listings/new`** (moderator, gated by the same Supabase Auth session check as every other `/admin/*` page) — `<ListingFieldsFields>` inside a form with an approval-reason `FormSelect` (reusing `APPROVAL_REASON_OPTIONS`), submitting to `directAddListing`. Linked from `AdminHeader.astro` alongside the existing Archive link.

**`queue/[id].astro`** — no page-level changes beyond what `ListingApprovalForm.astro` and `getPrefillForEntry` already absorb; a public submission proposing a new venue now correctly pre-fills the reveal block when a moderator opens it for review.

## Testing

Per this project's existing testing priorities (automate state-transition/governance logic; verify UI manually at this scale):

- `parseProposedListingFields` correctly parses the `"__new__"` venue sentinel into a `newVenue` object, and a real venue id into `venueId` with `newVenue` null.
- `createListingFromFields` creates a venue when `newVenue` is set and uses its id for the listing; uses `venueId` directly otherwise. Both cases assert the resulting `listings.venue_id` and that `approved_data`/`proposed_data` records the resolved id, not the original proposal shape.
- `directAddListing` creates a listing (and venue, when proposed) and a `moderation_queue` row with `status: 'approved'`, `approved_by` set to the acting moderator, `decided_at` non-null, `origin: 'moderator_direct_add'`, in one call.
- RLS: an anonymous insert with `change_type: 'new'` succeeds only when it matches the new policy shape exactly (mirrors the existing "anyone can submit a correction report" forgery-style tests) — in particular, that `status`, `proposed_by`, `proposed_reason`, and `confirmed_by` can't be set by the anonymous submitter.
- RLS: an authenticated insert into `moderation_queue` is rejected unless `status = 'approved'`, `approved_by = auth.uid()`, and `decided_at is not null` — a moderator cannot use the new insert policy to sneak in a `pending` entry or attribute the approval to someone else.
- The two new pages: manual verification, consistent with how `/admin/archive` and the queue detail/list pages were treated in prior phases.

## Known Limitations / Edge Cases

- Venue-then-listing creation isn't wrapped in a database transaction — the Supabase client as used in this project doesn't support multi-statement transactions. If the venue insert succeeds but the listing insert fails, the result is an orphaned, unused venue row. This is not a new risk introduced by this phase: `approveNewListing`'s existing listing-then-recurrence sequence has the identical failure shape today (an orphaned listing if the recurrence insert fails); this phase just adds one more insert ahead of it.
- A proposed new venue is created exactly once, at the moment its listing entry is approved (or, for direct-add, at creation) — there's no deduplication against an existing venue with the same name/address. Two independent submitters proposing "the same" new venue by name will produce two venue rows if both are approved; resolving that is a moderator judgment call at review time (reject the second as a duplicate), not something this phase automates.
- No self-serve way to add an area or neighborhood — see Non-goals and the corresponding entry now in `future-considerations.md`.

## Open Items for the Implementation Plan

- Exact wording/order for the mic/show field-visibility script and the new-venue reveal script in `ListingFieldsFields.astro` — whether they're one combined `<script>` or two, given both now live in a component that's imported three times (Astro de-dupes identical inline scripts per page, but this should be verified during implementation rather than assumed).
- Confirm `astro check` and the existing moderation test suite both stay green through the `ProposedListingFields.venueId` type change from `string` to `string | null`, since every existing caller (seed data, prior tests) currently assumes it's always a string.
