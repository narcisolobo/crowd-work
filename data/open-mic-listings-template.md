# `open-mic-listings-template.csv` column guide

Companion to [open-mic-listings-template.csv](./open-mic-listings-template.csv). Column guide, using that file's example row.

| Column | Example value | Notes |
|---|---|---|
| `type` | `mic` | `mic` or `show` |
| `title` | `Whatever Wednesday Mic` | |
| `host` | `Alex Rivera` | blank if unknown |
| `description` | *(blank)* | optional, rarely needed |
| `venue_name` | `The Comedy Store` | must exactly match a name already in `supabase/seeds/02_open_mic_venues.sql` — if it's a brand-new venue, that file needs the venue added first |
| `frequency` | `weekly` | `weekly`, `monthly`, or blank for a one-off |
| `day_of_week` | `3` | 0=Sunday...6=Saturday; blank for a one-off |
| `week_of_month` | *(blank)* | only for monthly (1-4, or -1 for "last"); blank for weekly/one-off |
| `one_off_date` | *(blank)* | `YYYY-MM-DD`, only for a one-off (leave `frequency`/`day_of_week`/`week_of_month` blank when this is set) |
| `start_time` | `20:00` | 24-hour `HH:MM` |
| `sign_up_method` | `first_come` | mic-specific; blank for shows. One of `bucket_lotto`, `first_come`, `curated`, `slotted_online`, `hybrid_other` |
| `sign_up_url` | *(blank)* | only when `sign_up_method` is `slotted_online`; optional even then |
| `sign_up_other_note` | *(blank)* | required when `sign_up_method` is `hybrid_other`; blank otherwise |
| `sign_up_opens_at` | `19:30` | only when `sign_up_method` is `bucket_lotto` or `first_come`; 24-hour `HH:MM`, blank otherwise |
| `cost_to_perform` | `Free` | mic-specific; blank for shows |
| `ticket_price` | *(blank)* | show-specific; blank for mics |
| `ticket_url` | *(blank)* | show-specific; blank for mics |

A one-off show would instead leave `frequency`/`day_of_week`/`week_of_month`/`sign_up_method`/`sign_up_url`/`sign_up_other_note`/`sign_up_opens_at`/`cost_to_perform` blank and fill in `one_off_date`, `ticket_price`, `ticket_url`.

Once rows are filled in, they get converted into the `values()` list in `supabase/seeds/03_open_mic_listings.sql`.
