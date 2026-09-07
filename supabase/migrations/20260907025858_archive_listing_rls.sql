-- Closes the RLS gap documented in notes/archive-status-rls-gap.md: the only
-- SELECT policy on `listings` required status = 'published', and Postgres
-- checks an UPDATE's resulting row against the table's SELECT policy (not
-- just the UPDATE policy's own WITH CHECK), so no row could ever transition
-- to 'archived' even though the UPDATE policy itself is fully permissive.
--
-- Scoped to real moderators, not every `authenticated` principal —
-- `source_check_agents` (20260906052058_source_check_agent.sql) are also
-- `authenticated` and have no legitimate need to read archived listings, so
-- this deliberately doesn't use a blanket `using (true)`.
create policy "moderators can view archived listings"
  on listings for select
  to authenticated
  using (auth.uid() in (select id from moderators));

-- Lets a moderator archive a listing (or the recovery fallback in
-- createListingFromFields do so automatically) as its own accountable
-- change_type, routed through moderation_queue like every other change —
-- see the design doc for why this isn't a reuse of 'cancellation'.
--
-- The policy that lets a moderator actually INSERT an 'archive'-shaped
-- moderation_queue row lives in a separate, later migration
-- (archive_listing_queue_insert_policy) — Postgres forbids using a new enum
-- value (in a policy's WITH CHECK, here) within the same transaction that
-- added it via ALTER TYPE ... ADD VALUE (SQLSTATE 55P04, "unsafe use of new
-- value of enum type").
alter type moderation_change_type add value 'archive';
