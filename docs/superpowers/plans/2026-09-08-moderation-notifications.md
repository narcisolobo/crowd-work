# Moderation Queue Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email moderators automatically when `moderation_queue` entries need review — instantly for urgent cancellations/modifications happening within 3 days, and once daily for everything else still pending.

**Architecture:** One migration adds a `notified_at` column plus a `notification_agents` scoped account (mirroring the existing `source_check_agents` pattern) with narrow RLS grants. Three pure, dependency-free TypeScript modules (classification rules, email templates, and the fetch-classify-send-update orchestration cycle) are shared between the app's Vitest suite and a new Deno Edge Function via relative import — the same portability trick `moderation-labels.ts` already uses, extended so the orchestration logic itself is fully testable with a real local Supabase client and a mocked "send email" callback. The Edge Function is a thin Deno wrapper: parse the request, sign in as `notification_agents`, call the orchestration module, send via Resend, return a response. Two `pg_cron` schedules invoke it.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS, Edge Functions/Deno, pg_cron, pg_net, Vault), `@supabase/supabase-js`, Resend (plain `fetch`, no SDK), Vitest (integration tests against local Supabase).

**Spec:** [docs/superpowers/specs/2026-09-08-moderation-notifications-design.md](../specs/2026-09-08-moderation-notifications-design.md)

## Global Constraints

- No service-role key anywhere in the recurring path — the Edge Function authenticates as the scoped `notification_agents` account. The service-role key appears only once, inside the one-time provisioning script (Task 2). See spec Security section.
- `notification_agents` can only ever flip `notified_at` on a row that is, and remains, `status = 'pending'` — enforced by RLS, not application code. It must be rejected by every other write policy on `moderation_queue`, `listings`, `recurrence_rules`, `occurrence_exceptions`, and `venues`.
- Urgent scope: `change_type in ('cancellation', 'modification')`, `status = 'pending'`, reported `proposed_data.originalDate` within 3 days, never previously notified.
- Digest scope: `status = 'pending'` and not already notified today (regardless of `change_type`).
- No React Email, no new templating dependency — plain inline-CSS HTML strings, `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.
- The classification rules, email templates, and orchestration-cycle modules in `src/lib/utils/` must have zero non-type-only imports beyond one another, so the Deno Edge Function can import them directly by relative path without pulling in the rest of the Node-oriented data layer. PostgREST can't cleanly filter on `(proposed_data->>'originalDate')::date`, so all three modules work by fetching every `status = 'pending'` row (a small, bounded set) and classifying in plain TypeScript rather than in the query itself.

---

## File Structure

```
crowd-work/
├── supabase/
│   ├── migrations/
│   │   ├── <timestamp>_notification_agents.sql        # new
│   │   └── <timestamp>_notification_cron_schedules.sql # new
│   └── functions/
│       └── send-moderation-notifications/
│           └── index.ts                                # new (Deno)
├── scripts/
│   └── provision-notification-agent.mjs                # new
├── src/
│   └── lib/
│       ├── supabase/
│       │   └── database.types.ts                       # regenerated
│       ├── data/
│       │   ├── moderation-test-helpers.ts               # modified: signInNotificationAgent()
│       │   └── moderation-notifications-rls.test.ts      # new
│       └── utils/
│           ├── moderation-notification-rules.ts          # new
│           ├── moderation-notification-rules.test.ts     # new
│           ├── moderation-notification-templates.ts      # new
│           ├── moderation-notification-templates.test.ts # new
│           ├── moderation-notification-send.ts           # new
│           └── moderation-notification-send.test.ts      # new
├── PRODUCT.md                                            # modified: notifications line
└── .env.example                                          # modified: NOTIFICATION_AGENT_*, RESEND_FROM_EMAIL
```

---

### Task 1: Migration — `notification_agents` and the full RLS lockdown

**Files:**

- Create: `supabase/migrations/<timestamp>_notification_agents.sql`

**Interfaces:**

- Consumes: `moderation_queue`, `listings`, `recurrence_rules`, `occurrence_exceptions`, `venues` tables as they exist today
- Produces: `moderation_queue.notified_at` column; `notification_agents` table; a permissive UPDATE policy scoped to that account; restrictive policies blocking it from every other write — consumed by Task 2's provisioning script and Task 3's lockdown tests

- [x] **Step 1: Generate the migration file**

```bash
supabase migration new notification_agents
```

- [x] **Step 2: Write the migration**

```sql
alter table moderation_queue
  add column notified_at timestamptz;

-- Names which accounts get the narrow notification grant below, mirroring
-- source_check_agents. The select policy is required for the same
-- non-obvious reason: every policy below reads this table via a subquery,
-- itself subject to this table's own RLS — without a select policy the
-- subquery returns zero rows for everyone, including the agent itself.
create table notification_agents (
  id uuid primary key references auth.users(id)
);

alter table notification_agents enable row level security;

