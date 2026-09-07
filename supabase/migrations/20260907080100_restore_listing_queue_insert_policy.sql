-- Mirrors "moderators can directly insert a pre-approved archive entry"
-- (20260907030344) for the 'restore' direction — see
-- 20260907080000_restore_listing_rls.sql for why this has to be a separate
-- migration from the enum value it references.
create policy "moderators can directly insert a pre-approved restore entry"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'restore'
    and origin = 'moderator_restore'
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
    and proposed_data is null
    and approved_data is null
  );
