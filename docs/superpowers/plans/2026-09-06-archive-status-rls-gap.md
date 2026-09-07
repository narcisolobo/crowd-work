# Archive Status RLS Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the RLS gap that makes `listings.status = 'archived'` unreachable, and build the minimal moderator-facing archive feature on top of it, routed through `moderation_queue` so every archive event — moderator-initiated or the automatic recovery fallback in `createListingFromFields()` — shows up in the existing Moderation Archive with a real actor and reason.

**Architecture:** One migration adds a new `SELECT` policy on `listings` (scoped to real moderators, not every `authenticated` principal) and a new `archive` value on `moderation_change_type`. A new `archiveListing()` function in `src/lib/data/moderation.ts` is the single write-through path that flips a listing to `archived` and inserts an already-`approved` `moderation_queue` row recording who/why — used both by a new `/admin/listings` page (manual archive, native `<details>/<summary>` disclosure per row) and by the existing recovery fallback (refactored to use it instead of a raw, unaudited `.update()`). `/admin/archive` gains a small title lookup so archive entries render "Archived: \<title\>" instead of the JSON-blob preview every other change type uses.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase), Tailwind (existing `DESIGN.md` tokens/components only — no new ones).

**Spec:** [docs/superpowers/specs/2026-09-06-archive-status-rls-gap-design.md](../specs/2026-09-06-archive-status-rls-gap-design.md)

## Global Constraints

- The new `SELECT` policy is scoped to `auth.uid() in (select id from moderators)` — never a blanket `to authenticated using (true)` — because `source_check_agents` accounts are also `authenticated` and have no legitimate need to read archived listings.
- Every `archive` queue entry is inserted directly as `status: "approved"` — never `"pending"`. Archiving is single-moderator and immediate, like `directAddListing`; no propose/confirm ceremony.
- `proposed_data` and `approved_data` are always `null` on an `archive` entry — nothing about the listing's fields changes, only `status`.
- No unarchive/republish, no bulk archive, no second-moderator confirmation for archiving, and no general admin listings-management UI beyond what's needed to pick a listing to archive — all explicit non-goals in the spec.
- No new UI color or `Button` variant: the archive action uses the existing `outline`/`primary` variants. Cancellation Red is reserved for public-facing cancellation/urgency signals (The Red Line Rule in `DESIGN.md`) and does not apply here.
- The archive UI is a native `<details>/<summary>` disclosure per row (mirrors the Account Menu in `AdminHeader.astro`) — not a modal, not a dedicated page. This system has no modal anywhere, and a row-level disclosure reflows correctly for the moderator who works at 400%+ browser zoom (`PRODUCT.md`, Accessibility & Inclusion).

---

## File Structure

```
crowd-work/
├── supabase/
│   └── migrations/
│       └── <timestamp>_archive_listing_rls.sql   # new
├── src/
│   ├── lib/
│   │   ├── supabase/
│   │   │   └── database.types.ts                 # regenerated
│   │   ├── data/
│   │   │   ├── moderation.ts                     # modified: archiveListing, exported findMissingReason/parseApprovalNote, refactored recovery fallback, QueueChangeType
│   │   │   ├── moderation-archive-listing.test.ts   # new
│   │   │   ├── moderation-source-check.test.ts   # modified: one added lockdown assertion
│   │   │   ├── listings.ts                       # modified: getListingTitles
│   │   │   └── listings.test.ts                  # modified: getListingTitles tests
│   │   └── utils/
│   │       └── moderation-labels.ts              # modified: CHANGE_TYPE_LABEL/ORIGIN_LABEL entries, previewFor archive branch
│   ├── components/
│   │   └── layout/
│   │       └── AdminHeader.astro                 # modified: nav link to /admin/listings
│   └── pages/
│       └── admin/
│           ├── listings/
│           │   └── index.astro                   # new
│           └── archive/
│               └── index.astro                   # modified: wires in getListingTitles
```

---

### Task 1: Migration — RLS fix and the `archive` change type

**Files:**

- Create: `supabase/migrations/<timestamp>_archive_listing_rls.sql`

**Interfaces:**

