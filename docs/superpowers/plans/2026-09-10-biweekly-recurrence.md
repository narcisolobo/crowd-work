# Biweekly ("Every Other Week") Recurrence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "every other week" recurrence support by giving `recurrence_rules` an `interval_weeks` column (default 1) plus an `anchor_date`, threading both through the occurrence-calculation logic, the shared `ProposedListingFields`/`ListingWithVenue` types, both write paths, the admin form, and the seed/CSV authoring pipeline — while also closing a pre-existing gap where `week_of_month` was never tied to `frequency = 'monthly'`.

**Architecture:** One migration adds `interval_weeks`/`anchor_date` plus two `CHECK` constraints (no new Postgres enum value, so no enum-transaction split). `recurrence.ts`'s existing `weeklyDatesInRange` grows two parameters and a week-parity filter rather than gaining a parallel branch. The admin form's frequency dropdown gets a 4th, form-only value (`every_other_week`) that `moderation.ts` translates into `{ frequency: "weekly", intervalWeeks: 2 }` server-side — the DB `frequency` column itself never changes shape.

**Tech Stack:** Astro (SSR), Supabase/Postgres, TypeScript, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-10-biweekly-recurrence-design.md](../specs/2026-09-10-biweekly-recurrence-design.md)

## Global Constraints

