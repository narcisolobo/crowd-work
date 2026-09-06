# Real Areas & Neighborhoods — Design

**Status:** Approved for implementation planning
**Related:** [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md), [notes/future-considerations.md](../../../notes/future-considerations.md), [2026-09-04-listing-submission-design.md](2026-09-04-listing-submission-design.md)

## Summary

`areas` and `neighborhoods` have held only placeholder fixture data since the schema was created — 2 fictional areas ("Eastside", "Westside") and 3 neighborhoods. This phase replaces that with a real taxonomy: 16 LA Times "Mapping L.A." regions as `areas`, and 233 real LA County neighborhoods (114 of them independently verified against LA's live open-data geometry service) as `neighborhoods`.

Along the way, the area/neighborhood relationship changes from one-to-many to many-to-many. The reason is concrete, not speculative: the official LA Times region for Los Feliz and Silver Lake is "Central L.A.", but no one in the LA comedy scene calls it that — everyone says "Eastside". Rather than pick one label and be wrong for half the audience, both neighborhoods carry both tags. The schema needs to support that for any future case like it, not just this one.

There is no self-serve mechanism to add an area or neighborhood, and none is planned (`future-considerations.md`'s "Expand areas and neighborhoods" note, and the listing-submission design's non-goals). That absence is exactly why this phase leans toward comprehensive rather than minimal — a real venue address falling outside the taxonomy can't be fixed by a moderator in the UI, only by whoever has database access re-running a seed script.

## Goals

- Replace the placeholder taxonomy with a real, comprehensive one: all 16 LA Times regions as `areas`, all their constituent LA County neighborhoods as `neighborhoods` — not just neighborhoods inside LA city limits, since real venues (e.g. the existing seed venue "Westside Comedy Theater", in Santa Monica) sit outside them.
- Support a neighborhood belonging to more than one area, so a colloquial name and an official region name can coexist without forcing a single "correct" choice.
- Preserve the 3 existing placeholder neighborhoods' and 2 areas' fixed UUIDs (hardcoded across several existing tests) wherever the real taxonomy places them.
- Ship both a local dev/test seed and a production seeding path from one canonical, idempotent SQL file — no drift between the two.

## Non-goals (this phase)

- Any self-serve UI for managing areas/neighborhoods — still a direct-database/seed-file operation, per the existing convention.
- Auditing the full 233-neighborhood taxonomy for other colloquial-vs-official mismatches beyond Los Feliz/Silver Lake — the schema supports adding more later (new `neighborhood_areas` rows, no migration), so this is deliberately deferred rather than done exhaustively now.
- Neighborhood boundary geometry — the `neighborhoods` table has never stored geometry and doesn't start now; the live LA geohub dataset was used only to verify names, not to add a `geometry` column.
- Any change to how a moderator picks a venue's neighborhood on the add-listing forms — still a single-neighborhood picker; N:M is about which *areas* a neighborhood is tagged with, not about a venue having multiple neighborhoods.

## Data Provenance

- **Neighborhoods (verified)**: 114 of the 233 are the official "LA Times Neighborhood Boundaries" dataset, City of LA subset, queried live from `services5.arcgis.com` (via `data-lahub.opendata.arcgis.com`'s open data catalog) — an authoritative source, not reconstructed from memory.
- **Neighborhoods (unverified) + regions**: the remaining 119 neighborhoods (outside LA city limits) and all 16 region names came from the user, cross-checked against the archived `datadesk/latimes-mappingla-api` GitHub repo's docstring, which names "Central L.A." and "Westside" as example regions — matching the user-provided list and corroborating it as the genuine LA Times taxonomy, even though the live API behind that repo is no longer reachable.
- **Corrections applied to the 114 verified neighborhoods** where the user-provided list either spelled a name differently or omitted it (parks/enclaves not in that particular list): `Crenshaw` → `Baldwin Hills/Crenshaw`, `Bel Air` → `Bel-Air`; and additions `Elysian Park`, `Griffith Park`, `Hancock Park` (→ Central L.A.), `Elysian Valley`, `Montecito Heights` (→ Northeast L.A., the latter a judgment call — it borders both Eastside and Northeast L.A.), `Chatsworth Reservoir`, `Lake Balboa`, `Sepulveda Basin` (→ San Fernando Valley), `Central-Alameda`, `Exposition Park`, `Historic South-Central`, `University Park`, `Vermont Knolls` (→ South L.A.), `Hansen Dam` (→ Verdugos), `Beverlywood`, `Westchester` (→ Westside).
- **Dual-tag**: `Los Feliz` and `Silver Lake` belong to both `Central L.A.` (official) and `Eastside` (colloquial, and the reason this phase moved to many-to-many at all).

## Architecture Overview

The area/neighborhood relationship moves from a single FK column to a join table — a real schema change, not just a data change, since the public directory's `?area=` filter (`src/pages/index.astro`) already depends on it at runtime.

**Why a join table over the alternatives:**
- *Keep `area_id` as "primary" + a separate tags table for extras* — rejected: two sources of truth for "which areas is this neighborhood in," and no clear answer for what happens if they disagree.
- *A `area_ids uuid[]` array column on `neighborhoods`* — rejected: no FK integrity on array elements, and it breaks from this schema's consistent use of real join tables for every other relationship (`recurrence_rules`, `occurrence_exceptions`, etc.).
- *A `neighborhood_areas` join table (chosen)* — one source of truth, ordinary relational modeling, consistent with the rest of the schema.

## Data Model

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

No insert/update policy — matches the existing "no self-serve" convention already in place for `areas` and `neighborhoods` themselves.

## Data Layer & Consumer Changes

**`src/lib/data/listings.ts`:**
- `Neighborhood.areaId: string` → `Neighborhood.areaIds: string[]`. `getNeighborhoods()`'s select becomes `"id, name, neighborhood_areas(area_id)"`, mapped as `areaIds: (row.neighborhood_areas ?? []).map(na => na.area_id)`.
- `ListingWithVenue.venue.areaId: string` → `areaIds: string[]`. `LISTING_WITH_VENUE_SELECT`'s nested neighborhood select becomes `neighborhood:neighborhoods ( id, neighborhood_areas ( area_id ) )`; `mapListingRow` maps it the same way as above.

**`src/pages/index.astro`:**
- `matchesArea = !areaFilter || listing.venue.areaIds.includes(areaFilter)` (was strict equality against a single value).
- The row object passed to `ListingList`/`ListingRow` carries `areaIds: listing.venue.areaIds` instead of `areaId`.

**`src/components/listings/ListingRow.astro`:**
- Prop type `areaId: string` → `areaIds: string[]`; `data-area={areaId}` → `data-area={areaIds.join(" ")}`. This attribute isn't read by any script today (confirmed via search) — a mechanical rename, not a behavior change.

## Seeding

**`supabase/seed.sql`** (existing, local dev/test only) needs one edit: the `insert into neighborhoods (id, name, area_id) values (...)` statement drops the now-gone `area_id` column and its 3 values, becoming `insert into neighborhoods (id, name) values (...)`. The 3 fixed UUIDs and the 2 existing `areas` rows (also fixed UUIDs) are otherwise untouched.

**New `supabase/seeds/areas_and_neighborhoods.sql`** (generated, ~513 lines) carries the full taxonomy — 16 areas, 233 neighborhoods, 236 area/neighborhood pairs — as three idempotent statements:

```sql
insert into areas (name) values (...) on conflict (name) do nothing;

insert into neighborhoods (name)
select v.name from (values (...)) as v(name)
on conflict (name) do nothing;

insert into neighborhood_areas (neighborhood_id, area_id)
select n.id, a.id
from (values (...)) as v(neighborhood_name, area_name)
join neighborhoods n on n.name = v.neighborhood_name
join areas a on a.name = v.area_name
on conflict (neighborhood_id, area_id) do nothing;
```

Because every statement is `on conflict ... do nothing`, running this after the edited `seed.sql`:
- Leaves the pre-existing "Eastside"/"Westside" areas and "Los Feliz"/"Silver Lake"/"Santa Monica" neighborhoods on their original fixed UUIDs (name conflict skips re-insertion).
- Still creates fresh `neighborhood_areas` rows for all of them (that table has no pre-existing rows to conflict with) — including Los Feliz/Silver Lake's dual Central L.A. + Eastside tagging.
- Inserts every other area/neighborhood/pair fresh.

**`supabase/config.toml`**'s `db.seed.sql_paths` changes from `["./seed.sql"]` to `["./seed.sql", "./seeds/*.sql"]` — order matters, so the fixed-UUID rows exist before the new file's conflict checks run.

**Production**: the same `areas_and_neighborhoods.sql` file, unmodified, run once via `psql "$DATABASE_URL" -f supabase/seeds/areas_and_neighborhoods.sql` or pasted into the Studio SQL editor. No separate provisioning script is needed — unlike the source-check agent's scoped-account work, `areas`/`neighborhoods`/`neighborhood_areas` have no RLS write policy for anyone, so a direct SQL connection (which bypasses RLS as a privileged role) is the only way to write to them regardless, and the idempotent `on conflict` guards make accidental re-runs harmless.

## Testing

- `src/lib/data/listings.test.ts`'s `getNeighborhoods` test updates to assert `areaIds` (plural, array) instead of `areaId` — Los Feliz's should include *both* Central L.A.'s and Eastside's area ids.
- New coverage in the same file (or `getPublishedListings`'s existing tests, wherever venue/area mapping is already covered): a listing whose venue sits in a dual-tagged neighborhood returns both area ids.
- Manual verification: the public directory's `?area=` filter still narrows correctly for both a single-area neighborhood and the Los Feliz/Silver Lake dual-tagged case.

## Known Limitations

- The 119 neighborhoods outside LA city limits, and all 16 region names, rest on the user-provided list plus one piece of independent corroboration (the archived API repo's example region names) — not verified line-by-line against a live authoritative source the way the 114 City-of-LA neighborhoods were. If LA Times' actual boundaries differ in some corner, that's a content fix (edit the seed file, re-run), not a schema problem.
- Montecito Heights' region assignment (Northeast L.A., not Eastside) is a judgment call, flagged during design — it genuinely borders both.
- Only Los Feliz/Silver Lake got a colloquial dual-tag this phase; the rest of the 233-neighborhood taxonomy wasn't audited for similar cases (see Non-goals).
