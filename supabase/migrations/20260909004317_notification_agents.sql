alter table moderation_queue
  add column notified_at timestamptz;

-- Names which accounts get the narrow notification grant below, mirroring
-- source_check_agents. The select policy is required for the same
-- non-obvious reason: every policy below reads this table via a subquery,
-- itself subject to this table's own RLS — without a select policy the
-- subquery returns zero rows for everyone, including the agent itself.
create table notification_agents (
  id uuid primary key references auth.users(id)
);

alter table notification_agents enable row level security;

create policy "authenticated users can read notification agent ids"
  on notification_agents for select
  to authenticated
  using (true);

-- The one capability this account has: flipping notified_at on a row that
-- is, and remains, pending. SELECT on moderation_queue and moderators is
-- already `to authenticated using (true)`, so no new SELECT policy is
-- needed for either table.
create policy "notification agents can mark pending entries as notified"
  on moderation_queue for update
  to authenticated
  using (
    auth.uid() in (select id from notification_agents)
    and status = 'pending'
  )
  with check (
    auth.uid() in (select id from notification_agents)
    and status = 'pending'
  );

-- Narrows the permissive policy above so this account can never slip a
-- decision into the same call.
create policy "notification agents can't make moderation decisions"
  on moderation_queue as restrictive for update
  to authenticated
  with check (
    auth.uid() not in (select id from notification_agents)
    or (
      status = 'pending'
      and approved_by is null
      and confirmed_by is null
      and decided_at is null
    )
  );

-- This account has no legitimate insert path anywhere (unlike
-- source_check_agents, which files findings), so the moderation_queue
-- insert block is unconditional.
create policy "notification agents can't insert into the moderation queue"
  on moderation_queue as restrictive for insert
  to authenticated
  with check (auth.uid() not in (select id from notification_agents));

-- Everything below blocks a notification agent from every other
-- moderator-only write the broad `to authenticated` policies would
-- otherwise grant it — mirrors source_check_agents' identical lockdown.
create policy "notification agents can't insert listings"
  on listings as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't update listings"
  on listings as restrictive for update to authenticated
  using (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert recurrence rules"
  on recurrence_rules as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't update recurrence rules"
  on recurrence_rules as restrictive for update to authenticated
  using (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert occurrence exceptions"
  on occurrence_exceptions as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert venues"
  on venues as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));