# Moderator Listing Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give moderators a real, auth-gated way to edit a published listing's fields directly at `/admin/listings/edit/[id]` — self-approved and immediate, like `directAddListing` and `archiveListing` — and retire the spoofable `context=moderator` reuse of the public "Report a problem" form that currently backs the direct-add success card's "Edit this listing" link.

**Architecture:** A new `moderation_queue` INSERT policy lets an authenticated moderator insert an already-`approved` `update` entry (mirroring the existing direct-add and archive policies). `src/lib/data/moderation.ts` gains a shared `applyListingFields()` helper (extracted from `approveListingUpdate`, so the direct and queue-approved update paths share one implementation) and a shared `listingToProposedFields()` mapper (extracted from `getPrefillForEntry`'s report-form fallback), plus a new `directUpdateListing()` write-through function built on both. A new page `/admin/listings/edit/[id].astro` uses them, reachable from the direct-add success card and a new per-row link on `/admin/listings`. `report.astro` is simplified back to a single public identity.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase), Tailwind (existing `DESIGN.md` tokens/components only — no new ones).

**Spec:** [docs/superpowers/specs/2026-09-06-moderator-listing-edit-design.md](../specs/2026-09-06-moderator-listing-edit-design.md)

## Global Constraints

- Every direct-edit queue entry is inserted directly as `status: "approved"` — never `"pending"`. Editing is single-moderator and immediate, like `directAddListing`/`archiveListing`; no propose/confirm ceremony.
- `proposed_data` is always `null` on a direct-edit entry (nothing is "proposed," it's already decided); `approved_data` always carries the submitted fields.
- No RLS changes on `listings` or `recurrence_rules` — editing never touches `listings.status`, so it doesn't hit the SELECT-vs-UPDATE-result gap archiving hit.
- No new UI color or `Button` variant — reuses the existing `outline`/`primary` variants.
- `report.astro` loses `isModeratorContext` entirely, collapsing back to a single public "Report a problem" identity with no query-param-driven copy.
- No second-moderator confirmation, no diff/preview step before saving, no general listings CRUD UI beyond what's needed — explicit non-goals in the spec.

---

## File Structure

```
crowd-work/
├── supabase/
│   └── migrations/
│       └── <timestamp>_moderator_direct_edit_queue_insert_policy.sql   # new
├── src/
│   ├── lib/
│   │   ├── data/
│   │   │   ├── moderation.ts                    # modified: applyListingFields, listingToProposedFields, directUpdateListing
│   │   │   ├── moderation-parse.test.ts         # modified: listingToProposedFields tests
│   │   │   └── moderation-direct-edit.test.ts   # new
│   │   └── utils/
│   │       └── moderation-labels.ts             # modified: ORIGIN_LABEL entry
│   └── pages/
│       ├── admin/
│       │   └── listings/
│       │       ├── index.astro                  # modified: per-row Edit link
│       │       ├── new/index.astro               # modified: repointed "Edit this listing" link
│       │       └── edit/
│       │           └── [id].astro               # new
│       └── listings/
│           └── [id]/
│               └── report.astro                 # modified: isModeratorContext removed
```

---

### Task 1: Migration — `moderator_direct_edit` queue insert policy

**Files:**

- Create: `supabase/migrations/<timestamp>_moderator_direct_edit_queue_insert_policy.sql`

**Interfaces:**

- Consumes: `moderation_queue` as it exists today (no enum or column changes needed — `update` is already a valid `change_type`, and `origin` is a free-text column)
- Produces: a permissive INSERT policy allowing an authenticated moderator to insert a pre-approved `update` entry — consumed by Task 4's `directUpdateListing`

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new moderator_direct_edit_queue_insert_policy
```

- [x] **Step 2: Write the migration**

Open the generated file and write:

```sql
-- Moderators have only ever inserted a pre-approved queue row for a
-- moderator_direct_add 'new' listing (20260904182818) or a
-- moderator_archive/system_recovery 'archive' entry (20260907030344).
-- Direct editing needs its own equivalent permissive INSERT policy —
-- without one, no permissive policy on moderation_queue covers an
-- 'update'-shaped row inserted (rather than transitioned from 'pending')
-- by an authenticated moderator.
--
-- No RLS change is needed on `listings` or `recurrence_rules` here: unlike
-- archiving, editing never touches `listings.status`, so it never triggers
-- the SELECT-vs-UPDATE-result mismatch documented in
-- notes/archive-status-rls-gap.md.
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

- [x] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `moderator_direct_edit_queue_insert_policy` apply with no errors. No `database.types.ts` regeneration is needed — RLS policies aren't reflected in generated types (unlike an enum or column addition).

- [x] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "$(cat <<'EOF'
feat: add RLS policy for direct moderator listing edits

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `applyListingFields()` from `approveListingUpdate`

**Files:**

- Modify: `src/lib/data/moderation.ts`

**Interfaces:**

- Consumes: the existing private `resolveVenueId(client, fields)` helper; `ProposedListingFields` type
- Produces: `async function applyListingFields(client: SupabaseClient<Database>, listingId: string, fields: ProposedListingFields): Promise<{ venueId: string }>` (module-private, not exported) — consumed by Task 4's `directUpdateListing`

This is a pure refactor — no behavior change, so it's verified by the existing `approveListingUpdate` test coverage staying green, not a new failing test.

- [x] **Step 1: Run the existing tests to confirm the baseline is green**

```bash
pnpm test moderation-approve
```

Expected: PASS (2 tests under `describe("approveListingUpdate", ...)`).

- [x] **Step 2: Extract the function**

In `src/lib/data/moderation.ts`, replace the current `approveListingUpdate`:

```ts
export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
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

  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };
  await markApproved(client, entryId, listingId, approvedData, approvalNote);
}
```

with:

```ts
// Shared by approveListingUpdate (queue-review path) and directUpdateListing
// (moderator direct-edit path) — the only difference between the two is how
// the resulting moderation_queue row is recorded, not how a listing's fields
// get written.
async function applyListingFields(
  client: SupabaseClient<Database>,
  listingId: string,
  fields: ProposedListingFields,
): Promise<{ venueId: string }> {
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

export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const { venueId } = await applyListingFields(client, listingId, fields);
  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };
  await markApproved(client, entryId, listingId, approvedData, approvalNote);
}
```

- [x] **Step 3: Run the tests to verify no regression**

```bash
pnpm test moderation-approve
```

Expected: PASS — same 2 tests, unchanged behavior.

- [x] **Step 4: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 5: Commit**

```bash
git add src/lib/data/moderation.ts
git commit -m "$(cat <<'EOF'
refactor: extract applyListingFields from approveListingUpdate

Shares the listing/recurrence write logic with the upcoming direct-edit
path instead of duplicating it, matching how listing creation already
shares createListingFromFields between its direct and queue-approved
paths.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `listingToProposedFields()` from `getPrefillForEntry`

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-parse.test.ts`

**Interfaces:**

- Consumes: `ListingWithVenue` type from `./listings`
- Produces: `export function listingToProposedFields(listing: ListingWithVenue): ProposedListingFields` — consumed by Task 5's new edit page and by `getPrefillForEntry`

- [x] **Step 1: Write the failing tests**

Append to `src/lib/data/moderation-parse.test.ts`:

```ts
import { listingToProposedFields } from "./moderation";
import type { ListingWithVenue } from "./listings";
```

(add these to the top, alongside the existing `parseProposedListingFields` import)

```ts
describe("listingToProposedFields", () => {
  it("maps a recurring listing's current values, with newVenue null", () => {
    const listing: ListingWithVenue = {
      id: "d0000000-0000-0000-0000-000000000001",
      type: "mic",
      title: "The Weekly Mic",
      host: "Jane Host",
      description: "A great mic.",
      startTime: "20:00",
      signUpMethod: "Sign-up list at the door",
      costToPerform: "Free",
      ticketPrice: null,
      ticketUrl: null,
      venue: {
        id: "c0000000-0000-0000-0000-000000000001",
        name: "The Virgil",
        address: "4519 Santa Monica Blvd, Los Angeles, CA",
        googleMapsUrl: null,
        neighborhoodId: "b0000000-0000-0000-0000-000000000001",
        areaIds: ["a0000000-0000-0000-0000-000000000001"],
      },
      recurrenceRule: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
      },
      oneOffDate: null,
    };

    expect(listingToProposedFields(listing)).toEqual({
      type: "mic",
      title: "The Weekly Mic",
      host: "Jane Host",
      description: "A great mic.",
      venueId: "c0000000-0000-0000-0000-000000000001",
      newVenue: null,
      startTime: "20:00",
      signUpMethod: "Sign-up list at the door",
      costToPerform: "Free",
      ticketPrice: null,
      ticketUrl: null,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
      },
      oneOffDate: null,
    });
  });

  it("carries through a null recurrence for a one-off listing", () => {
    const listing: ListingWithVenue = {
      id: "d0000000-0000-0000-0000-000000000002",
      type: "show",
      title: "One Night Only",
      host: null,
      description: null,
      startTime: "21:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: "$15",
      ticketUrl: "https://example.com/tickets",
      venue: {
        id: "c0000000-0000-0000-0000-000000000001",
        name: "The Virgil",
        address: "4519 Santa Monica Blvd, Los Angeles, CA",
        googleMapsUrl: null,
        neighborhoodId: "b0000000-0000-0000-0000-000000000001",
        areaIds: ["a0000000-0000-0000-0000-000000000001"],
      },
      recurrenceRule: null,
      oneOffDate: "2026-10-01",
    };

    const result = listingToProposedFields(listing);
    expect(result.recurrence).toBeNull();
    expect(result.oneOffDate).toBe("2026-10-01");
    expect(result.newVenue).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-parse
```

Expected: FAIL — `listingToProposedFields` is not exported yet.

- [x] **Step 3: Implement `listingToProposedFields` and refactor `getPrefillForEntry`**

In `src/lib/data/moderation.ts`, update the import at the top of the file:

```ts
import { getListingById } from "./listings";
```

becomes:

```ts
import { getListingById, type ListingWithVenue } from "./listings";
```

Then replace the current `getPrefillForEntry`:

```ts
export async function getPrefillForEntry(
  entry: QueueEntry,
): Promise<ProposedListingFields | null> {
  if (entry.changeType === "new") {
    return entry.proposedData as ProposedListingFields;
  }

  if (entry.changeType !== "update") return null;

  if (entry.proposedData) {
    return entry.proposedData as ProposedListingFields;
  }

  const current = await getListingById(entry.listingId!);
  if (!current) return null;

  return {
    type: current.type,
    title: current.title,
    host: current.host,
    description: current.description,
    venueId: current.venue.id,
    newVenue: null,
    startTime: current.startTime,
    signUpMethod: current.signUpMethod,
    costToPerform: current.costToPerform,
    ticketPrice: current.ticketPrice,
    ticketUrl: current.ticketUrl,
    recurrence: current.recurrenceRule,
    oneOffDate: current.oneOffDate,
  };
}
```

with:

```ts
export function listingToProposedFields(
  listing: ListingWithVenue,
): ProposedListingFields {
  return {
    type: listing.type,
    title: listing.title,
    host: listing.host,
    description: listing.description,
    venueId: listing.venue.id,
    newVenue: null,
    startTime: listing.startTime,
    signUpMethod: listing.signUpMethod,
    costToPerform: listing.costToPerform,
    ticketPrice: listing.ticketPrice,
    ticketUrl: listing.ticketUrl,
    recurrence: listing.recurrenceRule,
    oneOffDate: listing.oneOffDate,
  };
}

export async function getPrefillForEntry(
  entry: QueueEntry,
): Promise<ProposedListingFields | null> {
  if (entry.changeType === "new") {
    return entry.proposedData as ProposedListingFields;
  }

  if (entry.changeType !== "update") return null;

  if (entry.proposedData) {
    return entry.proposedData as ProposedListingFields;
  }

  const current = await getListingById(entry.listingId!);
  if (!current) return null;

  return listingToProposedFields(current);
}
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
pnpm test moderation-parse
```

Expected: PASS.

- [x] **Step 5: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions (this also exercises `getPrefillForEntry` indirectly via `moderation-transitions.test.ts` and the queue page, if covered there).

- [x] **Step 6: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-parse.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract listingToProposedFields from getPrefillForEntry

Pulls the listing-to-ProposedListingFields mapping out of
getPrefillForEntry's report-form fallback branch so the upcoming direct-edit
page can reuse it instead of a third inline copy appearing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `directUpdateListing()` write-through function

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/utils/moderation-labels.ts`
- Create: `src/lib/data/moderation-direct-edit.test.ts`

**Interfaces:**

- Consumes: Task 1's RLS policy; Task 2's `applyListingFields(client, listingId, fields)`; the already-exported `parseProposedListingFields`, `findMissingRequiredFields`, `findMissingReason`, `parseApprovalNote`, `MissingRequiredFieldsError`; `createAdminClient`/`signInTestModerator` from `moderation-test-helpers.ts`
- Produces: `export async function directUpdateListing(client: SupabaseClient<Database>, listingId: string, formData: FormData): Promise<void>` — consumed by Task 5's new page

- [x] **Step 1: Write the failing tests**

Create `src/lib/data/moderation-direct-edit.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { directUpdateListing, MissingRequiredFieldsError } from "./moderation";
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
      start_time: "18:00",
      one_off_date: "2026-09-15",
      status: "published",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedListingIds.push(data.id);
  return data.id as string;
}

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("directUpdateListing", () => {
  it("updates the listing and records a self-approved 'update' queue entry", async () => {
    const listingId = await createTempListing(
      "Temp Listing For directUpdateListing Test",
    );
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const formData = buildFormData({
      type: "mic",
      title: "Temp Listing For directUpdateListing Test",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:30",
      reason: "Time corrected after a call with the venue",
    });

    await directUpdateListing(moderator1, listingId, formData);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("start_time")
      .eq("id", listingId)
      .single();
    expect(listing!.start_time).toBe("20:30:00");

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, proposed_data, approved_data, approval_note, decided_at",
      )
      .eq("listing_id", listingId)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("update");
    expect(entry!.origin).toBe("moderator_direct_edit");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.proposed_data).toBeNull();
    expect((entry!.approved_data as { startTime: string }).startTime).toBe(
      "20:30",
    );
    expect(entry!.approval_note).toBe(
      "Time corrected after a call with the venue",
    );
    expect(entry!.decided_at).not.toBeNull();
  });

  it("throws MissingRequiredFieldsError when a required field is missing", async () => {
    const listingId = await createTempListing(
      "Temp Listing For Missing Field Test",
    );
    const moderator1 = await signInTestModerator(1);

    const formData = buildFormData({
      type: "mic",
      title: "",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:30",
      reason: "Fixing a typo",
    });

    await expect(
      directUpdateListing(moderator1, listingId, formData),
    ).rejects.toBeInstanceOf(MissingRequiredFieldsError);
  });
});

