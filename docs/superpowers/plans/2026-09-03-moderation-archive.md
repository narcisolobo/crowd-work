# Moderation Archive Implementation Plan

**Goal:** Give moderators a viewable, filterable admin archive of every decided (`approved`/`rejected`) `moderation_queue` entry, capturing who acted, what was actually written, and why — closing the audit-trail gap the design doc identified (approval currently records no actor at all) and laying the schema the upcoming Listing Submission phase's moderator direct-add feature will rely on.

**Architecture:** Extends the existing Astro (SSR) + Supabase project with no new services. A migration adds four audit columns to `moderation_queue` plus tightened RLS, and a second migration adds a small `moderators` lookup table so the archive can show a human-readable moderator identity instead of a raw `auth.users` id (which isn't exposed to the `authenticated` role via PostgREST). Application changes extend the existing approve/reject write-through functions in `src/lib/data/moderation.ts`, add a new `/admin/archive` page using the same server-renders-everything-with-a-`hidden`-flag progressive-enhancement pattern the public listings page already uses, and extract label/preview helpers that are now shared across three admin pages.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-03-moderation-archive-design.md](../specs/2026-09-03-moderation-archive-design.md)

## Global Constraints

- Every application write to `moderation_queue` goes through the `authenticated`-role RLS policies — never bypassed with the service-role key. The service-role key is used only by `scripts/provision-moderators.mjs` and by test setup/teardown, per the existing project convention.
- `proposed_data` is never overwritten after insert — it remains the permanent record of the original proposal. The new `approved_data` column is a separate, independent snapshot taken at approval time.
- `approval_note` is nullable with no default — a default value would fabricate a "why" no moderator actually gave, which cuts against the accountability goal this phase exists for.
- `decided_at` is set explicitly by application code (the same `auth.getUser()` call pattern `proposeRejection`/`confirmRejection` already use), not by a DB-side trigger.
- No Playwright/e2e tests this phase — the design doc's own Testing section treats the admin UI as manual-verification-only, consistent with how the prior phase treated its list/detail pages.

---

## File Structure

```
crowd-work/
├── scripts/
│   └── provision-moderators.mjs        # modified: also seeds the moderators lookup table
├── src/
│   ├── lib/
│   │   ├── supabase/
│   │   │   └── database.types.ts       # regenerated (adds moderators table, new moderation_queue columns)
│   │   ├── data/
│   │   │   ├── moderation.ts           # modified: archive columns, getArchiveEntries()
│   │   │   ├── moderation-approve.test.ts       # modified: archive-column assertions + RLS forgery test
│   │   │   ├── moderation-transitions.test.ts   # modified: decided_at assertion + RLS forgery test
│   │   │   ├── moderation-archive.test.ts       # new: getArchiveEntries() tests
│   │   │   ├── moderators.ts           # new: getModeratorEmails()
│   │   │   └── moderators.test.ts      # new
│   │   └── utils/
│   │       └── moderation-labels.ts    # new: CHANGE_TYPE_LABEL (chip form), ORIGIN_LABEL, STATUS_LABEL, previewFor — shared by admin/index.astro, admin/queue/[id].astro, admin/archive/index.astro
│   ├── components/
│   │   └── layout/
│   │       └── AdminHeader.astro       # modified: nav link to /admin/archive
│   └── pages/
│       └── admin/
│           ├── index.astro             # modified: use shared label helpers
│           ├── archive/
│           │   └── index.astro         # new: the archive page
│           └── queue/
│               └── [id].astro          # modified: use shared label helpers; approve forms gain a Reason select
└── supabase/
    └── migrations/
        ├── <timestamp>_moderation_archive.sql
        └── <timestamp>_moderators.sql
```

---

### Task 1: Migration — `moderation_queue` archive columns and RLS

**Files:**

- Create: `supabase/migrations/<timestamp>_moderation_archive.sql`

**Interfaces:**

- Consumes: `moderation_queue` table from the moderation-queue-admin-review phase
- Produces: columns `approved_by`, `approved_data`, `approval_note`, `decided_at` on `moderation_queue`; tightened `with check` clauses on the existing approve/reject-confirm UPDATE policies, consumed by Task 3's write-through changes

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new moderation_archive
```

- [x] **Step 2: Write the migration**

Open the generated file and write:

```sql
alter table moderation_queue
  add column approved_by uuid references auth.users(id),
  add column approved_data jsonb,
  add column approval_note text,
  add column decided_at timestamptz;

-- Tighten the existing approve/reject policies so the new actor and
-- timestamp columns are enforced at the RLS level, the same way
-- proposed_by = auth.uid() already is for proposing a rejection. A
-- moderator can never write another moderator's id into approved_by or
-- confirmed_by.
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

- [x] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `moderation_archive` apply with no errors.

- [x] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `database.types.ts`'s `moderation_queue` entry now includes `approved_by`, `approved_data`, `approval_note`, and `decided_at`.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: add moderation_queue archive columns with tightened RLS

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration — `moderators` lookup table

**Files:**

- Create: `supabase/migrations/<timestamp>_moderators.sql`
- Modify: `scripts/provision-moderators.mjs`

**Interfaces:**

- Consumes: `auth.users` (Supabase Auth's own table, not exposed via PostgREST to `authenticated`)
- Produces: table `moderators` (`id`, `email`), readable by any authenticated moderator, populated only by the service-role provisioning script; consumed by Task 4's `getModeratorEmails()`

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new moderators
```

- [x] **Step 2: Write the migration**

```sql
-- A minimal id -> email lookup so the admin UI can show which moderator
-- did something, without querying auth.users directly (not exposed to the
-- authenticated role via PostgREST). This grants no new permissions — it's
-- a display label, not a moderator-role/permission table, so it doesn't
-- reopen the "no self-serve moderator table" non-goal from the original
-- moderation-queue-admin-review design.
create table moderators (
  id uuid primary key references auth.users(id),
  email text not null
);

alter table moderators enable row level security;

create policy "moderators can read moderator emails"
  on moderators for select
  to authenticated
  using (true);
```

- [x] **Step 3: Apply and verify**

```bash
supabase db reset
```

Expected: all migrations apply with no errors.

- [x] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `database.types.ts` now includes a `moderators` table entry.

- [x] **Step 5: Populate `moderators` in the provisioning script**

Modify `scripts/provision-moderators.mjs`. After both `auth.users` accounts are created (after line 40, `if (error2) throw error2;`) and before the existing `moderation_queue` seed insert, add:

```js
const { error: moderatorsError } = await admin.from("moderators").insert([
  { id: user1.user.id, email: email1 },
  { id: user2.user.id, email: email2 },
]);
if (moderatorsError) throw moderatorsError;
```

The full block should now read:

```js
const { data: user2, error: error2 } = await admin.auth.admin.createUser({
  email: email2,
  password: password2,
  email_confirm: true,
});
if (error2) throw error2;

const { error: moderatorsError } = await admin.from("moderators").insert([
  { id: user1.user.id, email: email1 },
  { id: user2.user.id, email: email2 },
]);
if (moderatorsError) throw moderatorsError;

const { error: queueError } = await admin.from("moderation_queue").insert({
```

(the rest of the `moderation_queue` insert block is unchanged)

- [x] **Step 6: Re-run the provisioning script and verify**

```bash
node scripts/provision-moderators.mjs mod1@crowdwork.test <password1> mod2@crowdwork.test <password2>
```

Use your own local test passwords in place of `<password1>`/`<password2>` — they should match whatever is already in your `.env`'s `TEST_MODERATOR_1_PASSWORD`/`TEST_MODERATOR_2_PASSWORD`, since Task 3's tests sign in with those same credentials.

Expected: the two "Provisioned moderator" lines, no errors. Then verify the table directly:

```bash
curl "http://127.0.0.1:54521/rest/v1/moderators?select=email" \
  -H "apikey: <local service_role key from supabase status>" \
  -H "Authorization: Bearer <local service_role key from supabase status>"
```

Expected: a JSON array with both provisioned emails.

- [x] **Step 7: Commit**

```bash
git add supabase/migrations scripts/provision-moderators.mjs
git commit -m "$(cat <<'EOF'
feat: add moderators lookup table for archive display

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Data layer — archive columns in the approve/reject write-through

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-approve.test.ts`
- Modify: `src/lib/data/moderation-transitions.test.ts`
- Create: `src/lib/data/moderation-archive.test.ts`

**Interfaces:**

- Consumes: `approved_by`/`approved_data`/`approval_note`/`decided_at` columns from Task 1
- Produces: `QueueEntry.approvedBy/approvedData/approvalNote/decidedAt`; `approveNewListing`/`approveListingUpdate`/`approveCancellation` gain an optional trailing `approvalNote?: string | null` parameter; `getArchiveEntries(client): Promise<QueueEntry[]>` — consumed by Task 7's archive page

- [x] **Step 1: Extend the failing tests first**

In `src/lib/data/moderation-approve.test.ts`, change the `approveNewListing` test's call and add assertions (replacing the existing `await approveNewListing(moderator1, entryId, edited);` line and everything after it up to the closing of that `it` block):

```ts
await approveNewListing(moderator1, entryId, edited, "Verified independently");

const admin = createAdminClient();
const { data: listing } = await admin
  .from("listings")
  .select("id, title, host, start_time")
  .eq("title", "Moderator-Corrected Title")
  .single();
expect(listing).not.toBeNull();
insertedListingIds.push(listing!.id);
expect(listing!.host).toBe("Corrected Host");
expect(listing!.start_time).toBe("19:30:00");

const { data: rule } = await admin
  .from("recurrence_rules")
  .select("day_of_week")
  .eq("listing_id", listing!.id)
  .single();
expect(rule!.day_of_week).toBe(1);

const {
  data: { user: moderator1User },
} = await moderator1.auth.getUser();
const { data: entry } = await admin
  .from("moderation_queue")
  .select(
    "status, listing_id, approved_by, approved_data, approval_note, decided_at",
  )
  .eq("id", entryId)
  .single();
expect(entry!.status).toBe("approved");
expect(entry!.listing_id).toBe(listing!.id);
expect(entry!.approved_by).toBe(moderator1User!.id);
expect(entry!.approval_note).toBe("Verified independently");
expect(entry!.decided_at).not.toBeNull();
// approved_data is a snapshot of the moderator-edited values, not the
// original proposal — matches `edited`, not `proposed_data` above.
expect((entry!.approved_data as { title: string }).title).toBe(
  "Moderator-Corrected Title",
);
```

In `describe("approveListingUpdate", ...)`, change the call and add assertions after the existing `updated!.start_time` check:

```ts
await approveListingUpdate(
  moderator1,
  entryId,
  original.id,
  edited,
  "Accurate after minor edits",
);

const { data: updated } = await admin
  .from("listings")
  .select("start_time")
  .eq("id", original.id)
  .single();
expect(updated!.start_time).toBe("20:30:00");

const { data: entry } = await admin
  .from("moderation_queue")
  .select("approved_data, approval_note")
  .eq("id", entryId)
  .single();
expect(entry!.approval_note).toBe("Accurate after minor edits");
expect((entry!.approved_data as { startTime: string }).startTime).toBe("20:30");
```

In `describe("approveCancellation", ...)`, change the call and add an assertion:

```ts
const moderator1 = await signInTestModerator(1);
await approveCancellation(
  moderator1,
  entryId,
  listing.id,
  "2026-09-15",
  "Venue closed that night",
  "Accurate as submitted",
);

const { data: exception } = await admin
  .from("occurrence_exceptions")
  .select("type, original_date")
  .eq("listing_id", listing.id)
  .eq("original_date", "2026-09-15")
  .single();
expect(exception!.type).toBe("cancelled");

const { data: entry } = await admin
  .from("moderation_queue")
  .select("approved_data, approval_note")
  .eq("id", entryId)
  .single();
expect(entry!.approval_note).toBe("Accurate as submitted");
expect(entry!.approved_data).toEqual({
  originalDate: "2026-09-15",
  note: "Venue closed that night",
});
```

Add a new describe block at the end of the file (after the `approveCancellation` block):

```ts
describe("approval RLS", () => {
  it("blocks a moderator from forging another moderator's id into approved_by", async () => {
    const entryId = await createPendingEntry({
      change_type: "cancellation",
      listing_id: "d0000000-0000-0000-0000-000000000001",
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "test entry",
    });

    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: moderator2User },
    } = await moderator2.auth.getUser();

    const { data, error } = await moderator1
      .from("moderation_queue")
      .update({
        status: "approved",
        approved_by: moderator2User!.id,
        decided_at: new Date().toISOString(),
      })
      .eq("id", entryId)
      .eq("status", "pending")
      .select("id");

    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});
```

In `src/lib/data/moderation-transitions.test.ts`, change the "lets a different moderator confirm the rejection" test:

```ts
it("lets a different moderator confirm the rejection", async () => {
  const moderator1 = await signInTestModerator(1);
  const moderator2 = await signInTestModerator(2);
  await proposeRejection(moderator1, entryId, "Duplicate of another entry");

  const result = await confirmRejection(moderator2, entryId);
  expect(result.status).toBe("rejected");
  expect(result.decidedAt).not.toBeNull();
});
```

Add a new test inside the same `describe("rejection state machine", ...)` block:

```ts
it("blocks a moderator from forging another moderator's id into confirmed_by", async () => {
  const moderator1 = await signInTestModerator(1);
  const moderator2 = await signInTestModerator(2);
  await proposeRejection(moderator1, entryId, "Duplicate of another entry");

  const {
    data: { user: moderator1User },
  } = await moderator1.auth.getUser();

  const { data, error } = await moderator2
    .from("moderation_queue")
    .update({
      status: "rejected",
      confirmed_by: moderator1User!.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("status", "rejection_proposed")
    .select("id");

  expect(error).not.toBeNull();
  expect(data).toBeNull();
});
```

Create `src/lib/data/moderation-archive.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import {
  approveCancellation,
  confirmRejection,
  getArchiveEntries,
  proposeRejection,
} from "./moderation";
import {
  createAdminClient,
  signInTestModerator,
} from "./moderation-test-helpers";

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

async function createPendingCancellation(listingId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      listing_id: listingId,
      proposed_data: { originalDate: "2026-09-15" },
      correction_note: "archive test entry",
      origin: "seed",
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id as string;
}

describe("getArchiveEntries", () => {
  it("returns only approved/rejected entries, most recently decided first, excluding pending/rejection_proposed", async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from("listings")
      .insert({
        type: "mic",
        title: "Temp Listing For Archive Test",
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
    const moderator2 = await signInTestModerator(2);

    const approvedEntryId = await createPendingCancellation(listing.id);
    await approveCancellation(
      moderator1,
      approvedEntryId,
      listing.id,
      "2026-09-15",
      "archive test entry",
      "Accurate as submitted",
    );

    const rejectedEntryId = await createPendingCancellation(listing.id);
    await proposeRejection(moderator1, rejectedEntryId, "Duplicate report");
    await confirmRejection(moderator2, rejectedEntryId);

    const pendingEntryId = await createPendingCancellation(listing.id);

    const entries = await getArchiveEntries(moderator1);
    const entryIds = entries.map((entry) => entry.id);

    expect(entryIds).toContain(approvedEntryId);
    expect(entryIds).toContain(rejectedEntryId);
    expect(entryIds).not.toContain(pendingEntryId);

    const rejectedIndex = entryIds.indexOf(rejectedEntryId);
    const approvedIndex = entryIds.indexOf(approvedEntryId);
    // rejected was decided after approved in this test, so it sorts first.
    expect(rejectedIndex).toBeLessThan(approvedIndex);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation
```

Expected: FAIL — `approveNewListing`/`approveListingUpdate`/`approveCancellation` don't yet accept a fourth `approvalNote` argument, `approved_by`/`approved_data`/`decided_at` are null, `getArchiveEntries` doesn't exist, and the RLS forgery tests currently pass through unblocked (`with check` doesn't yet reference `approved_by`/`confirmed_by`).

- [x] **Step 3: Update the type definitions**

In `src/lib/data/moderation.ts`, replace the `ProposedCancellation` interface (lines 27-29):

```ts
export interface ProposedCancellation {
  originalDate: string;
  note?: string | null;
}
```

Replace the `QueueEntry` interface (lines 31-43):

```ts
export interface QueueEntry {
  id: string;
  listingId: string | null;
  changeType: QueueChangeType;
  proposedData: ProposedListingFields | ProposedCancellation | null;
  correctionNote: string | null;
  origin: string;
  status: QueueStatus;
  proposedBy: string | null;
  proposedReason: string | null;
  confirmedBy: string | null;
  approvedBy: string | null;
  approvedData: ProposedListingFields | ProposedCancellation | null;
  approvalNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}
```

Replace `QUEUE_ENTRY_SELECT` and `mapQueueEntryRow` (lines 45-62):

```ts
export const QUEUE_ENTRY_SELECT =
  "id, listing_id, change_type, proposed_data, correction_note, origin, status, proposed_by, proposed_reason, confirmed_by, approved_by, approved_data, approval_note, decided_at, created_at";

export function mapQueueEntryRow(row: any): QueueEntry {
  return {
    id: row.id,
    listingId: row.listing_id,
    changeType: row.change_type,
    proposedData: row.proposed_data,
    correctionNote: row.correction_note,
    origin: row.origin,
    status: row.status,
    proposedBy: row.proposed_by,
    proposedReason: row.proposed_reason,
    confirmedBy: row.confirmed_by,
    approvedBy: row.approved_by,
    approvedData: row.approved_data,
    approvalNote: row.approval_note,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}
```

- [x] **Step 4: Update `confirmRejection` to set `decided_at`**

Replace the `.update(...)` call inside `confirmRejection` (currently `.update({ status: "rejected", confirmed_by: user.id })`):

```ts
    .update({
      status: "rejected",
      confirmed_by: user.id,
      decided_at: new Date().toISOString(),
    })
```

- [x] **Step 5: Update `markApproved` and the three approve functions**

Replace `markApproved` (lines 291-310) with:

```ts
async function markApproved(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  approvedData: ProposedListingFields | ProposedCancellation,
  approvalNote: string | null,
): Promise<void> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await client
    .from("moderation_queue")
    .update({
      status: "approved",
      listing_id: listingId,
      approved_by: user.id,
      approved_data: approvedData,
      approval_note: approvalNote,
      decided_at: new Date().toISOString(),
    })
    .eq("id", entryId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error)
    throw new Error(`Failed to mark queue entry approved: ${error.message}`);
  if (!data)
    throw new Error(
      "Could not mark this entry approved — it is no longer pending.",
    );
}
```

Update the three call sites. `approveNewListing` — change its signature and final call:

```ts
export async function approveNewListing(
  client: SupabaseClient<Database>,
  entryId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
```

(body unchanged down to the recurrence insert) then replace the final line `await markApproved(client, entryId, listing.id);` with:

```ts
await markApproved(client, entryId, listing.id, fields, approvalNote);
```

`approveListingUpdate` — change its signature and final call:

```ts
export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
```

replace the final line `await markApproved(client, entryId, listingId);` with:

```ts
await markApproved(client, entryId, listingId, fields, approvalNote);
```

`approveCancellation` — change its signature and final call:

```ts
export async function approveCancellation(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  originalDate: string,
  note: string | null,
  approvalNote: string | null = null,
): Promise<void> {
```

replace the final line `await markApproved(client, entryId, listingId);` with:

```ts
await markApproved(
  client,
  entryId,
  listingId,
  { originalDate, note },
  approvalNote,
);
```

- [x] **Step 6: Add `getArchiveEntries`**

Add to the end of `src/lib/data/moderation.ts`:

```ts
export async function getArchiveEntries(
  client: SupabaseClient<Database>,
): Promise<QueueEntry[]> {
  const { data, error } = await client
    .from("moderation_queue")
    .select(QUEUE_ENTRY_SELECT)
    .in("status", ["approved", "rejected"])
    .order("decided_at", { ascending: false });

  if (error)
    throw new Error(`Failed to load moderation archive: ${error.message}`);

  return (data ?? []).map(mapQueueEntryRow);
}
```

- [x] **Step 7: Run the tests to verify they pass**

```bash
pnpm test moderation
```

Expected: PASS — all `moderation*.test.ts` files green, including the two new RLS forgery tests.

- [x] **Step 8: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-approve.test.ts src/lib/data/moderation-transitions.test.ts src/lib/data/moderation-archive.test.ts
git commit -m "$(cat <<'EOF'
feat: record approver, final values, and reason on approve/reject

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Data layer — moderator email lookup

**Files:**

- Create: `src/lib/data/moderators.ts`
- Create: `src/lib/data/moderators.test.ts`

**Interfaces:**

- Consumes: `moderators` table from Task 2
- Produces: `getModeratorEmails(client, ids: string[]): Promise<Record<string, string>>` — consumed by Task 7's archive page

- [x] **Step 1: Write the failing test**

Create `src/lib/data/moderators.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getModeratorEmails } from "./moderators";
import { signInTestModerator } from "./moderation-test-helpers";

describe("getModeratorEmails", () => {
  it("resolves moderator ids to their emails", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: user1 },
    } = await moderator1.auth.getUser();
    const {
      data: { user: user2 },
    } = await moderator2.auth.getUser();

    const emails = await getModeratorEmails(moderator1, [user1!.id, user2!.id]);

    expect(emails[user1!.id]).toBe(process.env.TEST_MODERATOR_1_EMAIL);
    expect(emails[user2!.id]).toBe(process.env.TEST_MODERATOR_2_EMAIL);
  });

  it("returns an empty object for an empty id list", async () => {
    const moderator1 = await signInTestModerator(1);
    const emails = await getModeratorEmails(moderator1, []);
    expect(emails).toEqual({});
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm test moderators
```

Expected: FAIL with "Cannot find module './moderators'" or similar.

- [x] **Step 3: Write the implementation**

Create `src/lib/data/moderators.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export async function getModeratorEmails(
  client: SupabaseClient<Database>,
  ids: string[],
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from("moderators")
    .select("id, email")
    .in("id", uniqueIds);

  if (error)
    throw new Error(`Failed to load moderator emails: ${error.message}`);

  return Object.fromEntries((data ?? []).map((row) => [row.id, row.email]));
}
```

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm test moderators
```

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/lib/data/moderators.ts src/lib/data/moderators.test.ts
git commit -m "$(cat <<'EOF'
feat: add moderator email lookup for admin display

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Extract shared admin label/preview helpers

**Files:**

- Create: `src/lib/utils/moderation-labels.ts`
- Modify: `src/pages/admin/index.astro`
- Modify: `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: `QueueEntry`, `QueueChangeType` from `src/lib/data/moderation.ts`
- Produces: `CHANGE_TYPE_LABEL`, `ORIGIN_LABEL`, `STATUS_LABEL`, `previewFor()` — consumed by Task 7's archive page. `queue/[id].astro` keeps its own local `CHANGE_TYPE_LABEL` (heading-style wording, e.g. "New listing") since that reads naturally as a page heading, unlike the shared chip-style wording ("New") used in list rows — this is a deliberate, not accidental, divergence.

This is a pure refactor — no behavior change to either existing page.

- [x] **Step 1: Create the shared helpers module**

Create `src/lib/utils/moderation-labels.ts`:

```ts
import type {
  ProposedListingFields,
  QueueChangeType,
  QueueEntry,
} from "../data/moderation";

export const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New",
  update: "Update",
  cancellation: "Cancellation",
};

export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  rejection_proposed: "Rejection proposed",
  approved: "Approved",
  rejected: "Rejected",
};

export function previewFor(
  entry: Pick<QueueEntry, "correctionNote" | "proposedData" | "changeType">,
): string {
  if (entry.correctionNote) {
    return entry.correctionNote.length > 90
      ? `${entry.correctionNote.slice(0, 90)}…`
      : entry.correctionNote;
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

- [x] **Step 2: Update `src/pages/admin/index.astro`**

Replace the frontmatter's local `CHANGE_TYPE_LABEL`, `ORIGIN_LABEL`, and `previewFor` (lines 14-38) with an import, keeping only `dateLabel` locally:

```ts
---
import AdminLayout from "../../layouts/AdminLayout.astro";
import { getReviewableQueueEntries } from "../../lib/data/moderation";
import {
  CHANGE_TYPE_LABEL,
  ORIGIN_LABEL,
  previewFor,
} from "../../lib/utils/moderation-labels";

const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;
const entries = await getReviewableQueueEntries(supabase);

function dateLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
---
```

The rest of the file (the template) is unchanged — it already calls `CHANGE_TYPE_LABEL[entry.changeType]`, `ORIGIN_LABEL[entry.origin]`, and `previewFor(entry)`, which now resolve to the imports instead of local definitions.

- [x] **Step 3: Update `src/pages/admin/queue/[id].astro`**

Remove the local `ORIGIN_LABEL` and `STATUS_LABEL` definitions (currently just after `CHANGE_TYPE_LABEL`, around lines 164-173), keeping the local `CHANGE_TYPE_LABEL` as-is:

```ts
const CHANGE_TYPE_LABEL: Record<QueueChangeType, string> = {
  new: "New listing",
  update: "Update",
  cancellation: "Cancellation",
};
```

Add the import at the top of the frontmatter, alongside the other imports:

```ts
import {
  ORIGIN_LABEL,
  STATUS_LABEL,
} from "../../../lib/utils/moderation-labels";
```

The template's `ORIGIN_LABEL[entry.origin]` and `STATUS_LABEL[entry.status]` references are unchanged.

- [x] **Step 4: Verify nothing broke**

```bash
pnpm exec astro check
```

Expected: no new type errors.

```bash
astro dev --background
```

Open `/admin` and `/admin/queue/<a pending entry's id>` in your browser and confirm both pages render exactly as before (same badge text, same labels).

- [x] **Step 5: Commit**

```bash
git add src/lib/utils/moderation-labels.ts src/pages/admin/index.astro src/pages/admin/queue/\[id\].astro
git commit -m "$(cat <<'EOF'
refactor: extract shared admin queue label/preview helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Approval reason select on the queue detail page

**Files:**

- Modify: `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: `approveNewListing`/`approveListingUpdate`/`approveCancellation`'s new `approvalNote` parameter from Task 3
- Produces: both approve forms submit a `reason` (and, when `reason === "other"`, an `otherReason`) field, resolved server-side into the `approvalNote` string passed to the approve functions

- [x] **Step 1: Add the reason options and import `FormTextarea`'s sibling usage**

`FormSelect` and `FormTextarea` are already imported in this file. Add this constant near the other option arrays (after `weekOfMonthOptions`):

```ts
const approvalReasonOptions = [
  { value: "", label: "No reason provided" },
  { value: "Accurate as submitted", label: "Accurate as submitted" },
  { value: "Accurate after minor edits", label: "Accurate after minor edits" },
  { value: "Verified independently", label: "Verified independently" },
  { value: "other", label: "Other…" },
];
```

- [x] **Step 2: Resolve `approvalNote` in the POST handler**

In the `if (action === "approve")` branch, before the `if (entry.changeType === "new")` check, add:

```ts
const reason = formData.get("reason")?.toString() ?? "";
const otherReason = formData.get("otherReason")?.toString().trim() || null;
const approvalNote = reason === "other" ? otherReason : reason || null;
```

Then change the two calls in that branch:

```ts
if (entry.changeType === "new") {
  await approveNewListing(supabase, entry.id, fields, approvalNote);
} else if (entry.changeType === "update") {
  await approveListingUpdate(
    supabase,
    entry.id,
    entry.listingId!,
    fields,
    approvalNote,
  );
}
```

In the `if (action === "approve_cancellation")` branch, add the same resolution before the `approveCancellation` call and pass it through:

```ts
if (action === "approve_cancellation") {
  const originalDate = formData.get("originalDate")?.toString() ?? "";
  const note = formData.get("note")?.toString() || null;
  const reason = formData.get("reason")?.toString() ?? "";
  const otherReason = formData.get("otherReason")?.toString().trim() || null;
  const approvalNote = reason === "other" ? otherReason : reason || null;
  await approveCancellation(
    supabase,
    entry.id,
    entry.listingId!,
    originalDate,
    note,
    approvalNote,
  );
  return Astro.redirect("/admin");
}
```

- [x] **Step 3: Add the fields to the standard approve form**

In the template, inside the non-cancellation `<form>` (the `else` branch of the `entry.changeType === "cancellation"` ternary), insert this block after the Recurrence `<div>` and before the `<Button type="submit" ...>Approve</Button>`:

```astro
<div class="border-rule flex flex-col gap-4 border-t pt-6">
  <p
    class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
  >
    Approval
  </p>
  <FormSelect
    label="Reason"
    name="reason"
    options={approvalReasonOptions}
    value=""
  />
  <div data-other-reason hidden>
    <FormTextarea label="Other reason" name="otherReason" />
  </div>
</div>
```

- [x] **Step 4: Add the same fields to the cancellation approve form**

In the `entry.changeType === "cancellation"` branch's `<form>`, insert the same block after the `FormTextarea label="Note"` field and before the `<Button type="submit" ...>Approve cancellation</Button>`:

```astro
<div class="border-rule flex flex-col gap-4 border-t pt-6">
  <p
    class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
  >
    Approval
  </p>
  <FormSelect
    label="Reason"
    name="reason"
    options={approvalReasonOptions}
    value=""
  />
  <div data-other-reason hidden>
    <FormTextarea label="Other reason" name="otherReason" />
  </div>
</div>
```

- [x] **Step 5: Add the reveal script**

At the end of the file, after the closing `</AdminLayout>` tag, add:

```astro
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

- [x] **Step 6: Verify manually**

```bash
astro dev --background
```

Sign in at `/admin/login` with a provisioned moderator account, open a pending entry from `/admin`, and confirm:

- The Reason select appears with the four canned options plus "Other…".
- Selecting "Other…" reveals the free-text field; selecting anything else hides it.
- Approving with a canned reason selected succeeds and the entry leaves the queue.

Check server logs for errors:

```bash
astro dev logs
```

- [x] **Step 7: Commit**

```bash
git add src/pages/admin/queue/\[id\].astro
git commit -m "$(cat <<'EOF'
feat: add canned approval-reason select to the queue detail page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The `/admin/archive` page

**Files:**

- Create: `src/pages/admin/archive/index.astro`
- Modify: `src/components/layout/AdminHeader.astro`

**Interfaces:**

- Consumes: `getArchiveEntries` (Task 3), `getModeratorEmails` (Task 4), `CHANGE_TYPE_LABEL`/`ORIGIN_LABEL`/`STATUS_LABEL`/`previewFor` (Task 5)
- Produces: the `/admin/archive` route; a nav link from every other `/admin/*` page

- [ ] **Step 1: Write the page**

Create `src/pages/admin/archive/index.astro`:

```astro
---
import AdminLayout from "../../../layouts/AdminLayout.astro";
import {
  getArchiveEntries,
  type QueueEntry,
} from "../../../lib/data/moderation";
import { getModeratorEmails } from "../../../lib/data/moderators";
import {
  CHANGE_TYPE_LABEL,
  ORIGIN_LABEL,
  STATUS_LABEL,
  previewFor,
} from "../../../lib/utils/moderation-labels";

const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;

const statusFilter = Astro.url.searchParams.get("status") || "";

const entries = await getArchiveEntries(supabase);

const moderatorIds = entries.flatMap((entry) =>
  [entry.approvedBy, entry.proposedBy, entry.confirmedBy].filter(
    (id): id is string => Boolean(id),
  ),
);
const moderatorEmails = await getModeratorEmails(supabase, moderatorIds);

function whoFor(entry: QueueEntry): string {
  if (entry.status === "approved") {
    return entry.approvedBy
      ? (moderatorEmails[entry.approvedBy] ?? "Unknown moderator")
      : "Unknown moderator";
  }
  const proposer = entry.proposedBy
    ? (moderatorEmails[entry.proposedBy] ?? "Unknown moderator")
    : "Unknown moderator";
  const confirmer = entry.confirmedBy
    ? (moderatorEmails[entry.confirmedBy] ?? "Unknown moderator")
    : "Unknown moderator";
  return `Proposed by ${proposer}, confirmed by ${confirmer}`;
}

function whatFor(entry: QueueEntry): string {
  return previewFor({
    correctionNote: entry.correctionNote,
    proposedData:
      entry.status === "approved" ? entry.approvedData : entry.proposedData,
    changeType: entry.changeType,
  });
}

function whyFor(entry: QueueEntry): string {
  if (entry.status === "approved") return entry.approvalNote ?? "—";
  return entry.proposedReason ?? "—";
}

function whenFor(decidedAt: string | null): string {
  if (!decidedAt) return "—";
  return new Date(decidedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const tabs = [
  { value: "", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const rows = entries.map((entry) => ({
  entry,
  hidden: statusFilter !== "" && entry.status !== statusFilter,
}));
---

<AdminLayout
  title="Moderation archive — Crowd Work admin"
  userEmail={user.email}
>
  <div class="border-rule border-b pt-8 pb-5">
    <h1 class="font-display text-[1.28rem] font-bold">Moderation archive</h1>
    <p class="text-ink-soft mt-2 text-[0.95rem]">
      Every decided entry — who acted, what was written, and why.
    </p>
  </div>

  <form
    method="get"
    id="archive-filter"
    class="border-rule flex gap-1.5 border-b py-5"
    role="group"
    aria-label="Filter by status"
  >
    {
      tabs.map((tab) => {
        const pressed = statusFilter === tab.value;
        return (
          <button
            type="submit"
            name="status"
            value={tab.value}
            aria-pressed={pressed}
            class:list={[
              "font-display cursor-pointer rounded-sm border px-4 py-1.75 text-[0.95rem] font-bold tracking-wide uppercase",
              pressed
                ? "border-ink bg-ink text-paper"
                : "border-rule text-ink-soft bg-transparent",
            ]}
          >
            {tab.label}
          </button>
        );
      })
    }
  </form>

  {
    entries.length === 0 ? (
      <p class="text-ink-soft py-10 text-[0.95rem]">
        Nothing has been decided yet.
      </p>
    ) : (
      <ul class="m-0 list-none p-0">
        {rows.map(({ entry, hidden }) => (
          <li
            data-archive-row
            data-status={entry.status}
            hidden={hidden}
            class="border-rule flex flex-col gap-1.5 border-b py-5"
          >
            <div class="flex flex-wrap items-center gap-3">
              <span class="border-rule font-body text-ink-soft rounded-sm border px-1.5 py-px text-[0.65rem] font-semibold tracking-wider uppercase">
                {CHANGE_TYPE_LABEL[entry.changeType]}
              </span>
              <span class="text-[0.95rem] font-medium">
                {STATUS_LABEL[entry.status]}
              </span>
              <span class="text-ink-soft text-[0.82rem]">
                {ORIGIN_LABEL[entry.origin] ?? entry.origin} ·{" "}
                {whenFor(entry.decidedAt)}
              </span>
            </div>
            <p class="text-[0.9rem]">{whatFor(entry)}</p>
            <p class="text-ink-soft text-[0.82rem]">{whoFor(entry)}</p>
            <p class="text-ink-soft text-[0.82rem] italic">{whyFor(entry)}</p>
          </li>
        ))}
      </ul>
    )
  }
</AdminLayout>

<script>
  const form = document.getElementById(
    "archive-filter",
  ) as HTMLFormElement | null;
  if (form) {
    const buttons = Array.from(
      form.querySelectorAll<HTMLButtonElement>('button[name="status"]'),
    );
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-archive-row]"),
    );
    let activeStatus =
      buttons.find((btn) => btn.getAttribute("aria-pressed") === "true")
        ?.value ?? "";

    function applyFilter() {
      for (const row of rows) {
        row.hidden = activeStatus !== "" && row.dataset.status !== activeStatus;
      }
    }

    function setActive(value: string) {
      activeStatus = value;
      for (const btn of buttons) {
        const pressed = btn.value === value;
        btn.setAttribute("aria-pressed", String(pressed));
        btn.classList.toggle("border-ink", pressed);
        btn.classList.toggle("bg-ink", pressed);
        btn.classList.toggle("text-paper", pressed);
        btn.classList.toggle("border-rule", !pressed);
        btn.classList.toggle("bg-transparent", !pressed);
        btn.classList.toggle("text-ink-soft", !pressed);
      }
    }

    for (const button of buttons) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        setActive(button.value);
        applyFilter();
        const url = new URL(window.location.href);
        if (activeStatus) url.searchParams.set("status", activeStatus);
        else url.searchParams.delete("status");
        window.history.pushState({}, "", url);
      });
    }

    applyFilter();
  }
</script>
```

- [ ] **Step 2: Add the nav link**

Modify `src/components/layout/AdminHeader.astro`. In the `userEmail &&` block, add an Archive link before the existing "Log out" link:

```astro
{
  userEmail && (
    <div class="font-body text-ink-soft flex items-center gap-4.5 text-[0.86rem]">
      <span class="max-[480px]:hidden">{userEmail}</span>
      <a
        href="/admin/archive"
        class="hover:text-ink underline-offset-2 hover:underline"
      >
        Archive
      </a>
      <a
        href="/admin/logout"
        class="hover:text-ink underline-offset-2 hover:underline"
      >
        Log out
      </a>
    </div>
  )
}
```

- [ ] **Step 3: Verify manually**

```bash
astro dev --background
```

Sign in and open `/admin/archive`. Confirm:

- The page loads with no entries yet (if you haven't approved/rejected anything locally).
- The All / Approved / Rejected tabs render with "All" pressed by default.

```bash
astro dev logs
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/archive src/components/layout/AdminHeader.astro
git commit -m "$(cat <<'EOF'
feat: add /admin/archive with a progressively-enhanced status filter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end manual verification

**Files:** none — this task exercises the running app in a real browser, not headless automation.

- [ ] **Step 1: Reset and provision**

```bash
supabase db reset
node scripts/provision-moderators.mjs mod1@crowdwork.test <password1> mod2@crowdwork.test <password2>
astro dev --background
```

- [ ] **Step 2: Walk one entry to Approved**

Sign in as moderator 1 at `/admin/login`. Open the seeded `new` entry from `/admin`, select the "Verified independently" reason, and approve it.

- [ ] **Step 3: Walk one entry to Rejected**

As moderator 1, propose rejection on a different pending entry with a reason. Log out, sign in as moderator 2, confirm the rejection from its detail page.

- [ ] **Step 4: Check the archive**

Open `/admin/archive`. Confirm:

- Both the approved and rejected entries appear, most recent first.
- The approved row shows moderator 1's email as "who" and "Verified independently" as "why".
- The rejected row shows "Proposed by <moderator 1's email>, confirmed by <moderator 2's email>" and the rejection reason as "why".
- Clicking "Approved" hides the rejected row and vice versa; clicking "All" shows both.
- Reload the page with `?status=approved` directly in the URL bar (no JS interaction) and confirm only the approved row renders — this is the no-JS fallback path.

- [ ] **Step 5: Confirm the RLS forgery tests still hold outside Vitest**

This is already covered by Task 3's automated tests; no separate manual step needed here beyond re-running the suite once more for confidence:

```bash
pnpm test
```

Expected: all tests pass.
