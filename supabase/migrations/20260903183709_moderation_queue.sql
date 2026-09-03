create type moderation_change_type as enum ('new', 'update', 'cancellation');
create type moderation_status as enum ('pending', 'rejection_proposed', 'approved', 'rejected');

create table moderation_queue (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references listings(id) on delete set null,
  change_type moderation_change_type not null,
  proposed_data jsonb,
  correction_note text,
  origin text not null,
  status moderation_status not null default 'pending',
  proposed_by uuid references auth.users(id),
  proposed_reason text,
  confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table moderation_queue enable row level security;

create policy "moderators can read the queue"
  on moderation_queue for select
  to authenticated
  using (true);

-- The public report form is the only anonymous writer. It may only create a
-- pending update/cancellation correction tied to an existing listing — never
-- a 'new' listing, and never with proposer/reviewer fields pre-filled.
create policy "anyone can submit a correction report"
  on moderation_queue for insert
  to anon
  with check (
    change_type in ('update', 'cancellation')
    and origin = 'report_form'
    and listing_id is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and status = 'pending'
  );

-- Any authenticated moderator may approve a pending entry, or propose its
-- rejection (recording themselves as proposer with a required reason).
create policy "moderators can approve or propose rejection on a pending entry"
  on moderation_queue for update
  to authenticated
  using (status = 'pending')
  with check (
    (status = 'approved')
    or (status = 'rejection_proposed' and proposed_by = auth.uid() and proposed_reason is not null)
  );

-- Only a DIFFERENT moderator than the one who proposed the rejection may
-- confirm it or send it back to pending. This is the governance mechanism
-- the whole design exists to enforce, so it lives in the policy itself, not
-- just the UI.
create policy "a different moderator can confirm or return a proposed rejection"
  on moderation_queue for update
  to authenticated
  using (status = 'rejection_proposed' and auth.uid() <> proposed_by)
  with check (
    (status = 'rejected' and confirmed_by = auth.uid())
    or (status = 'pending')
  );