describe("moderator_direct_edit RLS", () => {
  it("rejects an authenticated insert that isn't already approved", async () => {
    const moderator1 = await signInTestModerator(1);
    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "update",
      origin: "moderator_direct_edit",
      status: "pending",
      approved_data: { title: "Sneaking in as pending" },
    });
    expect(error).not.toBeNull();
  });

  it("rejects attributing the approval to a different moderator", async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    const {
      data: { user: moderator2User },
    } = await moderator2.auth.getUser();

    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "update",
      origin: "moderator_direct_edit",
      status: "approved",
      approved_by: moderator2User!.id,
      decided_at: new Date().toISOString(),
      approved_data: { title: "Forged approver" },
    });
    expect(error).not.toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-direct-edit
```

Expected: the two RLS tests PASS already (Task 1's policy is applied); the `directUpdateListing` tests FAIL because the function doesn't exist yet.

- [x] **Step 3: Implement `directUpdateListing()`**

In `src/lib/data/moderation.ts`, add the following function after `directAddListing`:

```ts
// The direct-edit counterpart to directAddListing/archiveListing: a single
// moderator edits a published listing's fields immediately, self-approved,
// with no propose/confirm ceremony. Shares applyListingFields() with the
// queue-approval path (approveListingUpdate) so there's one implementation
// of "how to write a listing's fields."
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
    throw new Error(
      `Listing was updated, but the audit record failed to save: ${error.message}`,
    );
}
```

- [x] **Step 4: Add the origin label**

In `src/lib/utils/moderation-labels.ts`, add to `ORIGIN_LABEL`:

```ts
export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
  submission_form: "Public submission",
  moderator_direct_add: "Direct add",
  source_check: "Automated source check",
  moderator_archive: "Archived by moderator",
  system_recovery: "Automatic (recovery)",
  moderator_direct_edit: "Direct edit",
};
```

- [x] **Step 5: Run the tests to verify they pass**

```bash
pnpm test moderation-direct-edit
```

Expected: PASS — all 4 tests.

- [x] **Step 6: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-direct-edit.test.ts src/lib/utils/moderation-labels.ts
git commit -m "$(cat <<'EOF'
feat: let moderators directly edit a listing's fields

Adds directUpdateListing, modeled on directAddListing/archiveListing:
single-moderator, immediate, self-approved, with a full audit trail
in moderation_queue.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The `/admin/listings/edit/[id]` page

**Files:**

- Create: `src/pages/admin/listings/edit/[id].astro`

**Interfaces:**

- Consumes: `getListingById`, `getVenues`, `getNeighborhoods` (`../../../../lib/data/listings`); `directUpdateListing`, `listingToProposedFields`, `MissingRequiredFieldsError` (`../../../../lib/data/moderation`); `APPROVAL_REASON_HINT`, `APPROVAL_REASON_OPTIONS` (`../../../../lib/utils/moderation-labels`); `ListingFieldsFields`, `Button`, `FormSelect`, `FormTextarea`, `AdminUtilityBar`, `AdminLayout` components
- Produces: the route `/admin/listings/edit/[id]` — consumed by Task 6's link changes

Auth is handled for free by the existing `/admin` prefix check in `src/middleware.ts` — no page-level auth code needed.

- [x] **Step 1: Write the page**

Create `src/pages/admin/listings/edit/[id].astro`:

```astro
---
import Button from "../../../../components/forms/Button.astro";
import FormSelect from "../../../../components/forms/FormSelect.astro";
import FormTextarea from "../../../../components/forms/FormTextarea.astro";
import AdminUtilityBar from "../../../../components/layout/AdminUtilityBar.astro";
import ListingFieldsFields from "../../../../components/moderation/ListingFieldsFields.astro";
import AdminLayout from "../../../../layouts/AdminLayout.astro";
import {
  getListingById,
  getNeighborhoods,
  getVenues,
} from "../../../../lib/data/listings";
import {
  directUpdateListing,
  listingToProposedFields,
  MissingRequiredFieldsError,
} from "../../../../lib/data/moderation";
import {
  APPROVAL_REASON_HINT,
  APPROVAL_REASON_OPTIONS,
} from "../../../../lib/utils/moderation-labels";

