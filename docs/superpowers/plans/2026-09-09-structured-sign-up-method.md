# Structured Sign-Up Method Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text `signUpMethod` field with a five-value enum plus three conditionally-shown detail fields (slotted.co URL, hybrid/other explanation, drop time), threaded through the DB schema, the shared `ProposedListingFields` type, every read/write path, both public display surfaces, the check-sources agent's JSON contract, and the dev-data template pipeline.

**Architecture:** One new migration adds the enum and three columns; a single shared TypeScript type change ripples through two write functions, one read function, and one prefill-mapping function in `src/lib/data/moderation.ts`/`src/lib/data/listings.ts`; the moderator form gains a dropdown plus three conditionally-visible fields using the file's existing toggle pattern; two public display templates and one agent prompt get updated to match.

**Tech Stack:** Astro (SSR), Supabase/Postgres, TypeScript, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-09-structured-sign-up-method-design.md](../specs/2026-09-09-structured-sign-up-method-design.md)

## Global Constraints

- Enum labels are exact strings shared between Postgres and TypeScript: `bucket_lotto`, `first_come`, `curated`, `slotted_online`, `hybrid_other`. No other spelling anywhere (form option values, test fixtures, seed data, check-sources JSON).
- `sign_up_url` gets no server-side or domain-specific validation — native HTML `type="url"` only, matching `ticketUrl`/`newVenueGoogleMapsUrl`.
- `sign_up_other_note` is required only when `signUpMethod === "hybrid_other"`, enforced in `findMissingRequiredFields` (app layer) — no DB `CHECK` constraint.
- The new Postgres enum type is named `sign_up_method_type`, distinct from the `sign_up_method` column name (matches the existing `listing_type`/`recurrence_frequency` convention).
- This project requires a local Supabase instance running for the data-layer integration tests (`pnpm test`) — same prerequisite the existing `moderation-approve.test.ts` etc. already have.

---

## Task 1: Migration and seed data

**Files:**
- Create: `supabase/migrations/<timestamp>_structured_sign_up_method.sql` (generate the timestamp with `supabase migration new structured_sign_up_method`)
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces: Postgres enum type `sign_up_method_type` with labels `bucket_lotto | first_come | curated | slotted_online | hybrid_other`; `listings` columns `sign_up_method sign_up_method_type`, `sign_up_url text`, `sign_up_other_note text`, `sign_up_opens_at time`.

- [x] **Step 1: Generate the migration file**

Run: `supabase migration new structured_sign_up_method`

This creates an empty, correctly-timestamped file under `supabase/migrations/`.

- [x] **Step 2: Write the migration**

```sql
create type sign_up_method_type as enum (
  'bucket_lotto', 'first_come', 'curated', 'slotted_online', 'hybrid_other'
);

alter table listings
  drop column sign_up_method,
  add column sign_up_method sign_up_method_type,
  add column sign_up_url text,
  add column sign_up_other_note text,
  add column sign_up_opens_at time;
```

- [x] **Step 3: Update `supabase/seed.sql`'s two `sign_up_method` values**

In `supabase/seed.sql`, the first `insert into listings` (id `d0000000-0000-0000-0000-000000000001`) currently has `sign_up_method` value `'sign-up list at the door, 7:30pm'` in its column list at position matching `sign_up_method`. Change that INSERT's column list and values to include the new columns, and drop the old free-text value:

```sql
insert into listings (id, type, title, host, venue_id, start_time, sign_up_method, sign_up_opens_at, cost_to_perform, status) values
  ('d0000000-0000-0000-0000-000000000001', 'mic', 'Tuesday Night Mic', 'Jamie Rivera', 'c0000000-0000-0000-0000-000000000001', '20:00', 'first_come', '19:30', 'free', 'published');
```

The second `insert into listings` (id `d0000000-0000-0000-0000-000000000002`) currently has `sign_up_method` value `'app sign-up opens 6pm'`. Change it the same way:

```sql
insert into listings (id, type, title, host, venue_id, start_time, sign_up_method, sign_up_opens_at, cost_to_perform, status) values
  ('d0000000-0000-0000-0000-000000000002', 'mic', 'Last Thursday Mic', 'Dana Okafor', 'c0000000-0000-0000-0000-000000000001', '19:30', 'first_come', '18:00', '$5', 'published');
```

- [x] **Step 4: Reset the local database and verify**

