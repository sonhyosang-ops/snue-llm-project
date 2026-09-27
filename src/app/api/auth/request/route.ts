import { publicSupabase, serviceSupabase } from "@/lib/supabase";

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "로그인 메일을 보낼 수 없습니다.";
}

export async function POST(request: Request) {
  try {
    const { email: rawEmail } = await request.json() as { email?: string };
    const email = rawEmail?.trim().toLowerCase();
    const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "baegotnuri.es.kr";
    if (!email?.endsWith(`@${domain}`)) throw new Error(`@${domain} 이메일만 사용할 수 있습니다.`);

    const { data: allowed, error: allowedError } = await serviceSupabase()
      .from("allowed_users")
      .select("email")
      .eq("email", email)
      .eq("enabled", true)
      .maybeSingle();
    if (allowedError) throw allowedError;
    if (!allowed) throw new Error("관리자가 허용한 계정이 아닙니다.");

    const origin = new URL(request.url).origin;
    const { error } = await publicSupabase().auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    if (error) throw error;
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Login link request failed:", error);
    const message = messageOf(error);
    if (/rate limit|too many|over_email_send_rate_limit/i.test(message)) {
      return Response.json({ error: "로그인 메일 발송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
    }
    return Response.json({ error: message }, { status: 400 });
  }
}
