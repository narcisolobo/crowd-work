-- Bare Instagram handle (no leading @) for the account comics should check
-- for updates: the mic's own account, else its main host's.
-- Instagram usernames are 1-30 letters, digits, periods, and underscores.
alter table listings
  add column instagram text
    check (instagram ~ '^[A-Za-z0-9._]{1,30}$');