- No new Postgres enum value. `recurrence_frequency` stays `weekly | monthly`. "Every other week" is `frequency: "weekly", intervalWeeks: 2`.
- The **form's** frequency `<select>` uses 4 values, distinct from the DB enum: `"", "weekly", "every_other_week", "monthly"`. Only `parseProposedListingFields` (in `moderation.ts`) knows how to translate `"every_other_week"` into `{ frequency: "weekly", intervalWeeks: 2 }` — no other file references the string `"every_other_week"`.
- New shared field names, used verbatim everywhere: TypeScript `intervalWeeks` / `anchorDate` (camelCase, in `RecurrenceRule`, `ListingWithVenue['recurrenceRule']`, `ProposedListingFields['recurrence']`), Postgres/form `interval_weeks` / `anchor_date` (snake_case, in the DB column list, the `.insert()`/`.update()` payloads, and the `<FormField name="anchorDate">` — the form field's `name` attribute is `anchorDate`, matching the camelCase convention every other form field in this file already uses, e.g. `dayOfWeek`, `weekOfMonth`).
- `intervalWeeks` is always present and non-optional on `ProposedListingFields`/`ListingWithVenue` (mirrors how `weekOfMonth` is already present-but-nullable there, not optional) — default value `1`, not `undefined`. `anchorDate` is `string | null`, never `undefined`, on those two DB-adjacent types. On `recurrence.ts`'s `RecurrenceRule` (a generic calculation type, not DB-shaped), both stay optional, matching how `weekOfMonth` is already optional there.
- New `findMissingRequiredFields` labels, used verbatim: `{ field: "anchorDate", label: "Anchor date" }`, `{ field: "weekOfMonth", label: "Week of month" }`.
- This project requires a local Supabase instance running for the data-layer integration tests (`pnpm test` runs `moderation-approve.test.ts`, `moderation-archive-listing.test.ts`, `moderation-source-check.test.ts` against a real local DB) — same prerequisite those files already have. Per this project's own guidance, start it yourself (`supabase start`) and the dev server yourself (`astro dev --background`) rather than asking your assistant to cycle either.

---

## Task 1: Migration

**Files:**
- Create: `supabase/migrations/<timestamp>_recurrence_interval_weeks.sql` (generate the timestamp with `supabase migration new recurrence_interval_weeks`)

**Interfaces:**
- Produces: `recurrence_rules.interval_weeks smallint not null default 1` (`check (interval_weeks >= 1)`), `recurrence_rules.anchor_date date`; constraints `recurrence_rules_anchor_date_for_interval` and `recurrence_rules_monthly_fields`.

- [x] **Step 1: Generate the migration file**

Run: `supabase migration new recurrence_interval_weeks`

This creates an empty, correctly-timestamped file under `supabase/migrations/`.

- [x] **Step 2: Write the migration**

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

- [x] **Step 3: Reset the local database and verify existing fixtures still insert**

Run: `supabase db reset`
Expected: completes with no errors. `supabase/seed.sql`'s two `recurrence_rules` rows (one `weekly` with no `week_of_month`, one `monthly` with `week_of_month = -1`) already satisfy both new constraints — this confirms it.

- [x] **Step 4: Verify the new constraints actually reject bad data**

Using `psql` or the Supabase MCP `execute_sql` tool, run inside a transaction so nothing persists:

```sql
begin;
insert into listings (id, type, title, venue_id, start_time, status) values
  ('00000000-0000-0000-0000-000000000099', 'mic', 'Constraint Test', 'c0000000-0000-0000-0000-000000000001', '20:00', 'published');
-- should fail: monthly frequency without week_of_month
insert into recurrence_rules (listing_id, frequency, day_of_week) values
  ('00000000-0000-0000-0000-000000000099', 'monthly', 2);
rollback;
```

Expected: the `insert into recurrence_rules` fails with a `recurrence_rules_monthly_fields` constraint violation.

Then verify the interval/anchor pairing the same way:

```sql
begin;
insert into listings (id, type, title, venue_id, start_time, status) values
  ('00000000-0000-0000-0000-000000000099', 'mic', 'Constraint Test', 'c0000000-0000-0000-0000-000000000001', '20:00', 'published');
-- should fail: interval_weeks > 1 with no anchor_date
insert into recurrence_rules (listing_id, frequency, day_of_week, interval_weeks) values
  ('00000000-0000-0000-0000-000000000099', 'weekly', 2, 2);
rollback;
```

Expected: fails with a `recurrence_rules_anchor_date_for_interval` violation.

- [x] **Step 5: Regenerate Supabase TypeScript types**

Task 5's `.insert()`/`.update()` calls type-check against the generated `Database` type — without this, `interval_weeks`/`anchor_date` aren't valid keys on the `recurrence_rules` Insert/Update types yet.

Run:
```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Verify: `grep -c interval_weeks src/lib/supabase/database.types.ts` returns `3` (Row, Insert, Update).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_recurrence_interval_weeks.sql src/lib/supabase/database.types.ts
git commit -m "feat(db): add interval_weeks/anchor_date to recurrence_rules"
```

---

## Task 2: Occurrence calculation (`recurrence.ts`)

**Files:**
- Modify: `src/lib/utils/recurrence.ts`
- Test: `src/lib/utils/recurrence.test.ts`

**Interfaces:**
- Produces: `RecurrenceRule.intervalWeeks?: number` (default treated as `1` when absent), `RecurrenceRule.anchorDate?: string` — consumed by Task 3's `toRecurrenceListing`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/utils/recurrence.test.ts`, inside the existing `describe('resolveOccurrences', ...)` block:

```ts
  it('applies intervalWeeks to skip alternating weeks, anchored at anchorDate', () => {
    const listing = {
      id: 'mic-4',
      venueId: 'venue-1',
      startTime: '19:00',
      recurrenceRule: {
        frequency: 'weekly' as const,
        dayOfWeek: 2, // Tuesday
        intervalWeeks: 2,
        anchorDate: '2026-09-01',
      },
    };
    const result = resolveOccurrences(listing, [], '2026-09-01', '2026-09-30');
    expect(result.map((o) => o.date)).toEqual([
      '2026-09-01',
      '2026-09-15',
      '2026-09-29',
    ]);
  });

  it('computes week parity correctly when the anchor is outside the query range', () => {
    const listing = {
      id: 'mic-5',
      venueId: 'venue-1',
      startTime: '19:00',
      recurrenceRule: {
        frequency: 'weekly' as const,
        dayOfWeek: 2, // Tuesday
        intervalWeeks: 2,
        anchorDate: '2026-08-18', // two weeks before the query range starts
      },
    };
    const result = resolveOccurrences(listing, [], '2026-09-01', '2026-09-30');
    expect(result.map((o) => o.date)).toEqual([
      '2026-09-01',
      '2026-09-15',
      '2026-09-29',
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- recurrence`
Expected: both new tests FAIL (the current `weeklyDatesInRange` has no interval/anchor filtering, so it returns every Tuesday: `09-01, 09-08, 09-15, 09-22, 09-29`).

- [ ] **Step 3: Implement**

In `src/lib/utils/recurrence.ts`, update the `RecurrenceRule` interface:

```ts
export interface RecurrenceRule {
  frequency: 'weekly' | 'monthly';
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  weekOfMonth?: number; // 1-4, or -1 for "last" — required when frequency is 'monthly'
  intervalWeeks?: number; // every N weeks; default 1 when absent — only meaningful when frequency is 'weekly'
  anchorDate?: string; // "YYYY-MM-DD"; required when intervalWeeks > 1
}
```

Update `resolveRecurringDates` to pass the two new fields through on the weekly branch:

```ts
function resolveRecurringDates(
  rule: RecurrenceRule,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  if (rule.frequency === 'weekly') {
    return weeklyDatesInRange(
      rule.dayOfWeek,
      rule.intervalWeeks ?? 1,
      rule.anchorDate,
      rangeStart,
      rangeEnd,
    );
  }
  return monthlyDatesInRange(
    rule.dayOfWeek,
    rule.weekOfMonth!,
    rangeStart,
    rangeEnd,
  );
}
```

Replace `weeklyDatesInRange` and add `isOnIntervalWeek`:

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

`monthlyDatesInRange` and `nthWeekdayOfMonth` are unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- recurrence`
Expected: PASS, all cases (the two new ones plus every pre-existing one — `weeklyDatesInRange`'s plain-weekly path is unchanged when `intervalWeeks <= 1`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/recurrence.ts src/lib/utils/recurrence.test.ts
git commit -m "feat(recurrence): support every-N-weeks intervals in occurrence calculation"
```

---

## Task 3: Read path (`listings.ts`)

**Files:**
- Modify: `src/lib/data/listings.ts`

**Interfaces:**
- Consumes: `RecurrenceRule.intervalWeeks?`/`anchorDate?` (Task 2, `recurrence.ts`).
- Produces: `ListingWithVenue['recurrenceRule'].intervalWeeks: number`, `.anchorDate: string | null` — consumed by Task 4/5 (`moderation.ts`, which reads `ListingWithVenue` in `listingToProposedFields`).

- [ ] **Step 1: Update the `ListingWithVenue` type**

In `src/lib/data/listings.ts:42-46`, change:

```ts
  recurrenceRule: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
```

to:

```ts
  recurrenceRule: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
    intervalWeeks: number;
    anchorDate: string | null;
  } | null;
```

- [ ] **Step 2: Extend the select column list**

In `LISTING_WITH_VENUE_SELECT` (`listings.ts:79-88`), change:

```ts
  recurrence_rules ( frequency, day_of_week, week_of_month )
```

to:

```ts
  recurrence_rules ( frequency, day_of_week, week_of_month, interval_weeks, anchor_date )
```

- [ ] **Step 3: Extend the row mapping**

In `mapListingRow` (`listings.ts:115-121`), change:

```ts
    recurrenceRule: row.recurrence_rules
      ? {
          frequency: row.recurrence_rules.frequency,
          dayOfWeek: row.recurrence_rules.day_of_week,
          weekOfMonth: row.recurrence_rules.week_of_month,
        }
      : null,
```

to:

```ts
    recurrenceRule: row.recurrence_rules
      ? {
          frequency: row.recurrence_rules.frequency,
          dayOfWeek: row.recurrence_rules.day_of_week,
          weekOfMonth: row.recurrence_rules.week_of_month,
          intervalWeeks: row.recurrence_rules.interval_weeks,
          anchorDate: row.recurrence_rules.anchor_date,
        }
      : null,
```

- [ ] **Step 4: Extend `toRecurrenceListing`**

In `toRecurrenceListing` (`listings.ts:225-238`), change:

```ts
      recurrenceRule: {
        frequency: listing.recurrenceRule.frequency,
        dayOfWeek: listing.recurrenceRule.dayOfWeek,
        weekOfMonth: listing.recurrenceRule.weekOfMonth ?? undefined,
      },
```

to:

```ts
      recurrenceRule: {
        frequency: listing.recurrenceRule.frequency,
        dayOfWeek: listing.recurrenceRule.dayOfWeek,
        weekOfMonth: listing.recurrenceRule.weekOfMonth ?? undefined,
        intervalWeeks: listing.recurrenceRule.intervalWeeks,
        anchorDate: listing.recurrenceRule.anchorDate ?? undefined,
      },
```

- [ ] **Step 5: Type-check**

Run: `pnpm exec astro check`
Expected: no new errors. (No existing test exercises `mapListingRow`/`toRecurrenceListing` directly — both are consumed by `index.astro`/`listings/[id].astro`, and by `moderation.ts`'s `listingToProposedFields` in Task 4 — so type-checking is the correctness signal here, same as this file's pre-existing untested mapping code.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/data/listings.ts
git commit -m "feat(listings): read interval_weeks/anchor_date through the listing query"
```

---

## Task 4: `ProposedListingFields` type, parsing, and validation (`moderation.ts`)

**Files:**
- Modify: `src/lib/data/moderation.ts`
- Test: `src/lib/data/moderation-parse.test.ts`

**Interfaces:**
- Produces: `ProposedListingFields['recurrence'].intervalWeeks: number`, `.anchorDate: string | null` — consumed by Task 5 (write paths) and Task 6 (form prefill, via `listingToProposedFields`/`getPrefillForEntry`, both unchanged pass-throughs that pick up the new fields automatically once the type matches `ListingWithVenue`).
- Consumes: form field name `anchorDate`, cadence value `"every_other_week"` (Global Constraints) — the `<select name="frequency">` option itself is added in Task 6, but `parseProposedListingFields` only reads `formData.get("frequency")`/`formData.get("anchorDate")` as plain strings, so this task doesn't need the form to exist yet.

- [ ] **Step 1: Write the failing tests**

In `src/lib/data/moderation-parse.test.ts`, update the two existing recurrence fixtures first (both need the new fields to keep type-checking as non-optional `ProposedListingFields`/`ListingWithVenue` members):

Line 117-121 (inside the `listing: ListingWithVenue` in `"maps a recurring listing's current values..."`):
```ts
      recurrenceRule: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
```

Line 140-144 (the matching expected `recurrence` in the same test's `toEqual`):
```ts
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
```

Then add four new tests. In the `describe("parseProposedListingFields", ...)` block:

```ts
  it("parses 'every_other_week' into weekly with intervalWeeks 2 and the anchor date", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        frequency: "every_other_week",
        dayOfWeek: "2",
        anchorDate: "2026-09-01",
      }),
    );

    expect(fields.recurrence).toEqual({
      frequency: "weekly",
      intervalWeeks: 2,
      dayOfWeek: 2,
      weekOfMonth: null,
      anchorDate: "2026-09-01",
    });
  });

  it("parses plain 'weekly' into intervalWeeks 1 with a null anchor date", () => {
    const fields = parseProposedListingFields(
      buildFormData({
        type: "mic",
        title: "A Mic",
        venueId: "c0000000-0000-0000-0000-000000000001",
        startTime: "20:00",
        frequency: "weekly",
        dayOfWeek: "3",
      }),
    );

    expect(fields.recurrence).toEqual({
      frequency: "weekly",
      intervalWeeks: 1,
      dayOfWeek: 3,
      weekOfMonth: null,
      anchorDate: null,
    });
  });
