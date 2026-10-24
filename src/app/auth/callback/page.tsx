"use client";

// ─────────────────────────────────────────────────────────────────────────────
// auth/callback/page.tsx — 로그인 링크를 눌렀을 때 열리는 확인 창 (주소: /auth/callback)
//
// 메일의 로그인 링크를 누르면 Supabase가 이 주소로 돌려보내며, 주소 끝(#access_token=...)에 토큰을 붙인다.
// Supabase 브라우저 연결(browserSupabase)이 주소의 토큰을 읽어 세션을 저장하면 로그인이 끝난다.
// 이 창은 세션이 생기면 localStorage에 완료 표시를 남기고 1.5초 뒤 스스로 닫힌다.
// 처음 로그인을 요청했던 창(page.tsx)은 같은 브라우저 저장소를 보고 자동으로 채팅 화면으로 바뀐다.
// 그래서 메일 링크를 다른 브라우저나 휴대폰에서 열면 원래 창은 로그인되지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";

export default function AuthCallbackPage() {
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const supabase = browserSupabase();
    let closeTimer: number | undefined;
    // 세션이 저장됐는지 확인하고, 저장됐으면 완료 표시 → 화면 문구 변경 → 1.5초 뒤 창 닫기를 한다.
    const finish = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      localStorage.setItem("baegotnuri-login-complete", String(Date.now()));
      setComplete(true);
      if (!closeTimer) closeTimer = window.setTimeout(() => window.close(), 1500);
    };
    // 토큰 처리가 끝나는 시점을 정확히 알 수 없으므로 바로 한 번, 그 뒤 0.5초마다 다시 확인한다.
    finish();
    const timer = window.setInterval(() => { finish(); }, 500);
    return () => { window.clearInterval(timer); if (closeTimer) window.clearTimeout(closeTimer); };
  }, []);

  // window.close()는 브라우저 정책상 막힐 수 있으므로 직접 닫는 버튼도 함께 보여 준다.
  return <main className="login-shell"><section className="login-card"><p className="eyebrow">로그인 확인</p><h1>{complete ? "로그인이 완료되었습니다" : "로그인을 확인하는 중입니다"}</h1><p>{complete ? "처음 로그인 요청을 했던 창으로 돌아가면 채팅을 계속 사용할 수 있습니다. 이 창은 자동으로 닫힙니다." : "잠시만 기다려 주세요."}</p>{complete && <button className="text-button" onClick={() => window.close()}>이 창 닫기</button>}</section></main>;
}
