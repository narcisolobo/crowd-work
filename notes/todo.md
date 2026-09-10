# Todo

- [ ] **Unused-variable warnings from `pnpm run check`** — pre-existing, unrelated to the structured sign-up method refactor (docs/superpowers/plans/2026-09-09-structured-sign-up-method.md), surfaced while type-checking that work:
  - `src/pages/admin/archive/index.astro:53` — `redirectUrl` is declared but its value is never read.
  - `src/pages/admin/listings/new/index.astro:49` — `result` is declared but its value is never read.

- [ ] **Revisit the sign-up method label's visual weight in `ListingRow`** — `src/components/listings/ListingRow.astro:99` renders the "Sign-up: ..." line with `text-ink font-medium` (full-strength, bold), while the adjacent "Hosted by" (line 94) and `note` (line 116) lines both use the softer `text-ink-soft`. That styling predates the structured sign-up method refactor, but is now worth a second look now that the label reads more prominently (a real enum label, sometimes a link) — unsure if it should stay this bright or match the softer weight of the other secondary lines.
