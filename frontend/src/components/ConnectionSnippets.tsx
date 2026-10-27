"use client";

import { API_BASE } from "@/lib/api";

/** 웹판에서 외부 AI 앱(Claude Desktop·Claude Code)에 붙일 MCP 설정 조각. 데스크톱 앱은 메뉴 AI → 연결이 설정 파일에 직접 쓴다. */
export function ConnectionSnippets({ token }: { token: string }) {
  const apiUrl = API_BASE;
  const bridge = typeof window !== "undefined" && window.__MCP_COMMAND__ ? window.__MCP_COMMAND__ : { command: "uv", args: ["run", "--directory", "<이 저장소>/backend", "python", "-m", "app.mcp_stdio"] };
  const env = { ...(bridge.env ?? {}), EDITOR_API_URL: apiUrl, EDITOR_AI_TOKEN: token };
  const entry = { command: bridge.command, args: bridge.args, env };
  const claudeDesktop = JSON.stringify({ mcpServers: { coredotdocs: entry } }, null, 2);
  const claudeCode = `claude mcp add-json --scope user coredotdocs '${JSON.stringify({ type: "stdio", ...entry })}'`;
  return (
    <div className="tool-form">
      <label>
        <span>Claude Desktop — claude_desktop_config.json에 합치기</span>
        <pre className="result">{claudeDesktop}</pre>
      </label>
      <label>
        <span>Claude Code — 터미널에서 한 번</span>
        <pre className="result">{claudeCode}</pre>
      </label>
      <label>
        <span>직접 실행</span>
        <pre className="result">{`EDITOR_API_URL=${apiUrl} EDITOR_AI_TOKEN=${token} ${[bridge.command, ...bridge.args].map((s) => (/\s/.test(s) ? JSON.stringify(s) : s)).join(" ")}`}</pre>
      </label>
      <p className="muted">토큰은 지금 한 번만 보입니다. 세션을 특정 문서로 제한하려면 API로 document_ids를 주어 발급하세요.</p>
    </div>
  );
}
