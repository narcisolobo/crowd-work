# Moderation Queue + Admin Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `moderation_queue` table and an authenticated admin review UI so a moderator can approve or reject proposed listing changes — enforcing that rejection always requires a second, different moderator to confirm — and fix the dangling public "Report a problem" link so it feeds that same queue.

**Architecture:** Extends the existing Astro (SSR) + Supabase project with no new services. Admin pages live under `/admin/*`, gated by Supabase Auth (email/password) via an Astro middleware that attaches a per-request, request-scoped Supabase client to `Astro.locals`. `moderation_queue` RLS policies — not just UI checks — enforce every state transition, including the rule that a moderator can never confirm their own proposed rejection. Since the sourcing agent and full submission form don't exist yet, seed data and a narrow public "report a problem" form are this phase's only two producers of queue entries.

**Tech Stack:** Astro (SSR), Supabase (Postgres, Auth, RLS), `@supabase/supabase-js` (no `@supabase/ssr` — a fresh, non-session-persisting client per request/action avoids relying on browser storage server-side and avoids mutating any shared client instance across concurrent requests), Vitest (integration tests against local Supabase), Playwright (e2e).

**Spec:** [docs/superpowers/specs/2026-09-03-moderation-queue-admin-review-design.md](../specs/2026-09-03-moderation-queue-admin-review-design.md)

## Global Constraints

- No Tailwind classes or other styling in any file this plan touches — admin pages and the report form are plain, unstyled semantic HTML. Styling is a later pass, the same way the public pages were built unstyled first.
- Every application write to `moderation_queue`, `listings`, `recurrence_rules`, or `occurrence_exceptions` goes through the `authenticated`-role RLS policies added in this plan — never bypassed with the service-role key. The service-role key is used only by the one-off moderator-provisioning script and by test setup/teardown.
- A moderator can never confirm or send back their own proposed rejection — this is enforced by the `moderation_queue` UPDATE policies themselves (`auth.uid() <> proposed_by`), not only hidden in the UI.
- `proposed_data` on a `moderation_queue` row is never overwritten after insert — it's the permanent record of what was originally proposed, independent of whatever a moderator edits before approving.
- This phase provisions exactly two Supabase Auth accounts, both owned by the site owner (per the approved spec) — no self-serve invite flow, no moderator-role table (any authenticated user is treated as a moderator).
- No `sources` table, trust levels, or auto-publish path this phase.

---

## File Structure

```
crowd-work/
├── scripts/
│   └── provision-moderators.mjs        # one-off: creates the 2 moderator accounts + a rejection_proposed seed row
├── src/
│   ├── env.d.ts                        # new: App.Locals typing (user, supabase)
│   ├── middleware.ts                   # new: session handling + /admin route gating
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── supabase.ts             # existing, unchanged
│   │   │   ├── server.ts               # new: fresh, non-persisting client factory
│   │   │   └── database.types.ts       # regenerated (adds moderation_queue)
│   │   └── data/
│   │       ├── listings.ts             # modified: add getVenues()
│   │       ├── moderation.ts           # new: queue reads, transitions, approve write-through
│   │       ├── moderation-test-helpers.ts   # new: test-only admin/moderator client helpers
│   │       ├── moderation-transitions.test.ts  # new
│   │       └── moderation-approve.test.ts      # new
│   └── pages/
│       ├── admin/
│       │   ├── login.astro             # new
│       │   ├── logout.astro            # new
│       │   ├── index.astro             # new: queue list
│       │   └── queue/
│       │       └── [id].astro          # new: detail/edit + approve/reject actions
│       └── listings/
│           └── [id]/
│               └── report.astro        # new: public correction report form
├── vitest.config.ts                    # modified: setupFiles
├── vitest.setup.ts                     # new: loads .env for tests
├── playwright.config.ts                # modified: loads .env
├── e2e/
│   └── admin-moderation.spec.ts        # new
└── supabase/
    ├── seed.sql                        # modified: sample moderation_queue rows
    └── migrations/
        ├── <timestamp>_moderation_queue.sql
        └── <timestamp>_moderator_write_policies.sql
```

---

### Task 1: Migration — `moderation_queue` schema and RLS

**Files:**

- Create: `supabase/migrations/<timestamp>_moderation_queue.sql`
- Modify (regenerate): `src/lib/supabase/database.types.ts`

**Interfaces:**

- Consumes: `listings(id)` from the foundation schema
- Produces: table `moderation_queue` with columns `id, listing_id, change_type, proposed_data, correction_note, origin, status, proposed_by, proposed_reason, confirmed_by, created_at`; the regenerated `Database` type consumed by every task from here on

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new moderation_queue
```

- [ ] **Step 2: Write the migration**

Open the generated file and write:

```sql
create type moderation_change_type as enum ('new', 'update', 'cancellation');
create type moderation_status as enum ('pending', 'rejection_proposed', 'approved', 'rejected');