Run: `supabase db reset`
Expected: completes with no errors, and both seed listings insert successfully.

Verify the new schema with the Supabase MCP tools or `psql`:
```sql
select sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at from listings;
```
Expected: two rows, both `sign_up_method = 'first_come'`, matching `sign_up_opens_at` values, `sign_up_url`/`sign_up_other_note` both null.

- [x] **Step 5: Regenerate Supabase TypeScript types**

The generated `Database` type is what Task 2's `.insert()`/`.update()` calls type-check against — without this, `sign_up_url`/`sign_up_other_note`/`sign_up_opens_at` aren't valid keys on the `listings` Insert/Update types yet, and TypeScript reports those assignments as "not assignable to type 'never'".

Run:
```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Verify: `grep -c sign_up_opens_at src/lib/supabase/database.types.ts` returns `3` (Row, Insert, Update).

(This step was added after Task 1's commit already landed without it — the regenerated `database.types.ts` rides along with Task 2's commit instead, in its Step 20.)

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/*_structured_sign_up_method.sql supabase/seed.sql
git commit -m "feat(db): replace free-text sign-up method with structured enum + detail columns"
```

---

## Task 2: Data layer — types, parsing, validation, read/write paths

**Files:**
- Modify: `src/lib/data/moderation.ts` (interface `ProposedListingFields`, `parseProposedListingFields`, `findMissingRequiredFields`, `createListingFromFields`, `applyListingFields`, `listingToProposedFields`)
- Modify: `src/lib/data/listings.ts` (interface `ListingWithVenue`, the SELECT column list, and the row-mapping function)
- Modify: `src/lib/data/moderation-parse.test.ts`
- Modify: `src/lib/data/moderation-approve.test.ts`
- Modify: `src/lib/data/moderation-archive-listing.test.ts`
- Modify: `src/lib/data/moderation-source-check.test.ts`

**Interfaces:**
- Consumes: the migration from Task 1 (`sign_up_method_type` enum, three new columns).
- Produces: `ProposedListingFields.signUpMethod: "bucket_lotto" | "first_come" | "curated" | "slotted_online" | "hybrid_other" | null`, `.signUpUrl: string | null`, `.signUpOtherNote: string | null`, `.signUpOpensAt: string | null`; `ListingWithVenue` with the same three additional fields. These are what Tasks 3 and 4 read/write via form fields named `signUpUrl`, `signUpOtherNote`, `signUpOpensAt`.

- [x] **Step 1: Write the failing test for parsing the three new form fields**

In `src/lib/data/moderation-parse.test.ts`, add to the `describe("parseProposedListingFields", ...)` block:

```ts
  it("parses the three sign-up detail fields", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        signUpMethod: "slotted_online",
        signUpUrl: "https://slotted.co/some-mic",
        signUpOtherNote: "",
        signUpOpensAt: "",
      }),
    );

    expect(fields.signUpMethod).toBe("slotted_online");
    expect(fields.signUpUrl).toBe("https://slotted.co/some-mic");
    expect(fields.signUpOtherNote).toBeNull();
    expect(fields.signUpOpensAt).toBeNull();
  });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- moderation-parse`
