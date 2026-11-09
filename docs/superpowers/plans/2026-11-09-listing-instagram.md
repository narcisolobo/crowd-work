# Listing Instagram Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the new `listings.instagram` column through the data layer, admin form, public listing page, seed file, CSV template, and the check-sources skill, so a listing can hold one Instagram handle and show it as a link.

**Architecture:** One small pure module (`src/lib/utils/instagram.ts`) owns handle normalization, validation, and URL building. The data layer uses it when parsing form input and when checking required fields. The UI only renders what the data layer gives it. The seed/CSV path takes the bare handle as-is, and the DB check constraint is the backstop.

**Tech Stack:** Astro (SSR), TypeScript, Supabase/Postgres, Vitest.

**Spec:** No standalone spec. The decisions come from the 2026-11-09 vetting session and are recorded in `notes/fix.md`:
- One `instagram` text column on `listings` (migration `supabase/migrations/20261109232631_listings_instagram.sql`, already applied locally; types already updated).
- Store the **bare handle, no `@`**. The DB enforces `instagram ~ '^[A-Za-z0-9._]{1,30}$'`.
- Use it for the account a comic should check for updates: the mic's own account, otherwise the main host's.
- Handles currently in `sign_up_other_note` move into this column. `sign_up_other_note` goes back to being `hybrid_other`-only.

## Global Constraints

- Handle format is exactly the DB constraint: `^[A-Za-z0-9._]{1,30}$`. The TS validator must use the same pattern.
- Stored value never includes `@` and is never a URL.
- Profile URL format: `https://www.instagram.com/<handle>/`.
- External links on the listing page use `target="_blank" rel="noopener noreferrer"`, matching the description links in `src/pages/listings/[id].astro`.
- Commit steps are checkpoints for the user, who makes their own commits. At each one the executor stops, shows the suggested message, and waits. It never runs `git add` or `git commit`.
- Don't start or restart the dev server or Supabase stack. Ask the user to run long-lived servers, and only send one-shot checks against them.

## Review Focus

1. **Moderator pastes `@handle` or a full profile URL** (`https://www.instagram.com/handle/?hl=en`). Expected: stored as `handle`. Pinned in Task 1 (`normalizeInstagramHandle` tests) and Task 2 (parse test).
2. **Moderator types something invalid** (`my handle`, 31+ chars). Expected: a field error on the form, not a raw Postgres constraint error on approve. Pinned in Task 2 (`findMissingRequiredFields` test).
3. **Queue entries created before this change** have no `instagram` key in `proposed_data`. Expected: approving them writes `null` and doesn't throw. Pinned in Task 2 (insert/update payloads use `fields.instagram ?? null`, plus a `findMissingRequiredFields` test with the key absent).
4. **Editing an existing listing to clear the handle.** Expected: the empty field saves as `null`, not `""`, so the constraint doesn't reject it. Pinned in Task 2 (parse test for `""`).
5. **Show listings.** Expected: the field works for shows too. Venues and shows also post on Instagram, so it isn't mic-only. Covered by Task 3 placing the field outside the mic-only block.

---

### Task 1: Instagram handle utility

**Files:**
- Create: `src/lib/utils/instagram.ts`
- Test: `src/lib/utils/instagram.test.ts`

