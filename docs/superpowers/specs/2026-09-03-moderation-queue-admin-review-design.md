# Moderation Queue + Admin Review — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-01-crowd-work-directory-mvp-design.md](2026-09-01-crowd-work-directory-mvp-design.md), [2026-09-02-crowd-work-foundation.md](../plans/2026-09-02-crowd-work-foundation.md)

## Summary

The foundation plan built a public, read-only directory seeded directly via SQL. This phase adds the first write path into that data: a `moderation_queue` table and an authenticated admin review UI, so proposed listing changes can be reviewed and applied by a human before they go live. It also fixes the dangling "Report a problem" link already present on the styled listing detail page, giving the queue its first real (if minimal) public entry point.

Two producers of `moderation_queue` entries — the daily sourcing agent and the public submission form — are explicitly out of scope and covered by later plans. This phase stands in for both with seeded sample entries, so the queue and review UI can be built and exercised without either producer existing yet.

## Goals

- Give moderators a shared queue and a review UI that enforces the governance rule the whole design is built around: a single moderator can approve, but rejection requires a second, different moderator to confirm.
- Let a moderator correct proposed data (not just accept it verbatim) before it writes through to `listings`.
- Fix the dangling `/listings/[id]/report` link with a minimal public correction form that feeds the same queue.
- Prove the state machine and write-through logic work, since this is the highest-value target for automated tests per the original spec's Testing section.

## Non-goals (this phase)

Deferred to later plans:

- The daily sourcing agent (Supabase Edge Function, Claude Haiku extraction) — Path 1 from the original spec.
- The full public submission form for **new** listings — Path 2 from the original spec. Only the narrower report-a-correction form ships here.
- The `sources` table, trust levels, approval streaks, and the auto-publish path they enable.
- Email notifications (daily digest, real-time urgent alerts via Resend).
- Self-serve moderator invites or a dedicated moderator-role table — this phase provisions exactly two Supabase Auth accounts, both owned by the site owner, manually via the Supabase dashboard/CLI. Any authenticated user is treated as a moderator.
- A history view of past `approved`/`rejected` decisions in the admin UI.

## Architecture Overview

