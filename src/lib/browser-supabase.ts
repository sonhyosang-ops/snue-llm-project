"use client";

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function browserSupabase() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // The placeholder lets `next build` run before deployment variables exist.
  // Actual sign-in will fail clearly until the documented variables are configured.
  client = createClient(url ?? "https://placeholder.supabase.co", key ?? "placeholder-anon-key");
  return client;
}
