import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const roles = ["teacher", "vice_principal", "academic_affairs", "system_developer"] as const;
type Role = (typeof roles)[number];

async function requireManager() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "system_developer" && profile?.role !== "vice_principal") {
    return { error: NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 }) };
  }
  return { supabase, user };
}

export async function GET() {
  const result = await requireManager();
  if ("error" in result) return result.error;

  const { data, error } = await result.supabase
    .from("profiles")
    .select("id, email, role, can_upload")
    .order("email");

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function PATCH(request: Request) {
  const result = await requireManager();
  if ("error" in result) return result.error;

  const body = await request.json() as { id?: string; role?: Role; canUpload?: boolean };
  if (!body.id || !body.role || !roles.includes(body.role) || typeof body.canUpload !== "boolean") {
    return NextResponse.json({ error: "권한 정보가 올바르지 않습니다." }, { status: 400 });
  }
  if (body.id === result.user.id && body.role === "teacher") {
    return NextResponse.json({ error: "자신의 관리자 권한은 일반 교사로 변경할 수 없습니다." }, { status: 400 });
  }

  const { error } = await result.supabase
    .from("profiles")
    .update({ role: body.role, can_upload: body.canUpload })
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
