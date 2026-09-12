# Biweekly ("Every Other Week") Recurrence — Design

**Status:** Approved for implementation planning
**Related:** [supabase/migrations/20260902194949_listings_and_resources.sql](../../../supabase/migrations/20260902194949_listings_and_resources.sql), [src/lib/utils/recurrence.ts](../../../src/lib/utils/recurrence.ts), [src/lib/data/moderation.ts](../../../src/lib/data/moderation.ts), [src/lib/data/listings.ts](../../../src/lib/data/listings.ts), [src/components/moderation/ListingFieldsFields.astro](../../../src/components/moderation/ListingFieldsFields.astro)

## Summary

`recurrence_rules.frequency` only supports `weekly` and `monthly`. Several real listings from the source data (e.g. Ice House's "Breaking The Ice", Chevalier's Books' open mic, Laughology at UCSB) run every other week — a pattern the schema can't represent today. Rather than adding a third `frequency` enum value (which would need two migrations, since Postgres won't let a newly-added enum value be referenced in the same transaction that added it, and would duplicate most of the existing weekly occurrence-calculation logic), this phase adds an `interval_weeks` column to `recurrence_rules` (default `1`) plus an `anchor_date` that's required whenever the interval is greater than one. "Every other week" becomes `frequency = 'weekly', interval_weeks = 2`, calculated as a week-parity filter on the existing weekly date-generation logic.

While touching this table, this phase also closes a pre-existing gap noted in `notes/todo.md`: `week_of_month` is range-checked but never tied to `frequency = 'monthly'`, so a bad row could set it on a non-monthly listing, or a monthly listing could be missing it entirely, with no error either way.

## Goals

- Add `interval_weeks` (smallint, default `1`, `>= 1`) and `anchor_date` (date, nullable) to `recurrence_rules`.
- Enforce, via `CHECK` constraints: `anchor_date` is required (and must fall on `day_of_week`) exactly when `interval_weeks > 1`; `week_of_month` is required exactly when `frequency = 'monthly'` and forbidden otherwise; `interval_weeks` must be `1` for monthly listings.
- Extend `resolveRecurringDates`'s weekly branch in `recurrence.ts` to honor `interval_weeks`/`anchor_date` via a week-parity check, without introducing a new parallel branch.
- Surface a 4th option in the admin form's frequency dropdown — "Every other week" — that maps to `frequency: "weekly", intervalWeeks: 2` server-side, plus a conditionally-shown/required anchor-date field.
- Add the same conditionally-required-field validation pattern already used for `signUpOtherNote` to cover both new invariants (`anchorDate` when `intervalWeeks > 1`, `weekOfMonth` when `frequency === "monthly"`).
- Extend the two seed-authoring surfaces (`03_open_mic_listings.sql`, the CSV/MD template pair) with the two new columns.

## Non-goals (this phase)

- **A generic "every N weeks" UI.** The schema supports any `interval_weeks >= 1`, but the admin form only exposes "Weekly" and "Every other week." Any future cadence beyond that is a label/option addition only, not a schema change — no need to build it now.
- **Fixing `day_of_week`'s missing required-field validation.** It's already `not null` at the DB level and has no app-layer "missing" check today; that's a pre-existing gap this phase doesn't touch.
- **Backfilling real data.** Pre-launch; no production rows exist yet, and no existing fixture (`supabase/seed.sql`, test fixtures) currently violates either new constraint (verified below), so this is additive only.
- **Re-adding the specific biweekly listings** (Ice House, Chevalier's Books, Laughology) to the seed/CSV data. That's a data-entry follow-up once the schema lands, not part of this spec.
- **Occurrence-exception handling changes.** `occurrence_exceptions` doesn't reference frequency/interval at all; nothing there changes.

## Architecture Overview

One migration (two new columns, two new `CHECK` constraints, no enum change). One extension to the shared occurrence-calculation function in `recurrence.ts`. A form-level "cadence" concept in `ListingFieldsFields.astro`/`moderation-labels.ts` that's richer than the underlying `frequency` column, translated server-side in `moderation.ts`. Two new fields threaded through `ProposedListingFields`, `ListingWithVenue`, and both existing write paths (create, update). Matching column additions to the seed SQL and CSV/MD template pair.

## Data Model

Migration (single file, e.g. `<timestamp>_recurrence_interval_weeks.sql`):

```sql
alter table recurrence_rules
  add column interval_weeks smallint not null default 1
    check (interval_weeks >= 1),
  add column anchor_date date;

alter table recurrence_rules
  add constraint recurrence_rules_anchor_date_for_interval check (
    (interval_weeks = 1 and anchor_date is null)
    or (
      interval_weeks > 1
      and anchor_date is not null
      and extract(dow from anchor_date) = day_of_week
    )
  );

alter table recurrence_rules
  add constraint recurrence_rules_monthly_fields check (
    (frequency = 'monthly' and week_of_month is not null and interval_weeks = 1)
    or (frequency = 'weekly' and week_of_month is null)
  );
```

Verified against existing fixtures before writing this: `supabase/seed.sql`'s two `recurrence_rules` rows (one `weekly` with no `week_of_month`, one `monthly` with `week_of_month = -1`) both already satisfy `recurrence_rules_monthly_fields` as written, so no fixture rewrite is required for the schema change itself (test fixtures for `ProposedListingFields` still need the new TypeScript fields — see Tests to Update).

`anchor_date` semantics: any real date of a confirmed occurrence (not necessarily the first one ever) that the app uses to determine week parity for later dates — see Occurrence Calculation below. The `extract(dow from anchor_date) = day_of_week` clause guards against a transcription mistake (an anchor date that doesn't even fall on the listing's stated weekday).

`ListingWithVenue['recurrenceRule']` (`src/lib/data/listings.ts:42-46`) and `ProposedListingFields['recurrence']` (`src/lib/data/moderation.ts:38-42`) both gain the same two fields:

```ts
intervalWeeks: number;       // 1 by default; only >1 for weekly listings
anchorDate: string | null;   // "YYYY-MM-DD"; non-null exactly when intervalWeeks > 1
```

## Occurrence Calculation (`src/lib/utils/recurrence.ts`)

`RecurrenceRule` gains two optional fields (optional here, unlike the DB-adjacent types above, since this module is a generic calculation library used with `weekOfMonth` already optional the same way):

```ts
export interface RecurrenceRule {
  frequency: 'weekly' | 'monthly';
  dayOfWeek: number;
  weekOfMonth?: number;
  intervalWeeks?: number; // default 1 when absent
  anchorDate?: string;    // required when intervalWeeks > 1
}
```

`resolveRecurringDates`'s weekly branch passes both through; `weeklyDatesInRange` gains the two parameters and filters on interval:

```ts
function weeklyDatesInRange(
  dayOfWeek: number,
  intervalWeeks: number,
  anchorDate: string | undefined,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  const dates: string[] = [];
  let current = toUTCDate(rangeStart);
  const end = toUTCDate(rangeEnd);
  const anchor = anchorDate ? toUTCDate(anchorDate) : null;
  while (current <= end) {
    if (
      current.getUTCDay() === dayOfWeek &&
      (intervalWeeks <= 1 || (anchor && isOnIntervalWeek(current, anchor, intervalWeeks)))
    ) {
      dates.push(toDateStr(current));
    }
    current = addDays(current, 1);
  }
  return dates;
}

function isOnIntervalWeek(date: Date, anchor: Date, intervalWeeks: number): boolean {
  const daysBetween = Math.round((date.getTime() - anchor.getTime()) / 86_400_000);
  const weeksBetween = daysBetween / 7; // integer: both fall on the same weekday
  return ((weeksBetween % intervalWeeks) + intervalWeeks) % intervalWeeks === 0;
}
```

`monthlyDatesInRange` and `nthWeekdayOfMonth` are untouched. This is a two-parameter addition to one existing function, not a new sibling branch.

## Form UI (`ListingFieldsFields.astro`, `moderation-labels.ts`)

`FREQUENCY_OPTIONS` (`moderation-labels.ts`) gains a 4th, form-only value that does **not** correspond 1:1 to the `frequency` column:

```ts
export const FREQUENCY_OPTIONS = [
  { value: "", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "every_other_week", label: "Every other week" },
  { value: "monthly", label: "Monthly" },
];
```

A new conditional field, following the same `data-recurrence-for="..."` + `setGroupState` pattern already used for the monthly-only `weekOfMonth` field:

```html
<div data-recurrence-for="every-other-week" hidden={!isEveryOtherWeek}>
  <FormField
    label="Anchor date (any confirmed occurrence)"
    name="anchorDate"
    type="date"
    value={prefill?.recurrence?.anchorDate ?? ""}
  />
</div>
```

`isEveryOtherWeek` is computed the same way `isMonthly` is today, from the prefill's derived form-value (see Validation and Write Paths for how `intervalWeeks`/`frequency` round-trip back into the single `every_other_week` form value on edit). The existing `<script>` block's frequency-toggle loop gets one more branch alongside `recurringFields`/`monthlyFields`:

```ts
const everyOtherWeekFields = form.querySelectorAll<HTMLElement>(
  '[data-recurrence-for="every-other-week"]',
);
// inside sync():
setGroupState(Array.from(everyOtherWeekFields), select.value !== "every_other_week");
```

## Validation and Write Paths (`src/lib/data/moderation.ts`)

`parseProposedListingFields` translates the form's 4-value cadence into the DB-shaped `{ frequency, intervalWeeks }` pair:

```ts
const cadence = formData.get("frequency")?.toString();
const isRecurring =
  cadence === "weekly" || cadence === "every_other_week" || cadence === "monthly";
recurrence: isRecurring
  ? {
      frequency: cadence === "monthly" ? "monthly" : "weekly",
      intervalWeeks: cadence === "every_other_week" ? 2 : 1,
      dayOfWeek: Number(formData.get("dayOfWeek")),
      weekOfMonth: formData.get("weekOfMonth")
        ? Number(formData.get("weekOfMonth"))
        : null,
      anchorDate: formData.get("anchorDate")?.toString() || null,
    }
  : null,
```

`findMissingRequiredFields` gets two new rules, matching the existing `signUpOtherNote`-for-`hybrid_other` pattern exactly:

```ts
if (
  fields.recurrence &&
  fields.recurrence.intervalWeeks > 1 &&
  !fields.recurrence.anchorDate
) {
  missing.push({ field: "anchorDate", label: "Anchor date" });
}
if (
  fields.recurrence?.frequency === "monthly" &&
  fields.recurrence.weekOfMonth == null
) {
  missing.push({ field: "weekOfMonth", label: "Week of month" });
}
```

The second rule is the week_of_month/frequency gap fix — it didn't exist before this phase.

Both existing write paths (`createListingFromFields`'s `.insert()` at `moderation.ts:490-498`, and the symmetric `.update()` used by direct-edit/`approveListingUpdate` around line 676) add `interval_weeks: fields.recurrence.intervalWeeks, anchor_date: fields.recurrence.anchorDate` alongside the existing three `recurrence_rules` columns. No new write path — both are already shared helpers, not duplicated per action.

## Read Path (`src/lib/data/listings.ts`)

- `LISTING_WITH_VENUE_SELECT`'s `recurrence_rules ( ... )` sub-select (line 87) adds `interval_weeks, anchor_date`.
- `mapListingRow`'s `recurrenceRule` construction (lines 115-121) adds `intervalWeeks: row.recurrence_rules.interval_weeks, anchorDate: row.recurrence_rules.anchor_date`.
- `toRecurrenceListing` (lines 225-238) passes both through to the `recurrence.ts` shape, converting `null` to `undefined` the same way it already does for `weekOfMonth`: `intervalWeeks: listing.recurrenceRule.intervalWeeks, anchorDate: listing.recurrenceRule.anchorDate ?? undefined`.

## Seed and Template Pipeline

- **`supabase/seeds/03_open_mic_listings.sql`** — the `recurrence_rules` `values()` list and its column list (currently `frequency, day_of_week, week_of_month`) gain `interval_weeks, anchor_date`; the header comment documenting how to add a recurring row gets a one-line mention of the new columns.
- **`data/open-mic-listings-template.csv`** — two new columns, `interval_weeks` and `anchor_date`, mirroring the DB shape directly (consistent with how the CSV already mirrors insert columns 1:1). Blank `interval_weeks` is treated as `1`.
- **`data/open-mic-listings-template.md`** — the column-guide table documents both new columns: `interval_weeks` (blank or `1` for weekly/monthly; `2` for every-other-week) and `anchor_date` (blank unless `interval_weeks` is `2`, in which case a real confirmed occurrence date on the same weekday as `day_of_week` is required).

## Tests to Update

- **`src/lib/utils/recurrence.test.ts`** — new cases: an every-other-week rule matches only alternating weeks in a range; the anchor date itself is always included; a `weekly` rule with `intervalWeeks` absent/`1` is unaffected; `monthly` resolution is unaffected by the new fields.
- **`src/lib/data/moderation-parse.test.ts`** — parsing `every_other_week` into `{ frequency: "weekly", intervalWeeks: 2 }`; both new `findMissingRequiredFields` checks (missing `anchorDate`, missing `weekOfMonth`).
- **`src/lib/data/moderation-approve.test.ts`** and **`src/lib/data/moderation-archive-listing.test.ts`** — every hardcoded `recurrence: { frequency: ..., dayOfWeek: ..., weekOfMonth: ... }` fixture needs `intervalWeeks: 1, anchorDate: null` added so they keep type-checking, same mechanical update the sign-up-method phase made for `weekOfMonth`.