**Interfaces:**
- Produces:
  - `INSTAGRAM_HANDLE_PATTERN: RegExp` — `/^[A-Za-z0-9._]{1,30}$/`
  - `normalizeInstagramHandle(raw: string | null | undefined): string | null`
  - `isValidInstagramHandle(handle: string): boolean`
  - `instagramProfileUrl(handle: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  normalizeInstagramHandle,
  isValidInstagramHandle,
  instagramProfileUrl,
} from "./instagram";

describe("normalizeInstagramHandle", () => {
  it("returns null for empty, whitespace, null, and undefined", () => {
    expect(normalizeInstagramHandle("")).toBeNull();
    expect(normalizeInstagramHandle("   ")).toBeNull();
    expect(normalizeInstagramHandle(null)).toBeNull();
    expect(normalizeInstagramHandle(undefined)).toBeNull();
  });
  it("strips a leading @ and surrounding whitespace", () => {
    expect(normalizeInstagramHandle("  @storyjammic ")).toBe("storyjammic");
  });
  it("leaves a bare handle unchanged, including underscores and periods", () => {
    expect(normalizeInstagramHandle("__playspace__")).toBe("__playspace__");
    expect(normalizeInstagramHandle("courtney.black")).toBe("courtney.black");
  });
  it("extracts the handle from a profile URL", () => {
    expect(normalizeInstagramHandle("https://www.instagram.com/skintag_openmic/")).toBe("skintag_openmic");
    expect(normalizeInstagramHandle("instagram.com/storyjammic?hl=en")).toBe("storyjammic");
  });
  it("returns invalid input as-is (validation is a separate step)", () => {
    expect(normalizeInstagramHandle("my handle")).toBe("my handle");
  });
});

describe("isValidInstagramHandle", () => {
  it("accepts 1-30 letters, digits, periods, underscores", () => {
    expect(isValidInstagramHandle("a")).toBe(true);
    expect(isValidInstagramHandle("a".repeat(30))).toBe(true);
  });
  it("rejects @, spaces, URLs, and 31+ chars", () => {
    expect(isValidInstagramHandle("@a")).toBe(false);
    expect(isValidInstagramHandle("a b")).toBe(false);
    expect(isValidInstagramHandle("instagram.com/a")).toBe(false);
    expect(isValidInstagramHandle("a".repeat(31))).toBe(false);
  });
});

describe("instagramProfileUrl", () => {
  it("builds the canonical profile URL", () => {
    expect(instagramProfileUrl("storyjammic")).toBe("https://www.instagram.com/storyjammic/");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/utils/instagram.test.ts`
Expected: FAIL, because `./instagram` can't be resolved.

- [ ] **Step 3: Implement the three functions in `src/lib/utils/instagram.ts`**

URL extraction only triggers when the trimmed input contains `instagram.com/`. Take the first path segment after it and drop any query string or fragment. Otherwise, strip one leading `@`. Don't lowercase.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/utils/instagram.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit checkpoint (user commits)**

Stop and hand off. Suggested message: `feat(listings): add Instagram handle utility`. Files: `src/lib/utils/instagram.ts`, `src/lib/utils/instagram.test.ts`.

---

### Task 2: Data layer

**Files:**
- Modify: `src/lib/data/listings.ts` — `ListingWithVenue` (~line 14), `LISTING_WITH_VENUE_SELECT` (~line 81), `mapListingRow` (~line 91)
- Modify: `src/lib/data/moderation.ts` — `ProposedListingFields` (~line 17), `findMissingRequiredFields` (~line 236), `createListingFromFields` insert (~line 486), `applyListingFields` update (~line 675), `parseProposedListingFields` (~line 845), `listingToProposedFields` (~line 1006)
- Test: `src/lib/data/moderation-parse.test.ts`
- Modify (fixtures only): every test that builds a full `ListingWithVenue` or `ProposedListingFields` literal (`moderation-approve.test.ts`, `moderation-source-check.test.ts`, `moderation-archive-listing.test.ts`, `moderation-parse.test.ts`). Add `instagram: null` so they type-check.

**Interfaces:**
- Consumes: `normalizeInstagramHandle`, `isValidInstagramHandle` from Task 1.
- Produces:
  - `ListingWithVenue.instagram: string | null` (placed after `signUpOtherNote`)
  - `ProposedListingFields.instagram: string | null` (placed after `signUpOtherNote`)
  - Form control name: `instagram`
  - `MissingField` for an invalid handle: `{ field: "instagram", label: "Valid Instagram handle" }`

- [ ] **Step 1: Write the failing tests in `moderation-parse.test.ts`**

