# Moderation Queue Notifications — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-01-crowd-work-directory-mvp-design.md](2026-09-01-crowd-work-directory-mvp-design.md) (supersedes its Notifications section), [2026-09-03-moderation-queue-admin-review-design.md](2026-09-03-moderation-queue-admin-review-design.md), [2026-09-05-source-check-agent-design.md](2026-09-05-source-check-agent-design.md) (scoped-account convention this design follows), [2026-09-07-modified-occurrence-moderation-design.md](2026-09-07-modified-occurrence-moderation-design.md), [src/lib/data/moderation.ts](../../../src/lib/data/moderation.ts), [src/pages/listings/[id]/report.astro](../../../src/pages/listings/[id]/report.astro)

## Summary

Moderators currently have to remember to check `/admin` for pending `moderation_queue` entries. The original MVP design ([2026-09-01](2026-09-01-crowd-work-directory-mvp-design.md), lines 99-104) sketched two notification triggers — a daily digest right after the sourcing agent's run, and a database webhook firing an instant alert for time-sensitive entries — but that design predates two things that have since shipped: the sourcing agent became the manually-triggered `/check-sources` skill (no fixed daily run to hook the digest off of), and the `moderation_change_type` enum grew a `'modification'` value distinct from `'update'` ([2026-09-07](2026-09-07-modified-occurrence-moderation-design.md)).

This phase builds the actual notification system: a single Supabase Edge Function, invoked by two independent `pg_cron` schedules, sends instant alerts for urgent entries and a once-daily digest for everything else still pending — regardless of which producer (`report_form` or `source_check`) filed the entry.

## Goals

- Notify all moderators by email (via Resend, already scaffolded) when a `moderation_queue` entry needs review, without requiring them to poll `/admin`.
- Send an instant alert for entries that are urgent because they describe something happening soon: a pending `cancellation` or `modification` whose reported occurrence date is within 3 days.
- Send one daily digest covering every other still-pending entry, so nothing is silently missed even if an instant alert fails to fire or doesn't apply.
- Treat `report_form` and `source_check` origins identically — the queue doesn't distinguish producers for notification purposes.

## Non-goals (this phase)

- **Per-moderator preferences** (opt out, digest-only, different thresholds). All rows in `moderators` get both notification types; there's no concept of notification settings in the schema today and nothing is asking for one yet.
- **Retrofitting `/check-sources` to produce `cancellation`/`modification` entries.** It currently only ever files `'new'`/`'update'` ([2026-09-05-source-check-agent-design.md](2026-09-05-source-check-agent-design.md)) — out of scope here, called out only because the queries below are written to handle it transparently if that ever changes.
- **React Email or any templating dependency.** Two plain, minimally-styled inline-CSS HTML strings are enough for this scope.
- **In-app notifications, SMS, or Slack.** Email only, per the existing Resend commitment in `PRODUCT.md`.
- **Retry/backoff queues for failed sends.** A failed Resend call is logged and left for the next scheduled run to pick back up (see Error Handling).

## Architecture Overview

One new Edge Function, `send-moderation-notifications`, invoked by two `pg_cron` schedules against two different query shapes over the same table:

- `notify-urgent` — every 15 minutes, invokes the function with `{ mode: "urgent" }`.
- `notify-digest` — once daily at 15:00 UTC (7am Pacific Daylight Time / 8am Pacific Standard Time), invokes the function with `{ mode: "digest" }`. `pg_cron` schedules run in UTC and don't auto-adjust for daylight saving, so this drifts by an hour twice a year (6am/9am Pacific) — an accepted manual-maintenance tradeoff rather than a DST-aware scheduling mechanism for a single daily email.

Both modes run inside the same function so the email-composition and Resend-sending code path is shared; only the query and subject line differ. The function authenticates as a new scoped `notification_agents` account (mirroring the existing `source_check_agents` pattern — see Security below), not the service-role key, and is never reachable except via `pg_cron`'s scheduled invocation, which must present the function's own secret in its call — this is not a client-facing endpoint.

One new column drives both queries: `moderation_queue.notified_at timestamptz`, nullable, meaning "the last time this row was surfaced by either notification path."

## Security: Scoped Account, Not the Service-Role Key

Per this project's established convention ([2026-09-05-source-check-agent-design.md](2026-09-05-source-check-agent-design.md), Security Callout) and `.env.example`'s own note that `SUPABASE_SERVICE_ROLE_KEY` is "local-only... never use in production," this function must not carry the service-role key in its recurring invocation path. Checking what RLS already grants `authenticated` narrows the actual gap to one thing:

