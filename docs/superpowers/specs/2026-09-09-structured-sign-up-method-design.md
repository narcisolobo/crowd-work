# Structured Sign-Up Method — Design

**Status:** Approved for implementation planning
**Related:** [src/components/moderation/ListingFieldsFields.astro](../../../src/components/moderation/ListingFieldsFields.astro), [src/lib/data/moderation.ts](../../../src/lib/data/moderation.ts), [src/lib/data/listings.ts](../../../src/lib/data/listings.ts), [.claude/skills/check-sources/SKILL.md](../../../.claude/skills/check-sources/SKILL.md)

## Summary

`signUpMethod` is currently a single free-text field: moderators type anything into it, the sourcing agent guesses at free text too, and the public site just echoes the string back. There are only five real shapes a stand-up open mic's sign-up actually takes, plus two pieces of detail that only apply to two of them (a slotted.co-style URL, and a required explanation for anything that doesn't fit cleanly) and one piece of detail that applies to two others (what time a bucket/list opens). This phase replaces the free-text field with a five-value enum plus three narrowly-scoped detail fields, threading the change through the DB schema, the shared `ProposedListingFields` type, every read/write path that touches it, the public display templates, the check-sources agent's JSON contract, and the in-progress dev-data template pipeline.

## Goals

- Replace free-text `sign_up_method` with a constrained enum: `bucket_lotto`, `first_come`, `curated`, `slotted_online`, `hybrid_other`.
- Add three new optional detail fields, each meaningful only for specific enum values: `sign_up_url` (text, `slotted_online`), `sign_up_other_note` (text, required when `hybrid_other`), `sign_up_opens_at` (time, `bucket_lotto`/`first_come`).
- Keep the moderator form's existing conditional-visibility pattern (`data-*` wrapper + shared `setGroupState` toggle script) rather than introducing a new mechanism.
- Update every read/write path, the two public display surfaces, the check-sources prompt contract, and the dev-data CSV/MD template pipeline so nothing is left writing or expecting the old free-text shape.

## Non-goals (this phase)

- **URL format/domain validation beyond the browser's native `type="url"` check.** `sign_up_url` is treated exactly like the existing `ticketUrl`/`newVenueGoogleMapsUrl` fields — no server-side format check, no restriction to the `slotted.co` domain specifically, for consistency with those two.
- **Backfilling real production data.** This project is pre-launch; only fixture/seed data exists, so the migration drops and re-adds the column rather than migrating live values.
- **Restructuring `supabase/seeds/03_open_mic_listings.sql`'s actual confirmed-listing content** beyond matching its column shape to the new fields — no real rows exist there yet (it's a placeholder template row).

## Architecture Overview

One new migration (a new enum type + three new columns on `listings`), one shared type change (`ProposedListingFields` in `src/lib/data/moderation.ts`) that ripples through exactly two write functions and one read function, a form UI change confined to `ListingFieldsFields.astro`, two new lookup constants in `moderation-labels.ts`, small edits to two public display templates, a prompt-contract update in the check-sources skill, and a matching column split in the dev-data CSV/MD template pair.

## Data Model

New Postgres enum, named distinctly from the column (matching the existing `listing_type`/`recurrence_frequency` convention):

```sql
create type sign_up_method_type as enum (
  'bucket_lotto', 'first_come', 'curated', 'slotted_online', 'hybrid_other'
);
```

`listings` table changes, in one new migration:

```sql
alter table listings
  drop column sign_up_method,
  add column sign_up_method sign_up_method_type,
  add column sign_up_url text,
  add column sign_up_other_note text,
  add column sign_up_opens_at time;
```

