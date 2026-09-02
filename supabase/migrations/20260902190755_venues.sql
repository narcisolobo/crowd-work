create table venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  neighborhood_id uuid not null references neighborhoods(id),
  google_maps_url text
);

alter table venues enable row level security;

create policy "venues are publicly readable"
  on venues for select
  using (true);