create table areas (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table neighborhoods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  area_id uuid not null references areas(id)
);

alter table areas enable row level security;
alter table neighborhoods enable row level security;

create policy "areas are publicly readable"
  on areas for select
  using (true);

create policy "neighborhoods are publicly readable"
  on neighborhoods for select
  using (true);