Expected: FAIL — `fields.signUpUrl` is `undefined` (property doesn't exist yet) or a type error, since `parseProposedListingFields` doesn't read these fields yet.

- [x] **Step 3: Update the `ProposedListingFields` interface**

In `src/lib/data/moderation.ts`, change:

```ts
  signUpMethod: string | null;
```

to:

```ts
  signUpMethod:
    | "bucket_lotto"
    | "first_come"
    | "curated"
    | "slotted_online"
    | "hybrid_other"
    | null;
  signUpUrl: string | null;
  signUpOtherNote: string | null;
```

and add, right after the existing `startTime: string;` line (so it sits near the other timing field):

```ts
  signUpOpensAt: string | null;
```

(Final field order in the interface: `startTime`, `signUpMethod`, `signUpUrl`, `signUpOtherNote`, `signUpOpensAt`, `costToPerform`, ... — order doesn't affect behavior, just keep the four sign-up fields adjacent for readability.)

- [x] **Step 4: Update `parseProposedListingFields`**

In `src/lib/data/moderation.ts`, change:

```ts
    signUpMethod: formData.get("signUpMethod")?.toString() || null,
```

to:

```ts
    signUpMethod: (formData.get("signUpMethod")?.toString() ||
      null) as ProposedListingFields["signUpMethod"],
    signUpUrl: formData.get("signUpUrl")?.toString() || null,
    signUpOtherNote: formData.get("signUpOtherNote")?.toString() || null,
```

and add, right after the `startTime: formData.get("startTime")?.toString() ?? "",` line:

```ts
    signUpOpensAt: formData.get("signUpOpensAt")?.toString() || null,
```

- [x] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- moderation-parse`
Expected: PASS. (This will also surface TypeScript errors from other now-incomplete `ProposedListingFields` object literals in the same test file and elsewhere — that's expected; fixed in later steps of this task.)

- [x] **Step 6: Fix the now-incomplete fixtures in `moderation-parse.test.ts`**

In the `describe("listingToProposedFields", ...)` block, the first test's `listing: ListingWithVenue` literal has `signUpMethod: "Sign-up list at the door",` — change to:

```ts
      signUpMethod: "first_come",
      signUpUrl: null,
      signUpOtherNote: null,
```

and its matching `expect(listingToProposedFields(listing)).toEqual({...})` object's `signUpMethod: "Sign-up list at the door",` line — change to:

```ts
      signUpMethod: "first_come",
      signUpUrl: null,
      signUpOtherNote: null,
```

Also add `signUpOpensAt: null,` to both objects, right after their `startTime` line.

The second test's `listing: ListingWithVenue` literal has `signUpMethod: null,` — leave the value, but add the three new fields as `null` right after it: `signUpUrl: null, signUpOtherNote: null,` (and `signUpOpensAt: null,` after `startTime`).

This won't compile yet — `ListingWithVenue` doesn't have these fields until Step 10. That's fine; proceed.

- [x] **Step 7: Write the failing test for the new required-field rule**

`findMissingRequiredFields` has no dedicated test file yet. Add one to `moderation-parse.test.ts` (it already imports pure functions from `./moderation` and needs no live Supabase connection, matching this function's shape). Add the import and a new `describe` block:

```ts
import {
  listingToProposedFields,
  parseProposedListingFields,
  findMissingRequiredFields,
} from "./moderation";
```

```ts
describe("findMissingRequiredFields", () => {
  const baseFields: ProposedListingFields = {
    type: "mic",
    title: "A Mic",
    host: null,
    description: null,
    venueId: "c0000000-0000-0000-0000-000000000001",
    newVenue: null,
    startTime: "20:00",
    signUpMethod: null,
    signUpUrl: null,
    signUpOtherNote: null,
    signUpOpensAt: null,
    costToPerform: null,
    ticketPrice: null,
    ticketUrl: null,
    recurrence: null,
    oneOffDate: "2026-10-01",
  };

  it("requires signUpOtherNote when signUpMethod is hybrid_other", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "hybrid_other",
      signUpOtherNote: null,
    });

    expect(missing).toContainEqual({
      field: "signUpOtherNote",
      label: "Sign-up explanation",
    });
  });

  it("does not require signUpOtherNote for other sign-up methods", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "first_come",
      signUpOtherNote: null,
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "signUpOtherNote" }),
    );
  });

  it("does not require signUpOtherNote when hybrid_other has a non-empty note", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      signUpMethod: "hybrid_other",
      signUpOtherNote: "Bucket for first half, list for second half",
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "signUpOtherNote" }),
    );
  });
});
```

You'll also need `import type { ProposedListingFields } from "./moderation";` added to this test file's imports (it currently only imports the two functions, not the type).

- [x] **Step 8: Run the test to verify it fails**

Run: `pnpm test -- moderation-parse`
Expected: FAIL on the first new test (`findMissingRequiredFields` doesn't push the `signUpOtherNote` entry yet).

- [x] **Step 9: Implement the validation rule**

In `src/lib/data/moderation.ts`, in `findMissingRequiredFields`, add after the existing `venueId`/`newVenue` block:

```ts
  if (fields.signUpMethod === "hybrid_other" && !fields.signUpOtherNote?.trim()) {
    missing.push({ field: "signUpOtherNote", label: "Sign-up explanation" });
  }
```

- [x] **Step 10: Update `ListingWithVenue` and its read mapping in `src/lib/data/listings.ts`**

In the `ListingWithVenue` interface, replace its `signUpMethod: string | null;` line with:

```ts
  signUpMethod:
    | "bucket_lotto"
    | "first_come"
    | "curated"
    | "slotted_online"
    | "hybrid_other"
    | null;
  signUpUrl: string | null;
  signUpOtherNote: string | null;