- `sign_up_method` — nullable (mic-only field, no change to that existing optionality)
- `sign_up_url` — nullable even when `sign_up_method = 'slotted_online'`; a moderator may not have the link
- `sign_up_other_note` — nullable at the DB level, but required at the app layer when `sign_up_method = 'hybrid_other'` (see Validation) — no DB `CHECK`, matching how `newVenue`'s conditionally-required fields already work
- `sign_up_opens_at` — nullable `time`, parallel to `start_time`; meaningful for `bucket_lotto` and `first_come`

`ProposedListingFields` (`src/lib/data/moderation.ts`):

```ts
signUpMethod: "bucket_lotto" | "first_come" | "curated" | "slotted_online" | "hybrid_other" | null;
signUpUrl: string | null;
signUpOtherNote: string | null;
signUpOpensAt: string | null; // "HH:MM", parallel to startTime
```

`ListingWithVenue` (`src/lib/data/listings.ts`) gets the same three additions.

## Form UI (`ListingFieldsFields.astro`)

The dropdown replaces the current free-text field, staying inside the existing `data-field-for="mic"` wrapper (sign-up method stays mic-only) and staying optional (no `required`):

```ts
export const SIGN_UP_METHOD_OPTIONS = [
  { value: "", label: "Choose a sign-up method" },
  { value: "bucket_lotto", label: "Bucket / Lotto" },
  { value: "first_come", label: "First Come / First Served" },
  { value: "curated", label: "Curated / Booked" },
  { value: "slotted_online", label: "Slotted (Online)" },
  { value: "hybrid_other", label: "Hybrid / Other" },
];
```

Three conditional fields, each in its own `data-signup-for="<value>"` wrapper:

- `data-signup-for="slotted_online"` → `FormField type="url" name="signUpUrl" label="Slotted.co URL" placeholder="https://slotted.co/…"` — optional
- `data-signup-for="hybrid_other"` → `FormField name="signUpOtherNote" label="Explain sign-up method" required` — statically `required` in markup (harmless while hidden, since the sync script also disables it and disabled fields are excluded from HTML5 validation and form submission), same trick already used for `newVenue*` fields
- `data-signup-for="drop_time"` → `FormField type="time" name="signUpOpensAt" label="Sign-up opens at"` — optional, shown for **both** `bucket_lotto` and `first_come`

A new toggle block in the existing `<script>`, mirroring the type/frequency toggles already in the file:

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

Initial SSR visibility is computed the same way `initialType`/`isRecurring` are today:

```ts
const initialSignUpMethod = prefill?.signUpMethod ?? "";
```

## Validation and Write Paths

`findMissingRequiredFields(fields: ProposedListingFields)` — the single function already shared by direct-add, direct-edit, and both approve actions — gets one new rule, matching the existing conditionally-required pattern used for `newVenue`'s fields:

```ts
if (fields.signUpMethod === "hybrid_other" && !fields.signUpOtherNote?.trim()) {
  missing.push({ field: "signUpOtherNote", label: "Sign-up explanation" });
}
```

`parseProposedListingFields` gets three new `formData.get(...)` lines for `signUpUrl`, `signUpOtherNote`, `signUpOpensAt`.

Exactly two places write these fields to the `listings` table, both already shared helpers (not duplicated per action):

- `createListingFromFields`'s `.insert()` — shared by `directAddListing` and `approveNewListing`
- `applyListingFields`'s `.update()` — shared by direct-edit and `approveListingUpdate`

Each needs `sign_up_url: fields.signUpUrl, sign_up_other_note: fields.signUpOtherNote, sign_up_opens_at: fields.signUpOpensAt` added alongside the existing `sign_up_method: fields.signUpMethod` line.

## Read Path

`src/lib/data/listings.ts`: add `sign_up_url, sign_up_other_note, sign_up_opens_at` to the `ListingWithVenue` SELECT column list and the row-mapping function.

## Public Display

New lookup constants in `moderation-labels.ts` (same shape as `STATUS_LABEL`/`CHANGE_TYPE_LABEL`), shared by the admin form dropdown and both public display templates:

