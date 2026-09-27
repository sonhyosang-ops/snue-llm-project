"use client";

import { useEffect, useState } from "react";
import { browserSupabase } from "@/lib/browser-supabase";

export default function AuthCallbackPage() {
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const supabase = browserSupabase();
    let closeTimer: number | undefined;
    const finish = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      localStorage.setItem("baegotnuri-login-complete", String(Date.now()));
      setComplete(true);
      if (!closeTimer) closeTimer = window.setTimeout(() => window.close(), 1500);
    };
    finish();
    const timer = window.setInterval(() => { finish(); }, 500);
    return () => { window.clearInterval(timer); if (closeTimer) window.clearTimeout(closeTimer); };
  }, []);

  return <main className="login-shell"><section className="login-card"><p className="eyebrow">로그인 확인</p><h1>{complete ? "로그인이 완료되었습니다" : "로그인을 확인하는 중입니다"}</h1><p>{complete ? "처음 로그인 요청을 했던 창으로 돌아가면 채팅을 계속 사용할 수 있습니다. 이 창은 자동으로 닫힙니다." : "잠시만 기다려 주세요."}</p>{complete && <button className="text-button" onClick={() => window.close()}>이 창 닫기</button>}</section></main>;
}