In the `parseProposedListingFields` describe block:
```ts
it("normalizes the instagram field to a bare handle", () => {
  const fields = parseProposedListingFields(
    buildFormData({ type: "mic", title: "A Mic", venueId: "c0000000-0000-0000-0000-000000000001", startTime: "20:00", instagram: "@storyjammic" }),
  );
  expect(fields.instagram).toBe("storyjammic");
});

it("parses an empty instagram field as null", () => {
  const fields = parseProposedListingFields(
    buildFormData({ type: "mic", title: "A Mic", venueId: "c0000000-0000-0000-0000-000000000001", startTime: "20:00", instagram: "" }),
  );
  expect(fields.instagram).toBeNull();
});
```

In the `listingToProposedFields` describe block, extend the existing "maps a recurring listing's current values" test: set `instagram: "storyjammic"` on its listing fixture and assert `expect(fields.instagram).toBe("storyjammic")`.

In the `findMissingRequiredFields` describe block, using that block's existing base-fields fixture:
```ts
it("flags an invalid instagram handle", () => {
  expect(findMissingRequiredFields({ ...base, instagram: "my handle" }))
    .toContainEqual({ field: "instagram", label: "Valid Instagram handle" });
});

it("does not flag a valid or null instagram handle", () => {
  expect(findMissingRequiredFields({ ...base, instagram: "storyjammic" }).map((m) => m.field)).not.toContain("instagram");
  expect(findMissingRequiredFields({ ...base, instagram: null }).map((m) => m.field)).not.toContain("instagram");
});

it("does not flag queue data saved before the instagram field existed", () => {
  const { instagram: _omit, ...legacy } = { ...base, instagram: null };
  expect(findMissingRequiredFields(legacy as ProposedListingFields).map((m) => m.field)).not.toContain("instagram");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/data/moderation-parse.test.ts`
Expected: FAIL on the new tests (`instagram` is `undefined`, and no `instagram` entry in missing fields). Type errors in the fixtures are expected until Step 3.

- [ ] **Step 3: Implement**

- `listings.ts`: add `instagram` to the interface, to the select string after `sign_up_opens_at`, and `instagram: row.instagram` in `mapListingRow`.
- `moderation.ts`:
  - Add `instagram` to `ProposedListingFields`.
  - Parse with `normalizeInstagramHandle(formData.get("instagram")?.toString())`.
  - Map `listing.instagram` in `listingToProposedFields`.
  - Write `instagram: fields.instagram ?? null` in both the `createListingFromFields` insert and the `applyListingFields` update. The `?? null` handles legacy queue JSON.
  - In `findMissingRequiredFields`, push the invalid-handle entry when `fields.instagram` is truthy and `!isValidInstagramHandle(fields.instagram)`.
- Add `instagram: null` to each full-literal fixture in the four test files.

- [ ] **Step 4: Run the full unit suite and the type check**

Run: `npm test && npx astro check`
Expected: all Vitest tests pass, and `astro check` reports `0 errors`.

- [ ] **Step 5: Commit checkpoint (user commits)**

Stop and hand off. Suggested message: `feat(listings): carry instagram through the data layer`. Files: `src/lib/data/listings.ts`, `src/lib/data/moderation.ts`, and the four updated test files.

---

### Task 3: Admin form field and listing page link

**Files:**
- Modify: `src/components/moderation/ListingFieldsFields.astro` — add a field after the Host field (~line 85)
- Modify: `src/pages/listings/[id].astro` — render under the "Hosted by" line (~line 210)

**Interfaces:**
- Consumes: `ProposedListingFields.instagram` (form prefill, plus `fieldErrors.instagram`), `ListingWithVenue.instagram`, and `instagramProfileUrl` from Task 1.

- [ ] **Step 1: Add the form field**

```astro
<FormField
  label="Instagram"
  name="instagram"
  placeholder="handle, without @"
  value={prefill?.instagram ?? ""}
  error={fieldErrors.instagram}
/>
```
Put it next to Host and outside the `data-field-for="mic"` wrapper, so it shows for both mics and shows. Not required.

- [ ] **Step 2: Render the link on the listing page**

When `listing.instagram` is set, render a line in the same style as "Hosted by" (`text-ink-soft mt-2 text-[0.86rem]`). The link text is `@{listing.instagram}`, the `href` is `instagramProfileUrl(listing.instagram)`, and it uses `target="_blank" rel="noopener noreferrer"` with the `underline underline-offset-2` class used by the nearby links.