- Consumes: `listings`, `moderators` tables as they exist today
- Produces: a `SELECT` policy allowing moderators to read archived listings; `'archive'` as a valid `moderation_change_type` value — consumed by every later task

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new archive_listing_rls
```

- [ ] **Step 2: Write the migration**

Open the generated file and write:

```sql
-- Closes the RLS gap documented in notes/archive-status-rls-gap.md: the only
-- SELECT policy on `listings` required status = 'published', and Postgres
-- checks an UPDATE's resulting row against the table's SELECT policy (not
-- just the UPDATE policy's own WITH CHECK), so no row could ever transition
-- to 'archived' even though the UPDATE policy itself is fully permissive.
--
-- Scoped to real moderators, not every `authenticated` principal —
-- `source_check_agents` (20260906052058_source_check_agent.sql) are also
-- `authenticated` and have no legitimate need to read archived listings, so
-- this deliberately doesn't use a blanket `using (true)`.
create policy "moderators can view archived listings"
  on listings for select
  to authenticated
  using (auth.uid() in (select id from moderators));

-- Lets a moderator archive a listing (or the recovery fallback in
-- createListingFromFields do so automatically) as its own accountable
-- change_type, routed through moderation_queue like every other change —
-- see the design doc for why this isn't a reuse of 'cancellation'.
alter type moderation_change_type add value 'archive';
```

- [ ] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `archive_listing_rls` apply with no errors.

- [ ] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `moderation_change_type` in `database.types.ts` now includes `"archive"` — verify with:

```bash
grep -n "moderation_change_type" src/lib/supabase/database.types.ts
```

Both occurrences (the `Enums` type and the `Constants` array) should list `"new" | "update" | "cancellation" | "archive"` / `["new", "update", "cancellation", "archive"]`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: let moderators archive listings, closing the status RLS gap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `archiveListing()` write-through function

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/utils/moderation-labels.ts`
- Create: `src/lib/data/moderation-archive-listing.test.ts`

**Interfaces:**

- Consumes: the RLS policy and `archive` enum value from Task 1; `createAdminClient`/`signInTestModerator`/`signInSourceCheckAgent` from `moderation-test-helpers.ts`
- Produces: `export async function archiveListing(client, listingId: string, reason: string, origin?: "moderator_archive" | "system_recovery"): Promise<void>` — consumed by Task 3's recovery-fallback refactor and Task 4's new admin page

This test file is distinct from the existing `moderation-archive.test.ts`, which tests `getArchiveEntries()` (the Moderation Archive page's decided-entries list) — an unrelated concept that happens to share the word "archive." This file tests `listings.status = 'archived'` and the function that sets it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/data/moderation-archive-listing.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { archiveListing } from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";

let insertedListingIds: string[] = [];
let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  if (insertedListingIds.length > 0) {
    await admin.from("listings").delete().in("id", insertedListingIds);
  }
  insertedListingIds = [];
  insertedEntryIds = [];
});