```

In the `describe("findMissingRequiredFields", ...)` block:

```ts
  it("requires anchorDate when intervalWeeks is greater than 1", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 2,
        anchorDate: null,
      },
    });

    expect(missing).toContainEqual({
      field: "anchorDate",
      label: "Anchor date",
    });
  });

  it("does not require anchorDate for plain weekly (intervalWeeks 1)", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "anchorDate" }),
    );
  });

  it("requires weekOfMonth when frequency is monthly", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "monthly",
        dayOfWeek: 4,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).toContainEqual({
      field: "weekOfMonth",
      label: "Week of month",
    });
  });

  it("does not require weekOfMonth for weekly", () => {
    const missing = findMissingRequiredFields({
      ...baseFields,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
    });

    expect(missing).not.toContainEqual(
      expect.objectContaining({ field: "weekOfMonth" }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- moderation-parse`
Expected: FAIL — `fields.recurrence.intervalWeeks`/`anchorDate` don't exist yet (parsing), and the two new `findMissingRequiredFields` rules don't exist yet (validation). The two fixture-only edits (updating existing tests) should still pass once the type change lands in Step 3, since they're additive.

- [ ] **Step 3: Update the `ProposedListingFields` type**

In `src/lib/data/moderation.ts:38-42`, change:

```ts
  recurrence: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
```

to:

```ts
  recurrence: {
    frequency: "weekly" | "monthly";
    dayOfWeek: number;
    weekOfMonth: number | null;
    intervalWeeks: number;
    anchorDate: string | null;
  } | null;
```

- [ ] **Step 4: Update `parseProposedListingFields`**

In `moderation.ts:826-857`, change:

```ts
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
    signUpOpensAt: formData.get("signUpOpensAt")?.toString() || null,
    signUpMethod: (formData.get("signUpMethod")?.toString() ||
      null) as ProposedListingFields["signUpMethod"],
    signUpUrl: formData.get("signUpUrl")?.toString() || null,
    signUpOtherNote: formData.get("signUpOtherNote")?.toString() || null,
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

to:

```ts
export function parseProposedListingFields(
  formData: FormData,
): ProposedListingFields {
  const cadence = formData.get("frequency")?.toString();
  const isRecurring =
    cadence === "weekly" || cadence === "every_other_week" || cadence === "monthly";
  return {
    type: formData.get("type")?.toString() === "show" ? "show" : "mic",
    title: formData.get("title")?.toString() ?? "",
    host: formData.get("host")?.toString() || null,
    description: formData.get("description")?.toString() || null,
    ...parseVenueSelection(formData),
    startTime: formData.get("startTime")?.toString() ?? "",
    signUpOpensAt: formData.get("signUpOpensAt")?.toString() || null,
    signUpMethod: (formData.get("signUpMethod")?.toString() ||
      null) as ProposedListingFields["signUpMethod"],
    signUpUrl: formData.get("signUpUrl")?.toString() || null,
    signUpOtherNote: formData.get("signUpOtherNote")?.toString() || null,
    costToPerform: formData.get("costToPerform")?.toString() || null,
    ticketPrice: formData.get("ticketPrice")?.toString() || null,
    ticketUrl: formData.get("ticketUrl")?.toString() || null,
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
    oneOffDate: formData.get("oneOffDate")?.toString() || null,
  };
}
```

- [ ] **Step 5: Add the two new validation rules to `findMissingRequiredFields`**

In `moderation.ts:255-260`, immediately after the existing `signUpOtherNote`-for-`hybrid_other` block and before `return missing;`, add:

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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- moderation-parse`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-parse.test.ts
git commit -m "feat(moderation): parse and validate every-other-week recurrence fields"
```

---

## Task 5: Write paths and integration test fixtures (`moderation.ts`)

**Files:**
- Modify: `src/lib/data/moderation.ts`
- Test: `src/lib/data/moderation-approve.test.ts`, `src/lib/data/moderation-archive-listing.test.ts`, `src/lib/data/moderation-source-check.test.ts`

**Interfaces:**
- Consumes: `ProposedListingFields['recurrence'].intervalWeeks`/`.anchorDate` (Task 4); `recurrence_rules.interval_weeks`/`.anchor_date` DB columns (Task 1).

- [ ] **Step 1: Update existing fixtures so they keep type-checking**

`moderation-approve.test.ts:74` and `:95` — both currently `recurrence: { frequency: "weekly", dayOfWeek: 1, weekOfMonth: null }`. Change both to:

```ts
        recurrence: {
          frequency: "weekly",
          dayOfWeek: 1,
          weekOfMonth: null,
          intervalWeeks: 1,
          anchorDate: null,
        },
```

(match the existing indentation at each of the two call sites — one is nested inside `proposed_data`, one is a top-level property of `edited`).

`moderation-archive-listing.test.ts:136` — currently `recurrence: { frequency: "weekly", dayOfWeek: 9, weekOfMonth: null }`. Change to:

```ts
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 9,
        weekOfMonth: null,
        intervalWeeks: 1,
        anchorDate: null,
      },
```

`moderation-source-check.test.ts:25` — currently `recurrence: { frequency: "weekly" as const, dayOfWeek: 2, weekOfMonth: null }`. Change to:

```ts
  recurrence: {
    frequency: "weekly" as const,
    dayOfWeek: 2,
    weekOfMonth: null,
    intervalWeeks: 1,
    anchorDate: null,
  },
```

- [ ] **Step 2: Write the failing test for the new columns**

Add to `moderation-approve.test.ts`, inside `describe("approveNewListing", ...)`, after the existing "inserts a listing and recurrence rule..." test:

```ts
  it("inserts interval_weeks and anchor_date for an every-other-week recurrence", async () => {
    const entryId = await createPendingEntry({
      change_type: "new",
      listing_id: null,
      proposed_data: {
        type: "mic",
        title: "Every Other Week Original",
        host: null,
        description: null,
        venueId: EXISTING_VENUE_ID,
        newVenue: null,
        startTime: "19:00",
        signUpOpensAt: null,
        signUpMethod: null,
        signUpUrl: null,
        signUpOtherNote: null,
        costToPerform: null,
        ticketPrice: null,
        ticketUrl: null,
        recurrence: {
          frequency: "weekly",
          dayOfWeek: 2,
          weekOfMonth: null,
          intervalWeeks: 2,
          anchorDate: "2026-09-01",
        },
        oneOffDate: null,
      },
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: "mic",
      title: "Every Other Week Mic",
      host: null,
      description: null,
      venueId: EXISTING_VENUE_ID,
      newVenue: null,
      startTime: "19:00",
      signUpOpensAt: null,
      signUpMethod: null,
      signUpUrl: null,
      signUpOtherNote: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: {
        frequency: "weekly",
        dayOfWeek: 2,
        weekOfMonth: null,
        intervalWeeks: 2,
        anchorDate: "2026-09-01",
      },
      oneOffDate: null,
    };

    await approveNewListing(
      moderator1,
      entryId,
      edited,
      "Verified independently",
    );

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("id")
      .eq("title", "Every Other Week Mic")
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);

    const { data: rule } = await admin
      .from("recurrence_rules")
      .select("interval_weeks, anchor_date")
      .eq("listing_id", listing!.id)
      .single();
    expect(rule!.interval_weeks).toBe(2);
    expect(rule!.anchor_date).toBe("2026-09-01");
  });
```

- [ ] **Step 3: Run the tests to verify the new one fails**

Run: `pnpm test -- moderation-approve`
Expected: the new test FAILS — `recurrence_rules.interval_weeks` stays at its default (`1`) and `anchor_date` stays `null`, because `createListingFromFields`'s insert doesn't write them yet. The three fixture-only files from Step 1 should already pass (they're type/structure updates, not behavior changes).

- [ ] **Step 4: Update the insert path**

In `moderation.ts:490-498` (inside `createListingFromFields`), change:

```ts
  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .insert({
        listing_id: listing.id,
        frequency: fields.recurrence.frequency,
        day_of_week: fields.recurrence.dayOfWeek,
        week_of_month: fields.recurrence.weekOfMonth,
      });
```

to:

```ts
  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .insert({
        listing_id: listing.id,
        frequency: fields.recurrence.frequency,
        day_of_week: fields.recurrence.dayOfWeek,
        week_of_month: fields.recurrence.weekOfMonth,
        interval_weeks: fields.recurrence.intervalWeeks,
        anchor_date: fields.recurrence.anchorDate,
      });
```

- [ ] **Step 5: Update the update path**

In `moderation.ts:670-681` (inside `applyListingFields`), change:

```ts
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
```

to:

```ts
  if (fields.recurrence) {
    const { error: recurrenceError } = await client
      .from("recurrence_rules")
      .upsert(
        {
          listing_id: listingId,
          frequency: fields.recurrence.frequency,
          day_of_week: fields.recurrence.dayOfWeek,
          week_of_month: fields.recurrence.weekOfMonth,
          interval_weeks: fields.recurrence.intervalWeeks,
          anchor_date: fields.recurrence.anchorDate,
        },
        { onConflict: "listing_id" },
      );
```

- [ ] **Step 6: Run the full data-layer test suite**

Run: `pnpm test -- moderation-approve moderation-archive-listing moderation-source-check`
Expected: PASS, all files. (These hit a real local Supabase instance — make sure it's running via `supabase status`, starting it with `supabase start` if not.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-approve.test.ts src/lib/data/moderation-archive-listing.test.ts src/lib/data/moderation-source-check.test.ts
git commit -m "feat(moderation): write interval_weeks/anchor_date on create and update"
```

---

## Task 6: Admin form UI

**Files:**
- Modify: `src/lib/utils/moderation-labels.ts`
- Modify: `src/components/moderation/ListingFieldsFields.astro`

**Interfaces:**
- Consumes: `ProposedListingFields['recurrence']` (Task 4) via the `prefill` prop.
- Produces: `<select name="frequency">` option `"every_other_week"`, `<input name="anchorDate" type="date">` — consumed by Task 4's `parseProposedListingFields` (already implemented, this task just makes the value reachable from a real form).

- [ ] **Step 1: Add the dropdown option**

In `src/lib/utils/moderation-labels.ts:44-48`, change:

```ts
export const FREQUENCY_OPTIONS = [
  { value: "", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];
```

to:

```ts
export const FREQUENCY_OPTIONS = [
  { value: "", label: "One-time" },
  { value: "weekly", label: "Weekly" },
  { value: "every_other_week", label: "Every other week" },
  { value: "monthly", label: "Monthly" },
];
```

- [ ] **Step 2: Compute the form's cadence value and derive the three booleans from it**

In `ListingFieldsFields.astro:45-49`, change:

```ts
const isNewVenue = Boolean(prefill?.newVenue);
const initialType = prefill?.type ?? "mic";
const isRecurring = Boolean(prefill?.recurrence?.frequency);
const isMonthly = prefill?.recurrence?.frequency === "monthly";
const initialSignUpMethod = prefill?.signUpMethod ?? "";
```

to:

```ts
const isNewVenue = Boolean(prefill?.newVenue);
const initialType = prefill?.type ?? "mic";
const initialCadence =
  prefill?.recurrence == null
    ? ""
    : prefill.recurrence.frequency === "monthly"
      ? "monthly"
      : prefill.recurrence.intervalWeeks > 1
        ? "every_other_week"
        : "weekly";
const isRecurring = initialCadence !== "";
const isMonthly = initialCadence === "monthly";
const isEveryOtherWeek = initialCadence === "every_other_week";
const initialSignUpMethod = prefill?.signUpMethod ?? "";
```

- [ ] **Step 3: Point the frequency select at the new cadence value**

In `ListingFieldsFields.astro:228-233`, change:

```astro
  <FormSelect
    label="Frequency"
    name="frequency"
    options={FREQUENCY_OPTIONS}
    value={prefill?.recurrence?.frequency ?? ""}
  />
```

to:

```astro
  <FormSelect
    label="Frequency"
    name="frequency"
    options={FREQUENCY_OPTIONS}
    value={initialCadence}
  />
```

- [ ] **Step 4: Add the anchor-date field**

In `ListingFieldsFields.astro:242-249`, immediately after the existing `data-recurrence-for="monthly"` block, add:

```astro
  <div data-recurrence-for="every-other-week" hidden={!isEveryOtherWeek}>
    <FormField
      label="Anchor date (any confirmed occurrence)"
      name="anchorDate"
      type="date"
      value={prefill?.recurrence?.anchorDate ?? ""}
    />
  </div>
```

- [ ] **Step 5: Add the client-side toggle**

In the `<script>` block's `frequencySelects` loop (`ListingFieldsFields.astro:297-318`), change:

```ts
    const recurringFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="recurring"]',
    );
    const monthlyFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="monthly"]',
    );
    const oneTimeFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="one-time"]',
    );

    const sync = () => {
      const isRecurring = select.value !== "";
      const isMonthly = select.value === "monthly";
      setGroupState(Array.from(recurringFields), !isRecurring);
      setGroupState(Array.from(monthlyFields), !isMonthly);
      setGroupState(Array.from(oneTimeFields), isRecurring);
    };
```

to:

```ts
    const recurringFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="recurring"]',
    );
    const monthlyFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="monthly"]',
    );
    const everyOtherWeekFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="every-other-week"]',
    );
    const oneTimeFields = form.querySelectorAll<HTMLElement>(
      '[data-recurrence-for="one-time"]',
    );

    const sync = () => {
      const isRecurring = select.value !== "";
      const isMonthly = select.value === "monthly";
      const isEveryOtherWeek = select.value === "every_other_week";
      setGroupState(Array.from(recurringFields), !isRecurring);
      setGroupState(Array.from(monthlyFields), !isMonthly);
      setGroupState(Array.from(everyOtherWeekFields), !isEveryOtherWeek);
      setGroupState(Array.from(oneTimeFields), isRecurring);
    };