```

and add `signUpOpensAt: string | null;` near `startTime` (this one's a genuine addition, not a replacement).

In the SELECT column list (the line reading `sign_up_method, cost_to_perform, ticket_price, ticket_url,`), change to:

```ts
  sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
  cost_to_perform, ticket_price, ticket_url,
```

In the row-mapping function, change `signUpMethod: row.sign_up_method,` to also map the three new columns:

```ts
    signUpMethod: row.sign_up_method,
    signUpUrl: row.sign_up_url,
    signUpOtherNote: row.sign_up_other_note,
    signUpOpensAt: row.sign_up_opens_at,
```

- [x] **Step 11: Update `listingToProposedFields`**

In `src/lib/data/moderation.ts`, change `signUpMethod: listing.signUpMethod,` to also carry the three new fields:

```ts
    signUpMethod: listing.signUpMethod,
    signUpUrl: listing.signUpUrl,
    signUpOtherNote: listing.signUpOtherNote,
```

and add `signUpOpensAt: listing.signUpOpensAt,` near `startTime: listing.startTime,`.

- [x] **Step 12: Run the full test file to verify everything so far passes**

Run: `pnpm test -- moderation-parse`
Expected: PASS, all tests in the file.

- [x] **Step 13: Update the write paths — `createListingFromFields`**

In `src/lib/data/moderation.ts`, in `createListingFromFields`'s `.insert({...})` call, change `sign_up_method: fields.signUpMethod,` to also include:

```ts
      sign_up_method: fields.signUpMethod,
      sign_up_url: fields.signUpUrl,
      sign_up_other_note: fields.signUpOtherNote,
      sign_up_opens_at: fields.signUpOpensAt,
```

- [x] **Step 14: Update the write paths — `applyListingFields`**

In the same file, in `applyListingFields`'s `.update({...})` call, make the identical change to `sign_up_method: fields.signUpMethod,`.

- [x] **Step 15: Fix the now-incomplete fixtures in `moderation-approve.test.ts`**

This file has explicit `ProposedListingFields`-typed object literals at (originally) lines 67, 85, 157, 180, 260, and 331 with `signUpMethod: null,` or `signUpMethod: "text to sign up",`. For each one:
- If the value is `signUpMethod: null,`, add right after it: `signUpUrl: null,\n      signUpOtherNote: null,` (matching the literal's existing indentation), and add `signUpOpensAt: null,` right after its `startTime` line.
- The one at (originally) line 85 reads `signUpMethod: "text to sign up",` — change the value to `signUpMethod: "curated",` and add the same three new fields as `null`.

Also check the `proposed_data: {...}` object passed to `createPendingEntry` near the top of the first test (originally around line 67) — it is a plain object (not typed as `ProposedListingFields`), so it won't fail to compile, but update its `signUpMethod: null,` line the same way for consistency with what a real caller would send, adding the three new fields as `null`.

- [x] **Step 16: Fix the now-incomplete fixture in `moderation-archive-listing.test.ts`**

At (originally) line 122, the `fields: ProposedListingFields` literal has `signUpMethod: null,`. Add right after it: `signUpUrl: null,\n      signUpOtherNote: null,`, and add `signUpOpensAt: null,` after its `startTime` line.

- [x] **Step 17: Fix the now-incomplete fixture in `moderation-source-check.test.ts`**

The `SAMPLE_FIELDS` object has `signUpMethod: "sign-up list at the door, 7:30pm",` at (originally) line 18. Change to `signUpMethod: "first_come" as const,` and add `signUpUrl: null,\n  signUpOtherNote: null,` right after it, plus `signUpOpensAt: null,` after its `startTime` line.

- [x] **Step 18: Run the full test suite**

Run: `pnpm test`
Expected: PASS, all files. (`pnpm test -- moderation-approve`, `moderation-archive-listing`, and `moderation-source-check` hit a real local Supabase instance — make sure it's running via `supabase status`, starting it with `supabase start` if not.)

- [x] **Step 19: Type-check the whole project**

Run: `pnpm run check`
Expected: no errors. This catches any remaining `ProposedListingFields`/`ListingWithVenue` literal in the codebase this task's steps didn't already enumerate.

- [x] **Step 20: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/listings.ts \
  src/lib/data/moderation-parse.test.ts src/lib/data/moderation-approve.test.ts \
  src/lib/data/moderation-archive-listing.test.ts src/lib/data/moderation-source-check.test.ts \
  src/lib/supabase/database.types.ts
git commit -m "feat(data): thread structured sign-up method through parse, validation, read, and write paths"
```