create policy "authenticated users can read notification agent ids"
  on notification_agents for select
  to authenticated
  using (true);

-- The one capability this account has: flipping notified_at on a row that
-- is, and remains, pending. SELECT on moderation_queue and moderators is
-- already `to authenticated using (true)`, so no new SELECT policy is
-- needed for either table.
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

-- Narrows the permissive policy above so this account can never slip a
-- decision into the same call.
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

-- This account has no legitimate insert path anywhere (unlike
-- source_check_agents, which files findings), so the moderation_queue
-- insert block is unconditional.
create policy "notification agents can't insert into the moderation queue"
  on moderation_queue as restrictive for insert
  to authenticated
  with check (auth.uid() not in (select id from notification_agents));

-- Everything below blocks a notification agent from every other
-- moderator-only write the broad `to authenticated` policies would
-- otherwise grant it — mirrors source_check_agents' identical lockdown.
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

- [x] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `notification_agents` apply with no errors.

- [x] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `notification_agents` and `moderation_queue.notified_at` now appear in `database.types.ts`.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: add notified_at column and a scoped notification agent account

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Provisioning script for the scoped agent account

**Files:**

- Create: `scripts/provision-notification-agent.mjs`
- Modify: `.env.example`
- Modify: `src/lib/data/moderation-test-helpers.ts`

**Interfaces:**

- Consumes: `notification_agents` table (Task 1); `SUPABASE_SERVICE_ROLE_KEY`/`PUBLIC_SUPABASE_URL` env vars (existing)
- Produces: a Supabase Auth user registered in `notification_agents`; `signInNotificationAgent()` — consumed by Task 3's tests and Task 7's orchestration tests

This task has no automated test — mirrors `provision-source-check-agent.mjs`, verified by running it.

- [x] **Step 1: Write the provisioning script**

Create `scripts/provision-notification-agent.mjs`:

```js
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile();
} catch {
  // .env not present — required variables below will fail with a clear error instead.
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [email, password] = process.argv.slice(2);

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
  );
}
if (!email || !password) {
  throw new Error(
    "Usage: node scripts/provision-notification-agent.mjs <email> <password>",
  );
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: user, error: userError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (userError) throw userError;

const { error: agentError } = await admin
  .from("notification_agents")
  .insert({ id: user.user.id });
if (agentError) throw agentError;

console.log(`Provisioned notification agent: ${email} (${user.user.id})`);
```

- [x] **Step 2: Add env var placeholders**

In `.env.example`, add after the existing `SOURCE_CHECK_AGENT_PASSWORD` line:

```

# notification agent account (local dev/test only — see
# scripts/provision-notification-agent.mjs)
NOTIFICATION_AGENT_EMAIL=
NOTIFICATION_AGENT_PASSWORD=

# resend sender address and shared secret the cron jobs present to the
# send-moderation-notifications Edge Function (see Tasks 6/8)
RESEND_FROM_EMAIL=
NOTIFICATION_FUNCTION_SECRET=
```

- [x] **Step 3: Provision the account locally and verify**

In `.env` (gitignored), choose a local-only email/password pair.

```bash
node scripts/provision-notification-agent.mjs notifications@crowdwork.test <password>
```

Expected: logs `Provisioned notification agent: notifications@crowdwork.test (<uuid>)` with no errors.

- [x] **Step 4: Add the test-helper sign-in function**

In `src/lib/data/moderation-test-helpers.ts`, add after `signInSourceCheckAgent`:

```ts
export async function signInNotificationAgent(): Promise<
  SupabaseClient<Database>
> {
  const client = createClient<Database>(
    requiredEnv("PUBLIC_SUPABASE_URL"),
    requiredEnv("PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error } = await client.auth.signInWithPassword({
    email: requiredEnv("NOTIFICATION_AGENT_EMAIL"),
    password: requiredEnv("NOTIFICATION_AGENT_PASSWORD"),
  });
  if (error)
    throw new Error(`Failed to sign in notification agent: ${error.message}`);

  return client;
}
```

- [x] **Step 5: Commit**

```bash
git add scripts/provision-notification-agent.mjs .env.example src/lib/data/moderation-test-helpers.ts
git commit -m "$(cat <<'EOF'
feat: add provisioning script for the notification agent account

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: RLS lockdown regression tests

**Files:**

- Create: `src/lib/data/moderation-notifications-rls.test.ts`

**Interfaces:**

- Consumes: `signInNotificationAgent`, `createAdminClient` (Task 2); seeded fixture ids from `supabase/seed.sql` (reuse `EXISTING_LISTING_ID`/`EXISTING_VENUE_ID`/`EXISTING_NEIGHBORHOOD_ID`/`EXISTING_PENDING_ENTRY_ID` values already used in `moderation-source-check.test.ts`)
- Produces: proof the Task 1 policies hold — no other task depends on this file

- [x] **Step 1: Write the "can mark pending as notified" test**

```ts
import { describe, it, expect } from "vitest";
import {
  createAdminClient,
  signInNotificationAgent,
} from "./moderation-test-helpers";

