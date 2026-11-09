# Open mic listings: fixes for rows 2–28

Findings from checking the `open-mic-listings` Google Sheet against [the column guide](../data/open-mic-listings-template.md) and the venues seed. Row numbers refer to sheet rows (row 1 is the header).

## Data fixes

- [ ] **Row 6 — Friday Friends' Open Mic:** description says performance order is drawn from a bucket, but `sign_up_method` is `first_come`.
- [ ] **Row 7 — Potluck (Sunday):** description says sign-ups 4–5 PM and showtime 6 PM, but `start_time` is `16:00`. `sign_up_opens_at` is `15:30`, and the guide says `curated` should leave it blank.
- [ ] **Row 8 — Potluck (Monday):** same `start_time` issue as row 7. `sign_up_opens_at` is `17:30`, which doesn't match row 7's `15:30`.
- [ ] **Row 11 — Open Mic at the Laugh Factory:** `cost_to_perform` is blank. "First 10 in line, 10 more drawn from bucket" sounds like `hybrid_other`, not `bucket_lotto`.
- [ ] **Row 18 — Open Mic & Club Auditions:** typo in description: "every Sunda" should be "every Sunday".
- [ ] **Row 19 — Comedy Open Mic Sundays (Sal's):** `cost_to_perform` is blank. Sign-up is "DM @elmexicanmorrison on IG to reserve a spot," which may be `hybrid_other` rather than `first_come`.
- [ ] **Row 20 — Sunday Night Open Mic (Liquid Zoo):** set to monthly, last Sunday (`week_of_month` `-1`), but nothing in the row confirms it's monthly. Verify.
- [ ] **Row 23 — The Stellar Cellar:** `cost_to_perform` is blank. Description says one-item minimum.
- [ ] **Row 27 — Monday Open Mic (Boomtown):** row is cut off, so `sign_up_opens_at` and `cost_to_perform` are missing. Description says sign-ups start at 6:30 PM and the show at 7 PM, but `start_time` is `18:30`. Likely `start_time` `19:00`, `sign_up_opens_at` `18:30`, cost `Free`.

## Move handles to the new `instagram` column

Bare handle, no `@`. Once moved, `sign_up_other_note` should only hold notes for `hybrid_other` mics.

- [ ] **Row 2 — Storytelling Open Mic + Improv Jam:** `storyjammic`
- [ ] **Row 6 — Friday Friends' Open Mic:** `oliviacrossing_`
- [ ] **Row 9 — Bear Knuckles:** `drewjfahey`
- [ ] **Row 15 — Friday Open Mic (Tao):** `taocomedystudio`
- [ ] **Row 18 — Open Mic & Club Auditions:** `thecomedychateau`
- [ ] **Row 26 — Funny Games:** `__playspace__`

## Other `sign_up_other_note` values to resolve

These aren't Instagram handles, but the method isn't `hybrid_other` either.

- [ ] **Row 3 — Uriah's Hoopla:** note is a URL (`uriahwesman.com/open-mic-1`) that already appears in the description. Clear it.
- [ ] **Row 5 — Open Mic Comedy Wednesdays:** "20 comic limit chosen via random bucket draw." Move it to the description or clear it, since the description already says this.
- [ ] **Row 19 — Comedy Open Mic Sundays (Sal's):** see the data fix above. If it becomes `hybrid_other`, keep the note and move `elmexicanmorrison` to `instagram`.

## Open questions

- [x] `sign_up_opens_at` is allowed for `slotted_online` (when the online list opens), not for `curated`. Guide updated, so rows 9 and 21 are fine as they are. Rows 7–8 still need it blanked.
- [x] Let the admin form and listing page show `sign_up_opens_at` for `slotted_online`. Both currently limit it to `bucket_lotto`/`first_come`:
  - `src/components/moderation/ListingFieldsFields.astro`: the `drop_time` block's initial `hidden` condition (~line 192) and the toggle script (~line 365)
  - `src/pages/listings/[id].astro`: the "Sign-up opens" condition (~line 268)
- [x] Add the `instagram` column to the schema, admin form, seed file, and CSV template/guide. (The repo CSV got the empty column only; handles weren't migrated because it's a stale snapshot of the sheet.)