create table moderation_queue (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references listings(id) on delete set null,
  change_type moderation_change_type not null,
  proposed_data jsonb,
  correction_note text,
  origin text not null,
  status moderation_status not null default 'pending',
  proposed_by uuid references auth.users(id),
  proposed_reason text,
  confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table moderation_queue enable row level security;

create policy "moderators can read the queue"
  on moderation_queue for select
  to authenticated
  using (true);

-- The public report form is the only anonymous writer. It may only create a
-- pending update/cancellation correction tied to an existing listing — never
-- a 'new' listing, and never with proposer/reviewer fields pre-filled.
create policy "anyone can submit a correction report"
  on moderation_queue for insert
  to anon
  with check (
    change_type in ('update', 'cancellation')
    and origin = 'report_form'
    and listing_id is not null
    and correction_note is not null
    and proposed_by is null
    and proposed_reason is null
    and confirmed_by is null
    and status = 'pending'
  );

-- Any authenticated moderator may approve a pending entry, or propose its
-- rejection (recording themselves as proposer with a required reason).
create policy "moderators can approve or propose rejection on a pending entry"
  on moderation_queue for update
  to authenticated
  using (status = 'pending')
  with check (
    (status = 'approved')
    or (status = 'rejection_proposed' and proposed_by = auth.uid() and proposed_reason is not null)
  );

-- Only a DIFFERENT moderator than the one who proposed the rejection may
-- confirm it or send it back to pending. This is the governance mechanism
-- the whole design exists to enforce, so it lives in the policy itself, not
-- just the UI.
create policy "a different moderator can confirm or return a proposed rejection"
  on moderation_queue for update
  to authenticated
  using (status = 'rejection_proposed' and auth.uid() <> proposed_by)
  with check (
    (status = 'rejected' and confirmed_by = auth.uid())
    or (status = 'pending')
  );
```

- [ ] **Step 3: Apply the migration locally and verify**

```bash
supabase db reset
```

Expected: all prior migrations plus `moderation_queue` apply with no errors.

- [ ] **Step 4: Regenerate TypeScript types**

```bash
supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

Expected: `database.types.ts` now includes `moderation_queue`, `moderation_change_type`, and `moderation_status`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "$(cat <<'EOF'
feat: add moderation_queue schema with governance RLS policies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration — authenticated write policies for `listings`, `recurrence_rules`, `occurrence_exceptions`

**Files:**

- Create: `supabase/migrations/<timestamp>_moderator_write_policies.sql`

**Interfaces:**

- Consumes: `listings`, `recurrence_rules`, `occurrence_exceptions` tables from the foundation schema (currently public-select-only)
- Produces: INSERT/UPDATE policies for the `authenticated` role on those three tables, required before any approve write-through in Task 8 can succeed

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new moderator_write_policies
```

- [ ] **Step 2: Write the migration**

```sql
create policy "moderators can insert listings"
  on listings for insert
  to authenticated
  with check (true);

create policy "moderators can update listings"
  on listings for update
  to authenticated
  using (true)
  with check (true);

create policy "moderators can insert recurrence rules"
  on recurrence_rules for insert
  to authenticated
  with check (true);

create policy "moderators can update recurrence rules"
  on recurrence_rules for update
  to authenticated
  using (true)
  with check (true);

create policy "moderators can insert occurrence exceptions"
  on occurrence_exceptions for insert
  to authenticated
  with check (true);
```

- [ ] **Step 3: Apply and verify**

```bash
supabase db reset
```

Expected: all migrations apply with no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "$(cat <<'EOF'
feat: allow authenticated moderators to write listings data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Seed sample moderation queue entries

**Files:**

- Modify: `supabase/seed.sql`

**Interfaces:**

- Consumes: `moderation_queue` schema from Task 1, existing seeded `venues`/`listings` rows from the foundation seed
- Produces: three `pending` queue entries (one per `change_type`) standing in for the sourcing agent/submission form, which don't exist yet

- [ ] **Step 1: Append sample entries to the seed file**

Add to `supabase/seed.sql`:

```sql

-- Moderation queue sample data, standing in for the sourcing agent and
-- submission form (neither exists yet — see the moderation-queue-admin-review
-- spec's Non-goals). All three change_type cases are represented so the
-- admin review UI has a real case of each to work through.
insert into moderation_queue (id, listing_id, change_type, proposed_data, origin, status) values
  ('e0000000-0000-0000-0000-000000000001', null, 'new', '{
    "type": "mic",
    "title": "Echo Park Wednesday Mic",
    "host": "Priya Chandrasekaran",
    "description": null,
    "venueId": "c0000000-0000-0000-0000-000000000001",
    "startTime": "19:00",
    "signUpMethod": "sign-up list at the door, 6:30pm",
    "costToPerform": "free",
    "ticketPrice": null,
    "ticketUrl": null,
    "recurrence": { "frequency": "weekly", "dayOfWeek": 3, "weekOfMonth": null },
    "oneOffDate": null
  }'::jsonb, 'seed', 'pending');

insert into moderation_queue (id, listing_id, change_type, proposed_data, origin, status) values
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'update', '{
    "type": "mic",
    "title": "Tuesday Night Mic",
    "host": "Jamie Rivera",
    "description": null,
    "venueId": "c0000000-0000-0000-0000-000000000001",
    "startTime": "20:30",
    "signUpMethod": "sign-up list at the door, 8pm",
    "costToPerform": "free",
    "ticketPrice": null,
    "ticketUrl": null,
    "recurrence": { "frequency": "weekly", "dayOfWeek": 2, "weekOfMonth": null },
    "oneOffDate": null
  }'::jsonb, 'seed', 'pending');

insert into moderation_queue (id, listing_id, change_type, proposed_data, correction_note, origin, status) values
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'cancellation', '{
    "originalDate": "2026-09-19"
  }'::jsonb, 'Venue emailed to say this date is cancelled due to a private event.', 'seed', 'pending');
```

- [ ] **Step 2: Apply and verify**

```bash
supabase db reset
```

Expected output includes `Seeding data supabase/seed.sql...` with no errors. Verify with:

```bash
curl "http://127.0.0.1:54521/rest/v1/moderation_queue?select=change_type,status" \
  -H "apikey: <local publishable key from supabase status>"
```

Expected: a JSON array with the three seeded entries, all `status: "pending"`.

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "$(cat <<'EOF'
chore: seed sample moderation queue entries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Provision the two moderator accounts

**Files:**

- Create: `scripts/provision-moderators.mjs`
- Modify: `.env.example` (document new variables), `.env` (local values — gitignored, not committed)

**Interfaces:**

- Consumes: `moderation_queue` schema from Task 1; `SUPABASE_SERVICE_ROLE_KEY` (already scaffolded, empty, in `.env.example`)
- Produces: two Supabase Auth accounts and one `rejection_proposed` queue entry (`proposed_by` set to moderator 1), used by Task 7/8's tests and Task 9/10's manual and e2e verification

This script writes real rows to whichever Supabase project `PUBLIC_SUPABASE_URL` points at (local by default). **Because `supabase db reset` wipes the entire local Postgres instance including `auth.users`, this script must be re-run after every `supabase db reset`.**

- [ ] **Step 1: Write the provisioning script**

Create `scripts/provision-moderators.mjs`:

```js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [email1, password1, email2, password2] = process.argv.slice(2);

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
  );
}
if (!email1 || !password1 || !email2 || !password2) {
  throw new Error(
    "Usage: node scripts/provision-moderators.mjs <email1> <password1> <email2> <password2>",
  );
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: user1, error: error1 } = await admin.auth.admin.createUser({
  email: email1,
  password: password1,
  email_confirm: true,
});
if (error1) throw error1;

const { data: user2, error: error2 } = await admin.auth.admin.createUser({
  email: email2,
  password: password2,
  email_confirm: true,
});
if (error2) throw error2;

const { error: queueError } = await admin.from("moderation_queue").insert({
  id: "e0000000-0000-0000-0000-000000000004",
  listing_id: "d0000000-0000-0000-0000-000000000002",
  change_type: "cancellation",
  proposed_data: { originalDate: "2026-09-24" },
  correction_note: "Host says the venue is closed for renovations this month.",
  origin: "seed",
  status: "rejection_proposed",
  proposed_by: user1.user.id,
  proposed_reason:
    "Venue confirmed by phone this is inaccurate — the mic is still running as scheduled.",
});
if (queueError) throw queueError;

console.log(`Provisioned moderator 1: ${email1} (${user1.user.id})`);
console.log(`Provisioned moderator 2: ${email2} (${user2.user.id})`);
console.log(
  "Seeded a rejection_proposed queue entry (proposed by moderator 1) for testing the confirm flow.",
);
```

- [ ] **Step 2: Document the new environment variables**

Append to `.env.example` (the `SUPABASE_SERVICE_ROLE_KEY` line already exists):

```
# moderator accounts (local dev/test only — see scripts/provision-moderators.mjs)
TEST_MODERATOR_1_EMAIL=
TEST_MODERATOR_1_PASSWORD=
TEST_MODERATOR_2_EMAIL=
TEST_MODERATOR_2_PASSWORD=
```

- [ ] **Step 3: Set local values and run the script**

In `.env` (gitignored), fill in `SUPABASE_SERVICE_ROLE_KEY` with the `SECRET_KEY` value from `supabase status` (or `SERVICE_ROLE_KEY` on older CLI versions), and choose two local-only email/password pairs for `TEST_MODERATOR_1_*`/`TEST_MODERATOR_2_*` — these are dev/test accounts under your own control, not real invitees.

Run, substituting the same values you just put in `.env`:

```bash
node scripts/provision-moderators.mjs mod1@crowdwork.test <password1> mod2@crowdwork.test <password2>
```

Expected: two "Provisioned moderator" lines and the "Seeded a rejection_proposed..." line, no errors.

- [ ] **Step 4: Verify**

```bash
curl "http://127.0.0.1:54521/rest/v1/moderation_queue?select=id,status,proposed_by&id=eq.e0000000-0000-0000-0000-000000000004" \
  -H "apikey: <local publishable key from supabase status>" \
  -H "Authorization: Bearer <local publishable key from supabase status>"
