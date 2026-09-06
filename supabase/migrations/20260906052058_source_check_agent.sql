-- The registry of venue websites to check. No staleness tracking yet —
-- nothing consumes it. No insert/update policy: sources are registered
-- directly via Supabase Studio until a self-serve admin page justifies one.
create table sources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id),
  url text not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table sources enable row level security;

create policy "moderators can read sources"
  on sources for select
  to authenticated
  using (true);

-- Names which accounts get the narrow source-check insert grant below,
-- instead of hardcoding a uuid into six separate policies. RLS must be
-- enabled here (every other table in this schema is; without it, this
-- project's default role grants would leave the table fully writable by
-- anon/authenticated). The select policy is required for a less obvious
-- reason: every restrictive policy below reads this table via a subquery
-- (`auth.uid() in (select id from source_check_agents)`), and that
-- subquery is itself subject to this table's own RLS — without a select
-- policy it would return zero rows for every authenticated user,
-- including the agent itself, silently making every check below false.
-- Mirrors the existing `moderators` table's identical policy for the
-- identical reason.
create table source_check_agents (
  id uuid primary key references auth.users(id)
);

alter table source_check_agents enable row level security;

create policy "authenticated users can read source-check agent ids"
  on source_check_agents for select
  to authenticated
  using (true);

-- The one capability a source-check agent account has: filing a pending,
-- structurally-constrained finding. Mirrors the shape discipline of the
-- existing anonymous submission/report policies, plus the account
-- restriction.
create policy "a source-check agent can file a pending finding"
  on moderation_queue for insert
  to authenticated
  with check (
    auth.uid() in (select id from source_check_agents)
    and origin = 'source_check'
    and status = 'pending'
    and change_type in ('new', 'update')
    and proposed_data is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and (
      (change_type = 'new' and listing_id is null)
      or (change_type = 'update' and listing_id is not null)
    )
  );

-- Everything below blocks a source-check agent from every other
-- moderator-only write the broad `to authenticated` policies would
-- otherwise grant it. Restrictive policies AND-combine with permissive
-- ones, so these apply regardless of what the pre-existing policies allow.
create policy "source-check agents can't insert listings"
  on listings as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't update listings"
  on listings as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert recurrence rules"
  on recurrence_rules as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't update recurrence rules"
  on recurrence_rules as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert occurrence exceptions"
  on occurrence_exceptions as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert venues"
  on venues as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

-- moderation_queue needs a different shape of restrictive policy for
-- INSERT specifically, because it's the one table where the agent has a
-- legitimate insert path (above) sitting alongside an illegitimate one it
-- must not also satisfy: the existing moderator_direct_add policy has no
-- account restriction of its own, so without this, the agent could
-- self-approve a direct-add listing exactly like a real moderator. A
-- plain "block this uid unconditionally" restrictive policy won't work
-- here, since it would also block the agent's own legitimate insert.
create policy "source-check agents can only insert the finding shape"
  on moderation_queue as restrictive for insert to authenticated
  with check (
    auth.uid() not in (select id from source_check_agents)
    or (
      origin = 'source_check'
      and status = 'pending'
      and change_type in ('new', 'update')
    )
  );

-- moderation_queue UPDATE has no such exception — the agent never updates
-- the queue under any shape.
create policy "source-check agents can't update the moderation queue"
  on moderation_queue as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));
