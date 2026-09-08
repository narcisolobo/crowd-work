# Modified Occurrence Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a moderator record that a single occurrence of a recurring listing is different (new date, new time, and/or new venue) from its recurring pattern — via a new `'modification'` moderation queue flow mirroring the existing `'cancellation'` flow — and fix cancellation reports to finally carry a date at submission time instead of leaving it for the moderator to track down.

**Architecture:** One enum value (`moderation_change_type` gains `'modification'`) plus one RLS policy replacement on `moderation_queue`'s anonymous report-form policy (allowing the new type and requiring `proposed_data->>'originalDate'` for both occurrence-specific types). `src/lib/data/moderation.ts` gains `approveModification()`, mirroring `approveCancellation()`, writing an `occurrence_exceptions` row with `type: 'modified'`. The public report form (`report.astro`) gains a third reason option and a conditional date field. A new `ModificationApprovalForm.astro` component, mirroring `CancellationApprovalForm.astro`, is wired into the admin queue review page.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase), Tailwind (existing `DESIGN.md` tokens/components only — no new ones).

**Spec:** [docs/superpowers/specs/2026-09-07-modified-occurrence-moderation-design.md](../specs/2026-09-07-modified-occurrence-moderation-design.md)

## Global Constraints

- A pending `'modification'` entry's `proposed_data` reuses the existing `ProposedCancellation` shape (`{ originalDate }`) — there is no separate proposal-stage type. Only `approved_data` (written at approval time) uses the new `ProposedModification` shape with the structured override fields.
- The report form's date field is validated server-side only — no native HTML `required` attribute on a conditionally-hidden field, matching how the existing "other reason" field is already handled in this codebase.
- No moderator direct-create shortcut for modifications. The queue is the only path in, exactly mirroring cancellation (which also has no direct-create shortcut).
- No changes to `/check-sources`, no notifications work, no structured modification fields on the public report form beyond the one date field — the reporter supplies date + free-text note only, per the spec's Non-goals.
- Every RLS-sensitive change gets a real test against the local Supabase stack via `moderation-test-helpers.ts` (`createAnonClient`/`createAdminClient`/`signInTestModerator`) — never assume a policy works without a red/green cycle proving it.

---

## File Structure

```
crowd-work/
├── supabase/
│   └── migrations/
│       ├── <timestamp>_modification_change_type.sql          # new
│       └── <timestamp>_report_form_modification_policy.sql   # new
├── src/
│   ├── lib/
│   │   ├── data/
│   │   │   ├── moderation.ts                    # modified: ProposedModification type, approveModification, handleQueueReviewAction branch
│   │   │   ├── moderation-approve.test.ts       # modified: approveModification tests
│   │   │   └── moderation-report-rls.test.ts    # new
│   │   └── utils/
│   │       └── moderation-labels.ts             # modified: CHANGE_TYPE_LABEL, previewFor fallback
│   ├── components/
│   │   └── moderation/
│   │       └── ModificationApprovalForm.astro   # new
│   └── pages/
│       ├── admin/
│       │   └── queue/
│       │       └── [id].astro                   # modified: wire in ModificationApprovalForm
│       └── listings/
│           └── [id]/
│               └── report.astro                 # modified: third reason option + conditional date field
```

---

### Task 1: Migration — `'modification'` enum value

**Files:**

- Create: `supabase/migrations/<timestamp>_modification_change_type.sql`

**Interfaces:**

- Consumes: the existing `moderation_change_type` enum (currently `'new' | 'update' | 'cancellation' | 'archive' | 'restore'`)
- Produces: `moderation_change_type` gains `'modification'` — consumed by Task 2's RLS policy and Task 3's `QueueChangeType`/`approveModification`