const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;

const { id } = Astro.params;
if (!id) {
  return Astro.redirect("/admin/listings");
}

const listing = await getListingById(id);
if (!listing) {
  return Astro.redirect("/admin/listings");
}

const [venues, neighborhoods] = await Promise.all([
  getVenues(),
  getNeighborhoods(),
]);

let errorMessage: string | null = null;
let fieldErrors: Record<string, string> = {};
let submittedReason = "";
let submittedOtherReason = "";

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  submittedReason = formData.get("reason")?.toString() ?? "";
  submittedOtherReason = formData.get("otherReason")?.toString() ?? "";
  try {
    await directUpdateListing(supabase, listing.id, formData);
    return Astro.redirect(`/admin/listings/edit/${listing.id}?updated=1`);
  } catch (error) {
    if (error instanceof MissingRequiredFieldsError) {
      errorMessage = "Please fix the highlighted fields below.";
      fieldErrors = Object.fromEntries(
        error.fields.map(({ field }) => [field, "Required."]),
      );
    } else {
      errorMessage =
        error instanceof Error ? error.message : "Something went wrong.";
    }
  }
}

const justUpdated = Astro.url.searchParams.get("updated") === "1";

const venueOptions = venues.map((venue) => ({
  value: venue.id,
  label: venue.name,
}));
const neighborhoodOptions = neighborhoods.map((neighborhood) => ({
  value: neighborhood.id,
  label: neighborhood.name,
}));
---

