create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every 15 minutes: check for newly-urgent entries.
select cron.schedule(
  'notify-urgent',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_anon_key'),
      'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_secret')
    ),
    body := jsonb_build_object('mode', 'urgent')
  ) as request_id;
  $$
);

-- Once daily at 15:00 UTC (7am PDT / 8am PST — see spec's Architecture
-- Overview for the DST tradeoff): the full digest.
select cron.schedule(
  'notify-digest',
  '0 15 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_anon_key'),
      'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_secret')
    ),
    body := jsonb_build_object('mode', 'digest')
  ) as request_id;
  $$
);