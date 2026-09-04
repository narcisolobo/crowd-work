# Moderation Archive — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-03-moderation-queue-admin-review-design.md](2026-09-03-moderation-queue-admin-review-design.md), [2026-09-03-moderation-queue-admin-review.md](../plans/2026-09-03-moderation-queue-admin-review.md), [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md), [notes/future-considerations.md](../../../notes/future-considerations.md)

## Summary

The original vision for Crowd Work names a "full archive of what was rejected and why" as a core accountability mechanism — moderation governance is the project's answer to a prior community list collapsing under one person's unilateral judgment. The Moderation Queue + Admin Review phase built the *data* half of that promise (rejected entries are never deleted) but explicitly deferred the *viewable* half, and never captured an equivalent "who/why" for approvals at all — today, nothing in the schema records which moderator clicked Approve.

That gap becomes load-bearing for the next phase: a moderator direct-add path (creating/editing a listing without going through the queue) is only trustworthy if the action it takes is logged somewhere visible, which means the audit trail needs to exist *before* direct-add ships. This phase builds that trail — schema, write-through changes, and an admin archive view — against the queue as it exists today (seed and public-report-form entries). Direct-add itself, and the public new-listing submission form it was originally paired with, are a separate, later phase that will simply become the archive's next producer.

## Goals

- Give moderators a viewable, in-app record of every decided (`approved`/`rejected`) `moderation_queue` entry, closing the gap flagged as a known limitation in the prior phase ("auditing requires querying `moderation_queue` directly").
- Capture **who** approved an entry — untracked today. `proposed_by`/`confirmed_by` only exist for the rejection propose/confirm flow; approval currently records no actor at all.
- Capture **what** was actually approved. `proposed_data` is deliberately preserved as the original, unedited proposal, so it can't answer "what did the moderator actually publish" once they've edited fields before approving.
- Capture **why**, for both outcomes — rejections already have `proposed_reason`; approvals get an equivalent, optional field.
- Lay the exact audit foundation the upcoming direct-add feature needs, so that phase can insert a pre-approved entry into a schema already built to explain who acted and why.

## Non-goals (this phase)

Deferred to the **Listing Submission** phase:

- Moderator direct-add for listings (bypassing the queue) — this phase's schema is what that feature will write into, but no new write path ships here.
- The public new-listing submission form.

Deferred indefinitely, or until volume justifies it:

- Filtering, search, or pagination on the archive beyond a single reverse-chronological list.
- Editing or reversing a past decision from the archive view — it's read-only, matching the queue table's existing "rejected entries are never deleted" invariant.

## Architecture Overview

No new services. One new admin page, gated by the same Supabase Auth session check every other `/admin/*` page already uses. The work is mostly a migration (four new columns + updated RLS) and updated write-through logic in the existing approve/reject functions in `src/lib/data/moderation.ts` — no new tables.

## Data Model

```sql
alter table moderation_queue
  add column approved_by uuid references auth.users(id),
  add column approved_data jsonb,
  add column approval_note text,
  add column decided_at timestamptz;
```

- `approved_by` — the acting moderator's id, set when status transitions to `approved`. Mirrors how `confirmed_by` already works for rejections.
- `approved_data` — a snapshot of the final values written to `listings` (+ `recurrence_rules`/`occurrence_exceptions`), shaped per `change_type` the same way `proposed_data` already is. Taken at approval time, independent of whatever `proposed_data` originally said.
- `approval_note` — optional free text. Deliberately **not** required, unlike `proposed_reason`: the original design's own rationale is that approving is easy to correct later while rejecting silently drops a contribution, which is why only rejection carries a mandatory reason and a second-reviewer gate. A note here adds context to the archive without adding friction to routine approvals.
- `decided_at` — when the entry actually moved to `approved`/`rejected`, as distinct from `created_at` (when it entered the queue). This is the archive's sort/display key; for a seed or report-form entry these two timestamps can differ significantly, and for the future direct-add path they'll coincide.

RLS: the existing approve/reject update policies gain checks tying the new actor/timestamp columns to the transition they belong to, the same way `proposed_by = auth.uid()` is already enforced on proposing a rejection.

```sql
drop policy "moderators can approve or propose rejection on a pending entry" on moderation_queue;

create policy "moderators can approve or propose rejection on a pending entry"
  on moderation_queue for update
  to authenticated
  using (status = 'pending')
  with check (
    (status = 'approved' and approved_by = auth.uid() and decided_at is not null)
    or (status = 'rejection_proposed' and proposed_by = auth.uid() and proposed_reason is not null)
  );

drop policy "a different moderator can confirm or return a proposed rejection" on moderation_queue;

create policy "a different moderator can confirm or return a proposed rejection"
  on moderation_queue for update
  to authenticated
  using (status = 'rejection_proposed' and auth.uid() <> proposed_by)
  with check (
    (status = 'rejected' and confirmed_by = auth.uid() and decided_at is not null)
    or (status = 'pending')
  );
```

