"use client";

// 탭이 하나도 없을 때의 시작 화면: 열기·새 문서·최근 문서·이 앱의 문서·AI 연결.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, serverDate, type DocFormat, type DocumentSummary } from "@/lib/api";
import { isDesktop } from "@/lib/desktop";
import { useShell } from "@/lib/shell";
import { readableTitle, useWorkspace, workspace } from "@/lib/tabs";
import { ConnectionSnippets } from "./ConnectionSnippets";

const RECENT_SHOWN = 6;
const LIBRARY_SHOWN = 12;
// preload is fixed for the window lifetime. Hydration must first match the web-only server HTML.
const subscribeDesktop = () => () => {};
const serverIsDesktop = () => false;

const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
/** "3시간 전"처럼 지금과의 차이 */
function ago(at: number): string {
  const s = (at - Date.now()) / 1000;
  for (const [unit, sec] of UNITS) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  return "방금";
}

/** 경로의 바로 위 폴더 이름 (예: Downloads) */
function folderOf(path: string): string {
  return path.split(/[\\/]/).slice(-2, -1)[0] ?? path;
}

function DocBadge({ format }: { format: DocFormat }) {
  return (
    <span className={`doc-badge ${format}`} aria-hidden="true">
      {format === "docx" ? "W" : "한"}
    </span>
  );
}

function BrandMark() {
  return (
    <svg className="start-mark" viewBox="0 0 56 56" aria-hidden="true">
      <defs>
        <linearGradient id="cdd-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82c4" />
          <stop offset="1" stopColor="#1e4f8a" />
        </linearGradient>
      </defs>
      <rect width="56" height="56" rx="14" fill="url(#cdd-mark)" />
      <path d="M18 13h14l9 9v21a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3z" fill="#fff" opacity="0.96" />
      <path d="M32 13v6a3 3 0 0 0 3 3h6" fill="#cfe0f3" />
      <rect x="20" y="27" width="16" height="2.6" rx="1.3" fill="#9db8d8" />
      <rect x="20" y="33" width="11" height="2.6" rx="1.3" fill="#9db8d8" />
      <circle cx="37" cy="39" r="3.2" fill="#2b6cb0" />
    </svg>
  );
}

const icons = {
  open: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 10h18l-1.6 7.4A2 2 0 0 1 17.4 19H6.6a2 2 0 0 1-2-1.6z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  ),
};