```

Expected: one row with `status: "rejection_proposed"` and a non-null `proposed_by`.

- [ ] **Step 5: Commit**

```bash
git add scripts/provision-moderators.mjs .env.example
git commit -m "$(cat <<'EOF'
chore: add moderator account provisioning script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(`.env` is gitignored and never committed.)

---

### Task 5: Moderator authentication — request-scoped client, middleware, login/logout

**Files:**

- Create: `src/lib/supabase/server.ts`, `src/middleware.ts`, `src/env.d.ts`, `src/pages/admin/login.astro`, `src/pages/admin/logout.astro`

**Interfaces:**

- Consumes: `Database` type from Task 1
- Produces: `createServerSupabaseClient(): SupabaseClient<Database>` from `src/lib/supabase/server.ts`; `Astro.locals.user: User | null` and `Astro.locals.supabase: SupabaseClient<Database> | null`, populated by the middleware for every `/admin/*` request and consumed by every admin page in Tasks 9-10

A single module-level Supabase client (like the existing `src/lib/supabase/supabase.ts` singleton, used for anonymous public reads) must never have `signInWithPassword`/`setSession` called on it — that would mutate shared state read by every other concurrent request on the same server instance. Every authenticated operation in this task uses a freshly-constructed, non-session-persisting client instead.

- [ ] **Step 1: Write the request-scoped client factory**

Create `src/lib/supabase/server.ts`:

```ts
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export function createServerSupabaseClient() {
  const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      'Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables',
    );
  }

  return createClient<Database>(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

- [ ] **Step 2: Type `Astro.locals`**

Create `src/env.d.ts`:

```ts
/// <reference types="astro/client" />

import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from './lib/supabase/database.types';

declare global {
  namespace App {
    interface Locals {
      user: User | null;
      supabase: SupabaseClient<Database> | null;
    }
  }
}
```

- [ ] **Step 3: Write the middleware**

Create `src/middleware.ts`:

```ts
import { defineMiddleware } from 'astro:middleware';
import { createServerSupabaseClient } from './lib/supabase/server';

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = null;
  context.locals.supabase = null;

  if (!context.url.pathname.startsWith('/admin')) {
    return next();
  }

  const accessToken = context.cookies.get('sb-access-token')?.value;
  const refreshToken = context.cookies.get('sb-refresh-token')?.value;

  if (accessToken && refreshToken) {
    const supabase = createServerSupabaseClient();
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (!error && data.user) {
      context.locals.user = data.user;
      context.locals.supabase = supabase;
    } else {
      context.cookies.delete('sb-access-token', { path: '/' });
      context.cookies.delete('sb-refresh-token', { path: '/' });
    }
  }

  if (context.url.pathname !== '/admin/login' && !context.locals.user) {
    return context.redirect('/admin/login');
  }

  return next();
});
```

Note: this phase does not implement token refresh-on-expiry. A session lasts until the access token expires (Supabase's default is about an hour), after which the moderator is redirected back to `/admin/login`. Acceptable for a two-person internal tool; revisit if it's annoying in practice.

- [ ] **Step 4: Write the login page**

Create `src/pages/admin/login.astro`:

```astro
---
import { createServerSupabaseClient } from '../../lib/supabase/server';

let errorMessage: string | null = null;

if (Astro.request.method === 'POST') {
  const formData = await Astro.request.formData();
  const email = formData.get('email')?.toString();
  const password = formData.get('password')?.toString();

  if (!email || !password) {
    errorMessage = 'Email and password are required.';
  } else {
    const supabase = createServerSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      errorMessage = 'Incorrect email or password.';
    } else {
      Astro.cookies.set('sb-access-token', data.session.access_token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: import.meta.env.PROD,
      });
      Astro.cookies.set('sb-refresh-token', data.session.refresh_token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: import.meta.env.PROD,
      });
      return Astro.redirect('/admin');
    }
  }
}
---

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Moderator login — Crowd Work</title>
  </head>
  <body>
    <h1>Moderator login</h1>
    {errorMessage && <p role="alert">{errorMessage}</p>}
    <form method="post">
      <label>
        Email
        <input type="email" name="email" required />
      </label>
      <label>
        Password
        <input type="password" name="password" required />
      </label>
      <button type="submit">Log in</button>
    </form>
  </body>
</html>
```

- [ ] **Step 5: Write the logout page**

Create `src/pages/admin/logout.astro`:

```astro
---
Astro.cookies.delete('sb-access-token', { path: '/' });
Astro.cookies.delete('sb-refresh-token', { path: '/' });
return Astro.redirect('/admin/login');
---
```

- [ ] **Step 6: Verify manually**

Run: `astro dev --background`

- Visit `/admin` — expect a redirect to `/admin/login`.
- Log in with one of the two accounts from Task 4 — expect a redirect to `/admin`, which currently 404s (its page doesn't exist until Task 9). A 404 here — as opposed to a bounce back to `/admin/login` — confirms login succeeded and the middleware let the authenticated request through.
- Visit `/admin/logout`, then `/admin` again — expect a redirect back to `/admin/login`, confirming the cookies were cleared.

Run: `astro dev stop`

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase/server.ts src/middleware.ts src/env.d.ts src/pages/admin/login.astro src/pages/admin/logout.astro
git commit -m "$(cat <<'EOF'
feat: add moderator authentication and admin route gating

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Data access layer — moderation queue reads and venues

**Files:**

- Create: `src/lib/data/moderation.ts`
- Modify: `src/lib/data/listings.ts` (add `getVenues`)

**Interfaces:**

- Consumes: `Database` type from Task 1
- Produces:
  - `getReviewableQueueEntries(client): Promise<QueueEntry[]>`
  - `getQueueEntryById(client, id): Promise<QueueEntry | null>`
  - Types `QueueEntry`, `QueueStatus`, `QueueChangeType`, `ProposedListingFields`, `ProposedCancellation`
  - `getVenues(): Promise<Venue[]>` and type `Venue` from `listings.ts`

  All consumed by the admin pages in Tasks 9-10 and the transition/approve functions in Tasks 7-8.

- [ ] **Step 1: Add `getVenues` to the listings data layer**

In `src/lib/data/listings.ts`, add:

```ts
export interface Venue {
  id: string;
  name: string;
}

export async function getVenues(): Promise<Venue[]> {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name')
    .order('name');
  if (error) throw new Error(`Failed to load venues: ${error.message}`);
  return data ?? [];
}
```

- [ ] **Step 2: Write the moderation queue read functions**

Create `src/lib/data/moderation.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';

export type QueueStatus = 'pending' | 'rejection_proposed' | 'approved' | 'rejected';
export type QueueChangeType = 'new' | 'update' | 'cancellation';

