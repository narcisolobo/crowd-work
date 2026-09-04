import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export async function getModeratorEmails(
  client: SupabaseClient<Database>,
  ids: string[],
): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from("moderators")
    .select("id, email")
    .in("id", uniqueIds);

  if (error)
    throw new Error(`Failed to load moderator emails: ${error.message}`);

  return Object.fromEntries((data ?? []).map((row) => [row.id, row.email]));
}
