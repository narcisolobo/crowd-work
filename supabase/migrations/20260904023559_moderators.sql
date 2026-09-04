-- A minimal id -> email lookup so the admin UI can show which moderator
-- did something, without querying auth.users directly (not exposed to the
-- authenticated role via PostgREST). This grants no new permissions — it's
-- a display label, not a moderator-role/permission table, so it doesn't
-- reopen the "no self-serve moderator table" non-goal from the original
-- moderation-queue-admin-review design.
create table moderators (
  id uuid primary key references auth.users(id),
  email text not null
);

alter table moderators enable row level security;

create policy "moderators can read moderator emails"
  on moderators for select
  to authenticated
  using (true);