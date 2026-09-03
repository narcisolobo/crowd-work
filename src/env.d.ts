/// <reference types="astro/client" />

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "./lib/supabase/database.types";

declare global {
  namespace App {
    interface Locals {
      user: User | null;
      supabase: SupabaseClient<Database> | null;
    }
  }
}