const EXISTING_PENDING_ENTRY_ID = "e0000000-0000-0000-0000-000000000001";
const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";
const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";

describe("notification agent permitted update", () => {
  it("can set notified_at on a pending entry", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent
      .from("moderation_queue")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", EXISTING_PENDING_ENTRY_ID);
    expect(error).toBeNull();

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at, status")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.notified_at).not.toBeNull();
    expect(entry!.status).toBe("pending");

    // Reset for other tests/runs.
    await admin
      .from("moderation_queue")
      .update({ notified_at: null })
      .eq("id", EXISTING_PENDING_ENTRY_ID);
  });
});
```

- [x] **Step 2: Run it to verify it passes**

```bash
pnpm test -- moderation-notifications-rls
```

Expected: PASS. (This confirms the permissive policy works before testing the restrictive ones below.)

- [x] **Step 3: Write the lockdown tests**

Append to the same file:

```ts
describe("notification agent lockdown", () => {
  it("cannot approve a pending entry through the same update", async () => {
    // A restrictive policy silently excludes the row from the update set
    // (like a WHERE filter) rather than throwing, so the assertion is
    // that the row is unchanged afterward, not that `error` is non-null.
    const agent = await signInNotificationAgent();
    const {
      data: { user },
    } = await agent.auth.getUser();

    await agent
      .from("moderation_queue")
      .update({
        status: "approved",
        approved_by: user!.id,
        decided_at: new Date().toISOString(),
        notified_at: new Date().toISOString(),
      })
      .eq("id", EXISTING_PENDING_ENTRY_ID);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("status, approved_by, decided_at")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.status).toBe("pending");
    expect(entry!.approved_by).toBeNull();
    expect(entry!.decided_at).toBeNull();
  });

  it("cannot insert into the moderation queue", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      proposed_data: { title: "Sneaked in" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a listing directly", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("listings").insert({
      type: "mic",
      title: "Sneaked-In Listing",
      venue_id: EXISTING_VENUE_ID,
      start_time: "20:00",
      status: "published",
    });
    expect(error).not.toBeNull();
  });

  it("cannot update an existing listing", async () => {
    const agent = await signInNotificationAgent();
    await agent
      .from("listings")
      .update({ title: "Tampered Title" })
      .eq("id", EXISTING_LISTING_ID);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from("listings")
      .select("title")
      .eq("id", EXISTING_LISTING_ID)
      .single();
    expect(listing!.title).toBe("Tuesday Night Mic");
  });

  it("cannot insert a recurrence rule", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("recurrence_rules").insert({
      listing_id: EXISTING_LISTING_ID,
      frequency: "weekly",
      day_of_week: 3,
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert an occurrence exception", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("occurrence_exceptions").insert({
      listing_id: EXISTING_LISTING_ID,
      original_date: "2026-10-01",
      type: "cancelled",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a venue", async () => {
    const agent = await signInNotificationAgent();
    const { error } = await agent.from("venues").insert({
      name: "Sneaked-In Venue",
      address: "1 Fake St, Los Angeles, CA",
      neighborhood_id: EXISTING_NEIGHBORHOOD_ID,
    });
    expect(error).not.toBeNull();
  });
});
```

- [x] **Step 4: Run the full file and verify all pass**

```bash
pnpm test -- moderation-notifications-rls
```

Expected: PASS, all tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/data/moderation-notifications-rls.test.ts
git commit -m "$(cat <<'EOF'
test: add RLS lockdown regression tests for the notification agent

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Classification rules module

**Files:**

- Create: `src/lib/utils/moderation-notification-rules.ts`
- Create: `src/lib/utils/moderation-notification-rules.test.ts`

**Interfaces:**

- Consumes: `QueueChangeType`, `QueueStatus` types (type-only) from `../data/moderation`
- Produces: `URGENT_WINDOW_DAYS: number`, `isUrgent(entry, now: Date): boolean`, `isDigestEligible(entry, now: Date): boolean` — consumed by Task 7's orchestration module

This module must have no non-type-only imports at all, so Deno can import it directly by relative path (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { isUrgent, isDigestEligible, URGENT_WINDOW_DAYS } from "./moderation-notification-rules";

const NOW = new Date("2026-09-10T12:00:00Z");

function dateOffset(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("isUrgent", () => {
  it("is true for a pending cancellation exactly 3 days out", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(URGENT_WINDOW_DAYS) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for a pending cancellation 4 days out", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(4) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is true for a pending modification within the window", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "modification",
          proposedData: { originalDate: dateOffset(1) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("is false for an 'update' entry regardless of date", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "update",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false once already notified", () => {
    expect(
      isUrgent(
        {
          status: "pending",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: "2026-09-10T00:00:00Z",
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when not pending", () => {
    expect(
      isUrgent(
        {
          status: "approved",
          changeType: "cancellation",
          proposedData: { originalDate: dateOffset(0) },
          notifiedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false when proposedData has no originalDate", () => {
    expect(
      isUrgent(
        { status: "pending", changeType: "cancellation", proposedData: null, notifiedAt: null },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("isDigestEligible", () => {
  it("is true for a pending entry never notified", () => {
    expect(isDigestEligible({ status: "pending", notifiedAt: null }, NOW)).toBe(true);
  });

  it("is true for a pending entry notified yesterday", () => {
    expect(
      isDigestEligible({ status: "pending", notifiedAt: "2026-09-09T23:00:00Z" }, NOW),
    ).toBe(true);
  });

  it("is false for a pending entry already notified today", () => {
    expect(
      isDigestEligible({ status: "pending", notifiedAt: "2026-09-10T01:00:00Z" }, NOW),
    ).toBe(false);
  });

  it("is false when not pending", () => {
    expect(isDigestEligible({ status: "approved", notifiedAt: null }, NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- moderation-notification-rules
```