<AdminLayout
  title={`Edit — ${listing.title} — Crowd Work admin`}
  userEmail={user.email}
>
  <AdminUtilityBar backHref="/admin/listings" backLabel="Back to listings" />

  <div
    class="border-l-rule bg-paper-shadow max-w-form mt-5 rounded-sm border-l-[3px] px-5 py-6 sm:px-7 sm:py-7"
  >
    <h1 class="font-display text-[1.28rem] font-bold">Edit listing</h1>
    <p class="text-ink-soft mt-1.5 text-[0.86rem]">{listing.title}</p>

    {
      justUpdated && (
        <p
          role="status"
          class="bg-paper mt-5 rounded-sm border-l-[3px] border-l-[color-mix(in_srgb,var(--gold)_60%,var(--paper)_40%)] px-3.5 py-2.5 text-[0.86rem] font-medium"
        >
          Saved.
        </p>
      )
    }

    {
      errorMessage && (
        <p
          role="alert"
          class="border-l-error text-error bg-paper mt-5 rounded-sm border-l-[3px] px-3.5 py-2.5 text-[0.86rem] font-medium"
        >
          <strong>Error:</strong> {errorMessage}
        </p>
      )
    }

    <form method="post" novalidate class="mt-6 flex flex-col gap-6">
      <ListingFieldsFields
        prefill={listingToProposedFields(listing)}
        venueOptions={venueOptions}
        neighborhoodOptions={neighborhoodOptions}
        fieldErrors={fieldErrors}
      />

      <div
        class="flex flex-col gap-4 border-l-[3px] border-l-[color-mix(in_srgb,var(--gold)_60%,var(--paper)_40%)] pl-4"
      >
        <p
          class="font-body text-ink-soft text-[0.72rem] font-semibold tracking-wider uppercase"
        >
          Approval
        </p>
        <FormSelect
          label="Reason"
          name="reason"
          options={APPROVAL_REASON_OPTIONS}
          value={submittedReason}
          required
          error={fieldErrors.reason}
          hint={APPROVAL_REASON_HINT}
        />
        <div data-other-reason hidden={submittedReason !== "other"}>
          <FormTextarea
            label="Other reason"
            name="otherReason"
            value={submittedOtherReason}
            required
            error={fieldErrors.otherReason}
          />
        </div>
      </div>

      <p class="text-ink-soft text-[0.78rem]">
        Saves immediately, under your account — no second review.
      </p>

      <div
        class="bg-paper-shadow border-rule sticky bottom-0 z-10 -mx-5 -mb-6 rounded-b-sm border-t px-5 py-4 sm:-mx-7 sm:-mb-7 sm:px-7"
      >
        <Button type="submit" variant="primary" busyLabel="Saving…">
          Save changes
        </Button>
      </div>
    </form>
  </div>
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