- [ ] **Step 3: Type-check**

Run: `npx astro check`
Expected: `0 errors`.

- [ ] **Step 4: Manual check (ask the user to start the dev server)**

With `astro dev --background` running:
1. In the admin direct-add form, enter `@storyjammic` and save. The listing page shows `@storyjammic`, linked to `https://www.instagram.com/storyjammic/`.
2. Edit the listing and enter `my handle`. The form re-renders with an error on the Instagram field, not a server error.
3. Edit the listing, clear the field, and save. No Instagram line on the listing page.

- [ ] **Step 5: Commit checkpoint (user commits)**

Stop and hand off. Suggested message: `feat(listings): add Instagram field and listing-page link`. Files: `src/components/moderation/ListingFieldsFields.astro`, `src/pages/listings/[id].astro`.

---

### Task 4: Seed pipeline, CSV template, guide, and check-sources skill

**Files:**
- Modify: `supabase/seeds/03_open_mic_listings.sql` — insert column list, `select` list, the `v(...)` alias list, and both example rows (commented and placeholder)
- Modify: `data/open-mic-listings-template.csv` — new `instagram` column after `sign_up_other_note`, then move the IG handles out of `sign_up_other_note` on the existing rows
- Modify: `data/open-mic-listings-template.md` — new guide row, and tighten the `sign_up_other_note` note
- Modify: `.claude/skills/check-sources/SKILL.md` — add `"instagram": "bare handle (no @) or null"` to the fields JSON (~line 47), plus one sentence of guidance

**Interfaces:**
- Consumes: the column from the migration. The skill's JSON key `instagram` must match `ProposedListingFields.instagram` from Task 2.

- [ ] **Step 1: Seed file**

Add `instagram` immediately after `sign_up_other_note` in all three lists (insert columns, select as `v.instagram`, alias). Put `null` in that position in both example rows. Add a header comment line: "instagram is the bare handle, no @."

- [ ] **Step 2: Verify the seed in a rolled-back transaction**

Run: `docker exec -i supabase_db_ervnukkrecriucdsxxzu psql -U postgres -v ON_ERROR_STOP=1 -c 'begin;' -f - -c 'rollback;' < supabase/seeds/03_open_mic_listings.sql`
Expected: `INSERT 0 0` and `ROLLBACK`, with no column-count or type errors. The placeholder row joins against no venue, so nothing inserts.

- [ ] **Step 3: CSV template and guide**

- CSV: insert the `instagram` header after `sign_up_other_note`. On each row, move a handle that was in `sign_up_other_note` into `instagram` without the `@`. Leave non-handle notes where they are. Then check that every row has 20 fields by parsing the file with a real CSV parser, as the biweekly commit did.
- Guide: add the row `| instagram | storyjammic | bare handle, no @; the mic's own account, else the main host's. 1–30 letters, digits, periods, underscores |`. Change the `sign_up_other_note` row's note to: "required when `sign_up_method` is `hybrid_other`; blank otherwise. Put Instagram handles in `instagram`, not here."

- [ ] **Step 4: check-sources skill**

Add the `instagram` key to the JSON block. Then add one sentence after the `signUpMethod` classification paragraph: "If the source names the mic's (or host's) Instagram account, put the bare handle without `@` in `instagram`."

- [ ] **Step 5: Final verification**

Run: `npm test && npx astro check`
Expected: all tests pass, and `0 errors`.

- [ ] **Step 6: Update `notes/fix.md`**

Check off "Add the `instagram` column to the schema, admin form, seed file, and CSV template/guide."

- [ ] **Step 7: Commit checkpoint (user commits)**

Stop and hand off. Suggested message: `feat(seeds): add instagram to seed pipeline and check-sources`. Files: `supabase/seeds/03_open_mic_listings.sql`, `data/open-mic-listings-template.csv`, `data/open-mic-listings-template.md`, `.claude/skills/check-sources/SKILL.md`, `notes/fix.md`.
