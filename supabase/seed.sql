insert into areas (id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'Eastside'),
  ('a0000000-0000-0000-0000-000000000002', 'Westside');

insert into neighborhoods (id, name, area_id) values
  ('b0000000-0000-0000-0000-000000000001', 'Los Feliz', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', 'Silver Lake', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003', 'Santa Monica', 'a0000000-0000-0000-0000-000000000002');

insert into venues (id, name, address, neighborhood_id, google_maps_url) values
  ('c0000000-0000-0000-0000-000000000001', 'The Virgil', '4519 Santa Monica Blvd, Los Angeles, CA', 'b0000000-0000-0000-0000-000000000002', 'https://maps.google.com/?q=The+Virgil+LA'),
  ('c0000000-0000-0000-0000-000000000002', 'Westside Comedy Theater', '1323 3rd St Promenade, Santa Monica, CA', 'b0000000-0000-0000-0000-000000000003', 'https://maps.google.com/?q=Westside+Comedy+Theater');

insert into listings (id, type, title, host, venue_id, start_time, sign_up_method, cost_to_perform, status) values
  ('d0000000-0000-0000-0000-000000000001', 'mic', 'Tuesday Night Mic', 'Jamie Rivera', 'c0000000-0000-0000-0000-000000000001', '20:00', 'sign-up list at the door, 7:30pm', 'free', 'published');

insert into recurrence_rules (listing_id, frequency, day_of_week) values
  ('d0000000-0000-0000-0000-000000000001', 'weekly', 2);

insert into listings (id, type, title, host, venue_id, start_time, sign_up_method, cost_to_perform, status) values
  ('d0000000-0000-0000-0000-000000000002', 'mic', 'Last Thursday Mic', 'Dana Okafor', 'c0000000-0000-0000-0000-000000000001', '19:30', 'app sign-up opens 6pm', '$5', 'published');

insert into recurrence_rules (listing_id, frequency, day_of_week, week_of_month) values
  ('d0000000-0000-0000-0000-000000000002', 'monthly', 4, -1);

insert into listings (id, type, title, venue_id, start_time, one_off_date, ticket_price, ticket_url, status) values
  ('d0000000-0000-0000-0000-000000000003', 'show', 'Westside Comedy Showcase', 'c0000000-0000-0000-0000-000000000002', '21:00', '2026-09-19', '$15', 'https://example.com/tickets', 'published');

-- Moderation queue sample data, standing in for the sourcing agent and
-- submission form (neither exists yet — see the moderation-queue-admin-review
-- spec's Non-goals). All three change_type cases are represented so the
-- admin review UI has a real case of each to work through.
insert into moderation_queue (id, listing_id, change_type, proposed_data, origin, status) values
  ('e0000000-0000-0000-0000-000000000001', null, 'new', '{
    "type": "mic",
    "title": "Echo Park Wednesday Mic",
    "host": "Priya Chandrasekaran",
    "description": null,
    "venueId": "c0000000-0000-0000-0000-000000000001",
    "startTime": "19:00",
    "signUpMethod": "sign-up list at the door, 6:30pm",
    "costToPerform": "free",
    "ticketPrice": null,
    "ticketUrl": null,
    "recurrence": { "frequency": "weekly", "dayOfWeek": 3, "weekOfMonth": null },
    "oneOffDate": null
  }'::jsonb, 'seed', 'pending');

insert into moderation_queue (id, listing_id, change_type, proposed_data, origin, status) values
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'update', '{
    "type": "mic",
    "title": "Tuesday Night Mic",
    "host": "Jamie Rivera",
    "description": null,
    "venueId": "c0000000-0000-0000-0000-000000000001",
    "startTime": "20:30",
    "signUpMethod": "sign-up list at the door, 8pm",
    "costToPerform": "free",
    "ticketPrice": null,
    "ticketUrl": null,
    "recurrence": { "frequency": "weekly", "dayOfWeek": 2, "weekOfMonth": null },
    "oneOffDate": null
  }'::jsonb, 'seed', 'pending');

insert into moderation_queue (id, listing_id, change_type, proposed_data, correction_note, origin, status) values
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'cancellation', '{
    "originalDate": "2026-09-19"
  }'::jsonb, 'Venue emailed to say this date is cancelled due to a private event.', 'seed', 'pending');