Note: on a validation error, the base listing fields re-render from the listing's stored values (via `listingToProposedFields(listing)`), not from the failed submission — the submitted `reason`/`otherReason` are preserved, but a rejected title/venue edit would need to be re-typed. This mirrors `/admin/listings/new`'s existing behavior on error (`prefill={null}` there discards the failed submission too) — not a new gap introduced here.

- [x] **Step 2: Run the full test suite**

```bash
pnpm test
```

Expected: PASS (this page has no automated tests — Astro pages are verified manually in this project, per Task 8).

- [x] **Step 3: Verify manually**

```bash
astro dev --background
```

Sign in as a moderator, navigate to `/admin/listings/edit/<id>` for any published listing, and confirm the form is prefilled with its current values. Leave this running for Task 6.

- [x] **Step 4: Commit**

```bash
git add src/pages/admin/listings/edit/
git commit -m "$(cat <<'EOF'
feat: add /admin/listings/edit/[id] page

Auth-gated by the existing /admin middleware check. Prefills
ListingFieldsFields from the listing's current values and saves via
directUpdateListing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Repoint the edit entry points

**Files:**

- Modify: `src/pages/admin/listings/new/index.astro`
- Modify: `src/pages/admin/listings/index.astro`

**Interfaces:**

- Consumes: the `/admin/listings/edit/[id]` route from Task 5
- Produces: none — terminal UI wiring

- [x] **Step 1: Repoint the direct-add success card's "Edit this listing" link**

In `src/pages/admin/listings/new/index.astro`, replace:

```astro
<Button
  href={`/listings/${added.listingId}/report?context=moderator`}
  variant="outline"