```

- [ ] **Step 6: Type-check**

Run: `pnpm exec astro check`
Expected: no new errors.

- [ ] **Step 7: Manual verification in the browser**

This project's own guidance is to start the dev server yourself (`astro dev --background`) rather than have your assistant cycle it — do that first if it isn't already running, then open the direct-add form (`/admin/listings/new`) and confirm:
- Selecting "Weekly" shows the day-of-week field only.
- Selecting "Every other week" shows day-of-week **and** the new anchor-date field, but not week-of-month.
- Selecting "Monthly" shows day-of-week **and** week-of-month, but not the anchor-date field.
- Submitting "Every other week" with no anchor date shows the "Anchor date" validation message; submitting "Monthly" with no week selected shows "Week of month".

- [ ] **Step 8: Commit**

```bash
git add src/lib/utils/moderation-labels.ts src/components/moderation/ListingFieldsFields.astro
git commit -m "feat(admin): add every-other-week option and anchor-date field to the listing form"
```

---

## Task 7: Seed and template pipeline

**Files:**
- Modify: `supabase/seeds/03_open_mic_listings.sql`
- Modify: `data/open-mic-listings-template.csv`
- Modify: `data/open-mic-listings-template.md`

**Interfaces:**
- Consumes: `recurrence_rules.interval_weeks`/`.anchor_date` (Task 1).

- [ ] **Step 1: Update the seed file's recurrence columns**

In `supabase/seeds/03_open_mic_listings.sql`, the second `insert` statement's column list and `values()` shape (lines 54-63) currently read:

```sql
insert into recurrence_rules (listing_id, frequency, day_of_week, week_of_month)
select
  nl.id, r.frequency::recurrence_frequency, r.day_of_week::smallint,
  r.week_of_month::smallint
