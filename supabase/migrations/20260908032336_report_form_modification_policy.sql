-- The public report form needs two changes to its existing anonymous
-- INSERT policy. That policy started as "anyone can submit a correction
-- report" (20260903183709_moderation_queue.sql) and was already renamed to
-- "anyone can submit a correction report or a new listing"
-- (20260904182818_listing_submission_policies.sql) when it gained an `or`
-- branch for brand-new listing submissions (change_type = 'new'). This
-- migration targets that current name and preserves the 'new' branch
-- untouched, while changing only the correction-report branch:
--
-- 1. Allow the new 'modification' change_type (report.astro's new
--    "something's different this time" option), alongside the existing
--    'update'/'cancellation'.
-- 2. Require proposed_data->>'originalDate' whenever change_type is
--    'cancellation' or 'modification' — closing a pre-existing gap where
--    a cancellation report could be filed with no date at all (report.astro
--    used to always insert { originalDate: null }, leaving the moderator to
--    track down the actual date during approval). Both occurrence-specific
--    report types need a date to review against; from here on the database
--    itself requires one, not just report.astro's application logic.
--
-- Split into its own migration (rather than living alongside the
-- 'modification' enum value it references) because Postgres forbids using
-- a new enum value within the same transaction that added it — see
-- 20260907025858_archive_listing_rls.sql for the same pattern.
drop policy "anyone can submit a correction report or a new listing" on moderation_queue;

create policy "anyone can submit a correction report or a new listing"
  on moderation_queue for insert
  to anon
  with check (
    (
      change_type in ('update', 'cancellation', 'modification')
      and origin = 'report_form'
      and listing_id is not null
      and correction_note is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
      and (
        change_type = 'update'
        or (proposed_data ->> 'originalDate') is not null
      )
    )
    or (
      change_type = 'new'
      and origin = 'submission_form'
      and listing_id is null
      and proposed_data is not null
      and proposed_by is null
      and proposed_reason is null
      and confirmed_by is null
      and status = 'pending'
    )
  );