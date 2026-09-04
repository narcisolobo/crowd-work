# Listing Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public "submit a new listing" form and a moderator "direct-add" form, both writing to the existing `moderation_queue` audit trail, with the ability for either to propose a venue that doesn't exist yet.

**Architecture:** Extends the existing Astro (SSR) + Supabase project with no new services. Two migrations (an `authenticated` INSERT policy on `venues`, and `moderation_queue` policy changes for anonymous `'new'` proposals and authenticated self-approved direct-add inserts), extensions to the existing write-through/parsing functions in `src/lib/data/moderation.ts`, a new shared `ListingFieldsFields.astro` component factored out of the existing `ListingApprovalForm.astro`, and two new pages (`/listings/new`, `/admin/listings/new`).

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-04-listing-submission-design.md](../specs/2026-09-04-listing-submission-design.md)

## Global Constraints

- Every application write to `moderation_queue` and `venues` goes through `authenticated`/`anon`-role RLS policies — never bypassed with the service-role key. The service-role key is used only by test setup/teardown (`createAdminClient()`), per the existing project convention.
- Exactly one of `venueId` / `newVenue` is populated on `ProposedListingFields` at a time — enforced in the form-parsing layer (`parseProposedListingFields`), not the database. `proposed_data`/`approved_data` stay unchecked `jsonb`, matching the existing convention.
- `approved_data` always records the venue id that was actually used (including a newly created one), never the original `newVenue` proposal shape — `approved_data` means "what was actually published," not "what was asked for."
- All new UI must conform to `DESIGN.md` — reuse the existing `FormField`/`FormSelect`/`FormTextarea`/`Button` components (they already encode the token set, focus-visible outline, and `4px` radius) rather than hand-rolling new styled inputs. No `box-shadow`, no card containers — tonal backgrounds (`--paper-shadow`) and hairline `--rule` borders only.
- No areas/neighborhoods can be created through this feature — a proposed venue must pick an existing neighborhood from the fixed taxonomy.
- No pagination, editing, or withdrawal concerns apply here — matches the spec's non-goals.

---

## File Structure

```
crowd-work/
├── supabase/
│   └── migrations/
│       └── <timestamp>_listing_submission_policies.sql   # new
├── src/
│   ├── lib/
│   │   ├── supabase/
│   │   │   └── database.types.ts                # regenerated
│   │   ├── data/
│   │   │   ├── moderation.ts                     # modified: ProposedVenue, resolveVenueId, createListingFromFields, submitNewListingProposal, directAddListing, exported parseProposedListingFields
│   │   │   ├── moderation-approve.test.ts        # modified: new-venue assertions on approve/update
│   │   │   ├── moderation-parse.test.ts          # new: parseProposedListingFields venue-branch tests
│   │   │   ├── moderation-submission.test.ts     # new: submitNewListingProposal + RLS tests
│   │   │   ├── moderation-direct-add.test.ts     # new: directAddListing + RLS tests
│   │   │   ├── moderation-test-helpers.ts        # modified: createAnonClient()
│   │   │   ├── listings.ts                       # modified: getNeighborhoods()
│   │   │   └── listings.test.ts                  # new: getNeighborhoods() test
│   │   └── utils/
│   │       └── moderation-labels.ts              # modified: ORIGIN_LABEL additions
│   ├── components/
│   │   ├── moderation/
│   │   │   ├── ListingFieldsFields.astro         # new: shared fields partial
│   │   │   └── ListingApprovalForm.astro         # modified: uses ListingFieldsFields
│   │   └── layout/
│   │       ├── SiteHeader.astro                  # modified: "Submit a listing" now points to /listings/new
│   │       └── AdminHeader.astro                 # modified: nav link to /admin/listings/new
│   └── pages/
│       ├── listings/
│       │   └── new/
│       │       └── index.astro                   # new: public submission page
│       └── admin/
│           ├── listings/
│           │   └── new/
│           │       └── index.astro               # new: moderator direct-add page
│           └── queue/
│               └── [id].astro                    # modified: passes neighborhoodOptions through
```

---

### Task 1: Migration — RLS policies for venue creation and listing submission

**Files:**

- Create: `supabase/migrations/<timestamp>_listing_submission_policies.sql`

**Interfaces:**

- Consumes: `venues`, `moderation_queue` tables as they exist today
- Produces: an `authenticated` INSERT policy on `venues`; a widened `anon` INSERT policy on `moderation_queue` covering `change_type: 'new'`; a new `authenticated` INSERT policy on `moderation_queue` for self-approved direct-add — consumed by Task 2's `createListingFromFields`/`resolveVenueId` and Tasks 5–6's `submitNewListingProposal`/`directAddListing`

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new listing_submission_policies
```

- [x] **Step 2: Write the migration**

Open the generated file and write:

```sql
-- Venues aren't moderated today — publicly readable, but nothing can insert
-- one. Needed because venue creation now happens inside the same
-- authenticated client call that approves (or direct-adds) a listing.
create policy "moderators can insert venues"
  on venues for insert
  to authenticated
  with check (true);

-- Extend the anonymous report-form policy to also allow proposing a brand
-- new listing, not just a correction to an existing one. Kept as an `or`
-- between the two proposal shapes (rather than one loosened check) since a
-- new listing has no listing_id to attach a correction to.
drop policy "anyone can submit a correction report" on moderation_queue;

