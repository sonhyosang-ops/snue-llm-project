import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "학교 업무 지식 도우미",
  description: "공식 업무 문서를 근거로 안내하는 교사용 지식검색 시스템",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="ko"><body>{children}</body></html>;
}