Expected: FAIL with "Cannot find module './moderation-notification-rules'" or similar.

- [ ] **Step 3: Write the implementation**

```ts
import type { QueueChangeType, QueueStatus } from "../data/moderation";

export const URGENT_WINDOW_DAYS = 3;

interface UrgencyInput {
  status: QueueStatus;
  changeType: QueueChangeType;
  proposedData: { originalDate?: string | null } | null;
  notifiedAt: string | null;
}

interface DigestInput {
  status: QueueStatus;
  notifiedAt: string | null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysUntil(dateStr: string, now: Date): number {
  const target = startOfUtcDay(new Date(`${dateStr}T00:00:00Z`));
  const today = startOfUtcDay(now);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function isUrgent(entry: UrgencyInput, now: Date): boolean {
  if (entry.status !== "pending") return false;
  if (entry.changeType !== "cancellation" && entry.changeType !== "modification") {
    return false;
  }
  if (entry.notifiedAt !== null) return false;
  const originalDate = entry.proposedData?.originalDate;
  if (!originalDate) return false;
  return daysUntil(originalDate, now) <= URGENT_WINDOW_DAYS;
}

export function isDigestEligible(entry: DigestInput, now: Date): boolean {
  if (entry.status !== "pending") return false;
  if (entry.notifiedAt === null) return true;
  return startOfUtcDay(new Date(entry.notifiedAt)).getTime() < startOfUtcDay(now).getTime();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- moderation-notification-rules
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/moderation-notification-rules.ts src/lib/utils/moderation-notification-rules.test.ts
git commit -m "$(cat <<'EOF'
feat: add urgent/digest classification rules for moderation notifications

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Email template module

**Files:**

- Create: `src/lib/utils/moderation-notification-templates.ts`
- Create: `src/lib/utils/moderation-notification-templates.test.ts`

**Interfaces:**

- Consumes: `CHANGE_TYPE_LABEL`, `ORIGIN_LABEL`, `previewFor` (value imports) from `./moderation-labels`; `QueueChangeType` type (type-only) from `../data/moderation`
- Produces: `buildUrgentEmail(entries, now: Date): { subject: string; html: string }`, `buildDigestEmail(entries, now: Date): { subject: string; html: string } | null` — consumed by Task 7's orchestration module

`moderation-labels.ts` has no non-type-only imports of its own, so this module stays Deno-importable by relative path (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildUrgentEmail, buildDigestEmail } from "./moderation-notification-templates";

const NOW = new Date("2026-09-10T12:00:00Z");

const CANCELLATION_ENTRY = {
  id: "11111111-1111-1111-1111-111111111111",
  changeType: "cancellation" as const,
  origin: "report_form",
  correctionNote: "Venue closed early this week",
  proposedData: { originalDate: "2026-09-12" },
  createdAt: "2026-09-08T10:00:00Z",
};

const NEW_LISTING_ENTRY = {
  id: "22222222-2222-2222-2222-222222222222",
  changeType: "new" as const,
  origin: "source_check",
  correctionNote: "Detected via automated check",
  proposedData: { title: "Brand New Open Mic" },
  createdAt: "2026-09-09T08:00:00Z",
};

describe("buildUrgentEmail", () => {
  it("includes the change type badge, headline, origin, and days-away", () => {
    const { subject, html } = buildUrgentEmail([CANCELLATION_ENTRY], NOW);
    expect(subject).toBe("Urgent: 1 moderation item needs review");
    expect(html).toContain("Cancellation");
    expect(html).toContain("Venue closed early this week");
    expect(html).toContain("/admin/queue/11111111-1111-1111-1111-111111111111");
    expect(html).toContain("Public report");
    expect(html).toContain("Occurs 2026-09-12 (in 2 days)");
    expect(html).toContain("system-ui");
  });

  it("pluralizes the subject for multiple entries", () => {
    const { subject } = buildUrgentEmail([CANCELLATION_ENTRY, CANCELLATION_ENTRY], NOW);
    expect(subject).toBe("Urgent: 2 moderation items need review");
  });
});

describe("buildDigestEmail", () => {
  it("returns null for an empty list", () => {
    expect(buildDigestEmail([], NOW)).toBeNull();
  });

  it("groups by change type and uses the origin/created-date line", () => {
    const result = buildDigestEmail([CANCELLATION_ENTRY, NEW_LISTING_ENTRY], NOW);
    expect(result).not.toBeNull();
    expect(result!.subject).toBe("Daily digest: 2 pending moderation items");
    expect(result!.html).toContain("Cancellation");
    expect(result!.html).toContain("New");
    expect(result!.html).toContain("Brand New Open Mic");
    expect(result!.html).toContain("Automated source check");
    expect(result!.html).toContain("2026-09-08");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- moderation-notification-templates
```