- **SELECT** on both `moderation_queue` and `moderators` is already `to authenticated using (true)` (see `20260903183709_moderation_queue.sql` and `20260904023559_moderators.sql`) — any authenticated account can already read everything both queries need. No new SELECT policy required.
- **UPDATE** on `moderation_queue` is the gap: both existing UPDATE policies are scoped to real moderator decision-making (`... and (status = 'approved' and approved_by = auth.uid() ...)`-shaped checks in `20260904023248_moderation_archive.sql`) and won't match a plain "set `notified_at`" write from a non-moderator account.

**New `notification_agents` marker table**, identical in shape and purpose to `source_check_agents` — names which accounts get the narrow grant below:

```sql
create table notification_agents (
  id uuid primary key references auth.users(id)
);

alter table notification_agents enable row level security;

create policy "authenticated users can read notification agent ids"
  on notification_agents for select
  to authenticated
  using (true);
```

(The select policy is required for the same non-obvious reason `source_check_agents`' is: every policy below reads this table via a subquery, which is itself subject to this table's own RLS.)

**New permissive UPDATE policy** — the one capability this account has: flipping `notified_at` on a still-pending row, nothing else:

```sql
create policy "notification agents can mark pending entries as notified"
  on moderation_queue for update
  to authenticated
  using (
    auth.uid() in (select id from notification_agents)
    and status = 'pending'
  )
  with check (
    auth.uid() in (select id from notification_agents)
    and status = 'pending'
  );
```

**New restrictive UPDATE policy on `moderation_queue`** — narrows the permissive policy above so this account can't slip a decision into the same call:

```sql
create policy "notification agents can't make moderation decisions"
  on moderation_queue as restrictive for update
  to authenticated
  with check (
    auth.uid() not in (select id from notification_agents)
    or (
      status = 'pending'
      and approved_by is null
      and confirmed_by is null
      and decided_at is null
    )
  );
```

**Full lockdown, mirroring `source_check_agents`' complete restrictive set**: this account has no legitimate insert path anywhere (unlike `source_check_agents`, which at least files findings), so its `moderation_queue` insert block is unconditional, and every other table's existing `to authenticated` policies get the identical restrictive treatment `source_check_agents` already has — closing the same loopholes for this account (e.g. `"moderators can insert venues"` is `with check (true)`, no membership check; `"moderators can directly insert a pre-approved new listing"` requires only `approved_by = auth.uid()`, not moderator membership):

```sql
create policy "notification agents can't insert into the moderation queue"
  on moderation_queue as restrictive for insert
  to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert listings"
  on listings as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't update listings"
  on listings as restrictive for update to authenticated
  using (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert recurrence rules"
  on recurrence_rules as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't update recurrence rules"
  on recurrence_rules as restrictive for update to authenticated
  using (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert occurrence exceptions"
  on occurrence_exceptions as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));

create policy "notification agents can't insert venues"
  on venues as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from notification_agents));
```

**Provisioning**: a new one-time, human-run script, `scripts/provision-notification-agent.mjs` (mirroring `provision-source-check-agent.mjs`), creates the `auth.users` account and inserts its id into `notification_agents`. The service-role key appears exactly once, inside this script — never in the Edge Function itself. New env vars: `NOTIFICATION_AGENT_EMAIL`/`NOTIFICATION_AGENT_PASSWORD`, stored as Supabase Edge Function secrets (`supabase secrets set`) so the function can call `client.auth.signInWithPassword(...)` against the publishable key on each invocation, exactly as `submit-source-finding.mjs` already does for `source_check_agents`.

## Data Model

