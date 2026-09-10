-- Numbered (01/02/03, alongside its sibling seed files) because seed
-- files run in alphabetical filename order and this one joins against
-- venues that must already exist — the plain names sorted correctly only
-- by accident. Don't rename any of the 01_/02_/03_ files without keeping
-- neighborhoods -> venues -> listings order intact.
--
-- Real open mic/show listings for the venues seeded in
-- 02_open_mic_venues.sql. Each row is manually confirmed by hand against the
-- venue's own site/social (or by phone/in-person) before being added here
-- — see https://www.ianirarousso.com/la-open-mic-lists for the working
-- source list this is being built from.
--
-- Idempotent via NOT EXISTS, matching on (venue_id, title) since neither
-- column alone is unique. Safe to run against local dev (picked up
-- automatically via config.toml's db.seed.sql_paths) and, repeatedly, against
-- production via psql or the Studio SQL editor — re-running only inserts
-- rows that aren't already there, same as open_mic_venues.sql.
--
-- To add a confirmed listing: append a row to the first values() list
-- below (and, if it's recurring, a matching row — joined by title — to the
-- second values() list for its recurrence rule). Leave interval_weeks as 1
-- /anchor_date as null unless the listing runs every other week, in which
-- case set interval_weeks to 2 and anchor_date to any confirmed occurrence
-- date on the same weekday as day_of_week. One-off shows only need
-- the first list, with one_off_date set instead of a recurrence row.
--
-- The single placeholder row below joins against a venue name that will
-- never exist, so it never actually inserts anything — replace or delete
-- it once real confirmed listings are added.

with new_listings as (
  insert into listings (
    type, title, host, description, venue_id, start_time, one_off_date,
    sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
    cost_to_perform, ticket_price, ticket_url, status
  )
  select
    v.type::listing_type, v.title, v.host, v.description, ven.id,
    v.start_time::time, v.one_off_date::date, v.sign_up_method::sign_up_method_type,
    v.sign_up_url, v.sign_up_other_note, v.sign_up_opens_at::time,
    v.cost_to_perform, v.ticket_price, v.ticket_url, 'published'
  from (values
    -- ('mic', 'Example Mic Name', 'Example Host', null, 'Example Venue Name', '20:00', null, 'first_come', null, null, '19:30', 'Free', null, null),
    ('mic', '__EXAMPLE_REPLACE_ME__', null, null, '__EXAMPLE_VENUE_REPLACE_ME__', '20:00', null, 'first_come', null, null, '19:30', 'Free', null, null)
  ) as v(
    type, title, host, description, venue_name, start_time, one_off_date,
    sign_up_method, sign_up_url, sign_up_other_note, sign_up_opens_at,
    cost_to_perform, ticket_price, ticket_url
  )
  join venues ven on ven.name = v.venue_name
  where not exists (
    select 1 from listings existing
    where existing.venue_id = ven.id and existing.title = v.title
  )
  returning id, title
)
insert into recurrence_rules (
  listing_id, frequency, day_of_week, week_of_month, interval_weeks, anchor_date
)
select
  nl.id, r.frequency::recurrence_frequency, r.day_of_week::smallint,
  r.week_of_month::smallint, r.interval_weeks::smallint, r.anchor_date::date
from new_listings nl
join (values
  -- ('Example Mic Name', 'weekly', 2, null, 1, null)
  ('__EXAMPLE_REPLACE_ME__', 'weekly', 2, null, 1, null)
) as r(title, frequency, day_of_week, week_of_month, interval_weeks, anchor_date)
  on r.title = nl.title;