Expected: FAIL with "Cannot find module './moderation-notification-templates'".

- [ ] **Step 3: Write the implementation**

```ts
import { CHANGE_TYPE_LABEL, ORIGIN_LABEL, previewFor } from "./moderation-labels";
import type { QueueChangeType } from "../data/moderation";

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, system-ui';

interface TemplateEntry {
  id: string;
  changeType: QueueChangeType;
  origin: string;
  correctionNote: string | null;
  proposedData: { originalDate?: string | null; title?: string | null } | null;
  createdAt: string;
}

function daysAway(dateStr: string, now: Date): number {
  const target = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function itemHtml(entry: TemplateEntry, secondLine: string): string {
  const headline = previewFor(entry);
  return `
    <li style="list-style:none;padding:12px 0;border-bottom:1px solid #ddd;">
      <span style="display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;border:1px solid #999;border-radius:2px;padding:1px 6px;margin-right:8px;">${CHANGE_TYPE_LABEL[entry.changeType]}</span>
      <a href="/admin/queue/${entry.id}" style="font-family:${FONT_STACK};font-size:15px;color:#111;text-decoration:underline;">${headline}</a>
      <div style="font-family:${FONT_STACK};font-size:13px;color:#666;margin-top:2px;">${secondLine}</div>
    </li>
  `;
}

function wrap(bodyHtml: string): string {
  return `<html><body style="font-family:${FONT_STACK};margin:0;padding:16px;">
    <ul style="margin:0;padding:0;">${bodyHtml}</ul>
  </body></html>`;
}

export function buildUrgentEmail(
  entries: TemplateEntry[],
  now: Date,
): { subject: string; html: string } {
  const items = entries
    .map((entry) => {
      const originalDate = entry.proposedData?.originalDate ?? "";
      const secondLine = `${ORIGIN_LABEL[entry.origin] ?? entry.origin} · Occurs ${dateLabel(originalDate)} (in ${daysAway(originalDate, now)} days)`;
      return itemHtml(entry, secondLine);
    })
    .join("");

  return {
    subject: `Urgent: ${pluralize(entries.length, "moderation item")} need${entries.length === 1 ? "s" : ""} review`,
    html: wrap(items),
  };
}

export function buildDigestEmail(
  entries: TemplateEntry[],
  _now: Date,
): { subject: string; html: string } | null {
  if (entries.length === 0) return null;

  const grouped = new Map<QueueChangeType, TemplateEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.changeType) ?? [];
    group.push(entry);
    grouped.set(entry.changeType, group);
  }

  const items = [...grouped.values()]
    .flat()
    .map((entry) => {
      const secondLine = `${ORIGIN_LABEL[entry.origin] ?? entry.origin} · ${dateLabel(entry.createdAt)}`;
      return itemHtml(entry, secondLine);
    })
    .join("");

  return {
    subject: `Daily digest: ${pluralize(entries.length, "pending moderation item")}`,
    html: wrap(items),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- moderation-notification-templates
```

