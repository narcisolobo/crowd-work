# Source Check Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manually-triggered Claude Code skill, `/check-sources [venue-name]`, that checks registered venue-website sources for listing changes and files findings into the existing `moderation_queue` as pending entries, through a Supabase account scoped down to exactly that one capability.

**Architecture:** No new services or hosting. One migration adds two tables (`sources`, `source_check_agents`) and a set of permissive/restrictive RLS policies that grant a dedicated Supabase Auth account the single ability to insert pending, source-check-shaped `moderation_queue` rows while blocking every other moderator-only write it would otherwise inherit as an `authenticated` user. A new write-through function (`submitSourceCheckFinding`) and a standalone write-path script (authenticated as that account) form the reusable half of the design; the skill itself drives discovery (fetching sources, comparing against existing listings, reasoning about what changed) conversationally, with no matching/diffing code.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js`, Vitest (integration tests against local Supabase), plain Node scripts (`.mjs`, no TS runner). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-05-source-check-agent-design.md](../specs/2026-09-05-source-check-agent-design.md)

## Global Constraints

- The service-role key is used only inside the one-time, human-run provisioning script — never in the recurring write path, which always authenticates as the scoped `source_check_agents` account. See the spec's Security Callout.
- The scoped agent account can only insert pending `moderation_queue` rows shaped exactly as `origin = 'source_check', status = 'pending', change_type in ('new', 'update')` — enforced by RLS, not application code alone. It must be rejected by every other write policy on `listings`, `recurrence_rules`, `occurrence_exceptions`, `venues`, and `moderation_queue` (insert of any other shape, and all updates).
- v1 produces only `change_type: 'new'` and `change_type: 'update'` findings — never `'cancellation'`.
- No admin UI or self-serve management for the `sources` table this phase — it's registered directly via Supabase Studio.
- Discovery (fetching a source, comparing it to existing listings, deciding what changed) happens via Claude reasoning inside a live Claude Code session — no fuzzy-matching code, no scheduling, no LLM API billing.

---

## File Structure

```
crowd-work/
├── supabase/
│   └── migrations/
│       └── <timestamp>_source_check_agent.sql       # new
├── scripts/
│   ├── provision-source-check-agent.mjs             # new
│   └── submit-source-finding.mjs                     # new
├── src/
│   └── lib/
│       ├── supabase/
│       │   └── database.types.ts                     # regenerated
│       ├── data/
│       │   ├── moderation.ts                          # modified: SourceCheckFinding, submitSourceCheckFinding
│       │   ├── moderation-source-check.test.ts        # new
│       │   └── moderation-test-helpers.ts             # modified: signInSourceCheckAgent()
│       └── utils/
│           └── moderation-labels.ts                   # modified: ORIGIN_LABEL source_check entry
├── .claude/
│   └── skills/
│       └── check-sources/
│           └── SKILL.md                                # new
└── .env.example                                         # modified: SOURCE_CHECK_AGENT_EMAIL/PASSWORD
```

---

### Task 1: Migration — `sources`, `source_check_agents`, and the full RLS lockdown

**Files:**

- Create: `supabase/migrations/<timestamp>_source_check_agent.sql`

**Interfaces:**

- Consumes: `venues`, `moderation_queue`, `listings`, `recurrence_rules`, `occurrence_exceptions` tables as they exist today
- Produces: `sources` table; `source_check_agents` table; a narrow authenticated INSERT policy on `moderation_queue` for `origin = 'source_check'`; restrictive policies blocking any `source_check_agents` account from every other moderator write — consumed by Task 3's `submitSourceCheckFinding` and its RLS tests, and Task 4's lockdown tests

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new source_check_agent
```

- [ ] **Step 2: Write the migration**

Open the generated file and write:

```sql
-- The registry of venue websites to check. No staleness tracking yet —
-- nothing consumes it. No insert/update policy: sources are registered
-- directly via Supabase Studio until a self-serve admin page justifies one.
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

-- Names which accounts get the narrow source-check insert grant below,
-- instead of hardcoding a uuid into six separate policies. RLS must be
-- enabled here (every other table in this schema is; without it, this
-- project's default role grants would leave the table fully writable by
-- anon/authenticated). The select policy is required for a less obvious
-- reason: every restrictive policy below reads this table via a subquery
-- (`auth.uid() in (select id from source_check_agents)`), and that
-- subquery is itself subject to this table's own RLS — without a select
-- policy it would return zero rows for every authenticated user,
-- including the agent itself, silently making every check below false.
-- Mirrors the existing `moderators` table's identical policy for the
-- identical reason.
create table source_check_agents (
  id uuid primary key references auth.users(id)
);

alter table source_check_agents enable row level security;

create policy "authenticated users can read source-check agent ids"
  on source_check_agents for select
  to authenticated
  using (true);

-- The one capability a source-check agent account has: filing a pending,
-- structurally-constrained finding. Mirrors the shape discipline of the
-- existing anonymous submission/report policies, plus the account
-- restriction.
create policy "a source-check agent can file a pending finding"
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

-- Everything below blocks a source-check agent from every other
-- moderator-only write the broad `to authenticated` policies would
-- otherwise grant it. Restrictive policies AND-combine with permissive
-- ones, so these apply regardless of what the pre-existing policies allow.
create policy "source-check agents can't insert listings"
  on listings as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't update listings"
  on listings as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert recurrence rules"
  on recurrence_rules as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't update recurrence rules"
  on recurrence_rules as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert occurrence exceptions"
  on occurrence_exceptions as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

create policy "source-check agents can't insert venues"
  on venues as restrictive for insert to authenticated
  with check (auth.uid() not in (select id from source_check_agents));

-- moderation_queue needs a different shape of restrictive policy for
-- INSERT specifically, because it's the one table where the agent has a
-- legitimate insert path (above) sitting alongside an illegitimate one it
-- must not also satisfy: the existing moderator_direct_add policy has no
-- account restriction of its own, so without this, the agent could
-- self-approve a direct-add listing exactly like a real moderator. A
-- plain "block this uid unconditionally" restrictive policy won't work
-- here, since it would also block the agent's own legitimate insert.
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
-- the queue under any shape.
create policy "source-check agents can't update the moderation queue"
  on moderation_queue as restrictive for update to authenticated
  using (auth.uid() not in (select id from source_check_agents));
```

- [ ] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `source_check_agent` apply with no errors.

- [ ] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `sources` and `source_check_agents` now appear in `database.types.ts`. No application code references them directly yet — this just keeps the file a faithful mirror of the schema, per project convention.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: add sources registry and a scoped source-check agent account

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Provisioning script for the scoped agent account

**Files:**

- Create: `scripts/provision-source-check-agent.mjs`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `source_check_agents` table (Task 1); `SUPABASE_SERVICE_ROLE_KEY`/`PUBLIC_SUPABASE_URL` env vars (existing)
- Produces: a Supabase Auth user registered in `source_check_agents` — consumed by Task 3's tests (`SOURCE_CHECK_AGENT_EMAIL`/`SOURCE_CHECK_AGENT_PASSWORD`) and Task 5's write-path script

This task has no automated test — mirrors `provision-moderators.mjs`, which is verified by running it, not by a Vitest suite.

- [ ] **Step 1: Write the provisioning script**

Create `scripts/provision-source-check-agent.mjs`:

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
    "Usage: node scripts/provision-source-check-agent.mjs <email> <password>",
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
  .from("source_check_agents")
  .insert({ id: user.user.id });
if (agentError) throw agentError;