No new services. Admin pages live under `/admin/*` in the existing Astro project, rendered server-side (already the project's `output: "server"` mode) and gated by Supabase Auth: each admin page checks for a valid session in its frontmatter and redirects to `/admin/login` if absent. `moderation_queue` RLS restricts read/write to authenticated requests only. The public report form at `/listings/[id]/report` is the one anonymous write path, restricted by RLS to insert-only.

## Data Model

```sql
create type moderation_change_type as enum ('new', 'update', 'cancellation');
create type moderation_status as enum ('pending', 'rejection_proposed', 'approved', 'rejected');

create table moderation_queue (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references listings(id),        -- null for 'new'
  change_type moderation_change_type not null,
  proposed_data jsonb,                             -- structured fields for new/update, as originally submitted
  correction_note text,                            -- free text from the report form or a cancellation
  origin text not null,                            -- 'seed' | 'report_form' this phase (sources FK deferred to the sourcing-agent phase)
  status moderation_status not null default 'pending',
  proposed_by uuid references auth.users(id),      -- null for report-form (anonymous) origin
  proposed_reason text,                            -- required once a rejection is proposed
  confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
```

- `new`/`update` entries carry structured `proposed_data`, shaped like the relevant `listings` fields. This phase's only producer of these is seed data, standing in for the future sourcing agent/submission form.
- `cancellation` entries and report-form corrections use `correction_note` instead of structured data — there's no automatic extraction in this phase, so a moderator reads the note and translates it into field edits by hand.
- `proposed_data` is never overwritten after submission — it's the permanent record of what was originally proposed, independent of whatever a moderator later edits before approving.
- RLS: authenticated users get full read/update; anonymous requests get insert-only (for the report form), with `origin` hardcoded server-side to `'report_form'` and `proposed_by` left null — never trust these from client input.

## Approve / Reject Flow

Clicking a queue entry in `/admin` opens a detail/edit view — approval is never a blind one-click write-through:

- **For `new`/`update` entries:** an editable form pre-filled from `proposed_data` (falling back to the existing `listings` row's current values for `update`), covering the listing's editable fields. The moderator can correct anything before approving.
- **For `cancellation` entries and report-form corrections** (no structured `proposed_data`): the form shows the current listing's editable fields pre-filled from `listings` itself, plus the reporter's `correction_note` for context, so the moderator turns the free-text report into actual field edits.
- **Approve:** submitting the (possibly-edited) form writes those final values to `listings` — inserting a `recurrence_rules` row for a new recurring listing, or an `occurrence_exceptions` row for a cancellation/modification — and sets `status = 'approved'`. `proposed_data` on the queue row is left untouched, per above.
- **Propose rejection:** a moderator enters a required reason. Status → `rejection_proposed`, `proposed_by` = current user, `proposed_reason` = the reason. Nothing is written to `listings`.
- **Confirm rejection:** any *other* logged-in moderator sees `rejection_proposed` entries with the proposer's reason and can confirm (→ `rejected`, `confirmed_by` = current user) or send the entry back to `pending` if they disagree. The confirm action is disabled in the UI, and blocked at the RLS/update-policy level, when `auth.uid() = proposed_by` on that row — the same account can never confirm its own proposed rejection, which is the entire reason this phase provisions two moderator accounts.
- Rejected entries are never deleted — the table is the permanent audit trail.

## Pages

- **`/admin/login`** — email/password form using Supabase Auth's `signInWithPassword`. Redirects to `/admin` on success.
- **`/admin`** — the queue: lists `pending` and `rejection_proposed` entries with origin, change type, and a preview of the proposed change or correction note. Each entry links to its detail/edit view. No `approved`/`rejected` history view this phase.
- **`/admin/queue/[id]`** — the detail/edit view described above: the editable form, plus Approve / Propose rejection / Confirm rejection / Send back to pending actions, gated per the rules above.
- **`/listings/[id]/report`** — public, no login. A single free-text "what's wrong" field plus a honeypot field for basic spam resistance (per the original spec — no CAPTCHA this phase). Submitting inserts a `moderation_queue` row: `change_type = 'cancellation'` if the note indicates the event isn't happening, otherwise `'update'`; `origin = 'report_form'`; `correction_note` set; `proposed_by` null. This replaces the currently-dead link on the listing detail page.

## Seed Data

`supabase/seed.sql` gains sample `moderation_queue` rows covering each case the admin UI needs to handle: a `new` listing proposal, an `update` to an existing seeded listing, and a `cancellation`, all `origin = 'seed'` and `status = 'pending'`. At least one entry is seeded directly into `rejection_proposed` (with a `proposed_by` set to one of the two provisioned moderator accounts) so the confirm/self-block behavior can be exercised immediately without first walking an entry through the full flow by hand.

## Testing

Per the original spec's Testing section, moderation queue state transitions are the governance mechanism this design exists to enforce, so they're the automated-test priority:

- A moderator cannot confirm their own proposed rejection (enforced at the RLS/policy level, not just hidden in the UI).
- A different moderator confirming moves the entry to `rejected`; disagreeing returns it to `pending`.
- Approving a `new` entry correctly inserts into `listings` (+ `recurrence_rules` when applicable).
- Approving an `update` entry correctly updates the existing `listings` row.
- Approving a `cancellation`/report-form correction correctly inserts an `occurrence_exceptions` row.
- Moderator-edited values (not the original `proposed_data`) are what gets written on approve.

The admin UI itself (login, queue list, edit form rendering) is reasonable to verify manually at this scale, consistent with how the foundation phase treated its own pages.

## Known Limitations / Edge Cases

- With only two moderator accounts (both owned by the site owner), the "different moderator" rule is real but not yet meaningfully adversarial — it proves the mechanism works, not that it's been tested under real multi-person use.
- Report-form corrections carry no structured diff, so a moderator must interpret free text — this is acceptable at this phase's volume but won't scale; structured correction fields could be considered later if report volume grows.
- No moderator can see past decisions in the admin UI this phase — auditing requires querying `moderation_queue` directly.

## Open Items for the Implementation Plan

- Exact RLS policies for `moderation_queue` (authenticated full read/update; anonymous insert-only with server-enforced `origin`/`proposed_by`).
- Whether the two provisioned moderator accounts are created via a migration/seed step or manually through the Supabase dashboard/CLI as a documented setup step.
- Exact editable-field set per `change_type` in the `/admin/queue/[id]` form.
