// ─────────────────────────────────────────────────────────────────────────────
// GET /api/keepalive — Supabase 자동 정지 방지용 하루 한 번 접속
//
// Supabase 무료 플랜은 7일 동안 사용이 없으면 프로젝트를 일시정지한다.
// 정지되면 주소가 사라져 로그인부터 "fetch failed"로 실패한다(2026-10-24 실제 장애).
// 그래서 Vercel Cron(vercel.json)이 매일 00:00 UTC(한국 09:00)에 이 주소를 불러 DB를 한 번 조회한다.
//
// 보안: Vercel Cron은 환경 변수 CRON_SECRET 값을 "Authorization: Bearer <값>" 헤더로 붙여 보낸다.
// 이 값이 맞지 않는 요청은 401로 거부해, 외부에서 이 주소를 마음대로 호출하지 못하게 한다.
// ─────────────────────────────────────────────────────────────────────────────
import { serviceSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // CRON_SECRET이 설정되지 않았으면 모든 요청을 거부한다(빈 값과 맞춰지는 일을 막는다).
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // 가장 가벼운 조회 한 번이면 "사용 중"으로 인정된다.
  const { error } = await serviceSupabase().from("allowed_users").select("email").limit(1);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
