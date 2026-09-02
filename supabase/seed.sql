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