export function StartScreen() {
  const shell = useShell();
  const ws = useWorkspace();
  const [library, setLibrary] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, serverIsDesktop);

  async function refresh() {
    try {
      setLibrary(await api.listDocuments());
      setError("");
    } catch (err) {
      setError(`백엔드에 연결하지 못했습니다: ${String(err)}`);
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 서버 목록을 비동기로 불러온다
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function pickFiles() {
    if (desktop) return shell.openFileDialog();
    fileInput.current?.click();
  }

  async function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await shell.openLocalFiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
  }

  async function remove(d: DocumentSummary) {
    if (!confirm(`'${d.title}' 문서를 이 앱에서 지울까요? (디스크의 파일은 그대로 둡니다)`)) return;
    await api.deleteDocument(d.id);
    workspace.removeRecent(d.id);
    refresh();
  }

  async function connect(target: "claude-desktop" | "claude-code" | "codex") {
    setAiMessage("연결하는 중…");
    try {
      await shell.connectAi(target);
      setAiMessage("");
    } catch (err) {
      setAiMessage(String(err));
    }
  }

  const q = query.trim().toLowerCase();
  const matched = q ? library.filter((d) => readableTitle(d.title).toLowerCase().includes(q)) : library;
  const shown = showAll || q ? matched : matched.slice(0, LIBRARY_SHOWN);
  const recent = ws.recent.slice(0, RECENT_SHOWN);

  return (
    <div className="start" onDoubleClick={(e) => e.target === e.currentTarget && pickFiles()}>
      <div className="start-inner">
        <header className="start-hero">
          <BrandMark />
          <div>
            <h1>Core.Docs</h1>
            <p className="start-lead">한글·Word 문서를 열고, AI와 함께 고칩니다. 파일을 이 창에 끌어다 놓아도 열립니다.</p>
          </div>
        </header>

        <div className="start-actions">
          <button type="button" className="action-tile primary" onClick={pickFiles} aria-label="문서 열기…" aria-describedby="act-open">
            <span className="action-icon">{icons.open}</span>
            <span className="action-text">
              <span className="action-title">문서 열기…</span>
              <span className="action-sub" id="act-open">HWPX · HWP · DOCX</span>
            </span>
          </button>
          <button type="button" className="action-tile hwpx" onClick={() => shell.newDocument("hwpx")} aria-label="새 한글 문서" aria-describedby="act-hwpx">
            <span className="action-icon">{icons.plus}</span>
            <span className="action-text">
              <span className="action-title">새 한글 문서</span>
              <span className="action-sub" id="act-hwpx">빈 HWPX 문서</span>
            </span>
          </button>
          <button type="button" className="action-tile docx" onClick={() => shell.newDocument("docx")} aria-label="새 Word 문서" aria-describedby="act-docx">
            <span className="action-icon">{icons.plus}</span>
            <span className="action-text">
              <span className="action-title">새 Word 문서</span>
              <span className="action-sub" id="act-docx">빈 DOCX 문서</span>
            </span>
          </button>
          <input ref={fileInput} type="file" multiple accept=".hwpx,.hwp,.docx,application/hwp+zip,application/x-hwp,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="HWPX, HWP 또는 DOCX 파일" onChange={onInput} style={{ display: "none" }} />
        </div>

        {recent.length > 0 && (
          <section className="start-section" aria-labelledby="recent-head">
            <div className="section-head">
              <h2 id="recent-head">최근 문서</h2>
            </div>
            <ul className="recent-grid">
              {recent.map((r) => (
                <li key={r.id} className="recent-card">
                  <DocBadge format={r.format} />
                  <button type="button" className="recent-open" onClick={() => shell.openRecent(r)} title={r.path ?? r.filename}>
                    {readableTitle(r.title)}
                  </button>
                  <span className="recent-meta">
                    {r.path ? folderOf(r.path) : "이 앱 안"} · {ago(r.at)}
                  </span>
                  <button type="button" className="recent-remove" onClick={() => workspace.removeRecent(r.id)} aria-label={`${r.title} 최근 목록에서 빼기`} title="최근 목록에서 빼기">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="start-columns">
          <section className="library" aria-labelledby="library-head">
            <div className="library-head">
              <h2 id="library-head">이 앱의 문서</h2>
              {library.length > 0 && <span className="count">{library.length}</span>}
              <span className="spacer" />
              {library.length > 0 && <input type="search" className="library-search" placeholder="제목으로 찾기" aria-label="문서 제목으로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />}
            </div>
            {error && <p className="library-empty is-error">{error}</p>}
            {!error && library.length === 0 && <p className="library-empty">아직 문서가 없습니다. 문서를 열거나 새로 만들면 여기에 남습니다.</p>}
            {!error && library.length > 0 && matched.length === 0 && <p className="library-empty">‘{query}’와 맞는 문서가 없습니다.</p>}
            <ul className="doc-list" aria-label="앱 문서 목록">
              {shown.map((d) => (
                <li key={d.id} className="doc-row">
                  <DocBadge format={d.format} />
                  <span className="doc-main">
                    <button type="button" className="doc-open" onClick={() => shell.openServerDocument(d.id)} title={readableTitle(d.title)}>
                      {readableTitle(d.title)}
                    </button>
                    <span className="doc-meta" title={serverDate(d.updated_at).toLocaleString("ko-KR")}>
                      리비전 {d.revision_seq} · {ago(serverDate(d.updated_at).getTime())}
                    </span>
                  </span>
                  <button type="button" className="doc-delete" onClick={() => remove(d)} aria-label={`${d.title} 지우기`} title="이 앱에서 지우기">
                    {icons.trash}
                  </button>
                </li>
              ))}
            </ul>
            {!q && matched.length > LIBRARY_SHOWN && (
              <button type="button" className="library-more" onClick={() => setShowAll(!showAll)}>
                {showAll ? "접기" : `${matched.length - LIBRARY_SHOWN}개 더 보기`}
              </button>
            )}
          </section>

          <aside className="start-aside">
            <section className="ai-card" aria-labelledby="ai-head">
              <h2 id="ai-head">
                {icons.spark} AI 연결
              </h2>
              <p className="muted">
                문서 화면의 <b>AI 패널</b>에 core.today API 키(cdt_…)를 넣으면 Claude·GPT·Gemini와 대화하며 고칠 수 있습니다. 외부 AI 앱은 MCP로 이 편집기의 도구 20개를 씁니다.
              </p>
              {desktop ? (
                <div className="ai-buttons">
                  <button type="button" onClick={() => connect("claude-desktop")}>
                    Claude Desktop에 연결… <span aria-hidden="true">→</span>
                  </button>
                  <button type="button" onClick={() => connect("claude-code")}>
                    Claude Code에 연결… <span aria-hidden="true">→</span>
                  </button>
                  <button type="button" onClick={() => connect("codex")}>
                    Codex에 연결… <span aria-hidden="true">→</span>
                  </button>
                  {aiMessage && <span className="muted small">{aiMessage}</span>}
                </div>
              ) : (
                <div className="ai-buttons">
                  <button type="button" onClick={async () => setToken((await api.createSession("AI 클라이언트")).token)}>
                    AI 세션 토큰 발급 <span aria-hidden="true">→</span>
                  </button>
                  {token && <ConnectionSnippets token={token} />}
                </div>
              )}
            </section>

            <section className="start-tips" aria-label="알아 두면 좋은 점">
              <ul>
                <li>열었던 문서는 리비전과 함께 앱 안에 남습니다.</li>
                <li>
                  디스크 파일과는 <kbd>Ctrl</kbd>+<kbd>S</kbd> 저장으로 맞춥니다.
                </li>
                <li>
                  새 문서는 탭 줄의 <kbd>+</kbd> 또는 <kbd>Ctrl</kbd>+<kbd>N</kbd>.
                </li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
