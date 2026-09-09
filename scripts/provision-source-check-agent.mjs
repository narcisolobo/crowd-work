import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile();
} catch {
  // .env not present — required variables below will fail with a clear error instead.
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [argEmail, argPassword] = process.argv.slice(2);
const email = argEmail ?? process.env.SOURCE_CHECK_AGENT_EMAIL;
const password = argPassword ?? process.env.SOURCE_CHECK_AGENT_PASSWORD;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
  );
}
if (!email || !password) {
  throw new Error(
    "Usage: node scripts/provision-source-check-agent.mjs [<email> <password>] " +
      "(defaults to SOURCE_CHECK_AGENT_EMAIL/PASSWORD from .env)",
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
