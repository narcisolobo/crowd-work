create type listing_type as enum ('mic', 'show');
create type listing_status as enum ('published', 'archived');
create type recurrence_frequency as enum ('weekly', 'monthly');
create type exception_type as enum ('cancelled', 'modified');

create table listings (
  id uuid primary key default gen_random_uuid(),
  type listing_type not null,
  title text not null,
  host text,
  description text,
  venue_id uuid not null references venues(id),
  start_time time not null,
  one_off_date date,
  sign_up_method text,
  cost_to_perform text,
  ticket_price text,
  ticket_url text,
  status listing_status not null default 'published',
  created_at timestamptz not null default now()
);

-- One recurrence rule per listing. Listings with no row here are treated
-- as one-off (using one_off_date) — enforced at the application layer,
-- since Postgres CHECK constraints can't reference other tables.
create table recurrence_rules (
  listing_id uuid primary key references listings(id) on delete cascade,
  frequency recurrence_frequency not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  week_of_month smallint check (week_of_month between -1 and 4)
);

create table occurrence_exceptions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  original_date date not null,
  type exception_type not null,
  new_date date,
  new_start_time time,
  new_venue_id uuid references venues(id),
  note text,
  unique (listing_id, original_date)
);

alter table listings enable row level security;
alter table recurrence_rules enable row level security;
alter table occurrence_exceptions enable row level security;

create policy "published listings are publicly readable"
  on listings for select
  using (status = 'published');

create policy "recurrence rules are publicly readable"
  on recurrence_rules for select
  using (true);

create policy "occurrence exceptions are publicly readable"
  on occurrence_exceptions for select
  using (true);