This is a schema-only change with no application-level behavior to test yet — verified by the migration applying cleanly, not a failing test.

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new modification_change_type
```

- [x] **Step 2: Write the migration**

Open the generated file and write:

```sql
-- occurrence_exceptions already supports a 'modified' row (new_date,
-- new_start_time, new_venue_id, note overriding a single occurrence
-- without touching the recurring rule) and recurrence.ts already resolves
-- it, but nothing in moderation_queue could ever produce one — only
-- 'cancelled' exceptions have an authoring path (approveCancellation).
-- This adds the matching change_type for the missing flow.
--
-- The RLS policy that lets the public report form actually insert a
-- 'modification'-shaped moderation_queue row lives in a separate, later
-- migration (report_form_modification_policy) — Postgres forbids using a
-- new enum value within the same transaction that added it via
-- ALTER TYPE ... ADD VALUE (SQLSTATE 55P04, "unsafe use of new value of
-- enum type"), the same reason 'archive'/'restore' were split across two
-- migrations each (20260907025858/20260907030344, 20260907080000/
-- 20260907080100).
alter type moderation_change_type add value 'modification';
```

- [ ] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `modification_change_type` apply with no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "$(cat <<'EOF'
feat: add 'modification' moderation_change_type enum value

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration — report-form RLS requires an occurrence date

**Files:**

- Create: `supabase/migrations/<timestamp>_report_form_modification_policy.sql`
- Create: `src/lib/data/moderation-report-rls.test.ts`

**Interfaces:**

- Consumes: Task 1's `'modification'` enum value; the existing `"anyone can submit a correction report or a new listing"` policy on `moderation_queue` (renamed from `"anyone can submit a correction report"` and given a `'new'`-listing `or` branch by 20260904182818_listing_submission_policies.sql)
- Produces: a report-form RLS policy that allows `'modification'` and requires `proposed_data->>'originalDate'` for both `'cancellation'` and `'modification'` — consumed by Task 4's updated `report.astro`

- [x] **Step 1: Write the failing tests**

Create `src/lib/data/moderation-report-rls.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createAdminClient, createAnonClient } from "./moderation-test-helpers";

const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

describe("report_form RLS", () => {
  it("accepts a 'modification' report with a date", async () => {
    const anon = createAnonClient();
    const correctionNote = "Moved to the back room this week";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "modification",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });

  it("rejects a 'modification' report with no date", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "modification",
      proposed_data: { originalDate: null },
      correction_note: "Moved to the back room this week",
      origin: "report_form",
      status: "pending",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'cancellation' report with no date", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "cancellation",
      proposed_data: { originalDate: null },
      correction_note: "Not happening anymore",
      origin: "report_form",
      status: "pending",
    });
    expect(error).not.toBeNull();
  });

  it("still accepts a 'cancellation' report with a date", async () => {
    const anon = createAnonClient();
    const correctionNote = "Not happening anymore";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "cancellation",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });

  it("still accepts an 'update' report with no proposed_data", async () => {
    const anon = createAnonClient();
    const correctionNote = "Wrong sign-up method listed";
    const { error } = await anon.from("moderation_queue").insert({
      listing_id: EXISTING_LISTING_ID,
      change_type: "update",
      proposed_data: null,
      correction_note: correctionNote,
      origin: "report_form",
      status: "pending",
    });
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data } = await admin
      .from("moderation_queue")
      .select("id")
      .eq("correction_note", correctionNote)
      .single();
    if (data) insertedEntryIds.push(data.id);
  });
});
```

**Note on the three "accepts"/"still accepts" tests:** they insert via the `anon` client without chaining `.select()`. Chaining `.select("id").single()` turns the insert into `INSERT ... RETURNING id`, and Postgres evaluates RETURNING against RLS's SELECT policies too — but `moderation_queue` has no SELECT policy for `anon` (only `"moderators can read the queue"`, scoped to `authenticated`). That produces the same "new row violates row-level security policy" error as a failed `WITH CHECK`, even when the insert itself is allowed. The fix is to insert without `.select()`, then look up the new row's id via `createAdminClient()` — the same pattern already used in `moderation-submission.test.ts`, not a change to the RLS policy (granting `anon` SELECT here would let anyone browse other people's reports).

- [x] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-report-rls
```

Expected: FAIL on both "accepts a 'modification' report with a date" (the current policy's `change_type in ('update', 'cancellation')` check doesn't list `'modification'` yet) and "rejects a 'cancellation' report with no date" (the current policy has no date requirement at all, so this currently succeeds when the test expects an error). The other three should already pass.

- [x] **Step 3: Generate the migration file**

```bash
supabase migration new report_form_modification_policy
```

- [x] **Step 4: Write the migration**

Open the generated file and write:

```sql
-- The public report form needs two changes to its existing anonymous
-- INSERT policy. That policy started as "anyone can submit a correction
-- report" (20260903183709_moderation_queue.sql) and was already renamed to
-- "anyone can submit a correction report or a new listing"
-- (20260904182818_listing_submission_policies.sql) when it gained an `or`
-- branch for brand-new listing submissions (change_type = 'new'). This
-- migration targets that current name and preserves the 'new' branch
-- untouched, while changing only the correction-report branch:
--
-- 1. Allow the new 'modification' change_type (report.astro's new
--    "something's different this time" option), alongside the existing
--    'update'/'cancellation'.
-- 2. Require proposed_data->>'originalDate' whenever change_type is
--    'cancellation' or 'modification' — closing a pre-existing gap where
--    a cancellation report could be filed with no date at all (report.astro
--    used to always insert { originalDate: null }, leaving the moderator to
--    track down the actual date during approval). Both occurrence-specific
--    report types need a date to review against; from here on the database
--    itself requires one, not just report.astro's application logic.
--
-- Split into its own migration (rather than living alongside the
-- 'modification' enum value it references) because Postgres forbids using
-- a new enum value within the same transaction that added it — see
-- 20260907025858_archive_listing_rls.sql for the same pattern.
drop policy "anyone can submit a correction report or a new listing" on moderation_queue;

create policy "anyone can submit a correction report or a new listing"
  on moderation_queue for insert
  to anon
  with check (
    (
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
    )
    or (
      change_type = 'new'
      and origin = 'submission_form'
      and listing_id is null
      and proposed_data is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
    )
  );
```

- [x] **Step 5: Apply the migration locally**

```bash
supabase db reset
```

Expected: all migrations apply with no errors.

- [x] **Step 6: Run the tests to verify they pass**

```bash
pnpm test moderation-report-rls
```

Expected: PASS — all 5 tests.

- [x] **Step 7: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 8: Commit**

