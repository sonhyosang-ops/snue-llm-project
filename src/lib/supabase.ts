// ─────────────────────────────────────────────────────────────────────────────
// supabase.ts — 서버(API 라우트)에서 쓰는 Supabase 연결
//
// Supabase 키는 두 종류이고 권한이 크게 다르다.
//   - anon 키(NEXT_PUBLIC_SUPABASE_ANON_KEY)        : 공개해도 되는 키. 브라우저에도 전달된다.
//   - service_role 키(SUPABASE_SERVICE_ROLE_KEY)    : 모든 테이블을 제한 없이 읽고 쓰는 관리자 키. 절대 브라우저로 보내면 안 된다.
// 이 앱은 모든 테이블에 행 단위 보안(RLS)을 켜고 허용 정책을 만들지 않았다(supabase/schema.sql).
// 그래서 브라우저는 테이블에 직접 접근할 수 없고, 데이터는 반드시 서버 API를 거쳐 service_role 키로만 읽고 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

// 필수 환경 변수를 읽는다. 없으면 어떤 변수가 빠졌는지 바로 알 수 있도록 오류를 낸다.
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경 변수가 없습니다.`);
  return value;
}

// 관리자 권한 연결. DB 읽기·쓰기, Storage(PDF 파일), 사용자 토큰 확인에 쓴다.
// 서버에서 요청마다 새로 만드는 짧은 연결이므로 로그인 세션을 저장하거나 갱신할 필요가 없다.
export function serviceSupabase() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 공개 키 연결. 로그인 링크 메일 발송(api/auth/request)처럼 "일반 사용자 자격"으로 해야 하는 일에 쓴다.
export function publicSupabase() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