Expected: PASS, all tests. (The subject-line assertions in Step 1 use singular/plural exactly as this implementation produces — adjust either side if they drift.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/moderation-notification-templates.ts src/lib/utils/moderation-notification-templates.test.ts
git commit -m "$(cat <<'EOF'
feat: add HTML email templates for moderation notifications

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `pg_cron`/`pg_net` schedules

**Files:**

- Create: `supabase/migrations/<timestamp>_notification_cron_schedules.sql`

**Interfaces:**

- Consumes: `pg_cron`, `pg_net`, `supabase_vault` extensions (enabled by this task)
- Produces: two scheduled jobs (`notify-urgent`, `notify-digest`) that POST to the Task 8 Edge Function — no other task depends on this file directly, but Task 8 must exist (even as a stub) before these schedules do anything useful

The three Vault secrets below are environment-specific and must never be committed — set them once per environment (local included, since `supabase db reset` wipes Vault along with all other data) via the Studio SQL editor or `supabase db execute`, the same way `NOTIFICATION_AGENT_EMAIL`/`PASSWORD` are set once per environment rather than hardcoded.

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new notification_cron_schedules
```

- [ ] **Step 2: Write the migration**

```sql
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
```

- [ ] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: no errors. Verify the jobs registered:

```bash
supabase db execute --sql "select jobname, schedule from cron.job;"
```

Expected: `notify-urgent` and `notify-digest` listed with their schedules.

- [ ] **Step 4: Set the per-environment Vault secrets locally**

Run once (and again after any future `supabase db reset`) via `supabase db execute` or the Studio SQL editor — do not add this to a migration file, since the values differ per environment and the URL/anon key are not meant to be committed alongside a secret:

```sql
select vault.create_secret('http://host.docker.internal:54521/functions/v1/send-moderation-notifications', 'notification_function_url');
select vault.create_secret('<your PUBLIC_SUPABASE_PUBLISHABLE_KEY value>', 'notification_function_anon_key');
select vault.create_secret('<your NOTIFICATION_FUNCTION_SECRET value from .env>', 'notification_function_secret');
```

`host.docker.internal` is the standard way for the local Postgres container to reach the local Edge Runtime container; the port (`54521` here) must match this project's `[api]` port in `supabase/config.toml`. If your local Supabase CLI version resolves container networking differently, adjust the URL and re-verify Task 8's manual invocation still succeeds end-to-end.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "$(cat <<'EOF'
feat: schedule urgent and digest notification cron jobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Notification cycle orchestration module

**Files:**

- Create: `src/lib/utils/moderation-notification-send.ts`
- Create: `src/lib/utils/moderation-notification-send.test.ts`

**Interfaces:**

- Consumes: `isUrgent`/`isDigestEligible` (Task 4), `buildUrgentEmail`/`buildDigestEmail` (Task 5), `SupabaseClient`/`Database` types (type-only), `signInNotificationAgent`/`createAdminClient` (Task 2, test-only)
- Produces: `runNotificationCycle(client, mode, now, sendEmail): Promise<{ sent: boolean; matched: number }>` and its `SendEmail` type — consumed by Task 8's Edge Function

This is the piece the spec calls out explicitly: "Resend calls mocked in tests" and "one integration-style test covering a full urgent-then-digest cycle." It runs against the **real local Supabase instance** (same convention as every other data-layer test in this project) authenticated as the real `notification_agents` account (proving the Task 1 RLS grant is sufficient for the whole cycle, not just the isolated update tested in Task 3), with only the `sendEmail` callback mocked — nothing about Resend itself needs a real network call to test this logic. It has zero non-type-only imports beyond Tasks 4-5, so it stays Deno-importable (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { runNotificationCycle } from "./moderation-notification-send";
import {
  createAdminClient,
  signInNotificationAgent,
} from "../data/moderation-test-helpers";

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

async function insertPendingCancellation(originalDate: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("moderation_queue")
    .insert({
      change_type: "cancellation",
      origin: "report_form",
      status: "pending",
      listing_id: "d0000000-0000-0000-0000-000000000001",
      proposed_data: { originalDate },
      correction_note: "Orchestration cycle test fixture",
    })
    .select("id")
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id;
}

describe("runNotificationCycle", () => {
  it("sends an urgent email for a newly-urgent entry and marks it notified", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    await insertPendingCancellation("2026-09-11");

    const sendEmail = vi.fn().mockResolvedValue(true);
    const result = await runNotificationCycle(agent, "urgent", now, sendEmail);

    expect(result.sent).toBe(true);
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0][0];
    expect(call.subject).toMatch(/^Urgent:/);
    expect(call.html).toContain("Orchestration cycle test fixture");
    expect(call.to.length).toBeGreaterThan(0);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at")
      .eq("id", insertedEntryIds[0])
      .single();
    expect(entry!.notified_at).not.toBeNull();
  });

  it("does not re-send or duplicate-count an already-urgent-notified entry the same day", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    const id = await insertPendingCancellation("2026-09-11");

    const firstSend = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "urgent", now, firstSend);

    const secondSend = vi.fn().mockResolvedValue(true);
    const secondResult = await runNotificationCycle(agent, "urgent", now, secondSend);
    expect(secondSend).not.toHaveBeenCalled();
    expect(secondResult.sent).toBe(false);

    // Same-day digest also excludes it (already surfaced today)...
    const digestSameDay = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "digest", now, digestSameDay);
    if (digestSameDay.mock.calls.length > 0) {
      expect(digestSameDay.mock.calls[0][0].html).not.toContain(id);
    }

    // ...but reappears in tomorrow's digest, since it's still pending.
    const tomorrow = new Date("2026-09-11T12:00:00Z");
    const digestNextDay = vi.fn().mockResolvedValue(true);
    await runNotificationCycle(agent, "digest", tomorrow, digestNextDay);
    expect(digestNextDay).toHaveBeenCalledTimes(1);
    expect(digestNextDay.mock.calls[0][0].html).toContain("Orchestration cycle test fixture");
  });

  it("does not mark notified_at when sendEmail reports failure", async () => {
    const agent = await signInNotificationAgent();
    const now = new Date("2026-09-10T12:00:00Z");
    await insertPendingCancellation("2026-09-11");

    const failingSend = vi.fn().mockResolvedValue(false);
    const result = await runNotificationCycle(agent, "urgent", now, failingSend);
    expect(result.sent).toBe(false);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("notified_at")
      .eq("id", insertedEntryIds[0])
      .single();
    expect(entry!.notified_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- moderation-notification-send
```

Expected: FAIL with "Cannot find module './moderation-notification-send'".

- [ ] **Step 3: Write the implementation**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { isUrgent, isDigestEligible } from "./moderation-notification-rules";
import { buildUrgentEmail, buildDigestEmail } from "./moderation-notification-templates";

export type SendEmail = (args: {
  subject: string;
  html: string;
  to: string[];
}) => Promise<boolean>;

export async function runNotificationCycle(
  client: SupabaseClient<Database>,
  mode: "urgent" | "digest",
  now: Date,
  sendEmail: SendEmail,
): Promise<{ sent: boolean; matched: number }> {
  const { data: rows, error } = await client
    .from("moderation_queue")
    .select(
      "id, change_type, origin, correction_note, proposed_data, created_at, notified_at",
    )
    .eq("status", "pending");
  if (error) throw new Error(`Failed to fetch pending entries: ${error.message}`);

  const pending = (rows ?? []) as any[];
  const matched =
    mode === "urgent"
      ? pending.filter((row) =>
          isUrgent(
            {
              status: "pending",
              changeType: row.change_type,
              proposedData: row.proposed_data,
              notifiedAt: row.notified_at,
            },
            now,
          ),
        )
      : pending.filter((row) =>
          isDigestEligible({ status: "pending", notifiedAt: row.notified_at }, now),
        );

  if (matched.length === 0) return { sent: false, matched: 0 };

  const templateEntries = matched.map((row) => ({
    id: row.id,
    changeType: row.change_type,
    origin: row.origin,
    correctionNote: row.correction_note,
    proposedData: row.proposed_data,
    createdAt: row.created_at,
  }));

  const email =
    mode === "urgent"
      ? buildUrgentEmail(templateEntries, now)
      : buildDigestEmail(templateEntries, now);
  if (!email) return { sent: false, matched: 0 };

  const { data: moderators, error: moderatorsError } = await client
    .from("moderators")
    .select("email");
  if (moderatorsError)
    throw new Error(`Failed to fetch moderators: ${moderatorsError.message}`);

  const ok = await sendEmail({
    subject: email.subject,
    html: email.html,
    to: (moderators ?? []).map((m: any) => m.email),
  });
  if (!ok) return { sent: false, matched: matched.length };

  const { error: updateError } = await client
    .from("moderation_queue")
    .update({ notified_at: now.toISOString() })
    .in(
      "id",
      matched.map((row) => row.id),
    );
  if (updateError)
    throw new Error(`Sent email but failed to mark notified_at: ${updateError.message}`);

  return { sent: true, matched: matched.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- moderation-notification-send
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/moderation-notification-send.ts src/lib/utils/moderation-notification-send.test.ts
git commit -m "$(cat <<'EOF'
feat: add the urgent/digest notification orchestration cycle

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The Edge Function

**Files:**

- Create: `supabase/functions/send-moderation-notifications/index.ts`

**Interfaces:**

- Consumes: `runNotificationCycle`/`SendEmail` (Task 7); `NOTIFICATION_AGENT_EMAIL`/`PASSWORD`/`RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`NOTIFICATION_FUNCTION_SECRET` secrets
- Produces: the deployed function the Task 6 cron jobs invoke — this is the last code task; only Task 9 (docs) depends on this existing

Since the substantive logic now lives in Task 7 (fully tested under Vitest), this file has no automated test of its own — it's a thin Deno wrapper, verified by local invocation, the same "run it and check the result" treatment as the provisioning script.

- [ ] **Step 1: Write the function**

```ts
import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import { runNotificationCycle } from "../../../src/lib/utils/moderation-notification-send.ts";

Deno.serve(async (req) => {
  const suppliedSecret = req.headers.get("x-notification-secret");
  const expectedSecret = Deno.env.get("NOTIFICATION_FUNCTION_SECRET");
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { mode } = await req.json();
  if (mode !== "urgent" && mode !== "digest") {
    return new Response("Invalid mode", { status: 400 });
  }

  const client = createClient(
    Deno.env.get("PUBLIC_SUPABASE_URL")!,
    Deno.env.get("PUBLIC_SUPABASE_PUBLISHABLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error: signInError } = await client.auth.signInWithPassword({
    email: Deno.env.get("NOTIFICATION_AGENT_EMAIL")!,
    password: Deno.env.get("NOTIFICATION_AGENT_PASSWORD")!,
  });
  if (signInError) {
    console.error("Failed to sign in notification agent:", signInError.message);
    return new Response("Internal error", { status: 500 });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
  const resendFrom = Deno.env.get("RESEND_FROM_EMAIL")!;

  try {
    const result = await runNotificationCycle(client, mode, new Date(), async ({ subject, html, to }) => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: resendFrom, to, subject, html }),
      });
      if (!response.ok) {
        console.error("Resend send failed:", await response.text());
        return false;
      }
      return true;
    });

    return new Response(JSON.stringify(result), { status: 200 });
  } catch (err) {
    console.error("Notification cycle failed:", err);
    return new Response("Internal error", { status: 500 });
  }
});
```

- [ ] **Step 2: Set local Edge Function secrets**

Create `supabase/functions/.env` (gitignored — do not commit):

```
NOTIFICATION_AGENT_EMAIL=notifications@crowdwork.test
NOTIFICATION_AGENT_PASSWORD=<matches what you provisioned in Task 2>
NOTIFICATION_FUNCTION_SECRET=<a random value, matches the Vault secret from Task 6>
RESEND_API_KEY=<your local RESEND_API_KEY>
RESEND_FROM_EMAIL=<a verified Resend sender address>
```

```bash
supabase secrets set --env-file supabase/functions/.env
```

`PUBLIC_SUPABASE_URL`/`PUBLIC_SUPABASE_PUBLISHABLE_KEY` are already available to local Edge Functions by default.

- [ ] **Step 3: Serve locally and invoke manually**

```bash
supabase functions serve send-moderation-notifications
```

In another terminal:

```bash
curl -i -X POST http://localhost:54521/functions/v1/send-moderation-notifications \
  -H "Content-Type: application/json" \
  -H "x-notification-secret: <your NOTIFICATION_FUNCTION_SECRET>" \
  -d '{"mode":"digest"}'