>
  Edit this listing
</Button>
```

with:

```astro
<Button href={`/admin/listings/edit/${added.listingId}`} variant="outline">
  Edit this listing
</Button>
```

- [x] **Step 2: Add a per-row "Edit" link on `/admin/listings`**

In `src/pages/admin/listings/index.astro`, replace the whole `<li>` block (from `<li class="border-rule ...">` through its closing `</li>`) with:

```astro
<li class="border-rule flex flex-col gap-3 border-b py-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <p class="text-[0.95rem] font-medium">{listing.title}</p>
      <p class="text-ink-soft text-[0.82rem]">
        {typeLabel} · {listing.venue.name}
      </p>
    </div>
    <div class="flex items-center gap-3">
      <Button href={`/admin/listings/edit/${listing.id}`} variant="outline">
        Edit
      </Button>
      <details open={rowHasError}>
        <summary
          class="font-display text-ink-soft hover:text-ink inline-block cursor-pointer text-[0.82rem] font-bold tracking-wide uppercase [&::-webkit-details-marker]:hidden"
        >
          Archive
        </summary>
        <form
          method="post"
          novalidate
          class="max-w-form-compact mt-3 flex flex-col gap-4"
        >
          <input type="hidden" name="listingId" value={listing.id} />

          {
            rowHasError && errorMessage && (
              <p
                role="alert"
                class="border-l-error text-error bg-paper rounded-sm border-l-[3px] px-3.5 py-2.5 text-[0.86rem] font-medium"
              >
                <strong>Error:</strong> {errorMessage}
              </p>
            )
          }

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
              error={rowHasError ? fieldErrors.otherReason : undefined}
            />
          </div>

          <Button type="submit" variant="outline" busyLabel="Archiving…">
            Archive this listing
          </Button>
        </form>
      </details>
    </div>
  </div>