console.log(`Provisioned source-check agent: ${email} (${user.user.id})`);
```

- [ ] **Step 2: Add env var placeholders**

In `.env.example`, add after the existing `TEST_MODERATOR_2_*` lines:

```
# source-check agent account (local dev/test only — see
# scripts/provision-source-check-agent.mjs)
SOURCE_CHECK_AGENT_EMAIL=
SOURCE_CHECK_AGENT_PASSWORD=
```

- [ ] **Step 3: Provision the account locally and verify**

In `.env` (gitignored), choose a local-only email/password pair for `SOURCE_CHECK_AGENT_EMAIL`/`PASSWORD` — a dev/test account under your own control, not a real one.

```bash
node scripts/provision-source-check-agent.mjs agent@crowdwork.test <password>
```

Expected: logs `Provisioned source-check agent: agent@crowdwork.test (<uuid>)` with no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/provision-source-check-agent.mjs .env.example
git commit -m "$(cat <<'EOF'
feat: add provisioning script for the source-check agent account

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Data layer — `submitSourceCheckFinding` and its RLS shape tests

**Files:**

- Modify: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/moderation-test-helpers.ts`
- Modify: `src/lib/utils/moderation-labels.ts`
- Create: `src/lib/data/moderation-source-check.test.ts`

**Interfaces:**

- Consumes: the `moderation_queue` insert policy from Task 1; `SOURCE_CHECK_AGENT_EMAIL`/`PASSWORD` from Task 2
- Produces: `SourceCheckFinding` interface; `submitSourceCheckFinding(client, finding): Promise<void>`; `signInSourceCheckAgent(): Promise<SupabaseClient<Database>>` — consumed by this task's own tests and Task 4's lockdown tests

- [ ] **Step 1: Add `signInSourceCheckAgent` to the test helpers**

In `src/lib/data/moderation-test-helpers.ts`, add after `signInTestModerator`:

```ts
export async function signInSourceCheckAgent(): Promise<
  SupabaseClient<Database>
> {
  const client = createClient<Database>(
    requiredEnv("PUBLIC_SUPABASE_URL"),
    requiredEnv("PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error } = await client.auth.signInWithPassword({
    email: requiredEnv("SOURCE_CHECK_AGENT_EMAIL"),
    password: requiredEnv("SOURCE_CHECK_AGENT_PASSWORD"),
  });
  if (error)
    throw new Error(`Failed to sign in source-check agent: ${error.message}`);

  return client;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/data/moderation-source-check.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { submitSourceCheckFinding } from "./moderation";
import {
  createAdminClient,
  signInSourceCheckAgent,
} from "./moderation-test-helpers";

const EXISTING_LISTING_ID = "d0000000-0000-0000-0000-000000000001";

const SAMPLE_FIELDS = {
  type: "mic" as const,
  title: "Tuesday Night Mic",
  host: "Jamie Rivera",
  description: null,
  venueId: "c0000000-0000-0000-0000-000000000001",
  newVenue: null,
  startTime: "20:00",
  signUpMethod: "sign-up list at the door, 7:30pm",
  costToPerform: "free",
  ticketPrice: null,
  ticketUrl: null,
  recurrence: { frequency: "weekly" as const, dayOfWeek: 2, weekOfMonth: null },
  oneOffDate: null,
};

let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from("moderation_queue").delete().in("id", insertedEntryIds);
  }
  insertedEntryIds = [];
});

describe("submitSourceCheckFinding", () => {
  it("inserts a pending 'new' finding with no listing_id", async () => {
    const agent = await signInSourceCheckAgent();

    await submitSourceCheckFinding(agent, {
      sourceId: "any-source-id",
      changeType: "new",
      listingId: null,
      fields: { ...SAMPLE_FIELDS, title: "Brand New Open Mic" },
      note: "Detected via automated check of The Fixture Room's website.",
    });

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, origin, status, listing_id, proposed_data")
      .eq("origin", "source_check")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("new");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBeNull();
    expect((entry!.proposed_data as { title: string }).title).toBe(
      "Brand New Open Mic",
    );
  });

  it("inserts a pending 'update' finding tied to an existing listing", async () => {
    const agent = await signInSourceCheckAgent();

    await submitSourceCheckFinding(agent, {
      sourceId: "any-source-id",
      changeType: "update",
      listingId: EXISTING_LISTING_ID,
      fields: { ...SAMPLE_FIELDS, startTime: "20:30" },
      note: "Start time now reads 8:30pm on the venue's site.",
    });

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("id, change_type, status, listing_id, correction_note")
      .eq("origin", "source_check")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(entry).not.toBeNull();
    insertedEntryIds.push(entry!.id);
    expect(entry!.change_type).toBe("update");
    expect(entry!.status).toBe("pending");
    expect(entry!.listing_id).toBe(EXISTING_LISTING_ID);
    expect(entry!.correction_note).toBe(
      "Start time now reads 8:30pm on the venue's site.",
    );
  });
});

describe("source_check RLS shape", () => {
  it("rejects an insert that pre-fills a decided status", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "approved",
      proposed_data: { title: "Forged" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects a 'new' finding that includes a listing_id", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      listing_id: EXISTING_LISTING_ID,
      proposed_data: { title: "Shape mismatch" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects an 'update' finding with no listing_id", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "update",
      origin: "source_check",
      status: "pending",
      listing_id: null,
      proposed_data: { title: "Shape mismatch" },
      correction_note: "note",
    });
    expect(error).not.toBeNull();
  });

  it("rejects an insert missing a correction_note", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "source_check",
      status: "pending",
      proposed_data: { title: "No note" },
      correction_note: null,
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test moderation-source-check
```