create policy "anyone can submit a correction report or a new listing"
  on moderation_queue for insert
  to anon
  with check (
    (
      change_type in ('update', 'cancellation')
      and origin = 'report_form'
      and listing_id is not null
      and correction_note is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
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

-- Moderators have only ever UPDATEd existing queue rows (approving/rejecting
-- something already there). Direct-add is the first authenticated INSERT
-- path — allowed only when the row already arrives fully decided and
-- self-attributed, so this can never be used to sneak in a pending entry or
-- attribute an approval to someone else.
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

- [x] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `listing_submission_policies` apply with no errors.

- [x] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: no `moderation_queue`/`venues` shape changes (this migration only touches policies, not columns), but regenerate anyway per project convention so the file stays a faithful mirror of the schema.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: add RLS policies for venue creation and listing submission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Data layer — venue-aware listing creation in the write-through

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-approve.test.ts`

**Interfaces:**

- Consumes: the `venues` INSERT policy from Task 1
- Produces: `ProposedVenue` interface; `ProposedListingFields.venueId: string | null` and `.newVenue: ProposedVenue | null`; `createListingFromFields(client, fields): Promise<{ listingId: string; venueId: string }>` — consumed by Task 6's `directAddListing`; a private `resolveVenueId` shared by `createListingFromFields` and `approveListingUpdate`

`ListingFieldsFields.astro` (Task 7) lets a moderator pick "Add a new venue…" when reviewing _any_ `new`/`update` entry, not just when reviewing a public submission that proposed one — so `approveListingUpdate` needs the same venue-creation capability as `approveNewListing`, not just the new-listing path, otherwise selecting "Add a new venue…" while reviewing an _update_ would silently write a null `venue_id`.

- [ ] **Step 1: Extend the failing tests first**

In `src/lib/data/moderation-approve.test.ts`, add `newVenue: null,` to both existing `ProposedListingFields` literals — the `edited` object in `describe("approveNewListing", ...)` (after its `venueId: EXISTING_VENUE_ID,` line) and the `edited` object in `describe("approveListingUpdate", ...)` (same place). This is required for both objects to keep satisfying the `ProposedListingFields` type once `newVenue` becomes a required field.

Add a top-level `insertedVenueIds` array alongside the existing ones, and clean it up in `afterEach` (venues must be deleted after listings, since `listings.venue_id` references `venues.id`):

```ts
let insertedListingIds: string[] = [];
let insertedEntryIds: string[] = [];
let insertedVenueIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  if (insertedListingIds.length > 0) {
    await admin.from("listings").delete().in("id", insertedListingIds);
  }
  if (insertedVenueIds.length > 0) {
    await admin.from("venues").delete().in("id", insertedVenueIds);
  }
  insertedListingIds = [];
  insertedEntryIds = [];
  insertedVenueIds = [];
});
```

Add a new test inside `describe("approveNewListing", ...)`, after the existing `it`:

```ts
it("creates a new venue when the proposal includes one, and records the resolved venue id in approved_data", async () => {
  const entryId = await createPendingEntry({
    change_type: "new",
    listing_id: null,
    proposed_data: {
      type: "mic",
      title: "Listing At A New Venue",
      host: null,
      description: null,
      venueId: null,
      newVenue: {
        name: "The Back Room",
        address: "123 Fake St, Los Angeles, CA",
        neighborhoodId: "b0000000-0000-0000-0000-000000000002",
        googleMapsUrl: null,
      },
      startTime: "20:00",
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: null,
      oneOffDate: "2026-10-01",
    },
  });

  const moderator1 = await signInTestModerator(1);
  const fields: ProposedListingFields = {
    type: "mic",
    title: "Listing At A New Venue",
    host: null,
    description: null,
    venueId: null,
    newVenue: {
      name: "The Back Room",
      address: "123 Fake St, Los Angeles, CA",
      neighborhoodId: "b0000000-0000-0000-0000-000000000002",
      googleMapsUrl: null,
    },
    startTime: "20:00",
    signUpMethod: null,
    costToPerform: null,
    ticketPrice: null,
    ticketUrl: null,
    recurrence: null,
    oneOffDate: "2026-10-01",
  };

  await approveNewListing(moderator1, entryId, fields, "Accurate as submitted");

  const admin = createAdminClient();
  const { data: venue } = await admin
    .from("venues")
    .select("id, name")
    .eq("name", "The Back Room")
    .single();
  expect(venue).not.toBeNull();
  insertedVenueIds.push(venue!.id);

  const { data: listing } = await admin
    .from("listings")
    .select("id, venue_id")
    .eq("title", "Listing At A New Venue")
    .single();
  expect(listing).not.toBeNull();
  insertedListingIds.push(listing!.id);
  expect(listing!.venue_id).toBe(venue!.id);

  const { data: entry } = await admin
    .from("moderation_queue")
    .select("approved_data")
    .eq("id", entryId)
    .single();
  const approvedData = entry!.approved_data as {
    venueId: string;
    newVenue: unknown;
  };
  expect(approvedData.venueId).toBe(venue!.id);
  expect(approvedData.newVenue).toBeNull();
});
```

Add a new test inside `describe("approveListingUpdate", ...)`, after the existing `it`:

```ts
it("creates and switches to a new venue when the update proposes one", async () => {
  const admin = createAdminClient();
  const { data: original, error: createError } = await admin
    .from("listings")
    .insert({
      type: "mic",
      title: "Listing Moving Venues",
      venue_id: EXISTING_VENUE_ID,
      start_time: "18:00",
      status: "published",
    })
    .select("id")
    .single();
  if (createError) throw createError;
  insertedListingIds.push(original.id);

  const entryId = await createPendingEntry({
    change_type: "update",
    listing_id: original.id,
    proposed_data: null,
    correction_note: "Venue changed",
  });

  const moderator1 = await signInTestModerator(1);
  const edited: ProposedListingFields = {
    type: "mic",
    title: "Listing Moving Venues",
    host: null,
    description: null,
    venueId: null,
    newVenue: {
      name: "The New Spot",
      address: "456 Fake Ave, Los Angeles, CA",
      neighborhoodId: "b0000000-0000-0000-0000-000000000001",
      googleMapsUrl: null,
    },
    startTime: "18:00",
    signUpMethod: null,
    costToPerform: null,
    ticketPrice: null,
    ticketUrl: null,
    recurrence: null,
    oneOffDate: null,
  };

  await approveListingUpdate(moderator1, entryId, original.id, edited, null);

  const { data: venue } = await admin
    .from("venues")
    .select("id")
    .eq("name", "The New Spot")
    .single();
  expect(venue).not.toBeNull();
  insertedVenueIds.push(venue!.id);

  const { data: updated } = await admin
    .from("listings")
    .select("venue_id")
    .eq("id", original.id)
    .single();
  expect(updated!.venue_id).toBe(venue!.id);
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-approve
```

Expected: FAIL — `newVenue` doesn't exist on `ProposedListingFields` yet (type error), and the two new tests fail because venue creation isn't implemented.

- [x] **Step 3: Update the type definitions**

In `src/lib/data/moderation.ts`, add a new interface above `ProposedListingFields` and update `ProposedListingFields` itself:

```ts
export interface ProposedVenue {
  name: string;
  address: string;
  neighborhoodId: string;
  googleMapsUrl: string | null;
}

export interface ProposedListingFields {
  type: "mic" | "show";
  title: string;
  host: string | null;
  description: string | null;
  venueId: string | null;
  newVenue: ProposedVenue | null;
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
```

- [x] **Step 4: Fix the now-broken `getPrefillForEntry` literal**

In `getPrefillForEntry`'s `update` fallback branch (the object built from `current` when there's no `proposedData`), add `newVenue: null,` after `venueId: current.venue.id,`:

```ts
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
```

(The `new`-entry branch above it, `return entry.proposedData as ProposedListingFields;`, needs no change — `newVenue` is already part of the type it's cast to.)

- [x] **Step 5: Add `resolveVenueId` and `createListingFromFields`, and rewrite `approveNewListing`/`approveListingUpdate`**

Replace `approveNewListing` and `approveListingUpdate` in full with:

```ts
async function resolveVenueId(
  client: SupabaseClient<Database>,
  fields: Pick<ProposedListingFields, "venueId" | "newVenue">,
): Promise<string> {
  if (fields.newVenue) {
    const { data: venue, error } = await client
      .from("venues")
      .insert({
        name: fields.newVenue.name,
        address: fields.newVenue.address,
        neighborhood_id: fields.newVenue.neighborhoodId,
        google_maps_url: fields.newVenue.googleMapsUrl,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to create venue: ${error.message}`);
    return venue.id;
  }
  if (!fields.venueId)
    throw new Error("A venue is required to create or update a listing.");
  return fields.venueId;
}

export async function createListingFromFields(
  client: SupabaseClient<Database>,
  fields: ProposedListingFields,
): Promise<{ listingId: string; venueId: string }> {
  const venueId = await resolveVenueId(client, fields);

  const { data: listing, error: listingError } = await client
    .from("listings")
    .insert({
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
      status: "published",
    })
    .select("id")
    .single();

  if (listingError)
    throw new Error(`Failed to create listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .insert({
        listing_id: listing.id,
        frequency: fields.recurrence.frequency,
        day_of_week: fields.recurrence.dayOfWeek,
        week_of_month: fields.recurrence.weekOfMonth,
      });
    if (recurrenceError)
      throw new Error(
        `Failed to create recurrence rule: ${recurrenceError.message}`,
      );
  }

  return { listingId: listing.id, venueId };
}

export async function approveNewListing(
  client: SupabaseClient<Database>,
  entryId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const { listingId, venueId } = await createListingFromFields(client, fields);
  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };
  await markApproved(client, entryId, listingId, approvedData, approvalNote);
}

export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
  approvalNote: string | null = null,
): Promise<void> {
  const venueId = await resolveVenueId(client, fields);

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

- [x] **Step 6: Run the tests to verify they pass**

```bash
pnpm test moderation-approve
```

Expected: PASS — all `approveNewListing`/`approveListingUpdate` tests, including the two new venue-creation ones.

- [x] **Step 7: Type-check the whole project**

```bash
pnpm exec astro check
```

Expected: no errors. (This will surface any other `ProposedListingFields` literal this step missed — fix inline if so.)

- [x] **Step 8: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-approve.test.ts
git commit -m "$(cat <<'EOF'
feat: create a new venue when a listing proposal includes one

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Data layer — parse the venue selection out of submitted form data

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Create: `src/lib/data/moderation-parse.test.ts`

**Interfaces:**

- Consumes: `ProposedVenue`, `ProposedListingFields` from Task 2
- Produces: exported `parseProposedListingFields(formData): ProposedListingFields` (previously private) — consumed by Task 5's `submitNewListingProposal`, Task 6's `directAddListing`, and the existing `handleQueueReviewAction`

- [x] **Step 1: Write the failing test**

Create `src/lib/data/moderation-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseProposedListingFields } from "./moderation";

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("parseProposedListingFields", () => {
  it("parses a real venue id into venueId, with newVenue null", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
      }),
    );

    expect(fields.venueId).toBe("c0000000-0000-0000-0000-000000000001");
    expect(fields.newVenue).toBeNull();
  });

  it("parses the '__new__' sentinel into a newVenue object, with venueId null", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "show",
        title: "A Show",
        venueId: "__new__",
        newVenueName: "The Back Room",
        newVenueAddress: "123 Fake St, Los Angeles, CA",
        newVenueNeighborhoodId: "b0000000-0000-0000-0000-000000000002",
        newVenueGoogleMapsUrl: "https://maps.google.com/?q=back+room",
        startTime: "21:00",
      }),
    );

    expect(fields.venueId).toBeNull();
    expect(fields.newVenue).toEqual({
      name: "The Back Room",
      address: "123 Fake St, Los Angeles, CA",
      neighborhoodId: "b0000000-0000-0000-0000-000000000002",
      googleMapsUrl: "https://maps.google.com/?q=back+room",
    });
  });

  it("defaults an absent googleMapsUrl to null on a new venue", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "__new__",
        newVenueName: "The Back Room",
        newVenueAddress: "123 Fake St, Los Angeles, CA",
        newVenueNeighborhoodId: "b0000000-0000-0000-0000-000000000002",
        startTime: "20:00",
      }),
    );

    expect(fields.newVenue?.googleMapsUrl).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm test moderation-parse
```

Expected: FAIL — `parseProposedListingFields` isn't exported yet.

- [x] **Step 3: Export and extend `parseProposedListingFields`**

In `src/lib/data/moderation.ts`, replace the existing (private) `parseProposedListingFields` function with:

```ts
function parseVenueSelection(formData: FormData): {
  venueId: string | null;
  newVenue: ProposedVenue | null;
} {
  const venueId = formData.get("venueId")?.toString() ?? "";
  if (venueId !== "__new__") {
    return { venueId: venueId || null, newVenue: null };
  }
  return {
    venueId: null,
    newVenue: {
      name: formData.get("newVenueName")?.toString() ?? "",
      address: formData.get("newVenueAddress")?.toString() ?? "",
      neighborhoodId: formData.get("newVenueNeighborhoodId")?.toString() ?? "",
      googleMapsUrl: formData.get("newVenueGoogleMapsUrl")?.toString() || null,
    },
  };
}

export function parseProposedListingFields(
  formData: FormData,
): ProposedListingFields {
  const frequency = formData.get("frequency")?.toString();
  return {
    type: formData.get("type")?.toString() === "show" ? "show" : "mic",
    title: formData.get("title")?.toString() ?? "",
    host: formData.get("host")?.toString() || null,
    description: formData.get("description")?.toString() || null,
    ...parseVenueSelection(formData),
    startTime: formData.get("startTime")?.toString() ?? "",
    signUpMethod: formData.get("signUpMethod")?.toString() || null,
    costToPerform: formData.get("costToPerform")?.toString() || null,
    ticketPrice: formData.get("ticketPrice")?.toString() || null,
    ticketUrl: formData.get("ticketUrl")?.toString() || null,
    recurrence:
      frequency === "weekly" || frequency === "monthly"
        ? {
            frequency,
            dayOfWeek: Number(formData.get("dayOfWeek")),
            weekOfMonth: formData.get("weekOfMonth")
              ? Number(formData.get("weekOfMonth"))
              : null,
          }
        : null,
    oneOffDate: formData.get("oneOffDate")?.toString() || null,
  };
}
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
pnpm test moderation-parse
```

Expected: PASS

- [x] **Step 5: Run the full moderation suite to check for regressions**

```bash
pnpm test moderation
```

Expected: PASS — `handleQueueReviewAction`'s existing callers of `parseProposedListingFields` are unaffected by the export change.

- [x] **Step 6: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-parse.test.ts
git commit -m "$(cat <<'EOF'
feat: parse a proposed new venue out of submitted listing form data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Data layer — neighborhood picker

**Files:**

- Modify: `src/lib/data/listings.ts`
- Create: `src/lib/data/listings.test.ts`

**Interfaces:**

- Consumes: `neighborhoods` table (existing, publicly readable)
- Produces: `getNeighborhoods(): Promise<{ id: string; name: string; areaId: string }[]>` — consumed by Task 7's `ListingFieldsFields.astro`, and Tasks 8–9's pages

- [x] **Step 1: Write the failing test**

Create `src/lib/data/listings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getNeighborhoods } from "./listings";

describe("getNeighborhoods", () => {
  it("returns neighborhoods ordered by name, each with its area id", async () => {
    const neighborhoods = await getNeighborhoods();

    const losFeliz = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000001",
    );
    expect(losFeliz).toEqual({
      id: "b0000000-0000-0000-0000-000000000001",
      name: "Los Feliz",
      areaId: "a0000000-0000-0000-0000-000000000001",
    });

    const santaMonica = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000003",
    );
    expect(santaMonica?.areaId).toBe("a0000000-0000-0000-0000-000000000002");

    const names = neighborhoods.map((n) => n.name);
    expect(names).toEqual([...names].sort());
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm test listings
```

Expected: FAIL — `getNeighborhoods` doesn't exist.

- [x] **Step 3: Write the implementation**

In `src/lib/data/listings.ts`, add after `getAreas`:

```ts
export interface Neighborhood {
  id: string;
  name: string;
  areaId: string;
}

export async function getNeighborhoods(): Promise<Neighborhood[]> {
  const { data, error } = await supabase
    .from("neighborhoods")
    .select("id, name, area_id")
    .order("name");
  if (error) throw new Error(`Failed to load neighborhoods: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    areaId: row.area_id,
  }));
}
```

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm test listings
```

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/lib/data/listings.ts src/lib/data/listings.test.ts
git commit -m "$(cat <<'EOF'
feat: add getNeighborhoods for the new-venue picker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Data layer — public submission write path

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-test-helpers.ts`
- Modify: `src/lib/utils/moderation-labels.ts`
- Create: `src/lib/data/moderation-submission.test.ts`

**Interfaces:**

- Consumes: `parseProposedListingFields` from Task 3; the anon INSERT policy from Task 1
- Produces: `submitNewListingProposal(client, formData): Promise<void>` — consumed by Task 8's public page; `createAnonClient(): SupabaseClient<Database>` — consumed by this task's own RLS tests and Task 6's

- [x] **Step 1: Add `createAnonClient` to the test helpers**

In `src/lib/data/moderation-test-helpers.ts`, add after `createAdminClient`:

```ts
export function createAnonClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requiredEnv("PUBLIC_SUPABASE_URL"),
    requiredEnv("PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
```

- [x] **Step 2: Write the failing tests**

Create `src/lib/data/moderation-submission.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { submitNewListingProposal } from "./moderation";
import { createAdminClient, createAnonClient } from "./moderation-test-helpers";

const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("submitNewListingProposal", () => {
  it("inserts a pending 'new' entry with an existing venue", async () => {
    const anon = createAnonClient();
    const formData = buildFormData({
      type: "mic",
      title: "Anon-Submitted Mic",
      venueId: EXISTING_VENUE_ID,
      startTime: "20:00",
    });

    await submitNewListingProposal(anon, formData);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, listing_id, proposed_data")
      .eq("origin", "submission_form")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBeNull();
    expect((entry!.proposed_data as { title: string }).title).toBe(
      "Anon-Submitted Mic",
    );
  });

  it("accepts a proposed new venue instead of an existing one", async () => {
    const anon = createAnonClient();
    const formData = buildFormData({
      type: "show",
      title: "Anon-Submitted Show",
      venueId: "__new__",
      newVenueName: "The Back Room",
      newVenueAddress: "123 Fake St, Los Angeles, CA",
      newVenueNeighborhoodId: EXISTING_NEIGHBORHOOD_ID,
      startTime: "21:00",
    });

    await submitNewListingProposal(anon, formData);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, proposed_data")
      .eq("origin", "submission_form")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    const proposedData = entry!.proposed_data as {
      venueId: string | null;
      newVenue: { name: string } | null;
    };
    expect(proposedData.venueId).toBeNull();
    expect(proposedData.newVenue?.name).toBe("The Back Room");
  });
});

describe("submission_form RLS", () => {
  it("rejects an anonymous insert that pre-fills a decided status", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      change_type: "new",
      origin: "submission_form",
      status: "approved",
      proposed_data: { title: "Forged" },
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'new' change_type submitted under the report_form origin", async () => {
    const anon = createAnonClient();
    const { error } = await anon.from("moderation_queue").insert({
      change_type: "new",
      origin: "report_form",
      status: "pending",
      proposed_data: { title: "Wrong origin" },
    });
    expect(error).not.toBeNull();
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

```bash
pnpm test moderation-submission
```

Expected: FAIL — `submitNewListingProposal` doesn't exist yet, and the RLS tests fail because Task 1's policy isn't exercised by any insert yet (they should currently fail because the _first_ two `it`s throw on the missing function, not because the policy is wrong — the RLS `it`s should already pass once Task 1 is applied, since they test the policy directly; run this step to confirm the two RLS tests already pass and only the two `submitNewListingProposal` tests fail).

- [x] **Step 4: Implement `submitNewListingProposal`**

In `src/lib/data/moderation.ts`, add after `sendBackToPending` (or any convenient spot above `handleQueueReviewAction`):

```ts
export async function submitNewListingProposal(
  client: SupabaseClient<Database>,
  formData: FormData,
): Promise<void> {
  const fields = parseProposedListingFields(formData);

  const { error } = await client.from("moderation_queue").insert({
    change_type: "new",
    listing_id: null,
    proposed_data: fields as unknown as Json,
    correction_note: null,
    origin: "submission_form",
    status: "pending",
  });

  if (error) throw new Error(`Failed to submit listing: ${error.message}`);
}
```

- [x] **Step 5: Add the new origin label**

In `src/lib/utils/moderation-labels.ts`, update `ORIGIN_LABEL`:

```ts
export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
  submission_form: "Public submission",
  moderator_direct_add: "Direct add",
};
```

(Adding `moderator_direct_add` here now, ahead of Task 6, avoids a second edit to this file later.)

- [x] **Step 6: Run the tests to verify they pass**

```bash
pnpm test moderation-submission
```

Expected: PASS

- [x] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-test-helpers.ts src/lib/data/moderation-submission.test.ts src/lib/utils/moderation-labels.ts
git commit -m "$(cat <<'EOF'
feat: add the public new-listing submission write path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Data layer — moderator direct-add write path

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Create: `src/lib/data/moderation-direct-add.test.ts`

**Interfaces:**

- Consumes: `createListingFromFields` (Task 2), `parseProposedListingFields` (Task 3), the authenticated direct-add INSERT policy (Task 1)
- Produces: `directAddListing(client, formData): Promise<void>` — consumed by Task 9's admin page

- [x] **Step 1: Write the failing tests**

Create `src/lib/data/moderation-direct-add.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { directAddListing } from "./moderation";
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

function buildFormData(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe("directAddListing", () => {
  it("creates a listing and a self-approved queue entry in one step", async () => {
    const moderator1 = await signInTestModerator(1);
    const {
      data: { user: moderator1User },
    } = await moderator1.auth.getUser();

    const formData = buildFormData({
      type: "mic",
      title: "Direct-Added Mic",
      venueId: EXISTING_VENUE_ID,
      startTime: "19:00",
      reason: "Verified independently",
    });

    await directAddListing(moderator1, formData);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id")
      .eq("title", "Direct-Added Mic")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);

    const { data: entry } = await admin
      .from("moderation_queue")
      .select(
        "id, change_type, origin, status, listing_id, approved_by, approval_note, decided_at",
      )
      .eq("listing_id", listing!.id)
      .single();
    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.origin).toBe("moderator_direct_add");
    expect(entry!.status).toBe("approved");
    expect(entry!.approved_by).toBe(moderator1User!.id);
    expect(entry!.approval_note).toBe("Verified independently");
    expect(entry!.decided_at).not.toBeNull();
  });
});

describe("moderator_direct_add RLS", () => {
  it("rejects an authenticated insert that isn't already approved", async () => {
    const moderator1 = await signInTestModerator(1);
    const { error } = await moderator1.from("moderation_queue").insert({
      change_type: "new",
      origin: "moderator_direct_add",
      status: "pending",
      proposed_data: { title: "Sneaking in as pending" },
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
      change_type: "new",
      origin: "moderator_direct_add",
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
pnpm test moderation-direct-add
```

Expected: FAIL — `directAddListing` doesn't exist yet.

- [x] **Step 3: Implement `directAddListing`**

In `src/lib/data/moderation.ts`, add after `submitNewListingProposal`:

```ts
export async function directAddListing(
  client: SupabaseClient<Database>,
  formData: FormData,
): Promise<void> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const fields = parseProposedListingFields(formData);
  const approvalNote = parseApprovalNote(formData);
  const { listingId, venueId } = await createListingFromFields(client, fields);
  const approvedData: ProposedListingFields = {
    ...fields,
    venueId,
    newVenue: null,
  };

  const { error } = await client.from("moderation_queue").insert({
    change_type: "new",
    listing_id: listingId,
    proposed_data: null,
    correction_note: null,
    origin: "moderator_direct_add",
    status: "approved",
    approved_by: user.id,
    approved_data: approvedData as unknown as Json,
    approval_note: approvalNote,
    decided_at: new Date().toISOString(),
  });

  if (error)
    throw new Error(`Failed to record direct-added listing: ${error.message}`);
}
```

- [x] **Step 4: Run the tests to verify they pass**

```bash
pnpm test moderation-direct-add
```

Expected: PASS

- [x] **Step 5: Run the full test suite**

```bash
pnpm test
```

Expected: PASS — everything from prior tasks plus this one.

- [x] **Step 6: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-direct-add.test.ts
git commit -m "$(cat <<'EOF'
feat: add moderator direct-add write path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Shared `ListingFieldsFields` component with conditional fields

**Files:**

- Create: `src/components/moderation/ListingFieldsFields.astro`
- Modify: `src/components/moderation/ListingApprovalForm.astro`
- Modify: `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: `ProposedListingFields` (Task 2), `getNeighborhoods` (Task 4), `TYPE_OPTIONS`/`FREQUENCY_OPTIONS`/`DAY_OF_WEEK_OPTIONS`/`WEEK_OF_MONTH_OPTIONS` (existing, `moderation-labels.ts`)
- Produces: `<ListingFieldsFields prefill venueOptions neighborhoodOptions />` — consumed by `ListingApprovalForm.astro` (this task) and Tasks 8–9's new pages

This task is UI-only; per this project's existing testing convention, verify manually rather than with an automated test.

- [ ] **Step 1: Write `ListingFieldsFields.astro`**

Create `src/components/moderation/ListingFieldsFields.astro`:

```astro
---
import FormField from "../forms/FormField.astro";
import FormSelect from "../forms/FormSelect.astro";
import FormTextarea from "../forms/FormTextarea.astro";
import type { ProposedListingFields } from "../../lib/data/moderation";
import {
  DAY_OF_WEEK_OPTIONS,
  FREQUENCY_OPTIONS,
  TYPE_OPTIONS,
  WEEK_OF_MONTH_OPTIONS,
} from "../../lib/utils/moderation-labels";

interface Props {
  prefill: ProposedListingFields | null;
  venueOptions: { value: string; label: string }[];
  neighborhoodOptions: { value: string; label: string }[];
}

const { prefill, venueOptions, neighborhoodOptions } = Astro.props;

const venueSelectOptions = [
  ...venueOptions,
  { value: "__new__", label: "Add a new venue…" },
];
const isNewVenue = Boolean(prefill?.newVenue);
const initialType = prefill?.type ?? "mic";
---

<div class="flex flex-col gap-4">
  <p
    class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
  >
    Listing details
  </p>
  <FormSelect
    label="Type"
    name="type"
    options={TYPE_OPTIONS}
    value={initialType}
  />
  <FormField label="Title" name="title" value={prefill?.title ?? ""} required />
  <div data-field-for="mic" hidden={initialType === "show"}>
    <FormField label="Host" name="host" value={prefill?.host ?? ""} />
  </div>
  <FormTextarea
    label="Description"
    name="description"
    value={prefill?.description ?? ""}
  />
  <FormSelect
    label="Venue"
    name="venueId"
    options={venueSelectOptions}
    value={isNewVenue ? "__new__" : (prefill?.venueId ?? "")}
    required
  />
  <div data-new-venue hidden={!isNewVenue} class="flex flex-col gap-4">
    <FormField
      label="Venue name"
      name="newVenueName"
      value={prefill?.newVenue?.name ?? ""}
      required
    />
    <FormField
      label="Venue address"
      name="newVenueAddress"
      value={prefill?.newVenue?.address ?? ""}
      required
    />
    <FormSelect
      label="Neighborhood"
      name="newVenueNeighborhoodId"
      options={neighborhoodOptions}
      value={prefill?.newVenue?.neighborhoodId ?? ""}
      required
    />
    <FormField
      label="Google Maps URL"
      name="newVenueGoogleMapsUrl"
      type="url"
      value={prefill?.newVenue?.googleMapsUrl ?? ""}
    />
  </div>
  <FormField
    label="Start time"
    name="startTime"
    type="time"
    value={prefill?.startTime ?? ""}
    required
  />
  <div data-field-for="mic" hidden={initialType === "show"}>
    <FormField
      label="Sign-up method"
      name="signUpMethod"
      value={prefill?.signUpMethod ?? ""}
    />
  </div>
  <div data-field-for="mic" hidden={initialType === "show"}>
    <FormField
      label="Cost to perform"
      name="costToPerform"
      value={prefill?.costToPerform ?? ""}
    />
  </div>
  <div data-field-for="show" hidden={initialType !== "show"}>
    <FormField
      label="Ticket price"
      name="ticketPrice"
      value={prefill?.ticketPrice ?? ""}
    />
  </div>
  <div data-field-for="show" hidden={initialType !== "show"}>
    <FormField
      label="Ticket URL"
      name="ticketUrl"
      type="url"
      value={prefill?.ticketUrl ?? ""}
    />
  </div>
</div>

<div class="border-rule flex flex-col gap-4 border-t pt-6">
  <p
    class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
  >
    Recurrence
  </p>
  <FormSelect
    label="Frequency"
    name="frequency"
    options={FREQUENCY_OPTIONS}
    value={prefill?.recurrence?.frequency ?? ""}
  />
  <FormSelect
    label="Day of week"
    name="dayOfWeek"
    options={DAY_OF_WEEK_OPTIONS}
    value={prefill?.recurrence?.dayOfWeek ?? ""}
  />
  <FormSelect
    label="Week of month"
    name="weekOfMonth"
    options={WEEK_OF_MONTH_OPTIONS}
    value={prefill?.recurrence?.weekOfMonth ?? ""}
  />
  <FormField
    label="One-off date (if not recurring)"
    name="oneOffDate"
    type="date"
    value={prefill?.oneOffDate ?? ""}
  />
</div>

<script>
  const typeSelects = document.querySelectorAll<HTMLSelectElement>(
    'select[name="type"]',
  );
  for (const select of typeSelects) {
    const form = select.closest("form");
    if (!form) continue;
    const micFields = form.querySelectorAll<HTMLElement>(
      '[data-field-for="mic"]',
    );
    const showFields = form.querySelectorAll<HTMLElement>(
      '[data-field-for="show"]',
    );
    const sync = () => {
      const isShow = select.value === "show";
      for (const el of micFields) el.hidden = isShow;
      for (const el of showFields) el.hidden = !isShow;
    };
    select.addEventListener("change", sync);
    sync();
  }

  const venueSelects = document.querySelectorAll<HTMLSelectElement>(
    'select[name="venueId"]',
  );
  for (const select of venueSelects) {
    const container = select
      .closest("form")
      ?.querySelector<HTMLElement>("[data-new-venue]");
    if (!container) continue;
    const sync = () => {
      container.hidden = select.value !== "__new__";
    };
    select.addEventListener("change", sync);
    sync();
  }
</script>
```

- [ ] **Step 2: Wire it into `ListingApprovalForm.astro`**

In `src/components/moderation/ListingApprovalForm.astro`, replace the imports and Props to drop the fields this component no longer renders directly, and swap in `ListingFieldsFields`:

```astro
---
import Button from "../forms/Button.astro";
import FormSelect from "../forms/FormSelect.astro";
import FormTextarea from "../forms/FormTextarea.astro";
import ListingFieldsFields from "./ListingFieldsFields.astro";
import type {
  ProposedListingFields,
  QueueEntry,
} from "../../lib/data/moderation";
import { APPROVAL_REASON_OPTIONS } from "../../lib/utils/moderation-labels";

interface Props {
  entry: QueueEntry;
  prefill: ProposedListingFields | null;
  venueOptions: { value: string; label: string }[];
  neighborhoodOptions: { value: string; label: string }[];
}

const { entry, prefill, venueOptions, neighborhoodOptions } = Astro.props;
---

<form method="post" class="mt-8 flex max-w-104 flex-col gap-6">
  <input type="hidden" name="action" value="approve" />

  <ListingFieldsFields
    prefill={prefill}
    venueOptions={venueOptions}
    neighborhoodOptions={neighborhoodOptions}
  />

  <div class="border-rule flex flex-col gap-4 border-t pt-6">
    <p
      class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
    >
      Approval
    </p>
    <FormSelect
      label="Reason"
      name="reason"
      options={APPROVAL_REASON_OPTIONS}
      value=""
    />
    <div data-other-reason hidden>
      <FormTextarea label="Other reason" name="otherReason" />
    </div>
  </div>

  <Button
    type="submit"
    variant="primary"
    disabled={entry.status !== "pending"}
    class="self-start"
  >
    Approve
  </Button>
</form>
```

(`FormField` is no longer used directly in this file — remove its import along with the option-array imports (`TYPE_OPTIONS`, `FREQUENCY_OPTIONS`, `DAY_OF_WEEK_OPTIONS`, `WEEK_OF_MONTH_OPTIONS`), since `ListingFieldsFields` owns those now.)

- [ ] **Step 3: Pass `neighborhoodOptions` from `queue/[id].astro`**

In `src/pages/admin/queue/[id].astro`, update the import and venue/neighborhood loading:

```ts
import { getNeighborhoods, getVenues } from "../../../lib/data/listings";
```

Replace `const venues = await getVenues();` with:

```ts
const [venues, neighborhoods] = await Promise.all([
  getVenues(),
  getNeighborhoods(),
]);
```

After the existing `venueOptions` mapping, add:

```ts
const neighborhoodOptions = neighborhoods.map((neighborhood) => ({
  value: neighborhood.id,
  label: neighborhood.name,
}));
```

Update the `<ListingApprovalForm>` usage to pass it through:

```astro
<ListingApprovalForm
  entry={entry}
  prefill={prefill}
  venueOptions={venueOptions}
  neighborhoodOptions={neighborhoodOptions}
/>
```

- [ ] **Step 4: Type-check**

```bash
pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 5: Verify manually**

```bash
astro dev --background
```

Sign in at `/admin/login` with a provisioned moderator account and open a pending `new` or `update` entry from `/admin`. Confirm:

- The form renders exactly as before (same fields, same layout) — this is a pure refactor for existing entries with a real `venueId`.
- Switching the Type select between "Mic" and "Show" instantly shows/hides Host/Sign-up method/Cost to perform vs. Ticket price/Ticket URL, with no page reload.
- Selecting "Add a new venue…" in the Venue select reveals the Name/Address/Neighborhood/Maps URL fields; selecting a real venue hides them again.

```bash
astro dev logs
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/moderation/ListingFieldsFields.astro src/components/moderation/ListingApprovalForm.astro src/pages/admin/queue/\[id\].astro
git commit -m "$(cat <<'EOF'
refactor: extract ListingFieldsFields with conditional mic/show and new-venue fields

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The public `/listings/new` page

**Files:**

- Create: `src/pages/listings/new/index.astro`
- Modify: `src/components/layout/SiteHeader.astro`

**Interfaces:**

- Consumes: `ListingFieldsFields` (Task 7), `submitNewListingProposal`/`parseProposedListingFields` (Tasks 5/3), `getVenues`/`getNeighborhoods` (existing/Task 4)
- Produces: the `/listings/new` route

This task is UI-only; verify manually.

- [ ] **Step 1: Write the page**

Create `src/pages/listings/new/index.astro`:

```astro
---
import { Font } from "astro:assets";
import "../../../styles/global.css";
import Button from "../../../components/forms/Button.astro";
import ListingFieldsFields from "../../../components/moderation/ListingFieldsFields.astro";
import { supabase } from "../../../lib/supabase/supabase";
import { getNeighborhoods, getVenues } from "../../../lib/data/listings";
import {
  parseProposedListingFields,
  submitNewListingProposal,
  type ProposedListingFields,
} from "../../../lib/data/moderation";

const [venues, neighborhoods] = await Promise.all([
  getVenues(),
  getNeighborhoods(),
]);

let submitted = false;
let errorMessage: string | null = null;
let prefill: ProposedListingFields | null = null;

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  const honeypot = formData.get("company")?.toString() ?? "";

  if (honeypot !== "") {
    // Silently succeed for bots without writing anything.
    submitted = true;
  } else {
    prefill = parseProposedListingFields(formData);
    try {
      await submitNewListingProposal(supabase, formData);
      submitted = true;
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? error.message
          : "Something went wrong submitting your listing. Please try again.";
    }
  }
}

const venueOptions = venues.map((venue) => ({
  value: venue.id,
  label: venue.name,
}));
const neighborhoodOptions = neighborhoods.map((neighborhood) => ({
  value: neighborhood.id,
  label: neighborhood.name,
}));
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Submit a listing — Crowd Work</title>
    <script is:inline>
      (function () {
        const stored = localStorage.getItem("theme");
        if (stored === "light" || stored === "dark") {
          document.documentElement.setAttribute("data-theme", stored);
        }
      })();
    </script>
    <Font cssVariable="--font-big-shoulders" preload />
    <Font cssVariable="--font-ibm-plex-sans" preload />
    <Font cssVariable="--font-ibm-plex-mono" />
  </head>
  <body
    class="font-body text-ink flex min-h-screen flex-col text-base antialiased"
  >
    <div class="mx-auto flex w-full max-w-136 flex-1 flex-col px-5 py-10">
      <a
        href="/"
        class="text-ink-soft inline-flex items-center gap-1.5 text-[0.86rem] underline-offset-2 hover:underline"
      >
        <svg class="h-2.5 w-2.5 rotate-90" viewBox="0 0 12 12" fill="none">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"></path>
        </svg>
        Back to Crowd Work
      </a>

      {
        submitted ? (
          <div class="mt-10">
            <h1 class="font-display text-[1.28rem] font-bold">
              Thanks — a moderator will review this shortly.
            </h1>
            <p class="text-ink-soft mt-2.5 max-w-[45ch] text-[0.95rem]">
              Crowd Work listings are reviewed by working comics, not one
              person's spreadsheet — submissions like yours are how the list
              grows.
            </p>
          </div>
        ) : (
          <div class="border-l-rule bg-paper-shadow mt-8 rounded-sm border-l-[3px] px-5 py-6 sm:px-7 sm:py-7">
            <h1 class="font-display text-[1.28rem] font-bold">
              Submit a listing
            </h1>
            <p class="text-ink-soft mt-1.5 text-[0.9rem]">
              A moderator reviews every submission before it goes live.
            </p>

            {errorMessage && (
              <p
                role="alert"
                class="bg-paper text-ink mt-5 rounded-sm px-3.5 py-2.5 text-[0.86rem] font-medium"
              >
                <strong>Error:</strong> {errorMessage}
              </p>
            )}

            <form method="post" class="mt-6 flex flex-col gap-6">
              <div hidden>
                <label>
                  Company
                  <input
                    type="text"
                    name="company"
                    tabindex={-1}
                    autocomplete="off"
                  />
                </label>
              </div>

              <ListingFieldsFields
                prefill={prefill}
                venueOptions={venueOptions}
                neighborhoodOptions={neighborhoodOptions}
              />

              <Button type="submit" variant="primary" class="self-start">
                Submit listing
              </Button>
            </form>
          </div>
        )
      }
    </div>
  </body>
</html>
```

- [ ] **Step 2: Point the header's "Submit a listing" link at the new page**

In `src/components/layout/SiteHeader.astro`, replace the placeholder:

```astro
<a
  href="#"
  class="font-body text-ink-soft hover:text-ink text-[0.9rem] underline-offset-2 hover:underline"
></a>
```

with:

```astro
<a
  href="/listings/new"
  class="font-body text-ink-soft hover:text-ink text-[0.9rem] underline-offset-2 hover:underline"
></a>
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 4: Verify manually**

```bash
astro dev --background
```

From `/`, click "Submit a listing" in the header and confirm it lands on `/listings/new`. Fill out and submit a mic with an existing venue — confirm the thank-you message appears, then check `/admin` (signed in as a moderator) for a new pending entry with origin "Public submission". Repeat, this time choosing "Add a new venue…" and filling its fields — confirm the pending entry's proposed data includes the new venue (visible via `/admin/queue/<id>`, which after Task 7 renders the reveal block pre-filled).

Also submit with the hidden "company" field populated (e.g. via browser devtools) and confirm it shows the thank-you message without creating a queue entry.

```bash
astro dev logs
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/listings/new src/components/layout/SiteHeader.astro
git commit -m "$(cat <<'EOF'
feat: add the public /listings/new submission page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The moderator `/admin/listings/new` direct-add page

**Files:**

- Create: `src/pages/admin/listings/new/index.astro`
- Modify: `src/components/layout/AdminHeader.astro`

**Interfaces:**

- Consumes: `ListingFieldsFields` (Task 7), `directAddListing` (Task 6), `getVenues`/`getNeighborhoods` (existing/Task 4), `APPROVAL_REASON_OPTIONS` (existing)
- Produces: the `/admin/listings/new` route

This task is UI-only; verify manually.

- [ ] **Step 1: Write the page**

Create `src/pages/admin/listings/new/index.astro`:

```astro
---
import Button from "../../../../components/forms/Button.astro";
import FormSelect from "../../../../components/forms/FormSelect.astro";
import FormTextarea from "../../../../components/forms/FormTextarea.astro";
import ListingFieldsFields from "../../../../components/moderation/ListingFieldsFields.astro";
import AdminLayout from "../../../../layouts/AdminLayout.astro";
import { getNeighborhoods, getVenues } from "../../../../lib/data/listings";
import { directAddListing } from "../../../../lib/data/moderation";
import { APPROVAL_REASON_OPTIONS } from "../../../../lib/utils/moderation-labels";

const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;

const [venues, neighborhoods] = await Promise.all([
  getVenues(),
  getNeighborhoods(),
]);

let errorMessage: string | null = null;

if (Astro.request.method === "POST") {
  const formData = await Astro.request.formData();
  try {
    await directAddListing(supabase, formData);
    return Astro.redirect("/admin");
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Something went wrong.";
  }
}

const venueOptions = venues.map((venue) => ({
  value: venue.id,
  label: venue.name,
}));
const neighborhoodOptions = neighborhoods.map((neighborhood) => ({
  value: neighborhood.id,
  label: neighborhood.name,
}));
---

<AdminLayout title="Add a listing — Crowd Work admin" userEmail={user.email}>
  <div class="mt-5">
    <h1 class="font-display text-[1.28rem] font-bold">Add a listing</h1>
    <p class="text-ink-soft mt-1.5 text-[0.86rem]">
      Creates the listing directly — recorded in the archive as already
      approved, under your account.
    </p>
  </div>

  {
    errorMessage && (
      <p
        role="alert"
        class="bg-paper-shadow text-ink mt-5 rounded-sm px-3.5 py-2.5 text-[0.86rem] font-medium"
      >
        <strong>Error:</strong> {errorMessage}
      </p>
    )
  }

  <form method="post" class="mt-8 flex max-w-104 flex-col gap-6">
    <ListingFieldsFields
      prefill={null}
      venueOptions={venueOptions}
      neighborhoodOptions={neighborhoodOptions}
    />

    <div class="border-rule flex flex-col gap-4 border-t pt-6">
      <p
        class="font-body text-ink-soft text-[0.65rem] font-semibold tracking-wider uppercase"
      >
        Approval
      </p>
      <FormSelect
        label="Reason"
        name="reason"
        options={APPROVAL_REASON_OPTIONS}
        value=""
      />
      <div data-other-reason hidden>
        <FormTextarea label="Other reason" name="otherReason" />
      </div>
    </div>

    <Button type="submit" variant="primary" class="self-start">
      Add listing
    </Button>
  </form>
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

- [ ] **Step 2: Add the nav link**

In `src/components/layout/AdminHeader.astro`, add a "New listing" link before the existing "Archive" link (inside the same `userEmail &&` `<nav>` block):

```astro
<a
  href="/admin/listings/new"
  class="hover:text-ink underline-offset-2 hover:underline"
>
  New listing
</a>
<a
  href="/admin/archive"
  class="hover:text-ink underline-offset-2 hover:underline"
>
  Archive
</a>
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 4: Verify manually**

```bash
astro dev --background
```

Sign in as a moderator, click "New listing" in the admin header, and confirm it lands on `/admin/listings/new`. Fill out and submit a show with an existing venue — confirm it redirects to `/admin` and the listing appears on the public homepage immediately (no queue wait). Then open `/admin/archive` and confirm the new entry shows status "Approved", origin "Direct add", your email as "who", and the selected reason as "why". Repeat once more choosing "Add a new venue…" and confirm the venue is created and used.

```bash
astro dev logs
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/listings/new src/components/layout/AdminHeader.astro
git commit -m "$(cat <<'EOF'
feat: add moderator direct-add page at /admin/listings/new

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: End-to-end manual verification

**Files:** none — this task exercises the running app in a real browser, not headless automation.

- [ ] **Step 1: Reset and provision**

```bash
supabase db reset
node scripts/provision-moderators.mjs mod1@crowdwork.test <password1> mod2@crowdwork.test <password2>
astro dev --background
```

- [ ] **Step 2: Public submission with an existing venue, approved as-is**

At `/listings/new`, submit a mic at "The Virgil" (existing venue). Sign in as moderator 1, find the pending entry at `/admin`, open it, confirm the Listing details/Recurrence fields match what was submitted, select "Accurate as submitted", and approve. Confirm the listing now appears on `/`.

- [ ] **Step 3: Public submission proposing a new venue**

At `/listings/new`, submit a show choosing "Add a new venue…" with a made-up name/address/neighborhood. Sign in as moderator 1, open the pending entry, confirm the Venue select shows "Add a new venue…" selected with the proposed name/address/neighborhood pre-filled in the reveal block, and approve. Confirm both a new venue and the listing now exist (check `/` for the listing; the venue has no direct public page but its name should appear as the listing's venue).

- [ ] **Step 4: Moderator direct-add with an existing venue**

At `/admin/listings/new`, add a mic at "Westside Comedy Theater" with a canned approval reason. Confirm it redirects to `/admin` and the listing is immediately live on `/`. Check `/admin/archive` and confirm it shows as approved, origin "Direct add", with your email and reason.

- [ ] **Step 5: Moderator direct-add proposing a new venue**

At `/admin/listings/new`, add a show choosing "Add a new venue…". Confirm the listing and venue are both created and the listing is immediately live.

- [ ] **Step 6: Mic/show conditional fields, on all three forms**

On `/listings/new`, `/admin/listings/new`, and an open `/admin/queue/<id>` entry, toggle the Type select between "Mic" and "Show" and confirm Host/Sign-up method/Cost to perform show only for Mic, and Ticket price/Ticket URL show only for Show, with no page reload.

- [ ] **Step 7: Full automated suite**

```bash
pnpm test
pnpm exec astro check
```

Expected: everything passes, no type errors.

- [ ] **Step 8: Check server logs**

```bash
astro dev logs
```

Expected: no errors across all of the above.
