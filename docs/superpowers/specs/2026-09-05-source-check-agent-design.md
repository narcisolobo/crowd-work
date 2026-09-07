# Source Check Agent (Manual, Local-Trigger Phase) — Design

**Status:** Approved for implementation planning
**Related:** [2026-09-04-listing-submission-design.md](2026-09-04-listing-submission-design.md), [notes/crowd-work-vision.md](../../../notes/crowd-work-vision.md), [notes/future-considerations.md](../../../notes/future-considerations.md)

## Summary

The vision doc names a daily automated agent that checks seed sources (venue sites, Instagram) for listing changes as a core MVP feature. Nothing about it exists yet. This phase does not build that agent. It builds a smaller, manually-triggered version: a Claude Code skill you run by hand from your office computer that checks registered venue-website sources, reasons about what's changed, and files findings into the existing `moderation_queue` as ordinary pending entries — reusing the review/approve/reject flow every other listing change already goes through.

This phase is deliberately scoped down from the full vision on three axes: it requires you to trigger it (no cron, no hosting), it costs no LLM API credits (Claude Code's own tools do the work, not a billed API call), and it only handles venue websites, not Instagram. It is designed, however, so that the parts which don't depend on those three constraints — the source registry, the queue-write path, and the RLS security model — can be reused unchanged if a fully autonomous version gets built later.

## Goals

- Let you manually trigger a check of registered venue-website sources during a Claude Code session.
- Have Claude fetch each source, compare it against that venue's existing listings, and reason about what's new or changed.
- File each finding as a normal `pending` `moderation_queue` entry with structured `proposed_data` — no different from a public submission, just pre-filled instead of hand-typed.
- Scope the write path down to a dedicated Supabase account that can only insert pending, source-check-shaped queue entries — nothing else.
- Design the reusable pieces (source registry, write-through function, RLS model) so a future autonomous agent can adopt them without a redesign.

## Non-goals (this phase)

- Instagram or any JS-heavy/login-gated source — deferred; needs its own fetch-mechanism design (likely browser automation or an official API), which is a separate problem from this phase's WebFetch-based approach.
- Auto-publish "graduation" for trusted sources — deferred until this phase produces a track record to evaluate trust against.
- Cancellation detection (`change_type: 'cancellation'`) — a static schedule page rarely announces a one-off skip; that signal is more likely to show up on social media, which is also deferred.
- Scheduling or unattended automation (cron, hosted jobs) — this is manually triggered only, by design, to avoid both hosting infrastructure and LLM API billing.
- Self-serve management of the `sources` table — registering a source is a direct-database action for now, not an admin UI feature.
- Deduplicating a source's venue against `venues` if it isn't already registered — sources are pre-registered against existing venues, not auto-discovered.

## Architecture Overview

The design splits into two layers at a stable interface, specifically so half of it survives into a future autonomous version unchanged.

**Discovery** (swappable, tied to this phase's execution mode): produces a list of findings. In this phase, discovery is Claude reasoning inside a Claude Code session — `WebFetch` the source, read the venue's existing listings, compare them, and decide what's new or changed conversationally rather than via matching code. A future autonomous version would replace this entire layer with a hosted script calling the Claude API directly, with no live session or WebFetch tool available — different implementation, same required output.

**Write-through** (permanent, shared): takes one finding and inserts the `moderation_queue` row. One function, one RLS shape, one scoped account type, used identically whether discovery happens in a conversation today or a hosted job later.

The seam between them is a plain data shape:

```ts
export interface SourceCheckFinding {
  sourceId: string;
  changeType: "new" | "update";
  listingId: string | null; // set when changeType is "update"
  fields: ProposedListingFields;
  note: string; // becomes correction_note — why this looks like a change
}
```

**Reusable if a full autonomous agent gets built later:**

- The `sources` table and its schema.
- The `submitSourceCheckFinding()` write-through function.
- The `source_check_agents`-scoped RLS model (a future autonomous run can reuse the same account, or register its own under the same table with no policy changes).
- The `SourceCheckFinding` interface as the contract any future discovery implementation must produce.

**Not reusable, expected to be rebuilt later:** the discovery mechanism itself. WebFetch plus conversational reasoning is inherently tied to a live Claude Code session; an unattended job needs its own fetch/extraction code and its own Claude API calls.

## Security Callout: Never Use the Service-Role Key for the Write Path

This constraint is being written down now because it's the kind of shortcut that looks harmless in a hosted, unattended context and quietly defeats every RLS policy in this design.

The service-role key appears exactly once in this phase: inside the one-time, human-run provisioning script that creates the `source_check_agents` account (see Provisioning below). It never appears in the recurring write path — that path authenticates as the scoped agent account specifically so its blast radius is bounded by the RLS policies in this document, not by code discipline alone.

**If a future autonomous agent is built, its write path must also authenticate as a `source_check_agents`-scoped account (the same one, or an equivalently narrow new one) — never the service-role key.** The service-role key bypasses RLS entirely; any code path using it can approve, reject, or write anywhere in the schema regardless of the restrictive policies this design adds. In an unattended, long-running job, re-authenticating a scoped session on each run is more code than reaching for a static service-role key, which is exactly why that shortcut is worth naming explicitly rather than trusting a future implementation to avoid it by default.

This also gets more important, not less, once the agent is hosted remotely: a service-role key sitting in a deployed environment (build logs, platform env vars, anyone with deploy access) is a meaningfully larger attack surface than a scoped-account credential in the same place. The scoped-account model is what keeps a compromised hosting environment limited to "can file pending findings" instead of "can do anything a moderator can do."

## Data Model

**New `sources` table** — the registry of venue websites to check. No staleness tracking (`last_checked_at`) in v1; nothing consumes it yet, and it can be added later without breaking anything.

```sql
create table sources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id),
  url text not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table sources enable row level security;

create policy "moderators can read sources"
  on sources for select
  to authenticated
  using (true);
```

No insert/update policy — sources are registered directly via Supabase Studio (project-level access, not RLS) until a self-serve admin page justifies one.

**New `source_check_agents` marker table** — names which accounts get the scoped grant below, instead of hardcoding a UUID into six separate policies. This is also the concrete reuse mechanism for a future autonomous agent: it can adopt the same account, or register a new one here, without any policy SQL changing.

```sql
create table source_check_agents (
  id uuid primary key references auth.users(id)
);

alter table source_check_agents enable row level security;

create policy "authenticated users can read source-check agent ids"
  on source_check_agents for select
  to authenticated
  using (true);
```

RLS must be enabled here — every other table in this schema does, and this one is no exception: without it, this project's default Postgres role grants would leave the table fully writable by `anon`/`authenticated`, letting anyone self-elevate an account into the scoped-agent list. The select policy is required too, and for a less obvious reason: every restrictive policy below reads this table via a subquery (`auth.uid() in (select id from source_check_agents)`), and that subquery is itself subject to this table's own RLS. Without a select policy, the subquery would return zero rows for every authenticated user — including the agent itself — silently evaluating every one of those checks to false. This mirrors the existing `moderators` table's identical policy for the identical reason.

No insert policy: rows are added only by the service-role provisioning script (see Provisioning), never at runtime.

**The narrow permissive grant**, on `moderation_queue`:

```sql
create policy "the source-check agent can file pending findings"
  on moderation_queue for insert
  to authenticated
  with check (
    auth.uid() in (select id from source_check_agents)
    and origin = 'source_check'
    and status = 'pending'
    and change_type in ('new', 'update')
    and proposed_data is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and (
      (change_type = 'new' and listing_id is null)
      or (change_type = 'update' and listing_id is not null)
    )
  );
```

**Restrictive lockdown**, repeated (as `restrictive`) across every other moderator-only write the `authenticated` role would otherwise grant this account by default — `listings` (insert, update), `recurrence_rules` (insert, update), `occurrence_exceptions` (insert), `venues` (insert), and `moderation_queue` (insert, update):

```sql
create policy "source-check agents can't touch listings directly"
  on listings as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't update listings directly"
  on listings as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));

-- Same pattern repeated for recurrence_rules (insert, update),
-- occurrence_exceptions (insert), and venues (insert).
```

`moderation_queue` needs a different shape of restrictive policy for **insert** specifically, because it's the one table where the agent has a *legitimate* insert path (the narrow grant above) sitting alongside an *illegitimate* one it must not also satisfy: the existing `moderator_direct_add` policy is `to authenticated with check (...)` with no account restriction of its own, so without this, the scoped agent could self-approve a direct-add listing exactly like a real moderator — a full bypass of the entire point of scoping it down. A plain "block this uid unconditionally" restrictive policy won't work here, since that would also block the account's own legitimate insert; instead the restrictive check has to say "you're fine, unless you're the agent — in which case you must be using the source-check shape":

```sql
create policy "source-check agents can only insert the finding shape"
  on moderation_queue as restrictive for insert to authenticated
  with check (
    auth.uid() not in (select id from source_check_agents)
    or (
      origin = 'source_check'
      and status = 'pending'
      and change_type in ('new', 'update')
    )
  );

-- moderation_queue UPDATE has no such exception — the agent never updates
-- the queue under any shape, so this one blocks it unconditionally:
create policy "source-check agents can't update the moderation queue"
  on moderation_queue as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));
```

Restrictive policies AND-combine with every permissive policy on that table/command, so this account is blocked from everything above regardless of what the existing broad `to authenticated with check (true)` policies otherwise allow.

**`ORIGIN_LABEL`** (`moderation-labels.ts`) gains `source_check: "Automated source check"`.

## Write-Through Changes

**`SourceCheckFinding`** — new interface in `moderation.ts`, shown in Architecture Overview above.

**`submitSourceCheckFinding(client, finding): Promise<void>`** — new, mirrors `submitNewListingProposal`'s shape:

```ts
export async function submitSourceCheckFinding(
  client: SupabaseClient<Database>,
  finding: SourceCheckFinding,
): Promise<void> {
  const { error } = await client.from("moderation_queue").insert({
    listing_id: finding.listingId,
    change_type: finding.changeType,
    proposed_data: finding.fields,
    correction_note: finding.note,
    origin: "source_check",
    status: "pending",
  });
  if (error)
    throw new Error(`Failed to file source-check finding: ${error.message}`);
}
```

No app-code read helper (a `getSources()`-style function) is added: nothing in this phase's flow needs one, since the discovery flow reads `sources`/`venues`/`listings` directly via the already-available Supabase MCP tools (see Discovery Flow below), not through the app's own data layer. A `getSources()` helper would only earn its keep once a self-serve admin UI for managing sources exists — out of scope for this phase.

**The write-path CLI entry point** — invoked once per finding by the discovery flow (see below), authenticates as the scoped agent account (`SOURCE_CHECK_AGENT_EMAIL`/`SOURCE_CHECK_AGENT_PASSWORD`, new `.env` vars) and calls `submitSourceCheckFinding`. Whether it imports `moderation.ts` directly (needs a TS runner this project doesn't currently have for plain Node scripts) or duplicates the insert inline the way `provision-moderators.mjs` already does is left to the implementation plan.

## The Skill (Discovery Flow)

A new Claude Code skill, `/check-sources [venue-name]`, runnable with no argument (check every registered source) or a venue-name filter (check one). Steps:

1. Read the `sources` table and the relevant venues/listings via the already-available Supabase MCP tools — read-only, so it doesn't need the scoped agent account; only the final write does.
2. For each source, `WebFetch` its URL.
3. Compare the fetched content against that venue's existing listings, reasoning conversationally (per the earlier decision, not via matching code).
4. Show a running summary of findings before filing anything.
5. For each finding, invoke the write-path CLI entry point (authenticated as the scoped agent account) to file it as a pending `moderation_queue` entry.
6. End with a summary: sources checked, findings filed, and a pointer to `/admin` for review.

A source that fails to fetch or doesn't parse cleanly (e.g., turns out to be JS-rendered) is reported as skipped, not treated as a run-aborting error — one bad source shouldn't block checking the rest.

## Provisioning

**`scripts/provision-source-check-agent.mjs`** — new, one-time, mirrors `provision-moderators.mjs`: using the service-role key, creates the Supabase Auth user and inserts its id into `source_check_agents`. Run once by hand against production (see the Security Callout above for why this is the *only* place the service-role key belongs in this feature). The resulting email/password go into your local `.env` as `SOURCE_CHECK_AGENT_EMAIL`/`SOURCE_CHECK_AGENT_PASSWORD` for the write-path script to use.

## Testing

Per this project's existing testing priorities (automate state-transition/governance logic; verify UI/agent behavior manually):

- `submitSourceCheckFinding` inserts a correctly-shaped pending entry for both `new` and `update` findings.
- RLS: the scoped agent account's insert succeeds only for the exact `source_check` shape, and is rejected for any deviation (wrong status, wrong origin, mismatched `listing_id`/`change_type` pairing) — mirrors the existing forgery-style RLS tests for the report and submission forms.
- RLS: the scoped agent account is rejected by every policy it would otherwise satisfy as a plain `authenticated` user — inserting/updating `listings`, `recurrence_rules`, `occurrence_exceptions`, `venues`, and updating `moderation_queue`. This is the regression test that actually proves the lockdown works, and the one most worth keeping green over time.
- The discovery flow itself (WebFetch plus conversational comparison): manual verification only, consistent with how prior admin-page phases treated UI verification — not something a unit test can meaningfully cover.

## Known Limitations

- Sources must reference an existing venue — no source-side venue creation (matches the non-goals).
- No staleness tracking (`last_checked_at`) — deferred until something would consume it.
- No admin UI for managing `sources` — registered via Supabase Studio for now.
- Some venue sites will simply be unreadable via WebFetch (JS-rendered, behind auth) — an expected skip, not a bug to fix in this phase.
- The "reusable for a future autonomous agent" claim is a designed interface (`SourceCheckFinding`, the write-through function, the RLS model), not a built one — the autonomous discovery pipeline itself doesn't exist and isn't part of this phase.

## Resolved in the Implementation Plan

- The write-path CLI entry point (`scripts/submit-source-finding.mjs`) duplicates `submitSourceCheckFinding`'s insert inline, matching `provision-moderators.mjs`'s existing convention, rather than importing `moderation.ts` (which would require adding a TS runner for plain Node scripts this project doesn't currently have).
- No `getSources()` helper is added — see the Write-Through Changes section above.

See [docs/superpowers/plans/2026-09-05-source-check-agent.md](../plans/2026-09-05-source-check-agent.md) for the task-by-task build.