async function createTempListing(title: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("listings")
    .insert({
      type: "mic",
      title,
      venue_id: EXISTING_VENUE_ID,
      start_time: "19:00",
      one_off_date: "2026-09-15",
      status: "published",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedListingIds.push(data.id);
  return data.id as string;
}

describe("listings RLS: archived listings are visible to moderators", () => {
  it("lets a moderator archive a listing and read it back afterward", async () => {
    const listingId = await createTempListing("Temp Listing For Archive RLS Test");
    const moderator1 = await signInTestModerator(1);

    // The exact repro from notes/archive-status-rls-gap.md: before Task 1's
    // migration, this update was rejected with 42501 because Postgres
    // checks the resulting row against the table's SELECT policy, and the
    // only one that existed required status = 'published'.
    const { error: updateError } = await moderator1
      .from("listings")
      .update({ status: "archived" })
      .eq("id", listingId);
    expect(updateError).toBeNull();

    const { data: archived, error: selectError } = await moderator1
      .from("listings")
      .select("id, status")
      .eq("id", listingId)
      .single();
    expect(selectError).toBeNull();
    expect(archived?.status).toBe("archived");
  });
});

describe("archiveListing", () => {
  it("archives a listing and records an approved 'archive' queue entry", async () => {
    const listingId = await createTempListing("Temp Listing For archiveListing Test");
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    await archiveListing(moderator1, listingId, "Venue permanently closed");

    const admin = createAdminClient();
    const { data: updatedListing } = await admin
      .from("listings")
      .select("status")
      .eq("id", listingId)
      .single();
    expect(updatedListing?.status).toBe("archived");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, approved_data, approval_note, decided_at",
      )
      .eq("listing_id", listingId)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("archive");
    expect(entry!.origin).toBe("moderator_archive");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approved_data).toBeNull();
    expect(entry!.approval_note).toBe("Venue permanently closed");
    expect(entry!.decided_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-archive-listing
```

Expected: the RLS test PASSES already (Task 1's migration is applied); the `archiveListing` test FAILS with "archiveListing is not a function" (or a TS error, since it isn't exported yet).

- [ ] **Step 3: Implement `archiveListing()`**

In `src/lib/data/moderation.ts`, change the `QueueChangeType` declaration near the top:

```ts
export type QueueChangeType = "new" | "update" | "cancellation" | "archive";
```

Add the following function after `createListingFromFields` (before `approveNewListing`):

```ts
// The single write-through path that flips a listing to `archived`. Used
// both by a moderator's direct action (origin: "moderator_archive") and by
// createListingFromFields()'s recovery fallback (origin: "system_recovery")
// when a listing goes live but its recurrence schedule fails to save right
// after — see that function for why archiving is the safer outcome there.
// Modeled on directAddListing: single-moderator, immediate, no propose/
// confirm step, since archiving is reversible and moderator-initiated
// rather than a silent, unilateral rejection of someone's contribution.
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

- [ ] **Step 4: Add the new labels**

In `src/lib/utils/moderation-labels.ts`, update `CHANGE_TYPE_LABEL` and `ORIGIN_LABEL`:

```ts
export const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New",
  update: "Update",
  cancellation: "Cancellation",
  archive: "Archive",
};

export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
  submission_form: "Public submission",
  moderator_direct_add: "Direct add",
  source_check: "Automated source check",
  moderator_archive: "Archived by moderator",
  system_recovery: "Automatic (recovery)",
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test moderation-archive-listing
```

Expected: PASS — both tests.

- [ ] **Step 6: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS — `QueueChangeType` and `CHANGE_TYPE_LABEL`/`ORIGIN_LABEL` are additive changes, so no existing test should break.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-archive-listing.test.ts src/lib/utils/moderation-labels.ts
git commit -m "$(cat <<'EOF'
feat: add archiveListing, the audited write-through path for archiving

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Unify the recovery fallback with `archiveListing()`

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-archive-listing.test.ts`
- Modify: `src/lib/data/moderation-source-check.test.ts`

**Interfaces:**

- Consumes: `archiveListing` (Task 2)
- Produces: no new exports — `createListingFromFields`'s recovery fallback now leaves an audit trail instead of a silent, unaudited `.update()`

This is the exact code path the source note (`notes/archive-status-rls-gap.md`) started from.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/data/moderation-archive-listing.test.ts`, after the `archiveListing` describe block:

```ts
import { createListingFromFields } from "./moderation";
import type { ProposedListingFields } from "./moderation";

describe("createListingFromFields recovery fallback", () => {
  it("archives the listing and records a system_recovery queue entry when the recurrence insert fails", async () => {
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const fields: ProposedListingFields = {
      type: "mic",
      title: "Recovery Fallback Test Listing",
      host: null,
      description: null,
      venueId: EXISTING_VENUE_ID,
      newVenue: null,
      startTime: "19:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      // day_of_week 9 violates recurrence_rules' `check (day_of_week
      // between 0 and 6)` constraint — a real, deterministic Postgres
      // failure, not a mock, so this exercises the actual insert path.
      recurrence: { frequency: "weekly", dayOfWeek: 9, weekOfMonth: null },
      oneOffDate: null,
    };

    await expect(createListingFromFields(moderator1, fields)).rejects.toThrow(
      "Failed to save the recurrence schedule, so the listing was archived",
    );

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id, status")
      .eq("title", "Recovery Fallback Test Listing")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);
    expect(listing!.status).toBe("archived");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, approved_by, approval_note")
      .eq("listing_id", listing!.id)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("archive");
    expect(entry!.origin).toBe("system_recovery");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approval_note).toBe(
      "Recurrence schedule failed to save during creation",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test moderation-archive-listing
```

Expected: FAIL — the fallback still does a raw, unaudited `.update()`, so no `moderation_queue` entry with `change_type: "archive"` exists yet (the `.single()` call on the queue select errors with "no rows found").

- [ ] **Step 3: Refactor the fallback**

In `src/lib/data/moderation.ts`, inside `createListingFromFields`, replace:

```ts
    if (recurrenceError) {
      const { error: archiveError } = await client
        .from("listings")
        .update({ status: "archived" })
        .eq("id", listing.id);
      throw new Error(
        archiveError
          ? `Failed to save the recurrence schedule: ${recurrenceError.message} (the listing could not be archived either: ${archiveError.message} — it may be live with no recurrence data; check it manually)`
          : `Failed to save the recurrence schedule, so the listing was archived rather than left live with an incomplete schedule: ${recurrenceError.message}`,
      );
    }
```

with:

```ts
    if (recurrenceError) {
      try {
        await archiveListing(
          client,
          listing.id,
          "Recurrence schedule failed to save during creation",
          "system_recovery",
        );
      } catch (archiveError) {
        const archiveMessage =
          archiveError instanceof Error
            ? archiveError.message
            : String(archiveError);
        // Distinguishes "the listing itself failed to archive" (still live,
        // matches the original fallback's worst case) from "it archived
        // fine but the audit-trail insert failed" (safely unpublished, just
        // unaudited) — archiveListing()'s two failure points throw with
        // distinguishable message prefixes, checked here rather than
        // collapsing both into one misleading "it may be live" message.
        if (archiveMessage.startsWith("Failed to archive listing:")) {
          throw new Error(
            `Failed to save the recurrence schedule: ${recurrenceError.message} (the listing could not be archived either: ${archiveMessage} — it may be live with no recurrence data; check it manually)`,
          );
        }
        throw new Error(
          `Failed to save the recurrence schedule, so the listing was archived rather than left live with an incomplete schedule: ${recurrenceError.message} (note: the archive audit record failed to save — ${archiveMessage})`,
        );
      }
      throw new Error(
        `Failed to save the recurrence schedule, so the listing was archived rather than left live with an incomplete schedule: ${recurrenceError.message}`,
      );
    }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test moderation-archive-listing
```

Expected: PASS — all three tests in the file.

- [ ] **Step 5: Add one lockdown assertion for the source-check agent**

This closes the loop the spec calls out explicitly: confirm the new `SELECT` policy from Task 1 didn't accidentally widen what a `source_check_agents` account can write, since RLS policy interactions are exactly what caused the original gap. Add to the `source-check agent lockdown` describe block in `src/lib/data/moderation-source-check.test.ts`, after the existing `"cannot update an existing listing"` test:

```ts
  it("cannot archive a listing", async () => {
    // Same reasoning as "cannot update an existing listing" above: a
    // restrictive policy silently excludes the row from the update rather
    // than throwing, so the assertion is that status is unchanged.
    const agent = await signInSourceCheckAgent();
    await agent
      .from("listings")
      .update({ status: "archived" })
      .eq("id", EXISTING_LISTING_ID);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("status")
      .eq("id", EXISTING_LISTING_ID)
      .single();
    expect(listing!.status).toBe("published");
  });
```

- [ ] **Step 6: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-archive-listing.test.ts src/lib/data/moderation-source-check.test.ts
git commit -m "$(cat <<'EOF'
fix: give the recurrence-insert recovery fallback an audit trail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `/admin/listings` page

**Files:**

- Create: `src/pages/admin/listings/index.astro`
- Modify: `src/lib/data/moderation.ts` (export `findMissingReason`, `parseApprovalNote`)
- Modify: `src/components/layout/AdminHeader.astro`

**Interfaces:**

- Consumes: `getPublishedListings` (`src/lib/data/listings.ts`), `archiveListing`, `findMissingReason`, `parseApprovalNote` (Task 2/this task), `APPROVAL_REASON_OPTIONS`/`APPROVAL_REASON_HINT`/`TYPE_OPTIONS` (`moderation-labels.ts`)
- Produces: the `/admin/listings` route; a nav link from every other `/admin/*` page

No automated test for this page — per this project's existing testing priorities (state-transition/governance logic is automated; page rendering is verified manually at this scale), matching how `/admin/listings/new` was treated.

- [ ] **Step 1: Export the reason-parsing helpers**

In `src/lib/data/moderation.ts`, add `export` to the two existing module-private functions so this new page can reuse the exact same reason validation `/admin/listings/new` already uses, instead of duplicating it:

```ts
export function findMissingReason(formData: FormData): MissingField[] {
```

```ts
export function parseApprovalNote(formData: FormData): string | null {
```

(Only the `export` keyword changes — the bodies are unchanged.)

- [ ] **Step 2: Write the page**

Create `src/pages/admin/listings/index.astro`:

```astro
---
import Button from "../../../components/forms/Button.astro";
import FormSelect from "../../../components/forms/FormSelect.astro";
import FormTextarea from "../../../components/forms/FormTextarea.astro";
import AdminUtilityBar from "../../../components/layout/AdminUtilityBar.astro";
import AdminLayout from "../../../layouts/AdminLayout.astro";
import { getPublishedListings } from "../../../lib/data/listings";
import {
  archiveListing,
  findMissingReason,
  parseApprovalNote,
} from "../../../lib/data/moderation";
import {
  APPROVAL_REASON_HINT,
  APPROVAL_REASON_OPTIONS,
  TYPE_OPTIONS,
} from "../../../lib/utils/moderation-labels";

const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;

let errorListingId: string | null = null;
let errorMessage: string | null = null;
let fieldErrors: Record<string, string> = {};
let submittedReason = "";
let submittedOtherReason = "";

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  const listingId = formData.get("listingId")?.toString() ?? "";
  submittedReason = formData.get("reason")?.toString() ?? "";
  submittedOtherReason = formData.get("otherReason")?.toString() ?? "";

  const missingReason = findMissingReason(formData);
  if (missingReason.length > 0) {
    errorListingId = listingId;
    errorMessage = "Choose a reason for archiving this listing.";
    fieldErrors = Object.fromEntries(
      missingReason.map(({ field }) => [field, "Required."]),
    );
  } else {
    try {
      const reason = parseApprovalNote(formData) ?? "";
      await archiveListing(supabase, listingId, reason);
      return Astro.redirect("/admin/listings?archived=1");
    } catch (error) {
      errorListingId = listingId;
      errorMessage =
        error instanceof Error ? error.message : "Something went wrong.";
    }
  }
}

const listings = (await getPublishedListings()).sort((a, b) =>
  a.title.localeCompare(b.title),
);
const justArchived = Astro.url.searchParams.get("archived") === "1";
---

<AdminLayout title="Listings — Crowd Work admin" userEmail={user.email}>
  <AdminUtilityBar backHref="/admin" backLabel="Back to queue" />

  <div class="border-rule mt-5 border-b pb-5">
    <h1 class="font-display text-[1.28rem] font-bold">Listings</h1>
    <p class="text-ink-soft mt-2 text-[0.95rem]">
      Every currently published listing. Archiving removes it from the
      public site and records who did it and why.
    </p>
  </div>

  {
    justArchived && (
      <p
        role="status"
        class="bg-paper-shadow mt-5 rounded-sm border-l-[3px] border-l-[color-mix(in_srgb,var(--gold)_60%,var(--paper)_40%)] px-3.5 py-2.5 text-[0.86rem] font-medium"
      >
        Listing archived.
      </p>
    )
  }

  {
    listings.length === 0 ? (
      <p class="text-ink-soft py-10 text-[0.95rem]">No published listings.</p>
    ) : (
      <ul class="m-0 list-none p-0">
        {listings.map((listing) => {
          const typeLabel =
            TYPE_OPTIONS.find((option) => option.value === listing.type)
              ?.label ?? listing.type;
          const rowHasError = errorListingId === listing.id;
          return (
            <li class="border-rule flex flex-col gap-3 border-b py-5">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-[0.95rem] font-medium">{listing.title}</p>
                  <p class="text-ink-soft text-[0.82rem]">
                    {typeLabel} · {listing.venue.name}
                  </p>
                </div>
                <details open={rowHasError}>
                  <summary class="font-display text-ink-soft hover:text-ink inline-block cursor-pointer text-[0.82rem] font-bold tracking-wide uppercase [&::-webkit-details-marker]:hidden">
                    Archive
                  </summary>
                  <form
                    method="post"
                    novalidate
                    class="max-w-form-compact mt-3 flex flex-col gap-4"
                  >
                    <input type="hidden" name="listingId" value={listing.id} />

                    {rowHasError && errorMessage && (
                      <p
                        role="alert"
                        class="border-l-error text-error bg-paper rounded-sm border-l-[3px] px-3.5 py-2.5 text-[0.86rem] font-medium"
                      >
                        <strong>Error:</strong> {errorMessage}
                      </p>
                    )}

                    <FormSelect
                      label="Reason"
                      name="reason"
                      options={APPROVAL_REASON_OPTIONS}
                      value={rowHasError ? submittedReason : ""}
                      required
                      error={rowHasError ? fieldErrors.reason : undefined}
                      hint={APPROVAL_REASON_HINT}
                    />
                    <div
                      data-other-reason
                      hidden={!rowHasError || submittedReason !== "other"}
                    >
                      <FormTextarea
                        label="Other reason"
                        name="otherReason"
                        value={rowHasError ? submittedOtherReason : ""}
                        required
                        error={
                          rowHasError ? fieldErrors.otherReason : undefined
                        }
                      />
                    </div>

                    <Button
                      type="submit"
                      variant="outline"
                      busyLabel="Archiving…"
                    >
                      Archive this listing
                    </Button>
                  </form>
                </details>
              </div>
            </li>
          );
        })}
      </ul>
    )
  }
</AdminLayout>

<script>
  const reasonSelects = document.querySelectorAll<HTMLSelectElement>(
    'select[name="reason"]',
  );
  for (const select of reasonSelects) {
    const container = select
      .closest("form")
      ?.querySelector<HTMLElement>("[data-other-reason]");
    if (!container) continue;
    const sync = () => {
      container.hidden = select.value !== "other";
    };
    select.addEventListener("change", sync);
    sync();
  }
</script>
```

- [ ] **Step 3: Add the nav link**

Modify `src/components/layout/AdminHeader.astro`. In the `<nav>` block, add a "Listings" link between "New listing" and "Archive":

```astro
          <a
            href="/admin/listings/new"
            aria-current={currentPath === "/admin/listings/new" ? "page" : undefined}
            class={navLinkClass("/admin/listings/new")}
          >
            New listing
          </a>
          <a
            href="/admin/listings"
            aria-current={currentPath === "/admin/listings" ? "page" : undefined}
            class={navLinkClass("/admin/listings")}
          >
            Listings
          </a>
          <a
            href="/admin/archive"
            aria-current={currentPath === "/admin/archive" ? "page" : undefined}
            class={navLinkClass("/admin/archive")}
          >
            Archive
          </a>
```

- [ ] **Step 4: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS — exporting two previously-private functions is additive; nothing else changed behaviorally.

- [ ] **Step 5: Verify manually**

```bash
astro dev --background
```

Sign in and open `/admin/listings`. Confirm:

- Every published listing appears, alphabetically by title, each with its type and venue.
- Clicking "Archive" on a row expands a reason field in place (no navigation, no modal) — check the DevTools element tree to confirm it's a native `<details>`, not custom JS-driven show/hide.
- Selecting "Other…" reveals the free-text field; picking a canned reason hides it again.
- Submitting with no reason selected re-expands that same row with a validation error and preserves nothing from other rows.
- Submitting with a reason redirects to `/admin/listings?archived=1`, shows the "Listing archived." banner, and the archived listing no longer appears in the list (it's no longer published).
- The archived listing no longer resolves at its public `/listings/<id>` URL.

```bash
astro dev logs
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/admin/listings/index.astro src/lib/data/moderation.ts src/components/layout/AdminHeader.astro
git commit -m "$(cat <<'EOF'
feat: add /admin/listings with an inline archive action per row

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Data layer — `getListingTitles`

**Files:**

- Modify: `src/lib/data/listings.ts`
- Modify: `src/lib/data/listings.test.ts`

**Interfaces:**

- Consumes: `listings` table (`title`, `id` columns) via a caller-supplied client
- Produces: `export async function getListingTitles(client: SupabaseClient<Database>, ids: string[]): Promise<Record<string, string>>` — consumed by Task 6's `/admin/archive` wiring

An `archive` queue entry's `proposed_data`/`approved_data` are always `null` (Task 2) — nothing about the listing's fields changed, so unlike every other change type there's no title sitting in a JSON blob to preview with. This mirrors `getModeratorEmails` (`src/lib/data/moderators.ts`) exactly: same shape, same reason (a batch id→field lookup for display, done with the caller's own authenticated client rather than the page's module-level anon client).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/data/listings.test.ts`:

```ts
import { getListingTitles } from "./listings";
import { signInTestModerator } from "./moderation-test-helpers";

describe("getListingTitles", () => {
  it("resolves listing ids to their titles", async () => {
    const moderator1 = await signInTestModerator(1);
    // "Tuesday Night Mic", seeded in supabase/seed.sql.
    const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

    const titles = await getListingTitles(moderator1, [EXISTING_LISTING_ID]);

    expect(titles[EXISTING_LISTING_ID]).toBe("Tuesday Night Mic");
  });

  it("returns an empty object for an empty id list", async () => {
    const moderator1 = await signInTestModerator(1);
    const titles = await getListingTitles(moderator1, []);
    expect(titles).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test listings
```

Expected: FAIL — `getListingTitles` doesn't exist yet.

- [ ] **Step 3: Implement `getListingTitles`**

In `src/lib/data/listings.ts`, add the missing type imports at the top:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
```

Add the function anywhere convenient (e.g. after `getListingById`):

```ts
export async function getListingTitles(
  client: SupabaseClient<Database>,
  ids: string[],
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from("listings")
    .select("id, title")
    .in("id", uniqueIds);

  if (error)
    throw new Error(`Failed to load listing titles: ${error.message}`);

  return Object.fromEntries((data ?? []).map((row) => [row.id, row.title]));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test listings
```

Expected: PASS — both tests.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/data/listings.ts src/lib/data/listings.test.ts
git commit -m "$(cat <<'EOF'
feat: add getListingTitles for rendering archive entries by title

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/admin/archive` renders `archive` entries

**Files:**

- Modify: `src/lib/utils/moderation-labels.ts`
- Modify: `src/pages/admin/archive/index.astro`
- Modify: `src/lib/data/moderation-archive.test.ts`

**Interfaces:**

- Consumes: `getListingTitles` (Task 5); `archive` queue entries produced by Tasks 2–4
- Produces: no new exports — resolves the spec's one open item (the `archive` preview lives in the shared `previewFor()` helper, extended with an optional title parameter, rather than a second archive-page-specific function)

The page itself is verified manually (Step 6) — `previewFor()`'s other branches have no automated coverage either, and this task doesn't change that policy. What *is* automated here is the specific guarantee the spec's Testing section calls out: an `archive` entry is actually discoverable via `getArchiveEntries()` and renders with the right label and title preview — a read-path integrity check, not a UI test.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/data/moderation-archive.test.ts`, inside the `getArchiveEntries` describe block, after the existing test:

```ts
import { archiveListing } from "./moderation";
import { getListingTitles } from "./listings";
import {
  CHANGE_TYPE_LABEL,
  ORIGIN_LABEL,
  previewFor,
} from "../utils/moderation-labels";
```

(add these to the top of the file, alongside the existing imports)

```ts
  it("includes an archive entry, previewed by the listing's title", async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Archive Entry Rendering Test",
        venue_id: "c0000000-0000-0000-0000-000000000001",
        start_time: "19:00",
        one_off_date: "2026-09-15",
        status: "published",
      })
      .select("id")
      .single();
    if (createError) throw createError;
    insertedListingIds.push(listing.id);

    const moderator1 = await signInTestModerator(1);
    await archiveListing(moderator1, listing.id, "Venue closed");

    const entries = await getArchiveEntries(moderator1);
    const entry = entries.find((e) => e.listingId === listing.id);
    expect(entry).toBeDefined();
    insertedEntryIds.push(entry!.id);

    expect(CHANGE_TYPE_LABEL[entry!.changeType]).toBe("Archive");
    expect(ORIGIN_LABEL[entry!.origin]).toBe("Archived by moderator");

    const titles = await getListingTitles(moderator1, [listing.id]);
    const preview = previewFor(
      {
        correctionNote: entry!.correctionNote,
        proposedData: entry!.approvedData,
        changeType: entry!.changeType,
      },
      titles[listing.id],
    );
    expect(preview).toBe(
      "Archived: Temp Listing For Archive Entry Rendering Test",
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test moderation-archive
```

Expected: FAIL — `getListingTitles` doesn't exist in this import path context yet for an `archive`-typed entry, `CHANGE_TYPE_LABEL`/`ORIGIN_LABEL` are missing the new keys until Step 3, and `previewFor()` doesn't accept a second argument yet.

Note: Task 2 and Task 5 already added `CHANGE_TYPE_LABEL.archive`/`ORIGIN_LABEL.moderator_archive` and `getListingTitles` respectively — the only piece actually missing at this point is `previewFor()`'s new branch, so the failure should specifically be the final `expect(preview)` assertion returning `"Cancellation"` (today's fallback for an entry with no `proposedData.title`) instead of the expected string.

- [ ] **Step 3: Extend `previewFor()`**

In `src/lib/utils/moderation-labels.ts`, replace:

```ts
export function previewFor(
  entry: Pick<QueueEntry, "correctionNote" | "proposedData" | "changeType">,
): string {
  if (entry.correctionNote) {
    return truncate(entry.correctionNote);
  }
  const data = entry.proposedData as ProposedListingFields | null;
  if (data?.title) {
    return entry.changeType === "new"
      ? `New listing: ${data.title}`
      : `Update: ${data.title}`;
  }
  return "Cancellation";
}
```

with:

```ts
export function previewFor(
  entry: Pick<QueueEntry, "correctionNote" | "proposedData" | "changeType">,
  listingTitle?: string | null,
): string {
  if (entry.changeType === "archive") {
    return listingTitle ? `Archived: ${listingTitle}` : "Archived listing";
  }
  if (entry.correctionNote) {
    return truncate(entry.correctionNote);
  }
  const data = entry.proposedData as ProposedListingFields | null;
  if (data?.title) {
    return entry.changeType === "new"
      ? `New listing: ${data.title}`
      : `Update: ${data.title}`;
  }
  return "Cancellation";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test moderation-archive
```

Expected: PASS — the `previewFor()` branch alone is enough to make Step 1's test pass, since `entry.listingId` and `entries` already flow correctly through `getArchiveEntries()` with no other code changes needed for this specific test (it calls `getListingTitles`/`previewFor` directly rather than through the page's `whatFor()`).

- [ ] **Step 5: Wire it into the archive page**

In `src/pages/admin/archive/index.astro`, add `getListingTitles` to the imports from `../../../lib/data/listings`:

```ts
import { getListingTitles } from "../../../lib/data/listings";
```

After the existing `moderatorEmails` lookup, add:

```ts
const archiveListingIds = entries
  .filter(
    (entry): entry is typeof entry & { listingId: string } =>
      entry.changeType === "archive" && entry.listingId !== null,
  )
  .map((entry) => entry.listingId);
const listingTitles = await getListingTitles(supabase, archiveListingIds);
```

Update `whatFor()` to pass the title through:

```ts
function whatFor(entry: QueueEntry): string {
  return previewFor(
    {
      correctionNote: entry.correctionNote,
      proposedData:
        entry.status === "approved" ? entry.approvedData : entry.proposedData,
      changeType: entry.changeType,
    },
    entry.listingId ? listingTitles[entry.listingId] : null,
  );
}
```

- [ ] **Step 6: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS — `previewFor()`'s new parameter is optional, so every existing call site is unaffected.

- [ ] **Step 7: Verify manually**

With the local stack running (`astro dev --background` if not already), archive a listing via `/admin/listings` (Task 4), then open `/admin/archive`. Confirm:

- The new entry shows the "Archive" chip, "Archived by moderator" origin, and a preview reading "Archived: \<the listing's title\>".
- The "Who" line reads "Approved by \<your email\>" and "Why" shows the reason you typed.

- [ ] **Step 8: Commit**

```bash
git add src/lib/utils/moderation-labels.ts src/pages/admin/archive/index.astro
git commit -m "$(cat <<'EOF'
feat: render archive entries in the Moderation Archive by listing title

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: End-to-end manual verification

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Full moderator flow**

```bash
astro dev --background
```

Sign in as a moderator and:

1. Open `/admin/listings`, archive a listing with a canned reason. Confirm the success banner and that the listing disappears from the list.
2. Open `/admin/archive`, confirm the entry appears with the correct chip, origin, preview, who/why/when.
3. Try archiving another listing with "Other…" and free text — confirm that free text is what shows up as "Why" on the archive page.
4. Try submitting the archive form with no reason chosen — confirm the inline error and that the page doesn't lose your place (the same row's disclosure stays open).

- [ ] **Step 2: Recovery fallback still degrades honestly**

There's no UI path that deliberately breaks a recurrence insert, so this re-confirms the automated coverage from Task 3 is the real check:

```bash
pnpm test moderation-archive-listing
```

Expected: PASS, including the `system_recovery` test.

- [ ] **Step 3: Accessibility check at high zoom**

Per `PRODUCT.md`'s validated accessibility need, set the browser to 400% zoom and reload `/admin/listings`. Confirm:

- The page reflows to a single readable column with no horizontal scrolling.
- Opening a row's "Archive" disclosure at this zoom level doesn't clip or require two-dimensional scrolling to reach the reason field or submit button.

- [ ] **Step 4: Full regression suite**

```bash
pnpm test
```

Expected: PASS — full suite, no regressions from any task in this plan.

```bash
astro dev logs
```

Expected: no errors across the whole session.

- [ ] **Step 5: Stop the dev server**

```bash
astro dev stop
```
