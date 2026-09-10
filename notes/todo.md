# Todo

- [ ] **Unused-variable warnings from `pnpm run check`** — pre-existing, unrelated to the structured sign-up method refactor (docs/superpowers/plans/2026-09-09-structured-sign-up-method.md), surfaced while type-checking that work:
  - `src/pages/admin/archive/index.astro:53` — `redirectUrl` is declared but its value is never read.
  - `src/pages/admin/listings/new/index.astro:49` — `result` is declared but its value is never read.
