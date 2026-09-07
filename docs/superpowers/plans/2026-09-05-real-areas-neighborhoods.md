# Real Areas & Neighborhoods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `areas`/`neighborhoods` fixture data with a real taxonomy (16 LA Times regions, 233 LA County neighborhoods), and move the area/neighborhood relationship from one-to-many to many-to-many so a neighborhood can carry both an official region and a colloquial one (Los Feliz/Silver Lake: Central L.A. + Eastside).

**Architecture:** One migration drops `neighborhoods.area_id` and adds a `neighborhood_areas` join table (RLS-enabled, publicly readable, no write policy — matches the existing `areas`/`neighborhoods` convention). A new idempotent SQL seed file carries the full taxonomy, registered for local dev via `supabase/config.toml`, and run once against production via `psql`. `src/lib/data/listings.ts`'s `Neighborhood`/`ListingWithVenue` interfaces move from a single `areaId` to an `areaIds` array, rippling into the one live consumer of area filtering: `src/pages/index.astro` and `ListingRow.astro`.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase), plain SQL seed files. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-05-real-areas-neighborhoods-design.md](../specs/2026-09-05-real-areas-neighborhoods-design.md)

## Global Constraints

- `neighborhood_areas` has no insert/update policy for any role — matches the existing "no self-serve" convention already in place for `areas` and `neighborhoods` themselves. All writes to these three tables happen via seed files applied through a privileged connection (local: `supabase db reset`; production: `psql`), never through the app.
- The pre-existing fixed UUIDs must survive this change: areas `a0000000-0000-0000-0000-000000000001` (Eastside) and `a0000000-0000-0000-0000-000000000002` (Westside); neighborhoods `b0000000-0000-0000-0000-000000000001` (Los Feliz), `b0000000-0000-0000-0000-000000000002` (Silver Lake), `b0000000-0000-0000-0000-000000000003` (Santa Monica). Several existing tests hardcode these ids.
- Los Feliz and Silver Lake each belong to two areas: Central L.A. (official LA Times region) and Eastside (colloquial, and the fixed-UUID area already in `seed.sql`). Every other neighborhood in this phase belongs to exactly one area.
- `data-area` on `ListingRow.astro` is not read by any script today (confirmed via search) — its `areaIds.join(" ")` change is mechanical, not a behavior change.
- The project's local Supabase MCP tools are currently disconnected — use the Supabase CLI (`supabase db reset`, `supabase gen types`) and `psql` for all local verification in this plan, not MCP tools.
- Tasks 1 and 2 leave `pnpm test` transiently broken (`listings.ts` still selects the column Task 1 drops) — that's why neither task's steps run it. Don't run the full suite until Task 3, which fixes the query and its test together.

---

## File Structure

```
crowd-work/
├── supabase/
│   ├── config.toml                                          # modified: db.seed.sql_paths
│   ├── migrations/
│   │   └── <timestamp>_real_areas_and_neighborhoods.sql      # new
│   ├── seed.sql                                              # modified: drop area_id from the neighborhoods insert
│   └── seeds/
│       └── areas_and_neighborhoods.sql                       # new: the full taxonomy, 16 areas / 233 neighborhoods / 236 pairs
├── src/
│   ├── lib/
│   │   ├── supabase/
│   │   │   └── database.types.ts                             # regenerated
│   │   └── data/
│   │       ├── listings.ts                                   # modified: Neighborhood.areaIds, ListingWithVenue.venue.areaIds
│   │       └── listings.test.ts                               # modified: areaIds assertions; new getPublishedListings dual-tag test
│   ├── pages/
│   │   └── index.astro                                        # modified: matchesArea, areaIds pass-through
│   └── components/
│       └── listings/
│           └── ListingRow.astro                                # modified: areaIds prop, data-area
```

---

### Task 1: Migration — drop `area_id`, add the `neighborhood_areas` join table

**Files:**

- Create: `supabase/migrations/<timestamp>_real_areas_and_neighborhoods.sql`

**Interfaces:**

- Consumes: `neighborhoods`, `areas` tables as they exist today
- Produces: `neighborhood_areas` table (`neighborhood_id`, `area_id`, composite primary key) — consumed by Task 2's seed file and Task 3/4's queries

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new real_areas_and_neighborhoods
```

- [ ] **Step 2: Write the migration**

Open the generated file and write:

```sql
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
```

- [ ] **Step 3: Remove `area_id` from `seed.sql`'s neighborhoods insert**

This has to happen in the same task as the migration — `supabase db reset` runs migrations then `seed.sql` in one pass, and the old `insert into neighborhoods (id, name, area_id) values (...)` will fail once the column is gone.

In `supabase/seed.sql`, replace:

```sql
insert into neighborhoods (id, name, area_id) values
  ('b0000000-0000-0000-0000-000000000001', 'Los Feliz', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', 'Silver Lake', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003', 'Santa Monica', 'a0000000-0000-0000-0000-000000000002');