```bash
git add supabase/migrations src/lib/data/moderation-report-rls.test.ts
git commit -m "$(cat <<'EOF'
feat: require an occurrence date on cancellation/modification reports

Extends the public report-form RLS policy to allow the new
'modification' change_type and, for both it and 'cancellation', require
proposed_data->>'originalDate' to be present. Closes a pre-existing gap
where a cancellation report could be filed with no date at all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `approveModification()` and the queue-review action

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-approve.test.ts`
- Modify: `src/lib/utils/moderation-labels.ts`
- Modify: `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: Task 1's `'modification'` enum value; the existing `markApproved()`, `findMissingReason()`, `parseApprovalNote()` in `moderation.ts`
- Produces:
  - `export interface ProposedModification { originalDate: string; newDate?: string | null; newStartTime?: string | null; newVenueId?: string | null; note?: string | null; }`
  - `export async function approveModification(client: SupabaseClient<Database>, entryId: string, listingId: string, originalDate: string, newDate: string | null, newStartTime: string | null, newVenueId: string | null, note: string | null, approvalNote?: string | null): Promise<void>`
  - `handleQueueReviewAction` now handles `action === "approve_modification"`
  - `QueueChangeType` becomes `"new" | "update" | "cancellation" | "modification" | "archive" | "restore"` — consumed by Task 5's `ModificationApprovalForm` and Task 6's page wiring

- [x] **Step 1: Write the failing test**

In `src/lib/data/moderation-approve.test.ts`, add `approveModification` to the existing import from `./moderation`:

```ts
import {
  approveNewListing,
  approveListingUpdate,
  approveCancellation,
  approveModification,
  type ProposedListingFields,
} from "./moderation";
```

Then append a new `describe` block after the existing `describe("approveCancellation", ...)` block:

```ts
describe("approveModification", () => {
  it("records a modified occurrence exception", async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Modification Test",
        venue_id: EXISTING_VENUE_ID,
        start_time: "19:00",
        one_off_date: "2026-09-15",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(listing.id);

    const entryId = await createPendingEntry({
      change_type: "modification",
      listing_id: listing.id,
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "Moved to the back room this week",
    });

    const moderator1 = await signInTestModerator(1);
    await approveModification(
      moderator1,
      entryId,
      listing.id,
      "2026-09-15",
      null,
      "20:30",
      null,
      "Moved to the back room this week",
      "Accurate as submitted",
    );

    const { data: exception } = await admin
      .from("occurrence_exceptions")
      .select(
        "type, original_date, new_date, new_start_time, new_venue_id, note",
      )
      .eq("listing_id", listing.id)
      .eq("original_date", "2026-09-15")
      .single();
    expect(exception!.type).toBe("modified");
    expect(exception!.new_date).toBeNull();
    expect(exception!.new_start_time).toBe("20:30:00");
    expect(exception!.new_venue_id).toBeNull();
    expect(exception!.note).toBe("Moved to the back room this week");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("approved_data, approval_note")
      .eq("id", entryId)
      .single();
    expect(entry!.approval_note).toBe("Accurate as submitted");
    expect(entry!.approved_data).toEqual({
      originalDate: "2026-09-15",
      newDate: null,
      newStartTime: "20:30",
      newVenueId: null,
      note: "Moved to the back room this week",
    });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm test moderation-approve
```

Expected: FAIL — `approveModification` is not exported yet (and `change_type: "modification"` isn't a valid enum value in the generated TypeScript types yet either, which Step 3 also fixes).

- [x] **Step 3: Regenerate database types, add the new type and function**

The `moderation_change_type` enum change from Task 1 needs to be reflected in `src/lib/supabase/database.types.ts` before TypeScript will accept `change_type: "modification"` anywhere. Regenerate it:

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: the `moderation_change_type` enum in the generated file now includes `"modification"`.

In `src/lib/data/moderation.ts`, update `QueueChangeType`:

```ts
export type QueueChangeType =
  "new" | "update" | "cancellation" | "modification" | "archive" | "restore";
```

Add `ProposedModification` right after the existing `ProposedCancellation` interface:

```ts
export interface ProposedCancellation {
  originalDate: string;
  note?: string | null;
}

export interface ProposedModification {
  originalDate: string;
  newDate?: string | null;
  newStartTime?: string | null;
  newVenueId?: string | null;
  note?: string | null;
}
```

Update `QueueEntry`'s `proposedData`/`approvedData` fields to include the new type:

```ts
export interface QueueEntry {
  id: string;
  listingId: string | null;
  changeType: QueueChangeType;
  proposedData:
    | ProposedListingFields
    | ProposedCancellation
    | ProposedModification
    | null;
  correctionNote: string | null;
  origin: string;
  status: QueueStatus;
  proposedBy: string | null;
  proposedReason: string | null;
  confirmedBy: string | null;
  approvedBy: string | null;
  approvedData:
    | ProposedListingFields
    | ProposedCancellation
    | ProposedModification
    | null;
  approvalNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}
```

Update `markApproved`'s signature to accept the new type:

```ts
async function markApproved(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  approvedData:
    | ProposedListingFields
    | ProposedCancellation
    | ProposedModification,
  approvalNote: string | null,
): Promise<void> {
```

Add `approveModification` right after `approveCancellation`:

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

Add the review-action branch. In `handleQueueReviewAction`, right after the existing `if (action === "approve_cancellation") { ... }` block and before `if (action === "propose_reject") { ... }`, add:

```ts
  if (action === "approve_modification") {
    const originalDate = formData.get("originalDate")?.toString() ?? "";
    const newDate = formData.get("newDate")?.toString() || null;
    const newStartTime = formData.get("newStartTime")?.toString() || null;
    const newVenueId = formData.get("newVenueId")?.toString() || null;
    const note = formData.get("note")?.toString() || null;
    const missingReason = findMissingReason(formData);
    if (missingReason.length > 0) {
      return {
        type: "validation_error",
        message: "Choose a reason for this approval.",
      };
    }
    const approvalNote = parseApprovalNote(formData);
    await approveModification(
      client,
      entry.id,
      entry.listingId!,
      originalDate,
      newDate,
      newStartTime,
      newVenueId,
      note,
      approvalNote,
    );
    return { type: "redirect" };
  }
```

- [x] **Step 4: Update the labels**

In `src/lib/utils/moderation-labels.ts`, add `modification` to `CHANGE_TYPE_LABEL`:

```ts
export const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New",
  update: "Update",
  cancellation: "Cancellation",
  modification: "Modification",
  archive: "Archive",
  restore: "Restore",
};
```

Update `previewFor`'s final fallback (currently a bare `"Cancellation"`, only reached when `correctionNote` is empty) so it doesn't mislabel a note-less modification entry — replace:

```ts
  return "Cancellation";
}
```

with:

```ts
  return entry.changeType === "modification" ? "Modification" : "Cancellation";
}
```

- [x] **Step 5: Fix the local `CHANGE_TYPE_LABEL` duplicate in the queue review page**

`src/pages/admin/queue/[id].astro` defines its own separate `CHANGE_TYPE_LABEL` constant (not the one imported from `moderation-labels.ts`) — it must also cover `'modification'` or the `Record<QueueChangeType, string>` type will no longer be satisfied. In `src/pages/admin/queue/[id].astro`, replace:

```ts
const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New listing",
  update: "Update",
  cancellation: "Cancellation",
  archive: "Archive",
  restore: "Restore",
};
```

with:

```ts
const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New listing",
  update: "Update",
  cancellation: "Cancellation",
  modification: "Modification",
  archive: "Archive",
  restore: "Restore",
};
```

- [x] **Step 6: Run the type checker**

```bash
pnpm run check
```

Expected: PASS, no type errors (this confirms both `CHANGE_TYPE_LABEL` records and every other place typed against `QueueChangeType` still compile after the union grew).

- [x] **Step 7: Run the tests to verify they pass**

```bash
pnpm test moderation-approve
```

Expected: PASS — including the new `approveModification` test.

- [x] **Step 8: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 9: Commit**

```bash
git add src/lib/supabase/database.types.ts src/lib/data/moderation.ts src/lib/data/moderation-approve.test.ts src/lib/utils/moderation-labels.ts src/pages/admin/queue/\[id\].astro
git commit -m "$(cat <<'EOF'
feat: add approveModification, mirroring approveCancellation