from new_listings nl
join (values
  -- ('Example Mic Name', 'weekly', 2, null)
  ('__EXAMPLE_REPLACE_ME__', 'weekly', 2, null)
) as r(title, frequency, day_of_week, week_of_month)
  on r.title = nl.title;
```

Change to:

```sql
insert into recurrence_rules (
  listing_id, frequency, day_of_week, week_of_month, interval_weeks, anchor_date
)
select
  nl.id, r.frequency::recurrence_frequency, r.day_of_week::smallint,
  r.week_of_month::smallint, r.interval_weeks::smallint, r.anchor_date::date
from new_listings nl
join (values
  -- ('Example Mic Name', 'weekly', 2, null, 1, null)
  ('__EXAMPLE_REPLACE_ME__', 'weekly', 2, null, 1, null)
) as r(title, frequency, day_of_week, week_of_month, interval_weeks, anchor_date)
  on r.title = nl.title;
```

Update the header comment (around line 20-22) that documents how to add a recurring row, adding one sentence: after "a matching row — joined by title — to the second values() list for its recurrence rule", add "Leave `interval_weeks` as `1`/`anchor_date` as `null` unless the listing runs every other week, in which case set `interval_weeks` to `2` and `anchor_date` to any confirmed occurrence date on the same weekday as `day_of_week`."

- [ ] **Step 2: Update the CSV template**

In `data/open-mic-listings-template.csv`, add two columns, `interval_weeks` and `anchor_date`, after `week_of_month` in the header row and in every existing data row (blank values for all current rows, since none are every-other-week).

- [ ] **Step 3: Update the column guide**

In `data/open-mic-listings-template.md`'s table, add two rows immediately after the `week_of_month` row:

```markdown
| `interval_weeks` | *(blank)* | blank or `1` for weekly/monthly; `2` for every-other-week |
| `anchor_date` | *(blank)* | `YYYY-MM-DD`; required (and must fall on `day_of_week`) when `interval_weeks` is `2`, blank otherwise |
```

- [ ] **Step 4: Verify**

Run: `supabase db reset`
Expected: completes with no errors — the placeholder row's `interval_weeks`/`anchor_date` values (`1`/`null`) satisfy `recurrence_rules_anchor_date_for_interval`, same as every other placeholder column.

- [ ] **Step 5: Commit**

```bash
git add supabase/seeds/03_open_mic_listings.sql data/open-mic-listings-template.csv data/open-mic-listings-template.md
git commit -m "docs(seeds): add interval_weeks/anchor_date to the listing seed pipeline"
```