</li>
```

The only changes from the original: a new `<div class="flex items-center gap-3">` now wraps the "Edit" `Button` and the existing `<details>` disclosure (which is otherwise untouched, just re-indented one level deeper), with a matching closing `</div>` added right after `</details>`.

- [x] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: PASS, no regressions.

- [x] **Step 4: Verify manually**

With the dev server still running from Task 5:

1. Open `/admin/listings`, confirm each row now shows an "Edit" link next to "Archive", and it navigates to the correct listing's edit page.
2. Direct-add a new listing, confirm the success card's "Edit this listing" link goes to `/admin/listings/edit/<id>` and loads prefilled.

- [x] **Step 5: Commit**

```bash
git add src/pages/admin/listings/new/index.astro src/pages/admin/listings/index.astro
git commit -m "$(cat <<'EOF'
feat: link to the new edit page from listings admin UI

Repoints the direct-add success card's "Edit this listing" link and
adds a per-row "Edit" link on /admin/listings, both to
/admin/listings/edit/[id].

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Retire the spoofable `report.astro` moderator context

**Files:**

- Modify: `src/pages/listings/[id]/report.astro`

**Interfaces:** none — this task only removes code.

- [x] **Step 1: Remove `isModeratorContext` and its copy branches**

In `src/pages/listings/[id]/report.astro`, remove:

<!-- prettier-ignore -->
```astro
// A moderator arrives here from the direct-add success card's "Edit this
// listing" link, not as an anonymous visitor — same form and same queue
// path (still reviewed like any other update), but the copy shouldn't
// address them as a stranger reporting someone else's mistake.
const isModeratorContext = Astro.url.searchParams.get("context") === "moderator";
```

Replace the title block:

```astro
<title>
  {
    isModeratorContext
      ? `Edit listing — ${listing.title} — Crowd Work admin`
      : `Report a problem — ${listing.title} — Crowd Work`
  }
</title>
```

with:

```astro
<title>Report a problem — {listing.title} — Crowd Work</title>
```

Replace the submitted-state heading and body:

```astro
<h1 class="font-display text-[1.28rem] font-bold">
  {
    isModeratorContext
      ? "Submitted for review."
      : "Thanks — a moderator will review this shortly."
  }
</h1>
<p class="text-ink-soft mt-2.5 max-w-[45ch] text-[0.95rem]">
  {
    isModeratorContext
      ? "It's in the queue as a pending update, same as any other correction. Approve it from there whenever you're ready."
      : "Crowd Work listings are reviewed by working comics, not one person's spreadsheet — reports like yours are how the list stays accurate."
  }
</p>
```

with:

