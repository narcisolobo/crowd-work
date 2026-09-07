-- Moderators have only ever inserted a pre-approved queue row for a
-- moderator_direct_add 'new' listing (20260904182818) or a
-- moderator_archive/system_recovery 'archive' entry (20260907030344).
-- Direct editing needs its own equivalent permissive INSERT policy —
-- without one, no permissive policy on moderation_queue covers an
-- 'update'-shaped row inserted (rather than transitioned from 'pending')
-- by an authenticated moderator.
--
-- No RLS change is needed on `listings` or `recurrence_rules` here: unlike
-- archiving, editing never touches `listings.status`, so it never triggers
-- the SELECT-vs-UPDATE-result mismatch documented in
-- notes/archive-status-rls-gap.md.
create policy "moderators can directly insert a pre-approved update entry"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'update'
    and origin = 'moderator_direct_edit'
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
    and proposed_data is null
    and approved_data is not null
    and listing_id is not null
  );
