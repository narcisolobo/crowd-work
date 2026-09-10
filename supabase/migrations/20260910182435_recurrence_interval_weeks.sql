alter table recurrence_rules
  add column interval_weeks smallint not null default 1
    check (interval_weeks >= 1),
  add column anchor_date date;

alter table recurrence_rules
  add constraint recurrence_rules_anchor_date_for_interval check (
    (interval_weeks = 1 and anchor_date is null)
    or (
      interval_weeks > 1
      and anchor_date is not null
      and extract(dow from anchor_date) = day_of_week
    )
  );

alter table recurrence_rules
  add constraint recurrence_rules_monthly_fields check (
    (frequency = 'monthly' and week_of_month is not null and interval_weeks = 1)
    or (frequency = 'weekly' and week_of_month is null)
  );