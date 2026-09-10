create type sign_up_method_type as enum (
  'bucket_lotto', 'first_come', 'curated', 'slotted_online', 'hybrid_other'
);

alter table listings
  drop column sign_up_method,
  add column sign_up_method sign_up_method_type,
  add column sign_up_url text,
  add column sign_up_other_note text,
  add column sign_up_opens_at time;