```

Expected: `200 OK` with `{"sent":true,"matched":N}` if any pending entries exist locally (the seeded `EXISTING_PENDING_ENTRY_ID` entry qualifies), or `{"sent":false,"matched":0}` if none do. Check the Resend dashboard (or logs, if using a test API key) for the sent email. Re-run the same command — since the matched entry now has `notified_at` set to today, expect `{"sent":false,"matched":0}` on the second call, confirming idempotency.

- [ ] **Step 4: Verify the cron path end-to-end**

With the function still served locally and the Task 6 Vault secrets set, manually trigger the cron job to confirm wiring without waiting 15 minutes:

```bash
supabase db execute --sql "select cron.schedule_in_database('notify-urgent-test', '5 seconds', \$\$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_url'), headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_anon_key'), 'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notification_function_secret')), body := jsonb_build_object('mode', 'urgent')) as request_id;\$\$, 'postgres');"
```

Expected: the function logs (`supabase functions serve` output) show an incoming request within a few seconds. Clean up the one-off test job afterward: `select cron.unschedule('notify-urgent-test');`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions
git commit -m "$(cat <<'EOF'
feat: add the send-moderation-notifications Edge Function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Reconcile superseded docs

**Files:**

- Modify: `PRODUCT.md`
- Modify: `docs/superpowers/specs/2026-09-01-crowd-work-directory-mvp-design.md`

**Interfaces:**

- Consumes: nothing — documentation only, no code interfaces
- Produces: nothing consumed by other tasks; this is cleanup identified in the spec's Known Limitations section

- [ ] **Step 1: Update `PRODUCT.md`**

Find the line (around line 35):

```
- **Notifications**: Resend-powered daily digest of pending queue items, plus a real-time alert for time-sensitive changes (a cancellation or modification within 2-3 days).
```

Replace with:

```
- **Notifications**: Resend-powered daily digest of pending queue items, plus an instant alert (via `pg_cron`, polling every 15 minutes) for time-sensitive changes — a pending cancellation or modification within 3 days.
```

- [ ] **Step 2: Annotate the superseded MVP design doc**

In `docs/superpowers/specs/2026-09-01-crowd-work-directory-mvp-design.md`, immediately before the `## Notifications` heading (around line 99), add:

```
> **Update (2026-09-08):** Superseded by [2026-09-08-moderation-notifications-design.md](2026-09-08-moderation-notifications-design.md) — the digest/urgent-alert split below is accurate in spirit, but the trigger mechanism (a `pg_cron`-invoked Edge Function, not a database webhook) and the urgency window (3 days, not "2-3") have both changed.
```

- [ ] **Step 3: Commit**

```bash
git add PRODUCT.md docs/superpowers/specs/2026-09-01-crowd-work-directory-mvp-design.md
git commit -m "$(cat <<'EOF'
docs: reconcile PRODUCT.md and the MVP design doc with the shipped notification design

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
