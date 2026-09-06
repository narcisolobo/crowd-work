# Archive Status RLS Gap

**Not to be confused with the Moderation Archive page** (`src/pages/admin/archive/index.astro`). That page shows decided `moderation_queue` entries — proposals that were approved or rejected, via `getArchiveEntries()` filtering `moderation_queue.status in ('approved', 'rejected')`. It works fine and is unrelated to this note.

This note is about a completely different column: `listings.status`, which has always had two enum values — `published` and `archived` (`supabase/migrations/20260902194949_listings_and_resources.sql`) — describing whether a *listing itself* is currently live on the public site. No code path in the app has ever actually set a listing to `archived`. It's an unused half of the schema, not a working feature. A listing can sit in the Moderation Archive as "Approved" forever while its own `status` column stays `published` — the two concepts don't connect.

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

## Future: an "archive this listing" feature

If/when this gets built, it should go through `moderation_queue` (proposed and approved, like every other listing change) rather than a direct `listings.status` toggle from an admin page — for two reasons:

1. **It's the only way archived listings show up on the Moderation Archive page for free.** `getArchiveEntries()` (`src/lib/data/moderation.ts`) only reads `moderation_queue.status in ('approved', 'rejected')` — it has no awareness of `listings` at all. A direct status toggle would never appear there without teaching that page to merge in a second, differently-shaped data source. Routed through the queue instead, it shows up automatically using the exact same `whoFor`/`whatFor`/`whyFor` rendering already built for every other change type.
2. **It resolves the "does this need a second reviewer" question**, which this product's governance model (single-moderator approval, second-moderator-confirmed rejection) makes a real design decision rather than a detail. Going through the queue gets the accountability trail for free instead of building a parallel path that duplicates it.

This needs a new `change_type`, not a reuse of `"cancellation"` — `QueueChangeType` (`"new" | "update" | "cancellation"`) already has a `cancellation` value, but that means a single occurrence exception (`occurrence_exceptions`, e.g. "this week's mic is off"), not a permanent unpublish. Archiving the listing itself is a different, durable state change on `listings.status`, so it wants its own value — e.g. `change_type = "archive"` — plus the corresponding `approve*`/queue-action wiring the other change types already have (`approveNewListing`, `approveListingUpdate`, `approveCancellation`).
