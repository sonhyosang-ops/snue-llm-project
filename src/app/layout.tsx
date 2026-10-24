// ─────────────────────────────────────────────────────────────────────────────
// layout.tsx — 모든 화면을 감싸는 공통 틀(Next.js App Router의 루트 레이아웃)
// 문서 언어(ko), 브라우저 탭 제목·설명, 공통 CSS를 여기서 한 번만 정한다.
// ─────────────────────────────────────────────────────────────────────────────
import type { Metadata } from "next";
import "./globals.css";

// 브라우저 탭 제목과 검색 결과 설명
export const metadata: Metadata = {
  title: "교육공무원 인사실무편람",
  description: "장 선택형 근거 기반 인사실무편람 안내",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 브라우저 확장 프로그램(Liner 등)이 화면이 뜨기 전에 <html>·<body>에 자기 속성을 붙이면,
  // 서버가 만든 HTML과 달라져 React가 "hydration 불일치" 경고를 낸다.
  // suppressHydrationWarning은 이 두 태그의 속성 차이만 무시하게 하며, 그 안쪽 내용의 불일치는 여전히 잡아 준다.
  return <html lang="ko" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
