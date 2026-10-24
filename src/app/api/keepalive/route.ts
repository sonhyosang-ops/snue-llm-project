import { serviceSupabase } from "@/lib/supabase";

// Vercel Cron (vercel.json) calls this once a day so the free-plan Supabase project is not paused for inactivity.
// Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { error } = await serviceSupabase().from("allowed_users").select("email").limit(1);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