Lets a moderator approve a 'modification' queue entry into a 'modified'
occurrence_exceptions row (new date/time/venue overriding a single
occurrence, without touching the recurring rule). Regenerates
database.types.ts for the 'modification' enum value added in the prior
commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Report form — the "something's different" option and date field

**Files:**

- Modify: `src/pages/listings/[id]/report.astro`

**Interfaces:**

- Consumes: Task 2's tightened report-form RLS policy (this task is what makes `report.astro` satisfy it — before this task, a "not happening" report submitted through the running dev site would be rejected by RLS with no date, same as Task 2's tests describe)
- Produces: no new exports — this is a page-level change verified manually, per this project's existing testing conventions (Astro pages aren't unit-tested)

- [x] **Step 1: Add the `FormField` import**

In `src/pages/listings/[id]/report.astro`, add to the existing imports:

```astro
import FormField from "../../../components/forms/FormField.astro";
```

- [x] **Step 2: Update the frontmatter logic**

Replace the existing block (from `let submitted = false;` through the `reasonOptions` declaration):

```astro
let submitted = false;
let errorMessage: string | null = null;
let selectedReason: string | null = null;

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  const honeypot = formData.get("company")?.toString() ?? "";
  const reason = formData.get("reason")?.toString();
  const note = formData.get("note")?.toString();
  selectedReason = reason ?? null;

  if (honeypot !== "") {
    // Silently succeed for bots without writing anything.
    submitted = true;
  } else if (reason !== "not_happening" && reason !== "something_else") {
    errorMessage = "Please choose a reason.";
  } else if (!note || note.trim().length === 0) {
    errorMessage = "Please describe what's wrong.";
  } else {
    const { error } = await supabase.from("moderation_queue").insert({
      listing_id: listing.id,
      change_type: reason === "not_happening" ? "cancellation" : "update",
      proposed_data: reason === "not_happening" ? { originalDate: null } : null,
      correction_note: note.trim(),
      origin: "report_form",
      status: "pending",
    });

    if (error) {
      errorMessage =
        "Something went wrong submitting your report. Please try again.";
    } else {
      submitted = true;
    }
  }
}

const reasonOptions = [
  { value: "not_happening", label: "This isn't happening anymore" },
  { value: "something_else", label: "Something else is wrong" },
];
```

with:

```astro
// Both 'not_happening' (cancellation) and 'different_this_time'
// (modification) are about one specific occurrence, so both need a date;
// 'something_else' is a non-occurrence-specific correction (wrong
// description, wrong sign-up method) and stays date-less.
const OCCURRENCE_REASONS = new Set(["not_happening", "different_this_time"]);
const VALID_REASONS = new Set([
  "not_happening",
  "different_this_time",
  "something_else",
]);

let submitted = false;
let errorMessage: string | null = null;
let selectedReason: string | null = null;
let selectedOriginalDate: string | null = null;

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  const honeypot = formData.get("company")?.toString() ?? "";
  const reason = formData.get("reason")?.toString();
  const note = formData.get("note")?.toString();
  const originalDate = formData.get("originalDate")?.toString();
  selectedReason = reason ?? null;
  selectedOriginalDate = originalDate ?? null;

  const needsDate = reason !== undefined && OCCURRENCE_REASONS.has(reason);

  if (honeypot !== "") {
    // Silently succeed for bots without writing anything.
    submitted = true;
  } else if (!reason || !VALID_REASONS.has(reason)) {
    errorMessage = "Please choose a reason.";
  } else if (needsDate && (!originalDate || originalDate.trim().length === 0)) {
    errorMessage = "Please choose which date this is about.";
  } else if (!note || note.trim().length === 0) {
    errorMessage = "Please describe what's wrong.";
  } else {
    const changeType =
      reason === "not_happening"
        ? "cancellation"
        : reason === "different_this_time"
          ? "modification"
          : "update";

    const { error } = await supabase.from("moderation_queue").insert({
      listing_id: listing.id,
      change_type: changeType,
      proposed_data: needsDate ? { originalDate } : null,
      correction_note: note.trim(),
      origin: "report_form",
      status: "pending",
    });

    if (error) {
      errorMessage =
        "Something went wrong submitting your report. Please try again.";
    } else {
      submitted = true;
    }
  }
}

const reasonOptions = [
  { value: "not_happening", label: "This isn't happening anymore" },
  {
    value: "different_this_time",
    label: "It's happening, but something's different this time",
  },
  { value: "something_else", label: "Something else is wrong" },
];
const showDateField =
  selectedReason !== null && OCCURRENCE_REASONS.has(selectedReason);
```

- [x] **Step 3: Add the conditional date field to the markup**

In the form markup, replace:

```astro
              <FormTextarea label="Details" name="note" required rows={4} />
```

with:

```astro
              <div data-occurrence-date hidden={!showDateField}>
                <FormField
                  label="Which date is this about?"
                  name="originalDate"
                  type="date"
                  value={selectedOriginalDate}
                />
              </div>

              <FormTextarea label="Details" name="note" required rows={4} />
```

- [x] **Step 4: Add the client-side toggle script**

Right before the closing `</body>` tag, add:

```astro
    <script>
      const radios = document.querySelectorAll<HTMLInputElement>(
        'input[name="reason"]',
      );
      const dateContainer = document.querySelector<HTMLElement>(
        "[data-occurrence-date]",
      );
      if (dateContainer && radios.length > 0) {
        const sync = () => {
          const checked = document.querySelector<HTMLInputElement>(
            'input[name="reason"]:checked',
          );
          dateContainer.hidden =
            checked?.value !== "not_happening" &&
            checked?.value !== "different_this_time";
        };
        for (const radio of radios) {
          radio.addEventListener("change", sync);
        }
        sync();
      }
    </script>
```

