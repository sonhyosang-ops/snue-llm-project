// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/users — 허용 사용자 목록 조회(GET)와 등록·역할 변경(POST) (관리자 전용)
//
// allowed_users 테이블은 "이 앱을 쓸 수 있는 메일과 그 권한 층위" 목록이다.
// 로그인 링크 요청(api/auth/request)과 모든 API의 권한 확인(lib/auth.ts)이 이 목록을 본다.
// 역할은 관리자(admin) / 교장·교감(leader) / 교사(user) 세 가지다(src/lib/types.ts의 Role).
// ─────────────────────────────────────────────────────────────────────────────
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";
import type { Role } from "@/lib/types";

const ROLES: Role[] = ["admin", "leader", "user"];

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

// 메일 하나를 지정한 역할로 등록한다. 이미 있는 메일이면 역할을 바꾸고 다시 활성화한다.
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    const { email: rawEmail, role = "user" } = await request.json() as { email?: string; role?: Role };
    // 메일은 공백을 지우고 소문자로 맞춘다. 학교 도메인(ALLOWED_EMAIL_DOMAIN) 메일만 받는다.
    const email = rawEmail?.trim().toLowerCase();
    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    if (!email?.endsWith(`@${domain}`)) throw new Error(`@${domain} 이메일만 등록할 수 있습니다.`);
    // 화면이 보낸 역할 값을 그대로 믿지 않고, 정해진 세 가지 중 하나인지 서버에서 다시 확인한다.
    if (!ROLES.includes(role)) throw new Error("역할은 관리자, 교장·교감, 교사 중 하나여야 합니다.");
    // 관리자가 실수로 자기 권한을 내리면 아무도 관리자 화면에 들어올 수 없게 되므로 막는다.
    if (email === admin.email && role !== "admin") throw new Error("자기 자신의 관리자 권한은 내릴 수 없습니다.");
    // upsert: 메일(기본 키)이 없으면 새로 넣고, 있으면 그 행의 역할을 바꾼다.
    const { error } = await serviceSupabase().from("allowed_users").upsert({ email, role, enabled: true });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