**Migration** — one nullable column, no backfill needed (existing rows simply haven't been notified yet):

```sql
alter table moderation_queue
  add column notified_at timestamptz;
```

RLS changes for this column are covered in Security below (a new `notification_agents` scoped account and two new UPDATE policies) — no existing policy references `notified_at`, and this column doesn't change how any other account's existing policies evaluate.

### Urgent query (`mode: "urgent"`)

```sql
select *
from moderation_queue
where status = 'pending'
  and change_type in ('cancellation', 'modification')
  and (proposed_data->>'originalDate')::date <= current_date + 3
  and notified_at is null;
```

`originalDate` is the field `report.astro` already writes into `proposed_data` for both change types ([report.astro:67](../../../src/pages/listings/[id]/report.astro#L67)) — the date of the occurrence being reported, not a "new" date. A row matching this query gets an instant email; on a successful send, every matched row is updated to `notified_at = now()`.

### Digest query (`mode: "digest"`)

```sql
select *
from moderation_queue
where status = 'pending'
  and (notified_at is null or notified_at::date < current_date);
```

This is "everything still pending that hasn't already been surfaced today" — a `new`/`update`/`archive`/`restore` entry (never urgent-eligible) is only ever touched by this query. An entry already alerted today via the urgent path is excluded from today's digest but reappears tomorrow if still `pending`, since `notified_at::date < current_date` becomes true again. On a successful digest send, every matched row is updated to `notified_at = now()`.

Both queries run inside the Edge Function against Postgres via the `notification_agents`-authenticated client — no new database function/RPC needed, since the existing `to authenticated` SELECT policies on `moderation_queue` and `moderators` already cover everything both queries read.

## Email Content

Both templates are plain HTML strings with inline styles (no `<style>` block, no external CSS — most email clients strip or unreliably apply non-inline CSS) and share one font stack to avoid a serif fallback:

```
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

Each entry renders as a stacked list item mirroring the existing `/admin` dashboard row ([admin/index.astro:44-72](../../../src/pages/admin/index.astro#L44-L72)), reusing its labeling logic rather than inventing new copy: `CHANGE_TYPE_LABEL[changeType]` as a small badge, `previewFor(entry)` as the linked headline (usually the correction note, truncated), and `ORIGIN_LABEL[origin]` on a second line — exactly the three pieces of data a moderator already sees in the dashboard. The headline links to `/admin/queue/{id}` (the existing per-entry route), not the dashboard root.

- **Urgent** (`mode: "urgent"`, only sent if the query returns ≥1 row): one email per cron run covering every newly-qualifying row from that run — not one email per entry. Subject: `"Urgent: N moderation item(s) need review"`. Each item's second line swaps the dashboard's "origin · created date" for "origin · Occurs `<date>` (in N day(s))" — the reported occurrence date and its urgency, since that's the reason the entry is in this email rather than the digest, and `previewFor` doesn't surface it.
- **Digest** (`mode: "digest"`, only sent if the query returns ≥1 row — no "all clear" email): one email per day, grouped by `change_type`, each item using the dashboard's unmodified second line: `ORIGIN_LABEL[origin] · <created date>`. Subject: `"Daily digest: N pending moderation item(s)"`.
- Recipients for both: every row in `moderators.email`. No new env vars — `RESEND_API_KEY` is already scaffolded; `TEST_MODERATOR_*`/`SOURCE_CHECK_AGENT_EMAIL` are test/agent fixtures, not notification recipients.
- `previewFor`/`CHANGE_TYPE_LABEL`/`ORIGIN_LABEL` (`src/lib/utils/moderation-labels.ts`) are plain, dependency-free TS with no Node-specific APIs, so the Edge Function (Deno runtime) imports them directly by relative path rather than duplicating the logic — one source of truth for how an entry is described, whether in the dashboard or an email.

## Error Handling

- If the Resend send call fails, no row from that batch gets `notified_at` set — the next scheduled run will pick the same rows back up. This risks an occasional duplicate alert over risking a silently dropped cancellation.
- The function logs failures to Supabase's function logs; no in-app alerting or retry queue for this phase (see Non-goals).
- Both modes are safe to invoke repeatedly: the `notified_at` filters make a rerun before the next scheduled tick a no-op if the prior run already succeeded.

## Testing

- Query-shape unit tests seeding `moderation_queue` rows across all `change_type` values and boundary dates (exactly 3 days out, 4 days out, already `notified_at` today, `notified_at` yesterday) to verify urgent/digest inclusion and exclusion.
- Resend calls mocked in tests — assert email composition (recipients, subject, entry list) without sending real mail.
- One integration-style test covering a full urgent-then-digest cycle same day: an entry alerted urgently does not also appear in that day's digest, but does reappear in the next day's digest if still `pending`.
- RLS regression tests mirroring the existing `source_check_agents` coverage: the `notification_agents` account's update succeeds only for the exact "pending → pending, `notified_at` only" shape, and is rejected for any deviation (setting `status`, `approved_by`, `confirmed_by`, or `decided_at`); the account is also rejected by every other write path on `moderation_queue` (insert of any shape) and every policy on `listings`, `recurrence_rules`, `occurrence_exceptions`, `venues`, and `moderators`, the same way `source_check_agents`' lockdown is proven today.

## Known Limitations / Edge Cases

- **Up to ~15 minutes of latency on "instant" alerts**, since urgency is detected by polling rather than a database webhook. Acceptable given the webhook-based design in the original MVP doc was never implemented, and `pg_cron` requires no separate infrastructure.
- **A `'cancellation'`/`'modification'` entry with a null `originalDate`** (possible today only via direct manipulation, since `report.astro` always requires a date for these two reasons) would fail the urgent query's date cast and simply never qualify as urgent — it still surfaces via the digest query, which doesn't depend on the date field.
- **This spec supersedes** the Notifications section of [2026-09-01-crowd-work-directory-mvp-design.md](2026-09-01-crowd-work-directory-mvp-design.md#L99-L104) (webhook trigger, "2-3 days," daily-digest-tied-to-the-agent-run) and the matching line in [PRODUCT.md](../../../PRODUCT.md#L35) ("2-3 days"). Both should be updated to reflect this design once implemented — noted here rather than edited as part of this spec, since PRODUCT.md and the MVP doc are being left untouched until the corresponding code ships.
