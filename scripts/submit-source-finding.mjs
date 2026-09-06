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
