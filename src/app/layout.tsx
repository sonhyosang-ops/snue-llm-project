import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "교육공무원 인사실무편람",
  description: "장 선택형 근거 기반 인사실무편람 안내",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions (e.g. Liner) add attributes to <html>/<body> before hydration.
  return <html lang="ko" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
