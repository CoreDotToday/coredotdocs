import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Core.Docs",
  description: "코어닷독스 — 한글·Word 문서를 AI와 함께 고치는 문서 편집기",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 데스크톱 앱(Electron)은 실행 때 정한 백엔드 주소와 MCP 브리지 실행 명령을 런타임 env로 준다. 웹 배포에서는 비어 있다.
  const runtime: string[] = [];
  if (process.env.API_PUBLIC_URL) runtime.push(`window.__API_BASE__=${JSON.stringify(process.env.API_PUBLIC_URL)};`);
  if (process.env.MCP_COMMAND) runtime.push(`window.__MCP_COMMAND__=${process.env.MCP_COMMAND};`);
  return (
    <html lang="ko">
      <head>{runtime.length > 0 && <script dangerouslySetInnerHTML={{ __html: runtime.join("") }} />}</head>
      <body>{children}</body>
    </html>
  );
}