- [x] **Step 5: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions (no existing test targets `report.astro`'s markup or reason logic directly).

- [x] **Step 6: Verify manually**

```bash
astro dev --background
```

Navigate to `/listings/<any-published-id>/report` and confirm:

1. Selecting "This isn't happening anymore" or "It's happening, but something's different this time" reveals the date field; selecting "Something else is wrong" hides it.
2. Submitting "not happening" with no date shows "Please choose which date this is about." and preserves the selected reason.
3. Submitting "not happening" with a date and a note succeeds, and (checking `/admin` as a moderator) the resulting queue entry is `change_type: cancellation` with `proposed_data.originalDate` populated.
4. Submitting "something's different this time" with a date and note succeeds and produces a `change_type: modification` entry, labeled "Modification" in the admin queue list.
5. Submitting "something else is wrong" still works with no date required, producing a `change_type: update` entry as before.

Leave the dev server running for Task 6.

- [x] **Step 7: Commit**

```bash
git add src/pages/listings/\[id\]/report.astro
git commit -m "$(cat <<'EOF'
feat: add a modification report option and occurrence-date field

The public report form now asks which date a cancellation or
modification report is about, instead of leaving cancellation reports
date-less until a moderator investigates during approval.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `ModificationApprovalForm.astro` component

**Files:**

- Create: `src/components/moderation/ModificationApprovalForm.astro`

**Interfaces:**

- Consumes: `ProposedCancellation`, `QueueEntry` types (`../../lib/data/moderation`); `APPROVAL_REASON_HINT`, `APPROVAL_REASON_OPTIONS` (`../../lib/utils/moderation-labels`); `Button`, `FormField`, `FormSelect`, `FormTextarea` components
- Produces: the `ModificationApprovalForm` component, with props `{ entry: QueueEntry; proposedModification: ProposedCancellation | null; venueOptions: { value: string; label: string }[]; reason?: string; otherReason?: string }` — consumed by Task 6's page wiring

This is a presentational component with no standalone data logic, verified manually together with Task 6 (it can't be rendered in isolation without the queue page around it).

- [x] **Step 1: Write the component**

Create `src/components/moderation/ModificationApprovalForm.astro`:

```astro
---
import Button from "../forms/Button.astro";
import FormField from "../forms/FormField.astro";
import FormSelect from "../forms/FormSelect.astro";
import FormTextarea from "../forms/FormTextarea.astro";
import type {
  ProposedCancellation,
  QueueEntry,
} from "../../lib/data/moderation";
import {
  APPROVAL_REASON_HINT,
  APPROVAL_REASON_OPTIONS,
} from "../../lib/utils/moderation-labels";

interface VenueOption {
  value: string;
  label: string;
}

interface Props {
  entry: QueueEntry;
  proposedModification: ProposedCancellation | null;
  venueOptions: VenueOption[];
  reason?: string;
  otherReason?: string;
}

const {
  entry,
  proposedModification,
  venueOptions,
  reason = "",
  otherReason = "",
} = Astro.props;

const newVenueOptions = [{ value: "", label: "No change" }, ...venueOptions];
---

<form
  method="post"
  data-modification-form
  class="mt-8 flex max-w-form-compact flex-col gap-4"
>
  <input type="hidden" name="action" value="approve_modification" />
  <FormField
    label="Date being modified"
    name="originalDate"
    type="date"
    value={proposedModification?.originalDate}
    required
  />
  <div class="border-rule flex flex-col gap-4 border-t pt-6">
    <p class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase">
      What's different
    </p>
    <FormField label="New date (if changed)" name="newDate" type="date" />
    <FormField
      label="New start time (if changed)"
      name="newStartTime"
      type="time"
    />
    <FormSelect
      label="New venue (if changed)"
      name="newVenueId"
      options={newVenueOptions}
    />
  </div>
  <FormTextarea label="Note" name="note" value={entry.correctionNote ?? ""} />
  <div class="border-rule flex flex-col gap-4 border-t pt-6">
    <p class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase">
      Approval
    </p>
    <FormSelect
      label="Reason"
      name="reason"
      options={APPROVAL_REASON_OPTIONS}
      value={reason}
      required
      hint={APPROVAL_REASON_HINT}
    />
    <div data-other-reason hidden={reason !== "other"}>
      <FormTextarea label="Other reason" name="otherReason" value={otherReason} />
    </div>
  </div>
  <Button
    type="submit"
    variant="primary"
    disabled={entry.status !== "pending"}
    class="mt-2 self-start"
  >
    Approve modification
  </Button>
</form>

<script>
  // At least one of new date/time/venue must actually be set, or approving
  // would create an occurrence_exceptions row indistinguishable in effect
  // from no exception at all.
  const forms = document.querySelectorAll<HTMLFormElement>(
    "form[data-modification-form]",
  );
  for (const form of forms) {
    const submitButton = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!submitButton || submitButton.disabled) continue;
    const watched = form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >('[name="newDate"], [name="newStartTime"], [name="newVenueId"]');
    const sync = () => {
      const hasChange = Array.from(watched).some((el) => el.value !== "");
      submitButton.disabled = !hasChange;
    };
    for (const el of watched) {
      el.addEventListener("input", sync);
      el.addEventListener("change", sync);
    }
    sync();
  }
</script>
```

- [x] **Step 2: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 3: Commit**

```bash
git add src/components/moderation/ModificationApprovalForm.astro
git commit -m "$(cat <<'EOF'
feat: add ModificationApprovalForm component

Mirrors CancellationApprovalForm: prefilled/required original date,
optional new date/time/venue fields, and the existing approval-reason
section. The submit button stays disabled until at least one of the
new date/time/venue fields is set.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire `ModificationApprovalForm` into the queue review page

**Files:**

- Modify: `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: Task 5's `ModificationApprovalForm`; the existing `venues`/`venueOptions` already computed on this page
- Produces: none — terminal UI wiring

- [x] **Step 1: Import the new component**

Add to the existing imports:

```astro
import ModificationApprovalForm from "../../../components/moderation/ModificationApprovalForm.astro";
```

- [x] **Step 2: Preserve reason/otherReason for the new action**

Replace:

```ts
  if (action === "approve" || action === "approve_cancellation") {
    submittedReason = formData.get("reason")?.toString() ?? "";
    submittedOtherReason = formData.get("otherReason")?.toString() ?? "";
  }