Expected: FAIL — `submitSourceCheckFinding` doesn't exist yet, and `signInSourceCheckAgent` isn't exported yet (the four RLS-shape tests should already pass once Task 1's migration is applied, since they exercise the policy directly with a raw insert; only the two `submitSourceCheckFinding` tests should fail on the missing function).

- [ ] **Step 4: Implement `SourceCheckFinding` and `submitSourceCheckFinding`**

In `src/lib/data/moderation.ts`, add near `ProposedListingFields`:

```ts
export interface SourceCheckFinding {
  sourceId: string;
  changeType: "new" | "update";
  listingId: string | null;
  fields: ProposedListingFields;
  note: string;
}
```

Add after `directAddListing` (or any convenient spot above `createListingFromFields`):

```ts
export async function submitSourceCheckFinding(
  client: SupabaseClient<Database>,
  finding: SourceCheckFinding,
): Promise<void> {
  const { error } = await client.from("moderation_queue").insert({
    listing_id: finding.listingId,
    change_type: finding.changeType,
    proposed_data: finding.fields as unknown as Json,
    correction_note: finding.note,
    origin: "source_check",
    status: "pending",
  });

  if (error)
    throw new Error(`Failed to file source-check finding: ${error.message}`);
}
```

- [ ] **Step 5: Add the new origin label**

In `src/lib/utils/moderation-labels.ts`, add to `ORIGIN_LABEL`:

```ts
export const ORIGIN_LABEL: Record<string, string> = {
  seed: "Seed data",
  report_form: "Public report",
  submission_form: "Public submission",
  moderator_direct_add: "Direct add",
  source_check: "Automated source check",
};
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test moderation-source-check
```

Expected: PASS — all six tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-test-helpers.ts src/lib/data/moderation-source-check.test.ts src/lib/utils/moderation-labels.ts
git commit -m "$(cat <<'EOF'
feat: add the source-check finding write-through path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: RLS lockdown regression tests

**Files:**

- Modify: `src/lib/data/moderation-source-check.test.ts`

**Interfaces:**

- Consumes: the restrictive policies from Task 1; `signInSourceCheckAgent` from Task 3
- Produces: no new exports — this is the test suite that proves the account can't do anything beyond Task 3's narrow grant

This is the task the whole design exists to make pass: a scoped credential sitting in a local script is only as safe as these assertions.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/data/moderation-source-check.test.ts`, after the `source_check RLS shape` describe block:

```ts
const EXISTING_VENUE_ID = "c0000000-0000-0000-0000-000000000001";
const EXISTING_NEIGHBORHOOD_ID = "b0000000-0000-0000-0000-000000000002";
// Seeded as status 'pending' in supabase/seed.sql.
const EXISTING_PENDING_ENTRY_ID = "e0000000-0000-0000-0000-000000000001";

describe("source-check agent lockdown", () => {
  it("cannot insert a listing directly", async () => {
    const agent = await signInSourceCheckAgent();
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
    // An UPDATE blocked by a restrictive policy simply excludes the row
    // from the update set (like a WHERE filter) rather than throwing —
    // Postgres only raises an explicit error when a row passes USING but
    // then fails WITH CHECK. So the real assertion is that the row is
    // unchanged afterward, not that `error` is non-null.
    const agent = await signInSourceCheckAgent();
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
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("recurrence_rules").insert({
      listing_id: EXISTING_LISTING_ID,
      frequency: "weekly",
      day_of_week: 3,
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert an occurrence exception", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("occurrence_exceptions").insert({
      listing_id: EXISTING_LISTING_ID,
      original_date: "2026-10-01",
      type: "cancelled",
    });
    expect(error).not.toBeNull();
  });

  it("cannot insert a venue", async () => {
    const agent = await signInSourceCheckAgent();
    const { error } = await agent.from("venues").insert({
      name: "Sneaked-In Venue",
      address: "1 Fake St, Los Angeles, CA",
      neighborhood_id: EXISTING_NEIGHBORHOOD_ID,
    });
    expect(error).not.toBeNull();
  });

  it("cannot self-approve a moderator_direct_add listing", async () => {
    const agent = await signInSourceCheckAgent();
    const {
      data: { user },
    } = await agent.auth.getUser();

    const { error } = await agent.from("moderation_queue").insert({
      change_type: "new",
      origin: "moderator_direct_add",
      status: "approved",
      approved_by: user!.id,
      decided_at: new Date().toISOString(),
      approved_data: { title: "Self-approved by the agent" },
    });
    expect(error).not.toBeNull();
  });

  it("cannot update any moderation_queue entry", async () => {
    // Same reasoning as the listings-update test above: assert the row is
    // unchanged, not that an error was thrown.
    const agent = await signInSourceCheckAgent();
    await agent
      .from("moderation_queue")
      .update({ status: "approved" })
      .eq("id", EXISTING_PENDING_ENTRY_ID);

    const admin = createAdminClient();
    const { data: entry } = await admin
      .from("moderation_queue")
      .select("status")
      .eq("id", EXISTING_PENDING_ENTRY_ID)
      .single();
    expect(entry!.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test moderation-source-check
```

Expected: without Task 1's restrictive policies these would fail (the agent would succeed at each forbidden write); since Task 1 is already applied, run this as the actual verification that the migration's restrictive policies work — expect PASS. If any of these seven tests instead FAIL (the write succeeded), that means the corresponding restrictive policy from Task 1 is missing or wrong — stop and fix the migration before continuing, since this is the core security guarantee of the whole feature.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: PASS — everything from prior tasks plus this one, and no existing moderator-flow test broke (moderators aren't in `source_check_agents`, so none of the new restrictive policies affect them).

- [ ] **Step 4: Commit**

```bash
git add src/lib/data/moderation-source-check.test.ts
git commit -m "$(cat <<'EOF'
test: prove the source-check agent is locked out of every other write

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The write-path CLI script

**Files:**

- Create: `scripts/submit-source-finding.mjs`

**Interfaces:**

- Consumes: `SOURCE_CHECK_AGENT_EMAIL`/`PASSWORD` (Task 2); the `moderation_queue` insert policy (Task 1)
- Produces: a CLI entry point invoked once per finding — consumed by Task 6's skill

Duplicates `submitSourceCheckFinding`'s insert shape rather than importing `moderation.ts`, since this project has no TS runner set up for plain Node scripts (same precedent as `provision-moderators.mjs` not importing app code). No automated test — verified by running it once against local Supabase, same as the provisioning script in Task 2.

- [ ] **Step 1: Write the script**

Create `scripts/submit-source-finding.mjs`:

```js
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

try {
  process.loadEnvFile();
} catch {
  // .env not present — required variables below will fail with a clear error instead.
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const agentEmail = process.env.SOURCE_CHECK_AGENT_EMAIL;
const agentPassword = process.env.SOURCE_CHECK_AGENT_PASSWORD;
const [findingPath] = process.argv.slice(2);

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables",
  );
}
if (!agentEmail || !agentPassword) {
  throw new Error(
    "Missing SOURCE_CHECK_AGENT_EMAIL or SOURCE_CHECK_AGENT_PASSWORD environment variables",
  );
}
if (!findingPath) {
  throw new Error(
    "Usage: node scripts/submit-source-finding.mjs <path-to-finding.json>",
  );
}

// Expected JSON shape (mirrors SourceCheckFinding in src/lib/data/moderation.ts):
// { "sourceId": string, "changeType": "new" | "update",
//   "listingId": string | null, "fields": ProposedListingFields,
//   "note": string }
const finding = JSON.parse(readFileSync(findingPath, "utf-8"));

const client = createClient(supabaseUrl, supabasePublishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { error: signInError } = await client.auth.signInWithPassword({
  email: agentEmail,
  password: agentPassword,
});
if (signInError) throw signInError;

// Mirrors submitSourceCheckFinding in src/lib/data/moderation.ts. Duplicated
// rather than imported — this project has no TS runner for plain Node
// scripts (see scripts/provision-moderators.mjs for the same precedent).
// Keep the two insert shapes in sync if either one changes.
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

console.log(
  `Filed a pending '${finding.changeType}' finding from source ${finding.sourceId}.`,
);
```

- [ ] **Step 2: Verify manually against local Supabase**

```bash
supabase status
```

Confirm the local stack is running (start it with `supabase start` if not).

Create a scratch finding file, e.g. `/tmp/finding.json`:

```json
{
  "sourceId": "manual-test",
  "changeType": "new",
  "listingId": null,
  "fields": {
    "type": "mic",
    "title": "Manual Test Mic",
    "host": null,
    "description": null,
    "venueId": "c0000000-0000-0000-0000-000000000001",
    "newVenue": null,
    "startTime": "20:00",
    "signUpMethod": null,
    "costToPerform": null,
    "ticketPrice": null,
    "ticketUrl": null,
    "recurrence": null,
    "oneOffDate": "2026-10-01"
  },
  "note": "Manual verification of the write-path script."
}
```

```bash
node scripts/submit-source-finding.mjs /tmp/finding.json
```

Expected: logs `Filed a pending 'new' finding from source manual-test.` with no errors.

Confirm the row landed correctly, then clean it up:

```bash
supabase db execute --sql "select id, origin, status, change_type from moderation_queue where origin = 'source_check' order by created_at desc limit 1;"
```

Expected: one row with `origin = source_check`, `status = pending`, `change_type = new`. Delete it afterward via the same command with a `delete from moderation_queue where origin = 'source_check';` (this was a manual scratch entry, not a fixture other tests depend on).

- [ ] **Step 3: Commit**

```bash
git add scripts/submit-source-finding.mjs
git commit -m "$(cat <<'EOF'
feat: add the write-path script for filing source-check findings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The `/check-sources` skill

**Files:**

- Create: `.claude/skills/check-sources/SKILL.md`

**Interfaces:**

- Consumes: `sources`/`venues`/`listings` tables (read, via Supabase MCP tools); `scripts/submit-source-finding.mjs` (Task 5)
- Produces: the `/check-sources [venue-name]` skill

This task is prose/instructions, not application code — verified by invoking the skill, not by an automated test.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/check-sources/SKILL.md`:

````markdown
---
name: check-sources
description: Manually check registered venue-website sources for listing changes and file findings into crowd-work's moderation queue. Use when asked to check sources, check a venue's website for updates, or run /check-sources.
---

Checks one or more registered venue-website sources against crowd-work's existing listings, and files anything new or changed as a pending `moderation_queue` entry for later review in `/admin`. Read [docs/superpowers/specs/2026-09-05-source-check-agent-design.md](../../../docs/superpowers/specs/2026-09-05-source-check-agent-design.md) for the full design if anything here is unclear.

## Invocation

`/check-sources` — check every registered source.
`/check-sources <venue-name>` — check only the source(s) for a venue whose name matches (case-insensitive substring match).

## Steps

1. **Read the sources to check.** Use the Supabase MCP tools to query the `sources` table, joined with the venue name (`sources.venue_id -> venues.name`). If a venue-name argument was given, filter to sources whose venue name contains it (case-insensitive); report and stop if nothing matches. This step is read-only — it doesn't need the scoped agent account.

2. **For each source, fetch its page.** Use `WebFetch` on `sources.url`. If the fetch fails, times out, or the content is clearly not renderable as plain content (e.g., a near-empty shell that's obviously JS-rendered), report that source as **skipped** and move on to the next one — one bad source must never abort the run.

3. **Read that venue's existing listings.** Query `listings` (plus `recurrence_rules` for recurring ones) filtered to the source's `venue_id`, via the Supabase MCP tools.

4. **Compare and reason.** Look at what the fetched page describes (day/time, title, host, sign-up method, cost, etc. for mics; day/time, ticket price/URL for shows) against the existing listings for that venue. Decide, for each distinct listing on the page:
   - **New** — nothing in the existing listings resembles it (different day/time or clearly a different show/mic entirely).
   - **Update** — it clearly corresponds to an existing listing, but one or more fields differ (time changed, host changed, sign-up method changed, etc.).
   - **No change** — matches an existing listing with nothing different. Don't file anything for these.

   Do not attempt to detect cancellations (a listing that seems to have disappeared from the page) — that's out of scope for this phase; a missing listing is not evidence of anything by itself and should be left alone.

5. **Show a summary before filing anything.** List what you found per source: how many new, how many updates, and a one-line description of each. This is a courtesy, not a gate — findings still get filed as pending regardless, but you should see them before they're written.

6. **File each finding.** For each new/update finding, write a JSON file matching this shape (see `scripts/submit-source-finding.mjs` for the authoritative shape):

   ```json
   {
     "sourceId": "<the source's id>",
     "changeType": "new" | "update",
     "listingId": "<existing listing id, or null for a new finding>",
     "fields": {
       "type": "mic" | "show",
       "title": "string",
       "host": "string or null",
       "description": "string or null",
       "venueId": "<the source's venue_id>",
       "newVenue": null,
       "startTime": "HH:MM",
       "signUpMethod": "string or null",
       "costToPerform": "string or null",
       "ticketPrice": "string or null",
       "ticketUrl": "string or null",
       "recurrence": { "frequency": "weekly" | "monthly", "dayOfWeek": 0-6, "weekOfMonth": -1 to 4 or null } or null,
       "oneOffDate": "YYYY-MM-DD or null"
     },
     "note": "One sentence: what changed and where you saw it, e.g. 'Start time now reads 8:30pm on the venue's Tuesday mic page.'"
   }
   ```

   `newVenue` is always `null` in this phase — sources only ever propose changes to listings at their own already-registered venue, never a new venue. Then run:

   ```bash
   node scripts/submit-source-finding.mjs <path-to-the-json-file>
   ```

7. **Report a final summary.** Sources checked, sources skipped (and why), findings filed, and a pointer to `/admin` to review them.
````

- [ ] **Step 2: Verify manually**

Register a real source row for a venue that already has a seeded listing (via Supabase Studio or a direct `insert into sources ...`), then invoke the skill:

```
/check-sources
```

Confirm: the skill reads the source, fetches the page, shows a summary, and (if it found a genuine difference) files a pending entry visible in `/admin` with origin "Automated source check". If the venue's real website hasn't changed since the seeded listing was written, expect "no change" for that listing — this is correct behavior, not a bug.

Also verify the venue-name filter:

```
/check-sources <part of the venue's name>
```

Confirm it checks only that source, and that a name matching nothing reports no matches without erroring.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/check-sources/SKILL.md
git commit -m "$(cat <<'EOF'
feat: add the /check-sources skill

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
