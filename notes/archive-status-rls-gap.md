# Archive Status RLS Gap

`listings.status` has always had two enum values — `published` and `archived` (`supabase/migrations/20260902194949_listings_and_resources.sql`) — but no code path in the app has ever actually set a listing to `archived`. It's an unused half of the schema, not a working feature.

Discovered while hardening `src/pages/admin/listings/new/index.astro`'s direct-add flow (see `createListingFromFields()` in `src/lib/data/moderation.ts`): a defensive fallback tries to archive a listing if its `recurrence_rules` insert fails right after the listing itself was created (Postgrest has no cross-table transaction, so that two-step insert can fail partway through, and a live "published" listing with no recurrence data is worse than one flagged unpublished). That fallback is written correctly, but it can never succeed against the current database, for a reason unrelated to the code:

## Why it fails

The only `SELECT` policy on `listings` is:

```sql
create policy "published listings are publicly readable"
  on listings for select
  using (status = 'published');
```

The `UPDATE` policy is fully permissive (`using (true) with check (true)` for `authenticated`). Logically that should be enough to let a moderator flip `status` to `archived`. It isn't: Postgres requires an `UPDATE`'s *resulting* row to also satisfy the table's `SELECT` policy, not just the `UPDATE` policy's own `WITH CHECK`. Since the only `SELECT` policy requires `status = 'published'`, a row that's about to become `archived` fails that check and the update is rejected with `42501: new row violates row-level security policy for table "listings"` — even though the row is fully visible and updatable in every other respect.

Confirmed directly against Postgres (bypassing Postgrest) with `set local role authenticated`:
- Updating any other column (e.g. `title`) — succeeds.
- Setting `status = 'published'` (a no-op) — succeeds.
- Setting `status = 'archived'` — fails with the RLS error above.
- Temporarily broadening the `SELECT` policy to `using (true)` — the same `archived` update then succeeds.

This isn't a bug in the update code; it's a structural gap in the RLS setup that happened to never get exercised because nothing ever tried to write `archived` before.

## What's needed to close it

A migration that gives the `authenticated` role (or moderators specifically, if there's ever a reason to distinguish) `SELECT` visibility of archived listings — for example, an additional permissive `SELECT` policy like:

```sql
create policy "moderators can view archived listings"
  on listings for select
  to authenticated
  using (true);
```

This wasn't added as part of the hardening work above, on purpose: it's a real security/schema decision (who can see an archived listing, and whether "archived" should ever be publicly queryable at all) that deserves its own review rather than being a silent side effect of a form-validation fix. Until a decision like this lands, the `archived` status remains unreachable, and the recurrence-insert-failure fallback in `createListingFromFields()` will keep degrading honestly — reporting that the listing could not be archived and should be checked manually, rather than pretending to succeed.

## Related

- No other code references `"archived"` today — `grep -rn '"archived"' src` turns up only the type definitions and the one fallback call site described above.
- If this gets designed properly later, it likely wants a real feature around it (an admin "archive this listing" action, surfaced in the queue or a listing's admin view), not just an RLS policy fix for the edge case that surfaced it.
