-- Moderators have only ever inserted a pre-approved queue row for a
-- moderator_direct_add 'new' listing (20260904182818). Archiving needs its
-- own equivalent permissive INSERT policy — without one, no permissive
-- policy on moderation_queue covers an 'archive'-shaped row at all, so RLS
-- rejects the insert even though the acting user is a real moderator.
--
-- Split into its own migration (rather than living alongside the
-- 'archive' enum value it references) because Postgres forbids using a
-- new enum value within the same transaction that added it via
-- ALTER TYPE ... ADD VALUE — see 20260907025858_archive_listing_rls.sql.
--
-- Covers both origins archiveListing() can produce: a moderator's direct
-- action and the automatic recovery fallback in createListingFromFields()
-- (still attributed to the acting moderator, since it's their authenticated
-- insert). Mirrors the direct-add policy's shape discipline: the row must
-- already arrive fully decided and self-attributed, with no field data
-- attached since archiving never changes a listing's fields.
create policy "moderators can directly insert a pre-approved archive entry"
  on moderation_queue for insert
  to authenticated
  with check (
    change_type = 'archive'
    and origin in ('moderator_archive', 'system_recovery')
    and status = 'approved'
    and approved_by = auth.uid()
    and decided_at is not null
    and proposed_data is null
    and approved_data is null
  );
