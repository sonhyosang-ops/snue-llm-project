// ─────────────────────────────────────────────────────────────────────────────
// auth.ts — API 요청을 보낸 사람이 누구인지, 무엇을 할 수 있는지 확인한다.
//
// 이 앱의 로그인은 두 겹이다.
//   1) Supabase Auth : 메일로 받은 로그인 링크(매직 링크)를 눌러 "이 메일의 주인"임을 증명한다.
//   2) allowed_users : 관리자가 등록하고 활성화한 메일만 실제로 앱을 쓸 수 있다. role로 관리자 여부도 정한다.
// 브라우저는 로그인 후 받은 액세스 토큰을 "Authorization: Bearer <토큰>" 헤더로 보내고,
// 서버는 매 요청마다 이 파일의 함수로 토큰과 허용 목록을 다시 확인한다.
// ─────────────────────────────────────────────────────────────────────────────
import type { Role } from "@/lib/types";
import { serviceSupabase } from "@/lib/supabase";

export type RequestUser = { id: string; email: string; role: Role };

// 요청 헤더의 토큰으로 사용자를 찾는다. 확인에 실패하면 오류 대신 null을 돌려준다.
//   ① 토큰이 없으면 → null
//   ② Supabase Auth에 토큰을 보내 진짜 로그인 사용자인지 확인한다(위조·만료 토큰이면 user가 없다).
//   ③ 그 메일이 allowed_users에 있고 enabled=true인지 확인한다. 없으면 → null
// 메일은 소문자로 바꿔 비교한다. allowed_users는 소문자 메일만 저장하도록 DB에서 제한한다(schema.sql).
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

// 허용된 사용자가 아니면 오류를 낸다. 일반 사용자 API(질문, 장 목록)에서 쓴다.
export async function requireUser(request: Request) {
  const user = await requestUser(request);
  if (!user) throw new Error("로그인이 필요하거나 허용되지 않은 계정입니다.");
  return user;
}

// 관리자(role = "admin")가 아니면 오류를 낸다. 사용자 등록, PDF 업로드·색인 API에서 쓴다.
export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new Error("관리자만 사용할 수 있습니다.");
  return user;
}

// 모든 API 라우트가 공통으로 쓰는 오류 응답. 오류 메시지를 { error } JSON으로 돌려준다.
// 권한 문제(로그인·허용·관리자 메시지)는 403(권한 없음), 그 밖의 오류는 400(잘못된 요청)으로 구분한다.
export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  return Response.json({ error: message }, { status: /로그인|허용되지|관리자만/.test(message) ? 403 : 400 });
}