---

## Task 3: Moderator form UI

**Files:**
- Modify: `src/lib/utils/moderation-labels.ts` (add `SIGN_UP_METHOD_OPTIONS`, `SIGN_UP_METHOD_LABEL`)
- Modify: `src/components/moderation/ListingFieldsFields.astro`

**Interfaces:**
- Consumes: `ProposedListingFields` fields from Task 2 (`signUpMethod`, `signUpUrl`, `signUpOtherNote`, `signUpOpensAt`); form field names `signUpMethod`, `signUpUrl`, `signUpOtherNote`, `signUpOpensAt` (already read by `parseProposedListingFields` from Task 2).
- Produces: `SIGN_UP_METHOD_OPTIONS: { value: string; label: string }[]` and `SIGN_UP_METHOD_LABEL: Record<string, string>`, consumed by Task 4's display templates.

- [x] **Step 1: Add the label constants**

In `src/lib/utils/moderation-labels.ts`, add after `WEEK_OF_MONTH_OPTIONS`:

```ts
export const SIGN_UP_METHOD_OPTIONS = [
  { value: "", label: "Choose a sign-up method" },
  { value: "bucket_lotto", label: "Bucket / Lotto" },
  { value: "first_come", label: "First Come / First Served" },
  { value: "curated", label: "Curated / Booked" },
  { value: "slotted_online", label: "Slotted (Online)" },
  { value: "hybrid_other", label: "Hybrid / Other" },
];

export const SIGN_UP_METHOD_LABEL: Record<string, string> = {
  bucket_lotto: "Bucket / Lotto",
  first_come: "First Come / First Served",
  curated: "Curated / Booked",
  slotted_online: "Slotted (Online)",
  hybrid_other: "Hybrid / Other",
};
```

- [x] **Step 2: Replace the free-text field with the dropdown**

In `src/components/moderation/ListingFieldsFields.astro`, add `SIGN_UP_METHOD_OPTIONS` to the existing import from `moderation-labels`:

```ts
import {
  DAY_OF_WEEK_OPTIONS,
  FREQUENCY_OPTIONS,
  SIGN_UP_METHOD_OPTIONS,
  TYPE_OPTIONS,
  WEEK_OF_MONTH_OPTIONS,
} from "../../lib/utils/moderation-labels";
```

Add near the other `const initial*`/`is*` declarations (after `const isMonthly = ...`):

```ts
const initialSignUpMethod = prefill?.signUpMethod ?? "";
```

Replace this block:

```astro
  <div data-field-for="mic" hidden={initialType === "show"}>
    <FormField
      label="Sign-up method"
      name="signUpMethod"
      placeholder="Sign-up list at the door, 7:30pm"
      value={prefill?.signUpMethod ?? ""}
    />
  </div>
```

with:

```astro
  <div data-field-for="mic" hidden={initialType === "show"}>
    <FormSelect
      label="Sign-up method"
      name="signUpMethod"
      options={SIGN_UP_METHOD_OPTIONS}
      value={initialSignUpMethod}
    />
    <div
      data-signup-for="slotted_online"
      hidden={initialSignUpMethod !== "slotted_online"}
      class="mt-4"
    >
      <FormField
        label="Slotted.co URL"
        name="signUpUrl"
        type="url"
        placeholder="https://slotted.co/…"
        value={prefill?.signUpUrl ?? ""}
      />
    </div>
    <div
      data-signup-for="hybrid_other"
      hidden={initialSignUpMethod !== "hybrid_other"}
      class="mt-4"
    >
      <FormField
        label="Explain sign-up method"
        name="signUpOtherNote"
        required
        value={prefill?.signUpOtherNote ?? ""}
        error={fieldErrors.signUpOtherNote}
      />
    </div>
    <div
      data-signup-for="drop_time"
      hidden={
        initialSignUpMethod !== "bucket_lotto" &&
        initialSignUpMethod !== "first_come"
      }
      class="mt-4"
    >
      <FormField
        label="Sign-up opens at"
        name="signUpOpensAt"
        type="time"
        value={prefill?.signUpOpensAt ?? ""}
      />
    </div>
  </div>
```

