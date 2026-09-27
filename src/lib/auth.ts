import type { Role } from "@/lib/types";
import { serviceSupabase } from "@/lib/supabase";

export type RequestUser = { id: string; email: string; role: Role };

export async function requestUser(request: Request): Promise<RequestUser | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const supabase = serviceSupabase();
  const { data: authData } = await supabase.auth.getUser(token);
  const email = authData.user?.email?.toLowerCase();
  if (!authData.user || !email) return null;
  const { data: allowed } = await supabase.from("allowed_users").select("role").eq("email", email).eq("enabled", true).maybeSingle();
  if (!allowed) return null;
  return { id: authData.user.id, email, role: allowed.role as Role };
}

export async function requireUser(request: Request) {
  const user = await requestUser(request);
  if (!user) throw new Error("로그인이 필요하거나 허용되지 않은 계정입니다.");
  return user;
}

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new Error("관리자만 사용할 수 있습니다.");
  return user;
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  return Response.json({ error: message }, { status: /로그인|허용되지|관리자만/.test(message) ? 403 : 400 });
}
