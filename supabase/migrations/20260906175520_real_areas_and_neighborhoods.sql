alter table neighborhoods drop column area_id;

create table neighborhood_areas (
  neighborhood_id uuid not null references neighborhoods(id),
  area_id uuid not null references areas(id),
  primary key (neighborhood_id, area_id)
);

alter table neighborhood_areas enable row level security;

create policy "neighborhood-area associations are publicly readable"
  on neighborhood_areas for select
  using (true);