- [x] **Step 3: Add the toggle script**

In the `<script>` block at the bottom of the file, add after the existing `frequencySelects` loop and before the `venueSelects` loop:

```ts
  const signUpSelects = document.querySelectorAll<HTMLSelectElement>(
    'select[name="signUpMethod"]',
  );
  for (const select of signUpSelects) {
    const form = select.closest("form");
    if (!form) continue;
    const urlFields = form.querySelectorAll<HTMLElement>(
      '[data-signup-for="slotted_online"]',
    );
    const otherFields = form.querySelectorAll<HTMLElement>(
      '[data-signup-for="hybrid_other"]',
    );
    const dropTimeFields = form.querySelectorAll<HTMLElement>(
      '[data-signup-for="drop_time"]',
    );

    const sync = () => {
      const value = select.value;
      setGroupState(Array.from(urlFields), value !== "slotted_online");
      setGroupState(Array.from(otherFields), value !== "hybrid_other");
      setGroupState(
        Array.from(dropTimeFields),
        value !== "bucket_lotto" && value !== "first_come",
      );
    };
    select.addEventListener("change", sync);
    sync();
  }
```

- [x] **Step 4: Type-check**

Run: `pnpm run check`
Expected: no errors.

- [x] **Step 5: Manual verification**

This component has no dedicated unit test. Verified via Playwright against `/admin/listings/new` (logged in as `TEST_MODERATOR_1`):
- Selecting "Slotted (Online)" reveals the URL field and hides the other two. ✓
- Selecting "Hybrid / Other" reveals the explanation field, marked required. ✓
- Selecting "Bucket / Lotto" reveals the drop-time field. ✓
- Selecting "First Come / First Served" also reveals the drop-time field (shared trigger). ✓
- Selecting "Curated / Booked" (or the placeholder) hides all three. ✓
- Switching "Type" to "Show" hides the entire sign-up block, including whichever conditional field was open (existing `data-field-for="mic"` behavior, untouched). ✓
- No console errors or warnings during the session.

- [ ] **Step 6: Commit**

```bash
git add src/lib/utils/moderation-labels.ts src/components/moderation/ListingFieldsFields.astro
git commit -m "feat(form): turn sign-up method into a dropdown with conditional detail fields"
```

---

## Task 4: Public display

**Files:**
- Modify: `src/pages/index.astro`
- Modify: `src/components/listings/ListingRow.astro`
- Modify: `src/pages/listings/[id].astro`

**Interfaces:**
- Consumes: `SIGN_UP_METHOD_LABEL` from Task 3; `ListingWithVenue.signUpUrl`/`.signUpOtherNote`/`.signUpOpensAt` from Task 2; `formatTime` from `src/lib/utils/format.ts`.

- [ ] **Step 1: Pass the new fields through `index.astro`**

In `src/pages/index.astro`, find the mapping that currently includes `signUpMethod: listing.signUpMethod,` (used to build `ListingRowData`) and add the two fields `ListingRow` needs:

```ts
      signUpMethod: listing.signUpMethod,
      signUpUrl: listing.signUpUrl,
```

