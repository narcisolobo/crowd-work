alter table moderation_queue
  add column approved_by uuid references auth.users(id),
  add column approved_data jsonb,
  add column approval_note text,
  add column decided_at timestamptz;

-- Tighten the existing approve/reject policies so the new actor and
-- timestamp columns are enforced at the RLS level, the same way
-- proposed_by = auth.uid() already is for proposing a rejection. A
-- moderator can never write another moderator's id into approved_by or
-- confirmed_by.
drop policy "moderators can approve or propose rejection on a pending entry" on moderation_queue;

create policy "moderators can approve or propose rejection on a pending entry"
  on moderation_queue for update
  to authenticated
  using (status = 'pending')
  with check (
    (status = 'approved' and approved_by = auth.uid() and decided_at is not null)
    or (status = 'rejection_proposed' and proposed_by = auth.uid() and proposed_reason is not null)
  );

drop policy "a different moderator can confirm or return a proposed rejection" on moderation_queue;

create policy "a different moderator can confirm or return a proposed rejection"
  on moderation_queue for update
  to authenticated
  using (status = 'rejection_proposed' and auth.uid() <> proposed_by)
  with check (
    (status = 'rejected' and confirmed_by = auth.uid() and decided_at is not null)
    or (status = 'pending')
  );