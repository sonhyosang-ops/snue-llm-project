import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const { data, error } = await serviceSupabase().from("allowed_users").select("email, role, enabled, created_at").order("email");
    if (error) throw error;
    return Response.json({ users: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const { email: rawEmail, role = "user" } = await request.json() as { email?: string; role?: "admin" | "user" };
    const email = rawEmail?.trim().toLowerCase();
    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    if (!email?.endsWith(`@${domain}`)) throw new Error(`@${domain} 이메일만 등록할 수 있습니다.`);
    const supabase = serviceSupabase();
    const { data: existing, error: existingError } = await supabase.from("allowed_users").select("role").eq("email", email).maybeSingle();
    if (existingError) throw existingError;
    const { error } = await supabase.from("allowed_users").upsert({ email, role: existing?.role ?? role, enabled: true });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