A moderator can never set `approved_by` to another moderator's id — enforced at the policy level, not just by the application only ever passing `auth.getUser()`'s own id.

## Write-Through Changes

`markApproved()` in `src/lib/data/moderation.ts` gains `approvedData` and optional `approvalNote` parameters, looks up the acting user (the same `client.auth.getUser()` call `proposeRejection`/`confirmRejection` already make), and sets `approved_by`, `approved_data`, `approval_note`, and `decided_at` alongside the existing `status`/`listing_id` update. `approveNewListing`, `approveListingUpdate`, and `approveCancellation` each already assemble the final field values they write to `listings`/`occurrence_exceptions` — they pass that same object through as `approvedData`. `confirmRejection()` sets `decided_at` alongside `confirmed_by`.

The `/admin/queue/[id]` approve forms (both the standard listing form and the cancellation form) gain an optional "Reason" `FormSelect`, to keep routine approvals low-friction — a moderator shouldn't have to type a sentence just to approve something that's obviously accurate. Options:

- "Accurate as submitted"
- "Accurate after minor edits"
- "Verified independently"
- "Other" — reveals a free-text field instead

Selecting a canned reason submits its text directly as `approvalNote`; "Other" submits whatever's typed in the free-text field, or `null` if left blank. Either way the column receives plain text — the select is a UI convenience over the existing nullable `approval_note` column, not a new controlled vocabulary at the schema level.

`QueueEntry`, `QUEUE_ENTRY_SELECT`, and `mapQueueEntryRow` gain the four new fields.

## Pages

- **`/admin/archive`** — new. Lists entries with `status in ('approved', 'rejected')`, most recent `decided_at` first, with an All / Approved / Rejected status filter above the list — the same progressive-enhancement approach as the public listings page's `FilterBar`: the server always fetches and renders every decided entry, computing a `hidden` flag per row from `Astro.url.searchParams.get("status")` so a no-JS request still filters correctly via a plain `<form method="get">` GET submit; a `<script>` then progressively enhances the three tab buttons (mirroring `FilterBar`'s type tabs) to toggle `hidden` client-side instantly and sync the URL via `history.pushState`, with no full-page reload once JS is active. Each row shows change type, origin, status, and:
  - **Who** — `approved_by` for approvals; `proposed_by` (proposer) and `confirmed_by` (confirming moderator) for rejections.
  - **What** — a preview of `approved_data`/`correction_note` for approvals, `proposed_data`/`correction_note` for rejections (reusing the existing preview logic in `admin/index.astro`, factored into a shared helper rather than duplicated).
  - **Why** — `approval_note` (may be empty) for approvals; `proposed_reason` for rejections.
  - **When** — `decided_at`.

  No detail/drill-down route — the row itself carries everything, and there's no action to take on a decided entry, unlike the live queue.

- **`/admin`** (existing queue list) gains a nav link to `/admin/archive`.

## Testing

Per this project's existing testing priorities (automate the state-transition/governance logic; verify UI manually at this scale):

- Approving a `new`/`update`/`cancellation` entry sets `approved_by` to the acting moderator, `decided_at` to a non-null timestamp, and `approved_data` to the values actually written — extending the existing "moderator-edited values, not the original proposal, are what gets written" test to also assert this against `approved_data`.
- Confirming a rejection sets `decided_at`.
- RLS: a moderator cannot set `approved_by` (or `confirmed_by`) to another user's id — a policy-level test, matching the existing "cannot confirm your own proposed rejection" test.
- A query for archive entries returns only `approved`/`rejected` rows, ordered by `decided_at` descending, and excludes `pending`/`rejection_proposed`.
- The admin archive page itself: manual verification, consistent with how the queue list/detail pages were treated in the prior phase.

## Known Limitations / Edge Cases

- No pagination this phase — reasonable at current volume; revisit if the archive grows large enough for it to matter, the same reasoning that let the prior phase defer this view entirely.
- `approval_note` being optional means most approvals will show no "why" beyond the entry's own proposed data — treated as sufficient by default, consistent with the approve/reject asymmetry already established in the MVP design.
- Rows already `approved` before this migration ships (seed data only, at this pre-production stage) will show null `approved_by`/`approved_data`/`decided_at` in the archive — there's no historical actor to backfill.

## Open Items for the Implementation Plan

- Exact shared-helper extraction for the preview/label logic currently duplicated between `admin/index.astro` and `admin/queue/[id].astro`, now needed by a third page.