(`signUpOtherNote`/`signUpOpensAt` are detail-page-only per the spec — `ListingRow` doesn't need them.)

- [ ] **Step 2: Update `ListingRow.astro`'s props and rendering**

In `src/components/listings/ListingRow.astro`, add to the `ListingRowData` interface, right after `signUpMethod?: string | null;`:

```ts
  signUpUrl?: string | null;
```

Add `signUpUrl` to the destructured props (right after `signUpMethod,`).

Add the import at the top of the file:

```ts
import { SIGN_UP_METHOD_LABEL } from "../../lib/utils/moderation-labels";
```

Replace:

```astro
    {
      type === "mic" && signUpMethod && (
        <p class="mt-0.75 text-[0.86rem] font-medium text-ink">
          Sign-up: {signUpMethod}
        </p>
      )
    }
```

with:

```astro
    {
      type === "mic" && signUpMethod && (
        <p class="mt-0.75 text-[0.86rem] font-medium text-ink">
          Sign-up:{" "}
          {signUpMethod === "slotted_online" && signUpUrl ? (
            <a href={signUpUrl} target="_blank" rel="noopener" class="underline underline-offset-2">
              {SIGN_UP_METHOD_LABEL[signUpMethod]}
            </a>
          ) : (
            SIGN_UP_METHOD_LABEL[signUpMethod]
          )}
        </p>
      )
    }
```

- [ ] **Step 3: Update `listings/[id].astro`'s rendering**

Add the import:

```ts
import { SIGN_UP_METHOD_LABEL } from "../../lib/utils/moderation-labels";
```

Replace:

```astro
          {listing.signUpMethod && (
            <>
              <dt class={label}>Sign-up</dt>
              <dd>{listing.signUpMethod}</dd>
            </>
          )}
```

with:

```astro
          {listing.signUpMethod && (
            <>
              <dt class={label}>Sign-up</dt>
              <dd>
                {listing.signUpMethod === "slotted_online" && listing.signUpUrl ? (
                  <a href={listing.signUpUrl} target="_blank" rel="noopener" class="underline underline-offset-2">
                    {SIGN_UP_METHOD_LABEL[listing.signUpMethod]}
                  </a>
                ) : (
                  SIGN_UP_METHOD_LABEL[listing.signUpMethod]
                )}
              </dd>
            </>
          )}
          {listing.signUpMethod === "hybrid_other" && listing.signUpOtherNote && (
            <>
              <dt class={label}>Sign-up details</dt>
              <dd>{listing.signUpOtherNote}</dd>
            </>
          )}
          {(listing.signUpMethod === "bucket_lotto" ||
            listing.signUpMethod === "first_come") &&
            listing.signUpOpensAt && (
              <>
                <dt class={label}>Sign-up opens</dt>
                <dd>{formatTime(listing.signUpOpensAt)}</dd>
              </>
            )}
```

`formatTime` is already imported in this file (used for `timeLabel`), so no new import is needed for it.

- [ ] **Step 4: Type-check**

Run: `pnpm run check`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: PASS (no test file directly covers these Astro templates, but this confirms nothing else broke).

- [ ] **Step 6: Manual verification**

Same constraint as Task 3 — don't start the dev server yourself; ask the user to check `/` and a mic's detail page with each of the five sign-up methods (using the seed data from Task 1, or by direct-adding a test listing) to confirm the row stays a plain label (or a linked label for `slotted_online` with a URL) and the detail page shows the extra note/drop-time lines correctly.

- [ ] **Step 7: Commit**

```bash
git add src/pages/index.astro src/components/listings/ListingRow.astro src/pages/listings/\[id\].astro
git commit -m "feat(display): render structured sign-up method label, link, note, and drop time"
```

---

## Task 5: check-sources agent contract

**Files:**
- Modify: `.claude/skills/check-sources/SKILL.md`

**Interfaces:**
- Consumes: the five enum values from Task 1/2 (documentation only — no code dependency).

- [ ] **Step 1: Update the JSON shape in step 6**

In `.claude/skills/check-sources/SKILL.md`, replace:

```
      "signUpMethod": "string or null",
```

with:

```
      "signUpMethod": "bucket_lotto" | "first_come" | "curated" | "slotted_online" | "hybrid_other" | null,
      "signUpUrl": "string or null",
      "signUpOtherNote": "string or null",
      "signUpOpensAt": "HH:MM or null",
```

- [ ] **Step 2: Add classification guidance**

Immediately after the JSON code block (before the `newVenue is always null...` sentence), add:

```
   Classifying `signUpMethod` from what the page says: `bucket_lotto` (names drawn from a bucket/hat/lottery), `first_come` (no list, arrive early), `curated` (host books performers, no public sign-up), `slotted_online` (a link like slotted.co — put it in `signUpUrl`), `hybrid_other` (doesn't fit cleanly — explain in `signUpOtherNote`). If the page states a specific time the list/bucket opens, put it in `signUpOpensAt`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/check-sources/SKILL.md
git commit -m "docs(check-sources): update sign-up method contract to the structured enum"
```

---

## Task 6: Dev-data template pipeline

**Files:**
- Modify: `data/open-mic-listings-template.csv`
- Modify: `data/open-mic-listings-template.md`
- Modify: `supabase/seeds/03_open_mic_listings.sql`

**Interfaces:**
- Consumes: the five enum values and three detail-field names from Task 1/2.

- [ ] **Step 1: Split the CSV template's column**

In `data/open-mic-listings-template.csv`, change the header row's `sign_up_method` column into four columns, and update the one example row (`The Comedy Store` / `Whatever Wednesday Mic`) to match:

```
type,title,host,description,venue_name,frequency,day_of_week,week_of_month,one_off_date,start_time,sign_up_method,sign_up_url,sign_up_other_note,sign_up_opens_at,cost_to_perform,ticket_price,ticket_url
mic,Whatever Wednesday Mic,Alex Rivera,,The Comedy Store,weekly,3,,,20:00,first_come,,,19:30,Free,,
```

- [ ] **Step 2: Update the column guide**

In `data/open-mic-listings-template.md`, replace the `sign_up_method` row of the table with four rows:

```
| `sign_up_method` | `first_come` | mic-specific; blank for shows. One of `bucket_lotto`, `first_come`, `curated`, `slotted_online`, `hybrid_other` |
| `sign_up_url` | *(blank)* | only when `sign_up_method` is `slotted_online`; optional even then |
| `sign_up_other_note` | *(blank)* | required when `sign_up_method` is `hybrid_other`; blank otherwise |
| `sign_up_opens_at` | `19:30` | only when `sign_up_method` is `bucket_lotto` or `first_come`; 24-hour `HH:MM`, blank otherwise |
```

Update the sentence above the table that says the example uses `Sign-up-up list at the door, 7:30pm` (if any) and the sentence below the table listing which columns a one-off show leaves blank — add `sign_up_url`, `sign_up_other_note`, `sign_up_opens_at` to that list alongside the existing `sign_up_method`.

- [ ] **Step 3: Update the seed file's placeholder row**

In `supabase/seeds/03_open_mic_listings.sql`, update the column lists (both the `insert into listings (...)` column list and the `values(...)` alias list) to include the three new columns, and update the placeholder row's `sign_up_method` value and the commented example row to match:

```sql
with new_listings as (
  insert into listings (
    type, title, host, description, venue_id, start_time, one_off_date,
    sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
    cost_to_perform, ticket_price, ticket_url, status
  )
  select
    v.type::listing_type, v.title, v.host, v.description, ven.id,
    v.start_time::time, v.one_off_date::date, v.sign_up_method::sign_up_method_type,
    v.sign_up_url, v.sign_up_other_note, v.sign_up_opens_at::time,
    v.cost_to_perform, v.ticket_price, v.ticket_url, 'published'
  from (values
    -- ('mic', 'Example Mic Name', 'Example Host', null, 'Example Venue Name', '20:00', null, 'first_come', null, null, '19:30', 'Free', null, null)
    ('mic', '__EXAMPLE_REPLACE_ME__', null, null, '__EXAMPLE_VENUE_REPLACE_ME__', '20:00', null, 'first_come', null, null, '19:30', 'Free', null, null)
  ) as v(
    type, title, host, description, venue_name, start_time, one_off_date,
    sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
    cost_to_perform, ticket_price, ticket_url
  )
  join venues ven on ven.name = v.venue_name
  where not exists (
    select 1 from listings existing
    where existing.venue_id = ven.id and existing.title = v.title
  )
  returning id, title
)
```

Note the explicit `::sign_up_method_type` and `::time` casts on `v.sign_up_method` and `v.sign_up_opens_at` — needed because the `values(...)` list's columns are untyped literals, same reason `v.type::listing_type` and `v.start_time::time` are already cast this way.

- [ ] **Step 4: Reset the local database and verify**

Run: `supabase db reset`
Expected: completes with no errors (this exercises the placeholder row's type-correctness, even though it never actually inserts).

- [ ] **Step 5: Commit**

```bash
git add data/open-mic-listings-template.csv data/open-mic-listings-template.md \
  supabase/seeds/03_open_mic_listings.sql
git commit -m "docs(seeds): split sign-up method template column into structured fields"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: PASS, all files.

- [ ] **Step 2: Type-check**

Run: `pnpm run check`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `pnpm run build`
Expected: succeeds.

- [ ] **Step 4: Fresh database reset**

Run: `supabase db reset`
Expected: succeeds end-to-end (migrations + all seed files, including the updated `03_open_mic_listings.sql`).

- [ ] **Step 5: Ask the user to do a final manual pass**

Per this project's convention (Claude doesn't cycle the local dev server), ask the user to run `astro dev --background`, then check: direct-add a mic with each of the five sign-up methods, confirm the required-field error appears when "Hybrid / Other" is chosen with no explanation, and confirm the public homepage and a listing detail page render correctly for each.