```ts
export const SIGN_UP_METHOD_LABEL: Record<string, string> = {
  bucket_lotto: "Bucket / Lotto",
  first_come: "First Come / First Served",
  curated: "Curated / Booked",
  slotted_online: "Slotted (Online)",
  hybrid_other: "Hybrid / Other",
};
```

**`ListingRow.astro` (compact list row):** a plain label swap, no new elements — `Sign-up: {SIGN_UP_METHOD_LABEL[signUpMethod]}` — **except** when `signUpMethod === "slotted_online"` and `signUpUrl` is present, in which case the label itself becomes the link: `Sign-up: <a href={signUpUrl}>Slotted (Online)</a>`. This deliberately diverges from the `ticketUrl` precedent (a separate "Buy tickets" link) because the title column here is already stacked with title/badge/venue/host/note — a second block-level link was judged too crowded; the price column where `ticketUrl` lives has room to spare by comparison. No note or drop time appears in the row for any method.

**`listings/[id].astro` (detail page):** the fuller treatment, since there's room — same label-as-link behavior for the URL, plus (when present) the `signUpOtherNote` text and `signUpOpensAt` (formatted via the existing `formatTime` helper) as additional lines.

**`index.astro`** just needs its listing→`ListingRowData` mapping extended with the three new pass-through fields, same as it already does for `signUpMethod`.

## check-sources Contract (`.claude/skills/check-sources/SKILL.md`)

The JSON shape in step 6 gets the three new fields:

```json
"signUpMethod": "bucket_lotto" | "first_come" | "curated" | "slotted_online" | "hybrid_other" | null,
"signUpUrl": "string or null",
"signUpOtherNote": "string or null",
"signUpOpensAt": "HH:MM or null"
```

Plus a short classification guide for the agent, e.g.:

> `bucket_lotto`: names drawn from a bucket/hat/lottery. `first_come`: no list, arrive early. `curated`: host books performers, no public sign-up. `slotted_online`: a link like slotted.co. `hybrid_other`: doesn't fit cleanly — fill in `signUpOtherNote`.

This is a prompt-only change — `scripts/submit-source-finding.mjs` and `submitSourceCheckFinding` pass `fields` through as opaque JSON, so neither needs code changes.

## Dev-Data Template Pipeline

Three files, updated together to keep the pipeline consistent end to end:

- **`data/open-mic-listings-template.csv`** — the single `sign_up_method` column splits into four: `sign_up_method`, `sign_up_url`, `sign_up_other_note`, `sign_up_opens_at`. The existing example row (`The Comedy Store`, `"Sign-up list at the door, 7:30pm"`) gets rewritten to a valid enum value with the drop time moved into `sign_up_opens_at`.
- **`data/open-mic-listings-template.md`** — the column guide table gets the same four-column split documented, with the five enum values spelled out (mirroring `SIGN_UP_METHOD_LABEL`) so whoever fills in a row knows which value to use.
- **`supabase/seeds/03_open_mic_listings.sql`** — the placeholder `values()` row and its commented example both get the same column split, so `db reset` keeps working (the placeholder currently supplies a free-text literal with no cast, which would otherwise fail against the new enum column type even though the row never actually inserts) and the file stays an accurate template.

## Migration

One new migration file (e.g. `<timestamp>_structured_sign_up_method.sql`):

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

`supabase/seed.sql`'s two existing `sign_up_method` values (`'sign-up list at the door, 7:30pm'` and `'app sign-up opens 6pm'`) get rewritten to valid enum values (both fit `first_come`), with their drop times moved into `sign_up_opens_at`.

## Tests to Update

- `moderation-parse.test.ts` — form-data parsing fixtures and assertions for the three new fields
- `moderation-approve.test.ts` and `moderation-archive-listing.test.ts` — wherever a `ProposedListingFields` fixture sets `signUpMethod: "..."`, needs a valid enum value
- `moderation-source-check.test.ts` — same fixture concern