```

with:

```ts
  if (
    action === "approve" ||
    action === "approve_cancellation" ||
    action === "approve_modification"
  ) {
    submittedReason = formData.get("reason")?.toString() ?? "";
    submittedOtherReason = formData.get("otherReason")?.toString() ?? "";
  }
```

- [x] **Step 3: Compute the proposed-modification prefill**

Right after the existing `proposedCancellation` computation, add:

```ts
const proposedModification =
  entry.changeType === "modification"
    ? (entry.proposedData as ProposedCancellation)
    : null;
```

- [x] **Step 4: Render the new form for `'modification'` entries**

Replace:

```astro
  {
    entry.changeType === "cancellation" ? (
      <CancellationApprovalForm
        entry={entry}
        proposedCancellation={proposedCancellation}
        reason={submittedReason}
        otherReason={submittedOtherReason}
      />
    ) : (
      <ListingApprovalForm
        entry={entry}
        prefill={prefill}
        venueOptions={venueOptions}
        neighborhoodOptions={neighborhoodOptions}
        reason={submittedReason}
        otherReason={submittedOtherReason}
      />
    )
  }
```

with:

```astro
  {
    entry.changeType === "cancellation" ? (
      <CancellationApprovalForm
        entry={entry}
        proposedCancellation={proposedCancellation}
        reason={submittedReason}
        otherReason={submittedOtherReason}
      />
    ) : entry.changeType === "modification" ? (
      <ModificationApprovalForm
        entry={entry}
        proposedModification={proposedModification}
        venueOptions={venueOptions}
        reason={submittedReason}
        otherReason={submittedOtherReason}
      />
    ) : (
      <ListingApprovalForm
        entry={entry}
        prefill={prefill}
        venueOptions={venueOptions}
        neighborhoodOptions={neighborhoodOptions}
        reason={submittedReason}
        otherReason={submittedOtherReason}
      />
    )
  }
```

- [x] **Step 5: Run the type checker and full test suite**

```bash
pnpm run check
pnpm test
```

Expected: both PASS, no regressions.

- [x] **Step 6: Verify manually**

With the dev server still running from Task 4:

1. Submit a "something's different this time" report from `/listings/<id>/report` with a date and a note.
2. Open `/admin`, confirm the new entry is labeled "Modification" with origin "Public report", and open it.
3. Confirm `ModificationApprovalForm` renders with "Date being modified" prefilled from the report, and the "Approve modification" button is disabled until you set at least one of new date/time/venue.
4. Set a new start time, choose an approval reason, and submit — confirm the redirect back to `/admin`.
5. Open `/admin/archive`, confirm a "Modification" entry appears with the correct origin ("Public report") and reason.
6. As a second check, directly query (or ask a moderator to check) that the listing's `occurrence_exceptions` now has a `type: 'modified'` row for that date with the new start time set.

- [x] **Step 7: Commit**

```bash
git add src/pages/admin/queue/\[id\].astro
git commit -m "$(cat <<'EOF'
feat: render ModificationApprovalForm for 'modification' queue entries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: End-to-end verification

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Full moderator flow, cancellation path**

With the dev server still running:

1. From `/listings/<id>/report`, submit "This isn't happening anymore" with a date and a note — confirm it now requires the date (matching Task 2's tightened policy) and succeeds once provided.
2. Approve it from `/admin` as before — confirm the existing cancellation flow (`CancellationApprovalForm`) is completely unaffected by this plan's changes.

- [ ] **Step 2: Full moderator flow, modification path**

Repeat Task 6 Step 6's manual flow once more end to end, this time also confirming:

1. The listing's public detail page (`/listings/<id>`) or directory listing reflects the modified occurrence correctly for that specific date once the exception is approved (per `recurrence.ts`'s existing resolution logic — unchanged by this plan, but this is the first time it's ever fed a `'modified'` row that didn't come from seed data).
2. A different, non-modified future occurrence of the same recurring listing is unaffected.

- [ ] **Step 3: Accessibility check at high zoom**

Per this project's validated accessibility need, set the browser to 400% zoom and reload both `/listings/<id>/report` and an open `'modification'` entry at `/admin/queue/<id>`. Confirm both reflow to a single readable column with no horizontal scrolling.

- [ ] **Step 4: Full regression suite**

```bash
pnpm test
pnpm run check
```

Expected: both PASS — full suite, no regressions from any task in this plan.

```bash
astro dev logs
```

Expected: no errors across the whole session.

- [ ] **Step 5: Stop the dev server**

```bash
astro dev stop
```