export interface ProposedListingFields {
  type: 'mic' | 'show';
  title: string;
  host: string | null;
  description: string | null;
  venueId: string;
  startTime: string;
  signUpMethod: string | null;
  costToPerform: string | null;
  ticketPrice: string | null;
  ticketUrl: string | null;
  recurrence: {
    frequency: 'weekly' | 'monthly';
    dayOfWeek: number;
    weekOfMonth: number | null;
  } | null;
  oneOffDate: string | null;
}

export interface ProposedCancellation {
  originalDate: string;
}

export interface QueueEntry {
  id: string;
  listingId: string | null;
  changeType: QueueChangeType;
  proposedData: ProposedListingFields | ProposedCancellation | null;
  correctionNote: string | null;
  origin: string;
  status: QueueStatus;
  proposedBy: string | null;
  proposedReason: string | null;
  confirmedBy: string | null;
  createdAt: string;
}

export const QUEUE_ENTRY_SELECT =
  'id, listing_id, change_type, proposed_data, correction_note, origin, status, proposed_by, proposed_reason, confirmed_by, created_at';

export function mapQueueEntryRow(row: any): QueueEntry {
  return {
    id: row.id,
    listingId: row.listing_id,
    changeType: row.change_type,
    proposedData: row.proposed_data,
    correctionNote: row.correction_note,
    origin: row.origin,
    status: row.status,
    proposedBy: row.proposed_by,
    proposedReason: row.proposed_reason,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
  };
}

export async function getReviewableQueueEntries(
  client: SupabaseClient<Database>,
): Promise<QueueEntry[]> {
  const { data, error } = await client
    .from('moderation_queue')
    .select(QUEUE_ENTRY_SELECT)
    .in('status', ['pending', 'rejection_proposed'])
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to load moderation queue: ${error.message}`);

  return (data ?? []).map(mapQueueEntryRow);
}

export async function getQueueEntryById(
  client: SupabaseClient<Database>,
  id: string,
): Promise<QueueEntry | null> {
  const { data, error } = await client
    .from('moderation_queue')
    .select(QUEUE_ENTRY_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (error.code === '22P02') return null;
    throw new Error(`Failed to load queue entry ${id}: ${error.message}`);
  }
  if (!data) return null;

  return mapQueueEntryRow(data);
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm run check`
Expected: no type errors in `src/lib/data/moderation.ts` or `src/lib/data/listings.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/listings.ts
git commit -m "$(cat <<'EOF'
feat: add moderation queue read layer and venue lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Data access layer — rejection state machine, with tests proving the self-block

**Files:**

- Create: `src/lib/data/moderation-test-helpers.ts`
- Create: `src/lib/data/moderation-transitions.test.ts`
- Modify: `src/lib/data/moderation.ts` (add `proposeRejection`, `confirmRejection`, `sendBackToPending`)
- Modify: `vitest.config.ts`, create `vitest.setup.ts`

**Interfaces:**

- Consumes: `QueueEntry`, `mapQueueEntryRow`, `QUEUE_ENTRY_SELECT` from Task 6; the two moderator accounts from Task 4
- Produces:
  - `proposeRejection(client, entryId, reason): Promise<QueueEntry>`
  - `confirmRejection(client, entryId): Promise<QueueEntry>`
  - `sendBackToPending(client, entryId): Promise<QueueEntry>`
  - Test helpers `createAdminClient()`, `signInTestModerator(which: 1 | 2)` from `moderation-test-helpers.ts`, reused by Task 8's tests

These tests run against the real local Supabase instance (`supabase start` must be running) — the self-block is an RLS policy, not application code, so it can only be verified by actually hitting Postgres as two different authenticated users.

- [ ] **Step 1: Load `.env` for Vitest**

Create `vitest.setup.ts`:

```ts
try {
  process.loadEnvFile();
} catch {
  // .env not present (e.g. CI) — tests that need its variables will fail
  // with a clear "missing required environment variable" error instead.
}
```

Modify `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});