```

with:

```sql
insert into neighborhoods (id, name) values
  ('b0000000-0000-0000-0000-000000000001', 'Los Feliz'),
  ('b0000000-0000-0000-0000-000000000002', 'Silver Lake'),
  ('b0000000-0000-0000-0000-000000000003', 'Santa Monica');
```

The `insert into areas (id, name) values (...)` block above it is untouched — the `areas` table isn't changing shape.

- [ ] **Step 4: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `real_areas_and_neighborhoods` apply with no errors, and `seed.sql` re-applies successfully with the edited neighborhoods insert. This step does **not** yet populate `neighborhood_areas` (Task 2 adds that) — for now, just confirm the reset completes cleanly, since `venues` still references `neighborhood_id` (unaffected).

**Do not run `pnpm test` at the end of this task or Task 2.** `src/lib/data/listings.ts` still selects the now-dropped `area_id` column until Task 3 updates it, so `listings.test.ts`'s existing `getNeighborhoods` test will fail against this schema — that's expected and temporary, not a regression to chase. Task 3 fixes the query and the test together, in the same commit; that's the first point where running the suite is meaningful again.

- [ ] **Step 5: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `neighborhoods` loses its `area_id` field in the generated types; `neighborhood_areas` appears as a new table.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations supabase/seed.sql src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: replace neighborhoods.area_id with a neighborhood_areas join table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Seed data — the real area/neighborhood taxonomy

**Files:**

- Create: `supabase/seeds/areas_and_neighborhoods.sql`
- Modify: `supabase/config.toml`

**Interfaces:**

- Consumes: `neighborhood_areas` table (Task 1)
- Produces: 16 rows in `areas`, 233 rows in `neighborhoods`, 236 rows in `neighborhood_areas` — consumed by Task 3/4's tests and every page that reads this data

- [ ] **Step 1: Create the seed file**

Create `supabase/seeds/areas_and_neighborhoods.sql`:

```sql
-- Real LA area/neighborhood taxonomy, replacing the placeholder
-- Eastside/Westside fixture data. Neighborhoods are the LA Times'
-- Mapping L.A. project boundaries (114 official City of LA
-- neighborhoods, verified against the live dataset at
-- data-lahub.opendata.arcgis.com) extended with the surrounding LA
-- County neighborhoods under the same project's 16 regions, since real
-- comedy venues sit outside city limits too (e.g. the existing seed
-- venue "Westside Comedy Theater" is in Santa Monica).
--
-- Idempotent (on conflict do nothing) so this file can run safely
-- against local dev (via config.toml's db.seed.sql_paths) and, once,
-- against production via psql or the Studio SQL editor.

insert into areas (name) values
  ('Angeles Forest'),
  ('Antelope Valley'),
  ('Central L.A.'),
  ('Eastside'),
  ('Harbor'),
  ('Northeast L.A.'),
  ('Northwest County'),
  ('Pomona Valley'),
  ('San Fernando Valley'),
  ('San Gabriel Valley'),
  ('Santa Monica Mountains'),
  ('South Bay'),
  ('South L.A.'),
  ('Southeast'),
  ('Verdugos'),
  ('Westside')
on conflict (name) do nothing;

insert into neighborhoods (name)
select v.name from (values
  ('Acton'),
  ('Adams-Normandie'),
  ('Agoura Hills'),
  ('Agua Dulce'),
  ('Alhambra'),
  ('Alondra Park'),
  ('Altadena'),
  ('Angeles National Forest'),
  ('Arcadia'),
  ('Arleta'),
  ('Arlington Heights'),
  ('Artesia'),
  ('Atwater Village'),
  ('Avocado Heights'),
  ('Azusa'),
  ('Baldwin Hills/Crenshaw'),
  ('Baldwin Park'),
  ('Bel-Air'),
  ('Bell'),
  ('Bell Gardens'),
  ('Bellflower'),
  ('Beverly Crest'),
  ('Beverly Grove'),
  ('Beverly Hills'),
  ('Beverlywood'),
  ('Boyle Heights'),
  ('Bradbury'),
  ('Brentwood'),
  ('Broadway-Manchester'),
  ('Burbank'),
  ('Calabasas'),
  ('Canoga Park'),
  ('Carson'),
  ('Carthay'),
  ('Castaic'),
  ('Castaic Junction'),
  ('Central-Alameda'),
  ('Century City'),
  ('Cerritos'),
  ('Chatsworth'),
  ('Chatsworth Reservoir'),
  ('Chesterfield Square'),
  ('Cheviot Hills'),
  ('Chinatown'),
  ('City of Industry'),
  ('Claremont'),
  ('Commerce'),
  ('Covina'),
  ('Cudahy'),
  ('Culver City'),
  ('Cypress Park'),
  ('Del Aire'),
  ('Del Rey'),
  ('Desert View Highlands'),
  ('Diamond Bar'),
  ('Downey'),
  ('Downtown'),
  ('Duarte'),
  ('Eagle Rock'),
  ('East Hollywood'),
  ('East Pasadena'),
  ('Echo Park'),
  ('El Monte'),
  ('El Segundo'),
  ('El Sereno'),
  ('Elysian Park'),
  ('Elysian Valley'),
  ('Encino'),
  ('Exposition Park'),
  ('Fairfax'),
  ('Florence'),
  ('Florence-Firestone'),
  ('Gardena'),
  ('Glassell Park'),
  ('Glendale'),
  ('Glendora'),
  ('Gorman'),
  ('Gramercy Park'),
  ('Granada Hills'),
  ('Green Meadows'),
  ('Green Valley'),
  ('Griffith Park'),
  ('Hacienda Heights'),
  ('Hancock Park'),
  ('Hansen Dam'),
  ('Harbor City'),
  ('Harbor Gateway'),
  ('Harvard Heights'),
  ('Harvard Park'),
  ('Hasley Canyon'),
  ('Hawaiian Gardens'),
  ('Hawthorne'),
  ('Hermosa Beach'),
  ('Hidden Hills'),
  ('Highland Park'),
  ('Historic South-Central'),
  ('Hollywood'),
  ('Hollywood Hills'),
  ('Hollywood Hills West'),
  ('Huntington Park'),
  ('Hyde Park'),
  ('Irwindale'),
  ('Jefferson Park'),
  ('Koreatown'),
  ('La Cañada Flintridge'),
  ('La Crescenta-Montrose'),
  ('La Mirada'),
  ('La Puente'),
  ('La Verne'),
  ('Lake Balboa'),
  ('Lake Hughes'),
  ('Lake Los Angeles'),
  ('Lake View Terrace'),
  ('Lakewood'),
  ('Lancaster'),
  ('Larchmont'),
  ('Lawndale'),
  ('Leimert Park'),
  ('Leona Valley'),
  ('Lincoln Heights'),
  ('Little Tokyo'),
  ('Littlerock'),
  ('Llano'),
  ('Lomita'),
  ('Los Feliz'),
  ('Lynwood'),
  ('Malibu'),
  ('Manchester Square'),
  ('Manhattan Beach'),
  ('Mar Vista'),
  ('Marina del Rey'),
  ('Mayford'),
  ('Maywood'),
  ('Mid-City'),
  ('Mid-Wilshire'),
  ('Mission Hills'),
  ('Monrovia'),
  ('Montecito Heights'),
  ('Monterey Park'),
  ('Mount Baldy'),
  ('Mount Washington'),
  ('North Hills'),
  ('North Hollywood'),
  ('Northridge'),
  ('Norwalk'),
  ('Pacific Palisades'),
  ('Pacoima'),
  ('Palmdale'),
  ('Palms'),
  ('Palos Verdes Estates'),
  ('Panorama City'),
  ('Paramount'),
  ('Pasadena'),
  ('Pearblossom'),
  ('Pico Rivera'),
  ('Pico-Robertson'),
  ('Pico-Union'),
  ('Playa Vista'),
  ('Playa del Rey'),
  ('Pomona'),
  ('Porter Ranch'),
  ('Quartz Hill'),
  ('Rancho Palos Verdes'),
  ('Rancho Park'),
  ('Redondo Beach'),
  ('Reseda'),
  ('Rolling Hills'),
  ('Rolling Hills Estates'),
  ('Rosemead'),
  ('Rowland Heights'),
  ('San Dimas'),
  ('San Fernando'),
  ('San Gabriel'),
  ('San Marino'),
  ('San Pedro'),
  ('Santa Clarita'),
  ('Santa Monica'),
  ('Sawtelle'),
  ('Sepulveda Basin'),
  ('Shadow Hills'),
  ('Sherman Oaks'),
  ('Sierra Madre'),
  ('Signal Hill'),
  ('Silver Lake'),
  ('South El Monte'),
  ('South Gate'),
  ('South Park'),
  ('South Pasadena'),
  ('South San Gabriel'),
  ('Stevenson Ranch'),
  ('Studio City'),
  ('Sun Valley'),
  ('Sun Village'),
  ('Sunland'),
  ('Sylmar'),
  ('Tarzana'),
  ('Temple City'),
  ('Toluca Lake'),
  ('Topanga'),
  ('Torrance'),
  ('Tujunga'),
  ('Universal City'),
  ('University Park'),
  ('Val Verde'),
  ('Valinda'),
  ('Valley Glen'),
  ('Valley Village'),
  ('Valyermo'),
  ('Van Nuys'),
  ('Venice'),
  ('Vermont Knolls'),
  ('Vermont Square'),
  ('Vermont Vista'),
  ('Vermont-Slauson'),
  ('Vincent'),
  ('Watts'),
  ('West Adams'),
  ('West Carson'),
  ('West Covina'),
  ('West Hills'),
  ('West Hollywood'),
  ('West Los Angeles'),
  ('West Puente Valley'),
  ('Westchester'),
  ('Westlake'),
  ('Westlake Village'),
  ('Westwood'),
  ('Whittier'),
  ('Willowbrook'),
  ('Wilmington'),
  ('Windsor Square'),
  ('Winnetka'),
  ('Woodland Hills')
) as v(name)
on conflict (name) do nothing;

insert into neighborhood_areas (neighborhood_id, area_id)
select n.id, a.id
from (values
  ('Angeles National Forest', 'Angeles Forest'),
  ('Mount Baldy', 'Angeles Forest'),
  ('Acton', 'Antelope Valley'),
  ('Agua Dulce', 'Antelope Valley'),
  ('Desert View Highlands', 'Antelope Valley'),
  ('Green Valley', 'Antelope Valley'),
  ('Lake Los Angeles', 'Antelope Valley'),
  ('Lancaster', 'Antelope Valley'),
  ('Leona Valley', 'Antelope Valley'),
  ('Littlerock', 'Antelope Valley'),
  ('Llano', 'Antelope Valley'),
  ('Palmdale', 'Antelope Valley'),
  ('Pearblossom', 'Antelope Valley'),
  ('Quartz Hill', 'Antelope Valley'),
  ('Sun Village', 'Antelope Valley'),
  ('Valyermo', 'Antelope Valley'),
  ('Arlington Heights', 'Central L.A.'),
  ('Beverly Grove', 'Central L.A.'),
  ('Carthay', 'Central L.A.'),
  ('Chinatown', 'Central L.A.'),
  ('Downtown', 'Central L.A.'),
  ('East Hollywood', 'Central L.A.'),
  ('Echo Park', 'Central L.A.'),
  ('Elysian Park', 'Central L.A.'),
  ('Fairfax', 'Central L.A.'),
  ('Griffith Park', 'Central L.A.'),
  ('Hancock Park', 'Central L.A.'),
  ('Harvard Heights', 'Central L.A.'),
  ('Hollywood', 'Central L.A.'),
  ('Koreatown', 'Central L.A.'),
  ('Larchmont', 'Central L.A.'),
  ('Little Tokyo', 'Central L.A.'),
  ('Los Feliz', 'Central L.A.'),
  ('Mid-City', 'Central L.A.'),
  ('Mid-Wilshire', 'Central L.A.'),
  ('Pico-Union', 'Central L.A.'),
  ('Silver Lake', 'Central L.A.'),
  ('Westlake', 'Central L.A.'),
  ('Windsor Square', 'Central L.A.'),
  ('Boyle Heights', 'Eastside'),
  ('El Sereno', 'Eastside'),
  ('Lincoln Heights', 'Eastside'),
  ('Los Feliz', 'Eastside'),
  ('Silver Lake', 'Eastside'),
  ('Harbor City', 'Harbor'),
  ('Harbor Gateway', 'Harbor'),
  ('San Pedro', 'Harbor'),
  ('Wilmington', 'Harbor'),
  ('Atwater Village', 'Northeast L.A.'),
  ('Cypress Park', 'Northeast L.A.'),
  ('Eagle Rock', 'Northeast L.A.'),
  ('Elysian Valley', 'Northeast L.A.'),
  ('Glassell Park', 'Northeast L.A.'),
  ('Highland Park', 'Northeast L.A.'),
  ('Montecito Heights', 'Northeast L.A.'),
  ('Mount Washington', 'Northeast L.A.'),
  ('Castaic', 'Northwest County'),
  ('Castaic Junction', 'Northwest County'),
  ('Gorman', 'Northwest County'),
  ('Hasley Canyon', 'Northwest County'),
  ('Lake Hughes', 'Northwest County'),
  ('Santa Clarita', 'Northwest County'),
  ('Stevenson Ranch', 'Northwest County'),
  ('Val Verde', 'Northwest County'),
  ('Claremont', 'Pomona Valley'),
  ('Diamond Bar', 'Pomona Valley'),
  ('La Verne', 'Pomona Valley'),
  ('Pomona', 'Pomona Valley'),
  ('San Dimas', 'Pomona Valley'),
  ('Arleta', 'San Fernando Valley'),
  ('Burbank', 'San Fernando Valley'),
  ('Calabasas', 'San Fernando Valley'),
  ('Canoga Park', 'San Fernando Valley'),
  ('Chatsworth', 'San Fernando Valley'),
  ('Chatsworth Reservoir', 'San Fernando Valley'),
  ('Encino', 'San Fernando Valley'),
  ('Glendale', 'San Fernando Valley'),
  ('Granada Hills', 'San Fernando Valley'),
  ('Hidden Hills', 'San Fernando Valley'),
  ('Lake Balboa', 'San Fernando Valley'),
  ('Mission Hills', 'San Fernando Valley'),
  ('North Hills', 'San Fernando Valley'),
  ('North Hollywood', 'San Fernando Valley'),
  ('Northridge', 'San Fernando Valley'),
  ('Pacoima', 'San Fernando Valley'),
  ('Panorama City', 'San Fernando Valley'),
  ('Porter Ranch', 'San Fernando Valley'),
  ('Reseda', 'San Fernando Valley'),
  ('San Fernando', 'San Fernando Valley'),
  ('Sepulveda Basin', 'San Fernando Valley'),
  ('Sherman Oaks', 'San Fernando Valley'),
  ('Studio City', 'San Fernando Valley'),
  ('Sun Valley', 'San Fernando Valley'),
  ('Sylmar', 'San Fernando Valley'),
  ('Tarzana', 'San Fernando Valley'),
  ('Toluca Lake', 'San Fernando Valley'),
  ('Universal City', 'San Fernando Valley'),
  ('Valley Glen', 'San Fernando Valley'),
  ('Valley Village', 'San Fernando Valley'),
  ('Van Nuys', 'San Fernando Valley'),
  ('West Hills', 'San Fernando Valley'),
  ('Winnetka', 'San Fernando Valley'),
  ('Woodland Hills', 'San Fernando Valley'),
  ('Alhambra', 'San Gabriel Valley'),
  ('Altadena', 'San Gabriel Valley'),
  ('Arcadia', 'San Gabriel Valley'),
  ('Avocado Heights', 'San Gabriel Valley'),
  ('Azusa', 'San Gabriel Valley'),
  ('Baldwin Park', 'San Gabriel Valley'),
  ('Bradbury', 'San Gabriel Valley'),
  ('City of Industry', 'San Gabriel Valley'),
  ('Covina', 'San Gabriel Valley'),
  ('Duarte', 'San Gabriel Valley'),
  ('East Pasadena', 'San Gabriel Valley'),
  ('El Monte', 'San Gabriel Valley'),
  ('Glendora', 'San Gabriel Valley'),
  ('Hacienda Heights', 'San Gabriel Valley'),
  ('Irwindale', 'San Gabriel Valley'),
  ('La Puente', 'San Gabriel Valley'),
  ('Mayford', 'San Gabriel Valley'),
  ('Monrovia', 'San Gabriel Valley'),
  ('Monterey Park', 'San Gabriel Valley'),
  ('Pasadena', 'San Gabriel Valley'),
  ('Rosemead', 'San Gabriel Valley'),
  ('Rowland Heights', 'San Gabriel Valley'),
  ('San Gabriel', 'San Gabriel Valley'),
  ('San Marino', 'San Gabriel Valley'),
  ('Sierra Madre', 'San Gabriel Valley'),
  ('South El Monte', 'San Gabriel Valley'),
  ('South Pasadena', 'San Gabriel Valley'),
  ('South San Gabriel', 'San Gabriel Valley'),
  ('Temple City', 'San Gabriel Valley'),
  ('Valinda', 'San Gabriel Valley'),
  ('Vincent', 'San Gabriel Valley'),
  ('West Covina', 'San Gabriel Valley'),
  ('West Puente Valley', 'San Gabriel Valley'),
  ('Agoura Hills', 'Santa Monica Mountains'),
  ('Bel-Air', 'Santa Monica Mountains'),
  ('Beverly Crest', 'Santa Monica Mountains'),
  ('Brentwood', 'Santa Monica Mountains'),
  ('Hidden Hills', 'Santa Monica Mountains'),
  ('Hollywood Hills', 'Santa Monica Mountains'),
  ('Hollywood Hills West', 'Santa Monica Mountains'),
  ('Malibu', 'Santa Monica Mountains'),
  ('Pacific Palisades', 'Santa Monica Mountains'),
  ('Topanga', 'Santa Monica Mountains'),
  ('Westlake Village', 'Santa Monica Mountains'),
  ('Alondra Park', 'South Bay'),
  ('Carson', 'South Bay'),
  ('Del Aire', 'South Bay'),
  ('El Segundo', 'South Bay'),
  ('Gardena', 'South Bay'),
  ('Hawthorne', 'South Bay'),
  ('Hermosa Beach', 'South Bay'),
  ('Lawndale', 'South Bay'),
  ('Lomita', 'South Bay'),
  ('Manhattan Beach', 'South Bay'),
  ('Palos Verdes Estates', 'South Bay'),
  ('Rancho Palos Verdes', 'South Bay'),
  ('Redondo Beach', 'South Bay'),
  ('Rolling Hills', 'South Bay'),
  ('Rolling Hills Estates', 'South Bay'),
  ('Torrance', 'South Bay'),
  ('West Carson', 'South Bay'),
  ('Adams-Normandie', 'South L.A.'),
  ('Baldwin Hills/Crenshaw', 'South L.A.'),
  ('Broadway-Manchester', 'South L.A.'),
  ('Central-Alameda', 'South L.A.'),
  ('Chesterfield Square', 'South L.A.'),
  ('Exposition Park', 'South L.A.'),
  ('Florence', 'South L.A.'),
  ('Florence-Firestone', 'South L.A.'),
  ('Gramercy Park', 'South L.A.'),
  ('Green Meadows', 'South L.A.'),
  ('Harvard Park', 'South L.A.'),
  ('Historic South-Central', 'South L.A.'),
  ('Hyde Park', 'South L.A.'),
  ('Jefferson Park', 'South L.A.'),
  ('Leimert Park', 'South L.A.'),
  ('Lynwood', 'South L.A.'),
  ('Manchester Square', 'South L.A.'),
  ('Pico-Robertson', 'South L.A.'),
  ('South Park', 'South L.A.'),
  ('University Park', 'South L.A.'),
  ('Vermont Knolls', 'South L.A.'),
  ('Vermont Square', 'South L.A.'),
  ('Vermont Vista', 'South L.A.'),
  ('Vermont-Slauson', 'South L.A.'),
  ('Watts', 'South L.A.'),
  ('West Adams', 'South L.A.'),
  ('Willowbrook', 'South L.A.'),
  ('Artesia', 'Southeast'),
  ('Bell', 'Southeast'),
  ('Bell Gardens', 'Southeast'),
  ('Bellflower', 'Southeast'),
  ('Cerritos', 'Southeast'),
  ('Commerce', 'Southeast'),
  ('Cudahy', 'Southeast'),
  ('Downey', 'Southeast'),
  ('Hawaiian Gardens', 'Southeast'),
  ('Huntington Park', 'Southeast'),
  ('La Mirada', 'Southeast'),
  ('Lakewood', 'Southeast'),
  ('Maywood', 'Southeast'),
  ('Norwalk', 'Southeast'),
  ('Paramount', 'Southeast'),
  ('Pico Rivera', 'Southeast'),
  ('Signal Hill', 'Southeast'),
  ('South Gate', 'Southeast'),
  ('Whittier', 'Southeast'),
  ('Hansen Dam', 'Verdugos'),
  ('La Cañada Flintridge', 'Verdugos'),
  ('La Crescenta-Montrose', 'Verdugos'),
  ('Lake View Terrace', 'Verdugos'),
  ('Shadow Hills', 'Verdugos'),
  ('Sunland', 'Verdugos'),
  ('Tujunga', 'Verdugos'),
  ('Beverly Hills', 'Westside'),
  ('Beverlywood', 'Westside'),
  ('Century City', 'Westside'),
  ('Cheviot Hills', 'Westside'),
  ('Culver City', 'Westside'),
  ('Del Rey', 'Westside'),
  ('Mar Vista', 'Westside'),
  ('Marina del Rey', 'Westside'),
  ('Palms', 'Westside'),
  ('Playa Vista', 'Westside'),
  ('Playa del Rey', 'Westside'),
  ('Rancho Park', 'Westside'),
  ('Santa Monica', 'Westside'),
  ('Sawtelle', 'Westside'),
  ('Venice', 'Westside'),
  ('West Hollywood', 'Westside'),
  ('West Los Angeles', 'Westside'),
  ('Westchester', 'Westside'),
  ('Westwood', 'Westside')
) as v(neighborhood_name, area_name)
join neighborhoods n on n.name = v.neighborhood_name
join areas a on a.name = v.area_name
on conflict (neighborhood_id, area_id) do nothing;
```

- [ ] **Step 2: Register the new seed file**

In `supabase/config.toml`, under `[db.seed]`, change:

```toml
sql_paths = ["./seed.sql"]
```

to:

```toml
sql_paths = ["./seed.sql", "./seeds/*.sql"]
```

Order matters: `seed.sql` must apply first, so the fixed-UUID areas/neighborhoods already exist when the new file's `on conflict (name) do nothing` clauses run — otherwise this file would create fresh rows (and fresh UUIDs) for Eastside, Westside, Los Feliz, Silver Lake, and Santa Monica instead of reusing the existing fixed ones.

- [ ] **Step 3: Apply and verify row counts**

```bash
supabase db reset
```

Expected: no errors.

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54522/postgres" -c "select count(*) from areas;" -c "select count(*) from neighborhoods;" -c "select count(*) from neighborhood_areas;"
```

Expected: `areas` = 16, `neighborhoods` = 233, `neighborhood_areas` = 236.

- [ ] **Step 4: Verify the fixed UUIDs survived**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54522/postgres" -c "select id, name from areas where id in ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002') order by name;"
psql "postgresql://postgres:postgres@127.0.0.1:54522/postgres" -c "select id, name from neighborhoods where id in ('b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003') order by name;"
```

Expected: `a0000000-...001` is still named "Eastside", `a0000000-...002` still "Westside"; `b0000000-...001` still "Los Feliz", `b0000000-...002` still "Silver Lake", `b0000000-...003` still "Santa Monica" — i.e. the seed file's `on conflict` clauses correctly skipped re-inserting them rather than creating duplicates or new ids.

- [ ] **Step 5: Verify the dual-tag**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54522/postgres" -c "select n.name as neighborhood, a.name as area from neighborhood_areas na join neighborhoods n on n.id = na.neighborhood_id join areas a on a.id = na.area_id where n.name in ('Los Feliz', 'Silver Lake') order by n.name, a.name;"
```

Expected: 4 rows — Los Feliz/Central L.A., Los Feliz/Eastside, Silver Lake/Central L.A., Silver Lake/Eastside.

- [ ] **Step 6: Commit**

```bash
git add supabase/seeds supabase/config.toml
git commit -m "$(cat <<'EOF'
feat: seed the real LA area/neighborhood taxonomy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Data layer — `getNeighborhoods()` returns `areaIds`

**Files:**

- Modify: `src/lib/data/listings.ts`
- Modify: `src/lib/data/listings.test.ts`

**Interfaces:**

- Consumes: `neighborhood_areas` table (Task 1), the seeded taxonomy (Task 2)
- Produces: `Neighborhood.areaIds: string[]` (was `areaId: string`) — consumed by Task 4 (shared file) and every page that calls `getNeighborhoods()` (none of which read `.areaId`/`.areaIds` today — confirmed via search — so this is a non-breaking type change for those callers)

- [ ] **Step 1: Update the failing test**

In `src/lib/data/listings.test.ts`, replace the whole file:

```ts
import { describe, it, expect } from "vitest";
import { getNeighborhoods, getAreas } from "./listings";

describe("getNeighborhoods", () => {
  it("returns neighborhoods ordered by name, each with its area ids", async () => {
    const [neighborhoods, areas] = await Promise.all([
      getNeighborhoods(),
      getAreas(),
    ]);
    const centralLA = areas.find((a) => a.name === "Central L.A.");
    expect(centralLA).toBeDefined();

    const losFeliz = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000001",
    );
    expect(losFeliz?.name).toBe("Los Feliz");
    expect(losFeliz?.areaIds).toEqual(
      expect.arrayContaining([
        centralLA!.id,
        "a0000000-0000-0000-0000-000000000001",
      ]),
    );
    expect(losFeliz?.areaIds).toHaveLength(2);

    const santaMonica = neighborhoods.find(
      (n) => n.id === "b0000000-0000-0000-0000-000000000003",
    );
    expect(santaMonica?.areaIds).toEqual([
      "a0000000-0000-0000-0000-000000000002",
    ]);

    const names = neighborhoods.map((n) => n.name);
    expect(names).toEqual([...names].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test listings.test
```

Expected: FAIL — `areaIds` doesn't exist on the returned shape yet (still `areaId`).

- [ ] **Step 3: Update the `Neighborhood` interface and `getNeighborhoods`**

In `src/lib/data/listings.ts`, replace:

```ts
export interface Neighborhood {
  id: string;
  name: string;
  areaId: string;
}

export async function getNeighborhoods(): Promise<Neighborhood[]> {
  const { data, error } = await supabase
    .from("neighborhoods")
    .select("id, name, area_id")
    .order("name");
  if (error) throw new Error(`Failed to load neighborhoods: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    areaId: row.area_id,
  }));
}
```

with:

```ts
export interface Neighborhood {
  id: string;
  name: string;
  areaIds: string[];
}

export async function getNeighborhoods(): Promise<Neighborhood[]> {
  const { data, error } = await supabase
    .from("neighborhoods")
    .select("id, name, neighborhood_areas ( area_id )")
    .order("name");
  if (error) throw new Error(`Failed to load neighborhoods: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    areaIds: (row.neighborhood_areas ?? []).map(
      (na: { area_id: string }) => na.area_id,
    ),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test listings.test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/listings.ts src/lib/data/listings.test.ts
git commit -m "$(cat <<'EOF'
feat: return every tagged area for a neighborhood, not just one

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Data layer — `getPublishedListings()` returns `venue.areaIds`

**Files:**

- Modify: `src/lib/data/listings.ts`
- Modify: `src/lib/data/listings.test.ts`

**Interfaces:**

- Consumes: `neighborhood_areas` table (Task 1), the seeded taxonomy (Task 2); the `mapListingRow`/`LISTING_WITH_VENUE_SELECT` pattern this task extends
- Produces: `ListingWithVenue.venue.areaIds: string[]` (was `areaId: string`) — consumed by Task 5's `index.astro`/`ListingRow.astro`

- [ ] **Step 1: Write the failing test**

In `src/lib/data/listings.test.ts`, change the import line from Task 3 to also pull in `getPublishedListings`:

```ts
import { describe, it, expect } from "vitest";
import { getNeighborhoods, getAreas, getPublishedListings } from "./listings";
```

Add after the `getNeighborhoods` describe block:

```ts
describe("getPublishedListings", () => {
  it("returns every tagged area for a listing in a dual-tagged neighborhood", async () => {
    const [listings, areas] = await Promise.all([
      getPublishedListings(),
      getAreas(),
    ]);
    const centralLA = areas.find((a) => a.name === "Central L.A.");
    expect(centralLA).toBeDefined();

    // "The Virgil" (seeded venue) sits in Silver Lake, which is tagged
    // both Central L.A. (official) and Eastside (colloquial, fixed uuid).
    const tuesdayMic = listings.find((l) => l.title === "Tuesday Night Mic");
    expect(tuesdayMic).toBeDefined();
    expect(tuesdayMic!.venue.areaIds).toEqual(
      expect.arrayContaining([
        centralLA!.id,
        "a0000000-0000-0000-0000-000000000001",
      ]),
    );
    expect(tuesdayMic!.venue.areaIds).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test listings.test
```

Expected: FAIL — `venue.areaIds` doesn't exist yet (still `venue.areaId`).

- [ ] **Step 3: Update `ListingWithVenue`, `LISTING_WITH_VENUE_SELECT`, and `mapListingRow`**

In `src/lib/data/listings.ts`, in the `ListingWithVenue` interface, replace:

```ts
  venue: {
    id: string;
    name: string;
    address: string;
    googleMapsUrl: string | null;
    neighborhoodId: string;
    areaId: string;
  };
```

with:

```ts
  venue: {
    id: string;
    name: string;
    address: string;
    googleMapsUrl: string | null;
    neighborhoodId: string;
    areaIds: string[];
  };
```

Replace `LISTING_WITH_VENUE_SELECT`:

```ts
const LISTING_WITH_VENUE_SELECT = `
  id, type, title, host, description, start_time, one_off_date,
  sign_up_method, cost_to_perform, ticket_price, ticket_url,
  venue:venues (
    id, name, address, google_maps_url,
    neighborhood:neighborhoods ( id, area_id )
  ),
  recurrence_rules ( frequency, day_of_week, week_of_month )
`;
```

with:

```ts
const LISTING_WITH_VENUE_SELECT = `
  id, type, title, host, description, start_time, one_off_date,
  sign_up_method, cost_to_perform, ticket_price, ticket_url,
  venue:venues (
    id, name, address, google_maps_url,
    neighborhood:neighborhoods ( id, neighborhood_areas ( area_id ) )
  ),
  recurrence_rules ( frequency, day_of_week, week_of_month )
`;
```

In `mapListingRow`, replace:

```ts
      neighborhoodId: row.venue.neighborhood.id,
      areaId: row.venue.neighborhood.area_id,
```

with:

```ts
      neighborhoodId: row.venue.neighborhood.id,
      areaIds: (row.venue.neighborhood.neighborhood_areas ?? []).map(
        (na: { area_id: string }) => na.area_id,
      ),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test listings.test
```

Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS — everything from prior tasks plus this one.

- [ ] **Step 6: Commit**

```bash
git add src/lib/data/listings.ts src/lib/data/listings.test.ts
git commit -m "$(cat <<'EOF'
feat: return every tagged area for a listing's venue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Consumers — the public area filter and `ListingRow`

**Files:**

- Modify: `src/pages/index.astro`
- Modify: `src/components/listings/ListingRow.astro`

**Interfaces:**

- Consumes: `ListingWithVenue.venue.areaIds` (Task 4)
- Produces: the `/?area=<id>` filter continuing to work correctly against a multi-area venue

This task is UI-only; per this project's existing testing convention, verify manually rather than with an automated test.

- [ ] **Step 1: Update the area filter and row mapping in `index.astro`**

In `src/pages/index.astro`, replace:

```ts
    const matchesArea = !areaFilter || listing.venue.areaId === areaFilter;
```

with:

```ts
    const matchesArea =
      !areaFilter || listing.venue.areaIds.includes(areaFilter);
```

Replace:

```ts
      areaId: listing.venue.areaId,
```

with:

```ts
      areaIds: listing.venue.areaIds,
```

- [ ] **Step 2: Update `ListingRow.astro`'s prop type and `data-area`**

In `src/components/listings/ListingRow.astro`, replace:

```ts
export interface ListingRowData {
  id: string;
  title: string;
  type: "mic" | "show";
  dayOfWeek: number;
  areaId: string;
  venueName: string;
```

with:

```ts
export interface ListingRowData {
  id: string;
  title: string;
  type: "mic" | "show";
  dayOfWeek: number;
  areaIds: string[];
  venueName: string;
```

Replace:

```ts
const {
  id,
  title,
  type,
  dayOfWeek,
  areaId,
  venueName,
```

with:

```ts
const {
  id,
  title,
  type,
  dayOfWeek,
  areaIds,
  venueName,
```

Replace:

```astro
  data-area={areaId}
```

with:

```astro
  data-area={areaIds.join(" ")}
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec astro check
```

Expected: no errors.

- [ ] **Step 4: Verify manually**

```bash
astro dev --background
```

Visit `/` and confirm:

- The directory loads with no console errors and shows the seeded listings.
- Selecting "Eastside" in the area filter still shows "Tuesday Night Mic" and "Last Thursday Mic" (both at The Virgil, in Silver Lake — dual-tagged Central L.A. + Eastside).
- Selecting "Central L.A." also shows the same two listings (proving the dual-tag works both directions).
- Selecting "Westside" shows "Westside Comedy Showcase" (at Westside Comedy Theater, in Santa Monica) and not the Virgil listings.
- Selecting an area with no seeded venues (e.g. "Harbor") shows zero listings, not an error.

```bash
astro dev logs
```

Expected: no errors.

```bash
astro dev stop
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro src/components/listings/ListingRow.astro
git commit -m "$(cat <<'EOF'
feat: filter the public directory against every tagged area

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
