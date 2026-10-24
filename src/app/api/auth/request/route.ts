// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/request — 로그인 링크(매직 링크) 메일 요청
//
// 비밀번호 없이, 메일로 받은 일회용 링크를 눌러 로그인하는 방식이다.
//   1) 학교 도메인 메일인지, 관리자가 허용한 메일인지 서버에서 먼저 확인한다.
//   2) Supabase Auth에 링크 발송을 요청한다. 실제 메일은 Supabase에 연결한 SMTP(Resend)가 보낸다.
//   3) 사용자가 링크를 누르면 /auth/callback 화면으로 돌아와 로그인이 끝난다.
// 허용되지 않은 메일에는 메일 자체를 보내지 않으므로 발송 한도와 비용을 아낄 수 있다.
// ─────────────────────────────────────────────────────────────────────────────
import { publicSupabase, serviceSupabase } from "@/lib/supabase";

// 오류 객체의 모양이 제각각이라(Error, Supabase 오류 객체 등) 사람이 읽을 메시지만 꺼낸다.
function messageOf(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "로그인 메일을 보낼 수 없습니다.";
}

export async function POST(request: Request) {
  try {
    // 1) 메일 형식과 도메인 확인
    const { email: rawEmail } = await request.json() as { email?: string };
    const email = rawEmail?.trim().toLowerCase();
    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    if (!email?.endsWith(`@${domain}`)) throw new Error(`@${domain} 이메일만 사용할 수 있습니다.`);

    // 허용 목록 확인은 RLS를 넘어서 읽어야 하므로 service 키 연결을 쓴다.
    const { data: allowed, error: allowedError } = await serviceSupabase()
      .from("allowed_users")
      .select("email")
      .eq("email", email)
      .eq("enabled", true)
      .maybeSingle();
    if (allowedError) throw allowedError;
    if (!allowed) throw new Error("관리자가 허용한 계정이 아닙니다.");

    // 2) 링크를 누른 뒤 돌아올 주소는 "요청이 들어온 주소"를 기준으로 만든다.
    //    그래서 로컬(localhost)에서 요청하면 로컬로, 운영 사이트에서 요청하면 운영 사이트로 돌아온다.
    //    단, 이 주소는 Supabase 대시보드의 Redirect URLs에 등록되어 있어야 동작한다.
    const origin = new URL(request.url).origin;
    const { error } = await publicSupabase().auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Login link request failed:", error);
    const message = messageOf(error);
    // 메일 발송 한도 초과는 사용자가 이해하기 쉬운 한국어 메시지와 429(요청 과다) 상태로 돌려준다.
    if (/rate limit|too many|over_email_send_rate_limit/i.test(message)) {
      return Response.json({ error: "로그인 메일 발송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
    }
    return Response.json({ error: message }, { status: 400 });
  }
}