export default config;
```

- [ ] **Step 2: Write the test helpers**

Create `src/lib/data/moderation-test-helpers.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/database.types';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requiredEnv('PUBLIC_SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function signInTestModerator(
  which: 1 | 2,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(
    requiredEnv('PUBLIC_SUPABASE_URL'),
    requiredEnv('PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error } = await client.auth.signInWithPassword({
    email: requiredEnv(`TEST_MODERATOR_${which}_EMAIL`),
    password: requiredEnv(`TEST_MODERATOR_${which}_PASSWORD`),
  });
  if (error) throw new Error(`Failed to sign in test moderator ${which}: ${error.message}`);

  return client;
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/data/moderation-transitions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { proposeRejection, confirmRejection, sendBackToPending } from './moderation';
import { createAdminClient, signInTestModerator } from './moderation-test-helpers';

let entryId: string;

beforeEach(async () => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('moderation_queue')
    .insert({
      change_type: 'cancellation',
      listing_id: 'd0000000-0000-0000-0000-000000000001',
      proposed_data: { originalDate: '2026-09-15' },
      correction_note: 'test entry',
      origin: 'seed',
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw error;
  entryId = data.id;
});

afterEach(async () => {
  const admin = createAdminClient();
  await admin.from('moderation_queue').delete().eq('id', entryId);
});

describe('rejection state machine', () => {
  it('lets a moderator propose rejection on a pending entry', async () => {
    const moderator1 = await signInTestModerator(1);
    const result = await proposeRejection(moderator1, entryId, 'Duplicate of another entry');
    expect(result.status).toBe('rejection_proposed');
    expect(result.proposedReason).toBe('Duplicate of another entry');
  });

  it('blocks the proposing moderator from confirming their own rejection', async () => {
    const moderator1 = await signInTestModerator(1);
    await proposeRejection(moderator1, entryId, 'Duplicate of another entry');

    await expect(confirmRejection(moderator1, entryId)).rejects.toThrow();
  });

  it('lets a different moderator confirm the rejection', async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    await proposeRejection(moderator1, entryId, 'Duplicate of another entry');

    const result = await confirmRejection(moderator2, entryId);
    expect(result.status).toBe('rejected');
  });

  it('lets a different moderator send the entry back to pending', async () => {
    const moderator1 = await signInTestModerator(1);
    const moderator2 = await signInTestModerator(2);
    await proposeRejection(moderator1, entryId, 'Duplicate of another entry');

    const result = await sendBackToPending(moderator2, entryId);
    expect(result.status).toBe('pending');
    expect(result.proposedBy).toBeNull();
    expect(result.proposedReason).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Ensure `supabase start` is running and Task 4's provisioning script has been run against it. Run: `pnpm test`
Expected: FAIL — `proposeRejection` etc. are not exported from `./moderation` yet.

- [ ] **Step 5: Implement the transition functions**

Add to `src/lib/data/moderation.ts`:

```ts
export async function proposeRejection(
  client: SupabaseClient<Database>,
  entryId: string,
  reason: string,
): Promise<QueueEntry> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await client
    .from('moderation_queue')
    .update({ status: 'rejection_proposed', proposed_by: user.id, proposed_reason: reason })
    .eq('id', entryId)
    .eq('status', 'pending')
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error) throw new Error(`Failed to propose rejection: ${error.message}`);
  if (!data) throw new Error('Could not propose rejection — the entry is no longer pending.');

  return mapQueueEntryRow(data);
}

export async function confirmRejection(
  client: SupabaseClient<Database>,
  entryId: string,
): Promise<QueueEntry> {
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await client
    .from('moderation_queue')
    .update({ status: 'rejected', confirmed_by: user.id })
    .eq('id', entryId)
    .eq('status', 'rejection_proposed')
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error) throw new Error(`Failed to confirm rejection: ${error.message}`);
  if (!data)
    throw new Error(
      'Rejection was not confirmed — the entry may not be in rejection_proposed, or you proposed this rejection yourself and cannot confirm it.',
    );

  return mapQueueEntryRow(data);
}

export async function sendBackToPending(
  client: SupabaseClient<Database>,
  entryId: string,
): Promise<QueueEntry> {
  const { data, error } = await client
    .from('moderation_queue')
    .update({ status: 'pending', proposed_by: null, proposed_reason: null })
    .eq('id', entryId)
    .eq('status', 'rejection_proposed')
    .select(QUEUE_ENTRY_SELECT)
    .maybeSingle();

  if (error) throw new Error(`Failed to return entry to pending: ${error.message}`);
  if (!data)
    throw new Error(
      'Could not return this entry to pending — it may not be in rejection_proposed, or you proposed this rejection yourself.',
    );

  return mapQueueEntryRow(data);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all 4 tests in `moderation-transitions.test.ts` green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-test-helpers.ts src/lib/data/moderation-transitions.test.ts vitest.config.ts vitest.setup.ts
git commit -m "$(cat <<'EOF'
feat: add moderation rejection state machine with RLS-enforced tests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Data access layer — approve write-through, with tests proving edited values are used

**Files:**

- Modify: `src/lib/data/moderation.ts` (add `approveNewListing`, `approveListingUpdate`, `approveCancellation`)
- Create: `src/lib/data/moderation-approve.test.ts`

**Interfaces:**

- Consumes: `ProposedListingFields`, `QueueEntry` types and `signInTestModerator`/`createAdminClient` helpers from Tasks 6-7; authenticated write policies from Task 2
- Produces: `approveNewListing(client, entryId, fields): Promise<void>`, `approveListingUpdate(client, entryId, listingId, fields): Promise<void>`, `approveCancellation(client, entryId, listingId, originalDate, note): Promise<void>` — consumed by the admin edit page in Task 9

- [ ] **Step 1: Write the failing tests**

Create `src/lib/data/moderation-approve.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  approveNewListing,
  approveListingUpdate,
  approveCancellation,
  type ProposedListingFields,
} from './moderation';
import { createAdminClient, signInTestModerator } from './moderation-test-helpers';

const EXISTING_VENUE_ID = 'c0000000-0000-0000-0000-000000000001';

let insertedListingIds: string[] = [];
let insertedEntryIds: string[] = [];

afterEach(async () => {
  const admin = createAdminClient();
  if (insertedEntryIds.length > 0) {
    await admin.from('moderation_queue').delete().in('id', insertedEntryIds);
  }
  if (insertedListingIds.length > 0) {
    await admin.from('listings').delete().in('id', insertedListingIds);
  }
  insertedListingIds = [];
  insertedEntryIds = [];
});

async function createPendingEntry(overrides: Record<string, unknown>) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('moderation_queue')
    .insert({ origin: 'seed', status: 'pending', ...overrides })
    .select('id')
    .single();
  if (error) throw error;
  insertedEntryIds.push(data.id);
  return data.id as string;
}

describe('approveNewListing', () => {
  it('inserts a listing and recurrence rule using the moderator-edited values, not the original proposal', async () => {
    const entryId = await createPendingEntry({
      change_type: 'new',
      listing_id: null,
      proposed_data: {
        type: 'mic',
        title: 'Original Proposed Title',
        host: null,
        description: null,
        venueId: EXISTING_VENUE_ID,
        startTime: '19:00',
        signUpMethod: null,
        costToPerform: null,
        ticketPrice: null,
        ticketUrl: null,
        recurrence: { frequency: 'weekly', dayOfWeek: 1, weekOfMonth: null },
        oneOffDate: null,
      },
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: 'mic',
      title: 'Moderator-Corrected Title',
      host: 'Corrected Host',
      description: null,
      venueId: EXISTING_VENUE_ID,
      startTime: '19:30',
      signUpMethod: 'text to sign up',
      costToPerform: 'free',
      ticketPrice: null,
      ticketUrl: null,
      recurrence: { frequency: 'weekly', dayOfWeek: 1, weekOfMonth: null },
      oneOffDate: null,
    };

    await approveNewListing(moderator1, entryId, edited);

    const admin = createAdminClient();
    const { data: listing } = await admin
      .from('listings')
      .select('id, title, host, start_time')
      .eq('title', 'Moderator-Corrected Title')
      .single();
    expect(listing).not.toBeNull();
    insertedListingIds.push(listing!.id);
    expect(listing!.host).toBe('Corrected Host');
    expect(listing!.start_time).toBe('19:30:00');

    const { data: rule } = await admin
      .from('recurrence_rules')
      .select('day_of_week')
      .eq('listing_id', listing!.id)
      .single();
    expect(rule!.day_of_week).toBe(1);

    const { data: entry } = await admin
      .from('moderation_queue')
      .select('status, listing_id')
      .eq('id', entryId)
      .single();
    expect(entry!.status).toBe('approved');
    expect(entry!.listing_id).toBe(listing!.id);
  });
});

describe('approveListingUpdate', () => {
  it('updates the existing listing with the moderator-edited values', async () => {
    const admin = createAdminClient();
    const { data: original, error: createError } = await admin
      .from('listings')
      .insert({
        type: 'mic',
        title: 'Temp Listing For Update Test',
        venue_id: EXISTING_VENUE_ID,
        start_time: '18:00',
        status: 'published',
      })
      .select('id')
      .single();
    if (createError) throw createError;
    insertedListingIds.push(original.id);

    const entryId = await createPendingEntry({
      change_type: 'update',
      listing_id: original.id,
      proposed_data: null,
      correction_note: 'Start time changed',
    });

    const moderator1 = await signInTestModerator(1);
    const edited: ProposedListingFields = {
      type: 'mic',
      title: 'Temp Listing For Update Test',
      host: null,
      description: null,
      venueId: EXISTING_VENUE_ID,
      startTime: '20:30',
      signUpMethod: null,
      costToPerform: null,
      ticketPrice: null,
      ticketUrl: null,
      recurrence: null,
      oneOffDate: '2026-10-01',
    };

    await approveListingUpdate(moderator1, entryId, original.id, edited);

    const { data: updated } = await admin
      .from('listings')
      .select('start_time')
      .eq('id', original.id)
      .single();
    expect(updated!.start_time).toBe('20:30:00');
  });
});

describe('approveCancellation', () => {
  it('records an occurrence exception', async () => {
    const admin = createAdminClient();
    const { data: listing, error: createError } = await admin
      .from('listings')
      .insert({
        type: 'mic',
        title: 'Temp Listing For Cancellation Test',
        venue_id: EXISTING_VENUE_ID,
        start_time: '19:00',
        one_off_date: '2026-09-15',
        status: 'published',
      })
      .select('id')
      .single();
    if (createError) throw createError;
    insertedListingIds.push(listing.id);

    const entryId = await createPendingEntry({
      change_type: 'cancellation',
      listing_id: listing.id,
      proposed_data: { originalDate: '2026-09-15' },
      correction_note: 'Venue closed that night',
    });

    const moderator1 = await signInTestModerator(1);
    await approveCancellation(
      moderator1,
      entryId,
      listing.id,
      '2026-09-15',
      'Venue closed that night',
    );

    const { data: exception } = await admin
      .from('occurrence_exceptions')
      .select('type, original_date')
      .eq('listing_id', listing.id)
      .eq('original_date', '2026-09-15')
      .single();
    expect(exception!.type).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `approveNewListing` etc. are not exported yet.

- [ ] **Step 3: Implement the approve functions**

Add to `src/lib/data/moderation.ts`:

```ts
export async function approveNewListing(
  client: SupabaseClient<Database>,
  entryId: string,
  fields: ProposedListingFields,
): Promise<void> {
  const { data: listing, error: listingError } = await client
    .from('listings')
    .insert({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: fields.venueId,
      start_time: fields.startTime,
      one_off_date: fields.oneOffDate,
      sign_up_method: fields.signUpMethod,
      cost_to_perform: fields.costToPerform,
      ticket_price: fields.ticketPrice,
      ticket_url: fields.ticketUrl,
      status: 'published',
    })
    .select('id')
    .single();

  if (listingError) throw new Error(`Failed to create listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client.from('recurrence_rules').insert({
      listing_id: listing.id,
      frequency: fields.recurrence.frequency,
      day_of_week: fields.recurrence.dayOfWeek,
      week_of_month: fields.recurrence.weekOfMonth,
    });
    if (recurrenceError)
      throw new Error(`Failed to create recurrence rule: ${recurrenceError.message}`);
  }

  await markApproved(client, entryId, listing.id);
}

export async function approveListingUpdate(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  fields: ProposedListingFields,
): Promise<void> {
  const { error: listingError } = await client
    .from('listings')
    .update({
      type: fields.type,
      title: fields.title,
      host: fields.host,
      description: fields.description,
      venue_id: fields.venueId,
      start_time: fields.startTime,
      one_off_date: fields.oneOffDate,
      sign_up_method: fields.signUpMethod,
      cost_to_perform: fields.costToPerform,
      ticket_price: fields.ticketPrice,
      ticket_url: fields.ticketUrl,
    })
    .eq('id', listingId);

  if (listingError) throw new Error(`Failed to update listing: ${listingError.message}`);

  if (fields.recurrence) {
    const { error: recurrenceError } = await client.from('recurrence_rules').upsert(
      {
        listing_id: listingId,
        frequency: fields.recurrence.frequency,
        day_of_week: fields.recurrence.dayOfWeek,
        week_of_month: fields.recurrence.weekOfMonth,
      },
      { onConflict: 'listing_id' },
    );
    if (recurrenceError)
      throw new Error(`Failed to update recurrence rule: ${recurrenceError.message}`);
  }

  await markApproved(client, entryId, listingId);
}

export async function approveCancellation(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
  originalDate: string,
  note: string | null,
): Promise<void> {
  const { error: exceptionError } = await client.from('occurrence_exceptions').insert({
    listing_id: listingId,
    original_date: originalDate,
    type: 'cancelled',
    note,
  });

  if (exceptionError)
    throw new Error(`Failed to record cancellation: ${exceptionError.message}`);

  await markApproved(client, entryId, listingId);
}

async function markApproved(
  client: SupabaseClient<Database>,
  entryId: string,
  listingId: string,
): Promise<void> {
  const { data, error } = await client
    .from('moderation_queue')
    .update({ status: 'approved', listing_id: listingId })
    .eq('id', entryId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to mark queue entry approved: ${error.message}`);
  if (!data) throw new Error('Could not mark this entry approved — it is no longer pending.');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all tests across both moderation test files green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/moderation.ts src/lib/data/moderation-approve.test.ts
git commit -m "$(cat <<'EOF'
feat: add moderation approve write-through for new/update/cancellation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Admin queue list and detail/edit pages

**Files:**

- Create: `src/pages/admin/index.astro`, `src/pages/admin/queue/[id].astro`

**Interfaces:**

- Consumes: everything from Tasks 6-8 (`getReviewableQueueEntries`, `getQueueEntryById`, `approveNewListing`, `approveListingUpdate`, `approveCancellation`, `proposeRejection`, `confirmRejection`, `sendBackToPending`, `getVenues`, `getListingById`); `Astro.locals.user`/`Astro.locals.supabase` from Task 5
- Produces: the `/admin` and `/admin/queue/[id]` routes

- [ ] **Step 1: Write the queue list page**

Create `src/pages/admin/index.astro`:

```astro
---
import { getReviewableQueueEntries } from '../../lib/data/moderation';

const supabase = Astro.locals.supabase!;
const entries = await getReviewableQueueEntries(supabase);
---

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Moderation queue — Crowd Work</title>
  </head>
  <body>
    <div>
      <span>Logged in as {Astro.locals.user!.email}</span>
      <a href="/admin/logout">Log out</a>
    </div>
    <h1>Moderation queue</h1>
    {
      entries.length === 0 ? (
        <p>Nothing to review right now.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li>
              <a href={`/admin/queue/${entry.id}`}>
                {entry.changeType} — {entry.origin} — {entry.status}
              </a>
            </li>
          ))}
        </ul>
      )
    }
  </body>
</html>
```

- [ ] **Step 2: Write the detail/edit page**

Create `src/pages/admin/queue/[id].astro`:

```astro
---
import {
  getQueueEntryById,
  approveNewListing,
  approveListingUpdate,
  approveCancellation,
  proposeRejection,
  confirmRejection,
  sendBackToPending,
  type ProposedListingFields,
  type ProposedCancellation,
} from '../../../lib/data/moderation';
import { getListingById, getVenues } from '../../../lib/data/listings';

const { id } = Astro.params;
const supabase = Astro.locals.supabase!;
const user = Astro.locals.user!;

if (!id) {
  return Astro.redirect('/admin');
}

let entry = await getQueueEntryById(supabase, id);

if (!entry) {
  return Astro.redirect('/admin');
}

const venues = await getVenues();
let errorMessage: string | null = null;

if (Astro.request.method === 'POST') {
  const formData = await Astro.request.formData();
  const action = formData.get('action')?.toString();

  try {
    if (action === 'approve') {
      const frequency = formData.get('frequency')?.toString();
      const fields: ProposedListingFields = {
        type: formData.get('type')?.toString() === 'show' ? 'show' : 'mic',
        title: formData.get('title')?.toString() ?? '',
        host: formData.get('host')?.toString() || null,
        description: formData.get('description')?.toString() || null,
        venueId: formData.get('venueId')?.toString() ?? '',
        startTime: formData.get('startTime')?.toString() ?? '',
        signUpMethod: formData.get('signUpMethod')?.toString() || null,
        costToPerform: formData.get('costToPerform')?.toString() || null,
        ticketPrice: formData.get('ticketPrice')?.toString() || null,
        ticketUrl: formData.get('ticketUrl')?.toString() || null,
        recurrence:
          frequency === 'weekly' || frequency === 'monthly'
            ? {
                frequency,
                dayOfWeek: Number(formData.get('dayOfWeek')),
                weekOfMonth: formData.get('weekOfMonth')
                  ? Number(formData.get('weekOfMonth'))
                  : null,
              }
            : null,
        oneOffDate: formData.get('oneOffDate')?.toString() || null,
      };

      if (entry.changeType === 'new') {
        await approveNewListing(supabase, entry.id, fields);
      } else if (entry.changeType === 'update') {
        await approveListingUpdate(supabase, entry.id, entry.listingId!, fields);
      }

      return Astro.redirect('/admin');
    }

    if (action === 'approve_cancellation') {
      const originalDate = formData.get('originalDate')?.toString() ?? '';
      const note = formData.get('note')?.toString() || null;
      await approveCancellation(supabase, entry.id, entry.listingId!, originalDate, note);
      return Astro.redirect('/admin');
    }

    if (action === 'propose_reject') {
      const reason = formData.get('reason')?.toString();
      if (!reason) {
        errorMessage = 'A reason is required to propose rejection.';
      } else {
        await proposeRejection(supabase, entry.id, reason);
        return Astro.redirect('/admin');
      }
    }

    if (action === 'confirm_reject') {
      await confirmRejection(supabase, entry.id);
      return Astro.redirect('/admin');
    }

    if (action === 'send_back') {
      await sendBackToPending(supabase, entry.id);
      return Astro.redirect('/admin');
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
    entry = (await getQueueEntryById(supabase, id))!;
  }
}

// Pre-fill the edit form from proposed_data when there is a structured
// proposal (new listings, and updates simulating a future sourcing-agent
// proposal). A report-form 'update' has no proposed_data — pre-fill from
// the listing's current values instead, since the moderator is translating
// free text into field edits, not reviewing a structured diff.
let prefill: ProposedListingFields | null = null;
if (entry.changeType === 'new') {
  prefill = entry.proposedData as ProposedListingFields;
} else if (entry.changeType === 'update') {
  if (entry.proposedData) {
    prefill = entry.proposedData as ProposedListingFields;
  } else {
    const current = await getListingById(entry.listingId!);
    if (current) {
      prefill = {
        type: current.type,
        title: current.title,
        host: current.host,
        description: current.description,
        venueId: current.venue.id,
        startTime: current.startTime,
        signUpMethod: current.signUpMethod,
        costToPerform: current.costToPerform,
        ticketPrice: current.ticketPrice,
        ticketUrl: current.ticketUrl,
        recurrence: current.recurrenceRule,
        oneOffDate: current.oneOffDate,
      };
    }
  }
}
const proposedCancellation =
  entry.changeType === 'cancellation' ? (entry.proposedData as ProposedCancellation) : null;
const isOwnProposal = entry.proposedBy === user.id;
---

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Review entry — Crowd Work admin</title>
  </head>
  <body>
    <a href="/admin">Back to queue</a>
    <h1>{entry.changeType} — {entry.origin}</h1>
    <p>Status: {entry.status}</p>
    {errorMessage && <p role="alert">{errorMessage}</p>}
    {entry.correctionNote && <p>Reporter's note: {entry.correctionNote}</p>}

    {
      entry.changeType === 'cancellation' ? (
        <form method="post">
          <input type="hidden" name="action" value="approve_cancellation" />
          <label>
            Date being cancelled
            <input
              type="date"
              name="originalDate"
              value={proposedCancellation?.originalDate}
              required
            />
          </label>
          <label>
            Note
            <textarea name="note">{entry.correctionNote ?? ''}</textarea>
          </label>
          <button type="submit" disabled={entry.status !== 'pending'}>
            Approve cancellation
          </button>
        </form>
      ) : (
        <form method="post">
          <input type="hidden" name="action" value="approve" />
          <label>
            Type
            <select name="type">
              <option value="mic" selected={prefill?.type !== 'show'}>
                Mic
              </option>
              <option value="show" selected={prefill?.type === 'show'}>
                Show
              </option>
            </select>
          </label>
          <label>
            Title
            <input type="text" name="title" value={prefill?.title ?? ''} required />
          </label>
          <label>
            Host
            <input type="text" name="host" value={prefill?.host ?? ''} />
          </label>
          <label>
            Description
            <textarea name="description">{prefill?.description ?? ''}</textarea>
          </label>
          <label>
            Venue
            <select name="venueId" required>
              {venues.map((venue) => (
                <option value={venue.id} selected={venue.id === prefill?.venueId}>
                  {venue.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start time
            <input type="time" name="startTime" value={prefill?.startTime ?? ''} required />
          </label>
          <label>
            Sign-up method
            <input type="text" name="signUpMethod" value={prefill?.signUpMethod ?? ''} />
          </label>
          <label>
            Cost to perform
            <input type="text" name="costToPerform" value={prefill?.costToPerform ?? ''} />
          </label>
          <label>
            Ticket price
            <input type="text" name="ticketPrice" value={prefill?.ticketPrice ?? ''} />
          </label>
          <label>
            Ticket URL
            <input type="text" name="ticketUrl" value={prefill?.ticketUrl ?? ''} />
          </label>
          <fieldset>
            <legend>Recurrence</legend>
            <label>
              Frequency
              <select name="frequency">
                <option value="" selected={!prefill?.recurrence}>
                  One-time
                </option>
                <option value="weekly" selected={prefill?.recurrence?.frequency === 'weekly'}>
                  Weekly
                </option>
                <option value="monthly" selected={prefill?.recurrence?.frequency === 'monthly'}>
                  Monthly
                </option>
              </select>
            </label>
            <label>
              Day of week (0=Sunday..6=Saturday)
              <input
                type="number"
                name="dayOfWeek"
                min="0"
                max="6"
                value={prefill?.recurrence?.dayOfWeek}
              />
            </label>
            <label>
              Week of month (1-4, or -1 for last)
              <input
                type="number"
                name="weekOfMonth"
                min="-1"
                max="4"
                value={prefill?.recurrence?.weekOfMonth ?? ''}
              />
            </label>
            <label>
              One-off date (if not recurring)
              <input type="date" name="oneOffDate" value={prefill?.oneOffDate ?? ''} />
            </label>
          </fieldset>
          <button type="submit" disabled={entry.status !== 'pending'}>
            Approve
          </button>
        </form>
      )
    }

    {
      entry.status === 'pending' && (
        <form method="post">
          <input type="hidden" name="action" value="propose_reject" />
          <label>
            Reason for rejection
            <textarea name="reason" required />
          </label>
          <button type="submit">Propose rejection</button>
        </form>
      )
    }

    {
      entry.status === 'rejection_proposed' && (
        <div>
          <p>
            Rejection proposed by moderator {entry.proposedBy}: {entry.proposedReason}
          </p>
          {isOwnProposal ? (
            <p>You proposed this rejection — a different moderator must confirm it.</p>
          ) : (
            <>
              <form method="post">
                <input type="hidden" name="action" value="confirm_reject" />
                <button type="submit">Confirm rejection</button>
              </form>
              <form method="post">
                <input type="hidden" name="action" value="send_back" />
                <button type="submit">Send back to pending</button>
              </form>
            </>
          )}
        </div>
      )
    }
  </body>
</html>
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm run check`
Expected: no type errors.

- [ ] **Step 4: Manually verify against local Supabase**

Run: `astro dev --background`. Log in at `/admin/login` with moderator 1 (from Task 4).

- On `/admin`, confirm all four queue entries are listed (three `pending` from Task 3, one `rejection_proposed` from Task 4).
- Open the `new` entry, edit the title, click Approve. Confirm redirect to `/admin`, the entry is gone from the list, and the new listing appears on `/` with the edited title (not the original proposed one).
- Open the `update` entry, change the start time, click Approve. Confirm the Tuesday Night Mic's start time changed on `/`.
- Open the `cancellation` entry, click "Approve cancellation". Confirm the Westside Comedy Showcase occurrence no longer appears in that date range on `/`.
- Open the `rejection_proposed` entry (proposed by moderator 1) while still logged in as moderator 1. Confirm it shows "You proposed this rejection — a different moderator must confirm it" with no action buttons.
- Log out, log back in as moderator 2. Open the same entry — confirm "Confirm rejection" and "Send back to pending" are both available, and clicking "Confirm rejection" removes it from the queue.

Run: `astro dev stop`

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/index.astro src/pages/admin/queue
git commit -m "$(cat <<'EOF'
feat: add admin queue list and review/edit page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Public report form and e2e coverage

**Files:**

- Create: `src/pages/listings/[id]/report.astro`, `e2e/admin-moderation.spec.ts`
- Modify: `playwright.config.ts` (load `.env`)

**Interfaces:**

- Consumes: `getListingById` from `src/lib/data/listings.ts`; the anonymous `supabase` singleton from `src/lib/supabase/supabase.ts`; the anon insert RLS policy from Task 1
- Produces: the `/listings/[id]/report` route, which the existing detail page already links to

- [ ] **Step 1: Write the report form page**

Create `src/pages/listings/[id]/report.astro`:

```astro
---
import { supabase } from '../../../lib/supabase/supabase';
import { getListingById } from '../../../lib/data/listings';

const { id } = Astro.params;

if (!id) {
  return Astro.redirect('/404');
}

const listing = await getListingById(id);

if (!listing) {
  return Astro.redirect('/404');
}

let submitted = false;
let errorMessage: string | null = null;

if (Astro.request.method === 'POST') {
  const formData = await Astro.request.formData();
  const honeypot = formData.get('company')?.toString() ?? '';
  const reason = formData.get('reason')?.toString();
  const note = formData.get('note')?.toString();

  if (honeypot !== '') {
    // Silently succeed for bots without writing anything.
    submitted = true;
  } else if (reason !== 'not_happening' && reason !== 'something_else') {
    errorMessage = "Please choose a reason.";
  } else if (!note || note.trim().length === 0) {
    errorMessage = "Please describe what's wrong.";
  } else {
    const { error } = await supabase.from('moderation_queue').insert({
      listing_id: listing.id,
      change_type: reason === 'not_happening' ? 'cancellation' : 'update',
      proposed_data: reason === 'not_happening' ? { originalDate: null } : null,
      correction_note: note.trim(),
      origin: 'report_form',
      status: 'pending',
    });

    if (error) {
      errorMessage = 'Something went wrong submitting your report. Please try again.';
    } else {
      submitted = true;
    }
  }
}
---

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Report a problem — {listing.title} — Crowd Work</title>
  </head>
  <body>
    <a href={`/listings/${listing.id}`}>Back to {listing.title}</a>
    <h1>Report a problem with {listing.title}</h1>
    {
      submitted ? (
        <p>Thanks — a moderator will review this shortly.</p>
      ) : (
        <form method="post">
          {errorMessage && <p role="alert">{errorMessage}</p>}
          <div hidden>
            <label>
              Company
              <input type="text" name="company" tabindex={-1} autocomplete="off" />
            </label>
          </div>
          <fieldset>
            <legend>What's wrong?</legend>
            <label>
              <input type="radio" name="reason" value="not_happening" required />
              This isn't happening anymore
            </label>
            <label>
              <input type="radio" name="reason" value="something_else" />
              Something else is wrong
            </label>
          </fieldset>
          <label>
            Details
            <textarea name="note" required />
          </label>
          <button type="submit">Submit report</button>
        </form>
      )
    }
  </body>
</html>
```

Note: a "not_happening" report doesn't currently capture which specific occurrence date is being reported cancelled — `proposed_data.originalDate` is left `null` here, and the moderator fills in the correct date manually on the edit page (Task 9's cancellation form already has an editable date field for exactly this). Capturing the specific date automatically (e.g. from the currently-displayed next occurrence) would be a reasonable improvement but isn't required for this phase to function correctly, since the moderator always reviews and can set/correct it before approving.

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm run check`

- [ ] **Step 3: Manually verify the report flow**

Run: `astro dev --background`. Visit any listing's detail page, click "Report a problem", submit the form with "Something else is wrong" and a note. Confirm the thank-you message appears. Log into `/admin` and confirm a new `pending` `update` entry with `origin: report_form` and your note appears in the queue. Run: `astro dev stop`

- [ ] **Step 4: Load `.env` in the Playwright config**

Modify `playwright.config.ts` — add near the top, before the `defineConfig` call:

```ts
try {
  process.loadEnvFile();
} catch {
  // .env not present
}
```

- [ ] **Step 5: Write the e2e test**

Create `e2e/admin-moderation.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const email = process.env.TEST_MODERATOR_1_EMAIL;
const password = process.env.TEST_MODERATOR_1_PASSWORD;

test.skip(!email || !password, 'TEST_MODERATOR_1_EMAIL/PASSWORD not set in .env');

test('a moderator can log in and see the moderation queue', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login/);

  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Moderation queue' })).toBeVisible();
});

test('reporting a problem submits a correction into the moderation queue', async ({ page }) => {
  await page.goto('/');
  const firstLink = page.locator('[data-listing-row]:not([hidden]) h2 a').first();
  await firstLink.click();

  await page.getByRole('link', { name: /Report a problem/i }).click();
  await expect(page).toHaveURL(/\/report$/);

  await page.getByLabel(/Something else is wrong/i).check();
  await page.getByLabel('Details').fill('The sign-up sheet was gone by 7pm.');
  await page.getByRole('button', { name: 'Submit report' }).click();

  await expect(
    page.getByText('Thanks — a moderator will review this shortly.'),
  ).toBeVisible();
});
```

- [ ] **Step 6: Run the e2e tests**

Ensure `supabase start` is running, migrations/seed applied, and Task 4's provisioning script has been run. Run: `astro dev --background`, then `pnpm test:e2e`
Expected: both tests pass.
Run: `astro dev stop`

- [ ] **Step 7: Commit**

```bash
git add src/pages/listings e2e/admin-moderation.spec.ts playwright.config.ts
git commit -m "$(cat <<'EOF'
feat: add public report form and e2e coverage for the review flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Definition of Done

- `pnpm test` passes, including the RLS-enforced rejection self-block and the approve write-through tests.
- `pnpm test:e2e` passes.
- `pnpm run check` and `pnpm build` succeed with no errors.
- Visiting `/admin` while logged out redirects to `/admin/login`; logging in with either provisioned moderator account reaches the queue.
- A moderator can approve a `new`, `update`, or `cancellation` entry — after editing its fields — and see the result reflected on the public directory.
- A moderator cannot confirm or send back their own proposed rejection, in the UI and if attempted directly against the API.
- The previously-dangling "Report a problem" link on the listing detail page now submits a real `moderation_queue` entry.
