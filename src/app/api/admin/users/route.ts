// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/users — 허용 사용자 목록 조회(GET)와 등록(POST) (관리자 전용)
//
// allowed_users 테이블은 "이 앱을 쓸 수 있는 메일 목록"이다.
// 로그인 링크 요청(api/auth/request)과 모든 API의 권한 확인(lib/auth.ts)이 이 목록을 본다.
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

// 허용 사용자 전체를 메일 순으로 돌려준다.
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

// 메일 하나를 허용 사용자로 등록한다(이미 있으면 다시 활성화한다).
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const { email: rawEmail, role = "user" } = await request.json() as { email?: string; role?: "admin" | "user" };
    // 메일은 공백을 지우고 소문자로 맞춘다. 학교 도메인(ALLOWED_EMAIL_DOMAIN) 메일만 받는다.
    const email = rawEmail?.trim().toLowerCase();
    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    if (!email?.endsWith(`@${domain}`)) throw new Error(`@${domain} 이메일만 등록할 수 있습니다.`);
    const supabase = serviceSupabase();
    // 이미 등록된 메일이면 기존 역할을 유지한다.
    // (관리자 메일을 실수로 다시 등록해도 user로 강등되지 않게 하려는 장치다.)
    const { data: existing, error: existingError } = await supabase.from("allowed_users").select("role").eq("email", email).maybeSingle();
    if (existingError) throw existingError;
    // upsert: 메일(기본 키)이 없으면 새로 넣고, 있으면 그 행을 고친다.
    const { error } = await supabase.from("allowed_users").upsert({ email, role: existing?.role ?? role, enabled: true });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