```astro
<h1 class="font-display text-[1.28rem] font-bold">
  Thanks — a moderator will review this shortly.
</h1>
<p class="text-ink-soft mt-2.5 max-w-[45ch] text-[0.95rem]">
  Crowd Work listings are reviewed by working comics, not one person's
  spreadsheet — reports like yours are how the list stays accurate.
</p>
```

Replace the form heading and subtitle:

```astro
<h1 class="font-display text-[1.28rem] font-bold">
  {isModeratorContext ? "Edit this listing" : "Report a problem"}
</h1>
<p class="text-ink-soft mt-1.5 text-[0.9rem]">
  {isModeratorContext ? listing.title : `with ${listing.title}`}
</p>
```

with:

```astro
<h1 class="font-display text-[1.28rem] font-bold">Report a problem</h1>
<p class="text-ink-soft mt-1.5 text-[0.9rem]">
  with {listing.title}
</p>
```

Replace the fieldset legend:

```astro
<legend
  class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
>
  {isModeratorContext ? "What needs to change?" : "What's wrong?"}
</legend>
```

with:

```astro
<legend
  class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
>
  What's wrong?
</legend>
```

Replace the submit button label:

```astro
<Button type="submit" variant="primary" class="self-start">
  {isModeratorContext ? "Submit correction" : "Submit report"}
</Button>
```

with:

```astro
<Button type="submit" variant="primary" class="self-start">
  Submit report
</Button>
```

- [x] **Step 2: Run the full test suite**

```bash
pnpm test
```

Expected: PASS — no existing test references `isModeratorContext` or `context=moderator` (confirmed: neither string appears in any `*.test.ts` or `e2e/*.spec.ts` file).

- [x] **Step 3: Verify manually**

With the dev server still running:

1. Visit `/listings/<id>/report` directly (no query param) — confirm it still works exactly as before: "Report a problem" heading, "What's wrong?" legend, "Submit report" button.
2. Visit `/listings/<id>/report?context=moderator` — confirm the copy is now identical to the plain version (the query param no longer does anything).

- [x] **Step 4: Commit**

```bash
git add src/pages/listings/\[id\]/report.astro
git commit -m "$(cat <<'EOF'
fix: retire spoofable moderator context on the report form

isModeratorContext was driven by an unauthenticated query param on a
page with no auth check at all, so anyone could see moderator-flavored
copy by appending ?context=moderator — and even genuine moderator
edits went through the slow pending-review queue rather than applying
immediately. Moderators now use /admin/listings/edit/[id] instead,
which is auth-gated for free and applies changes directly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end manual verification

**Files:** none — verification only.

**Interfaces:** none.

- [x] **Step 1: Full moderator flow**

With the dev server still running (`astro dev --background` from Task 5), sign in as a moderator and:

1. Direct-add a new listing from `/admin/listings/new`. On the success card, click "Edit this listing" — confirm it lands on `/admin/listings/edit/<id>` with the form fully prefilled.
2. Change the start time and add a reason, click "Save changes" — confirm the redirect back to the same edit page shows a "Saved." banner and the form still reflects the new value.
3. Submit the form again with the title cleared — confirm the inline "Required." error on the title field and that the reason/other-reason values you'd entered are preserved.
4. Submit with a field filled in but no reason chosen — confirm the inline reason error.
5. Open `/admin/listings`, confirm the listing you just edited shows an "Edit" link, and that it opens the same prefilled page.
6. Open `/admin/archive`, confirm an "Update" entry appears for the edit, with origin "Direct edit" and the correct who/why/when.

- [x] **Step 2: Confirm the spoofable path is gone**

Visit `/listings/<any-published-id>/report?context=moderator` while signed out — confirm the copy is the plain public "Report a problem" form, not moderator-flavored, and submitting it lands in the queue as `pending` like any other report (check `/admin` queue list).

- [x] **Step 3: Accessibility check at high zoom**

Per `PRODUCT.md`'s validated accessibility need, set the browser to 400% zoom and reload `/admin/listings/edit/<id>`. Confirm the page reflows to a single readable column with no horizontal scrolling, and the sticky "Save changes" button at the bottom doesn't overlap or clip the form above it.

- [x] **Step 4: Full regression suite**

```bash
pnpm test
```

Expected: PASS — full suite, no regressions from any task in this plan.

```bash
astro dev logs
```

Expected: no errors across the whole session.

- [x] **Step 5: Stop the dev server**

```bash
astro dev stop
```
