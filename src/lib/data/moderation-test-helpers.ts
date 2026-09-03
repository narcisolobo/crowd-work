import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requiredEnv("PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function signInTestModerator(
  which: 1 | 2,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(
    requiredEnv("PUBLIC_SUPABASE_URL"),
    requiredEnv("PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error } = await client.auth.signInWithPassword({
    email: requiredEnv(`TEST_MODERATOR_${which}_EMAIL`),
    password: requiredEnv(`TEST_MODERATOR_${which}_PASSWORD`),
  });
  if (error)
    throw new Error(
      `Failed to sign in test moderator ${which}: ${error.message}`,
    );

  return client;
}
