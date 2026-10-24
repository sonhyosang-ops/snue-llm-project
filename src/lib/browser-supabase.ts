"use client";

// ─────────────────────────────────────────────────────────────────────────────
// browser-supabase.ts — 브라우저(화면)에서 쓰는 Supabase 연결
//
// 브라우저에서는 공개 키(anon)만 쓴다. 이 연결은 로그인 세션 관리에만 쓰인다.
//   - 메일 링크로 돌아왔을 때 주소에 담긴 토큰으로 세션 만들기(auth/callback 화면)
//   - 현재 로그인 상태와 액세스 토큰 읽기, 로그아웃
// 테이블 데이터는 이 연결로 읽지 않는다. 서버 API에 토큰을 보내 받아 온다(src/lib/supabase.ts 설명 참고).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

// 화면 전체에서 연결 하나를 같이 쓴다(싱글턴). 연결을 여러 개 만들면 로그인 상태가 서로 어긋날 수 있다.
let client: SupabaseClient | null = null;

export function browserSupabase() {
  if (client) return client;
  // NEXT_PUBLIC_ 으로 시작하는 환경 변수는 빌드할 때 값이 코드에 그대로 박혀 브라우저로 전달된다.
  // 그래서 여기에는 공개해도 되는 값(URL, anon 키)만 둔다.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // 환경 변수가 아직 없어도 `next build`가 멈추지 않도록 임시값을 쓴다.
  // 실제 로그인은 올바른 환경 변수를 넣기 전까지 분명한 오류로 실패한다.
  // `??`가 아니라 `||`를 쓰는 이유: 변수가 "있지만 빈 값"인 경우에도 임시값을 써야 하기 때문이다.
  // (`??`는 null·undefined일 때만 대체값을 쓰므로 빈 문자열이 그대로 들어가 빌드가 실패했었다.)
  client = createClient(url || "https://placeholder.supabase.co", key || "placeholder-anon-key");
  return client;
}
