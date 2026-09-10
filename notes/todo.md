# Todo

- [ ] **Unused-variable warnings from `pnpm run check`** — pre-existing, unrelated to the structured sign-up method refactor (docs/superpowers/plans/2026-09-09-structured-sign-up-method.md), surfaced while type-checking that work:
  - `src/pages/admin/archive/index.astro:53` — `redirectUrl` is declared but its value is never read.
  - `src/pages/admin/listings/new/index.astro:49` — `result` is declared but its value is never read.

- [ ] **Revisit the sign-up method label's visual weight in `ListingRow`** — `src/components/listings/ListingRow.astro:99` renders the "Sign-up: ..." line with `text-ink font-medium` (full-strength, bold), while the adjacent "Hosted by" (line 94) and `note` (line 116) lines both use the softer `text-ink-soft`. That styling predates the structured sign-up method refactor, but is now worth a second look now that the label reads more prominently (a real enum label, sometimes a link) — unsure if it should stay this bright or match the softer weight of the other secondary lines.

- [ ] **`week_of_month` isn't constrained to `frequency = 'monthly'`** — `recurrence_rules.week_of_month` (`supabase/migrations/20260902194949_listings_and_resources.sql`) only checks its range (-1 to 4), not that it's null for `weekly`/`biweekly` rows. A bad seed or admin-entered row could set it on a non-monthly listing with no error. Surfaced while speccing the `biweekly` recurrence schema change; add a check constraint tying `week_of_month is not null` to `frequency = 'monthly'`, same pattern as the biweekly/`anchor_date` constraint.
