import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile();
} catch {
  // .env not present — required variables below will fail with a clear error instead.
}

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

const { error: moderatorsError } = await admin.from("moderators").insert([
  { id: user1.user.id, email: email1 },
  { id: user2.user.id, email: email2 },
]);
if (moderatorsError) throw moderatorsError;

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
