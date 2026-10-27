"use client";

// 문서 오른쪽의 AI 패널: 앱 내 채팅, AI 활동 로그·도구 콘솔, 찾기, 리비전.
import { useCallback, useEffect, useState } from "react";
import type { AgentBridge } from "@/lib/agent-plugin";
import { api, serverDate, type Revision } from "@/lib/api";
import type { EditorEvent } from "@/lib/format";
import type { RhwpEditor } from "@/lib/studio";
import { useShell } from "@/lib/shell";
import type { Tab } from "@/lib/tabs";
import { AiPanel } from "./AiPanel";
import { ChatPanel } from "./ChatPanel";
import { FindPanel } from "./FindPanel";

export function AiSidebar({ tab, events, revision, onBusy }: { tab: Tab; events: EditorEvent[]; revision: number; onBusy: (busy: boolean) => void }) {
  const shell = useShell();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [section, setSection] = useState<"chat" | "tools" | "find" | "history">("chat");

  useEffect(() => {
    api.getRevisions(tab.id).then(setRevisions).catch(() => {});
  }, [tab.id, revision, events.length]);

  // 편집기 플러그인 다리 (스튜디오마다 하나). 선택 조회·표시 지우기·바뀐 곳 보기에 쓴다.
  const [studio, setStudio] = useState<RhwpEditor | null>(null);
  const [bridge, setBridge] = useState<AgentBridge | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      const h = shell.getStudio(tab.id) ?? null;
      setStudio((prev) => (prev === (h?.studio ?? null) ? prev : (h?.studio ?? null)));
      setBridge((prev) => (prev === (h?.bridge ?? null) ? prev : (h?.bridge ?? null)));
    }, 500);
    return () => clearInterval(t);
  }, [shell, tab.id]);
  const getSelection = useCallback(async () => {
    if (!bridge) return null;
    const r = await bridge.selection();
    if (!r.ok || r.own) return null;
    return { text: r.segments.map((seg) => seg.text).join("\n"), segments: r.segments.length };
  }, [bridge]);
  // 도구로 들어온 편집(앱 내 AI, 외부 MCP, 도구 콘솔)과 되돌리기. 편집기에서 직접 친 것(source editor)은 뺀다.
  const changes = events.filter((e) => (e.type === "edit" && e.source !== "editor" && !!e.tool) || e.type === "undo");

  function jump(blockNo: number) {
    window.dispatchEvent(new CustomEvent("coredotdocs:jump", { detail: { documentId: tab.id, blockNo } }));
  }

  return (
    <aside className="sidebar print-hide" aria-label="AI 패널">
      <nav className="sidebar-tabs" aria-label="패널 선택">
        {(
          [
            ["chat", "AI 채팅"],
            ["tools", "활동·도구"],
            ["find", "찾기"],
            ["history", `리비전 ${revision}`],
          ] as const
        ).map(([id, label]) => (
          <button type="button" key={id} className={section === id ? "is-on" : ""} onClick={() => setSection(id)} aria-pressed={section === id}>
            {label}
          </button>
        ))}
      </nav>
      <div className="sidebar-body">
        <div style={{ display: section === "chat" ? "block" : "none" }}>
          {changes.length > 0 && (
            <section className="panel changes" aria-label="AI가 바꾼 곳">
              <div className="row">
                <h2>바뀐 곳 {changes.length}</h2>
                {bridge && (
                  <button type="button" className="link" onClick={() => bridge.clearMarks().catch(() => {})}>
                    표시 지우기
                  </button>
                )}
                <button type="button" className="link" onClick={() => shell.undoAi(tab.id)} disabled={revision <= 1}>
                  AI 편집 되돌리기
                </button>
              </div>
              <ol className="change-list">
                {changes
                  .slice(-8)
                  .reverse()
                  .map((e, i) => (
                    <li key={`${e.revision_seq}-${i}`}>
                      <button
                        type="button"
                        className="link"
                        disabled={!e.place || !studio}
                        title={e.place ? "그 자리로 이동" : "자리 정보 없음"}
                        onClick={() => e.place && studio?.focusTarget({ kind: "body_paragraph", section: e.place.section, paragraph: e.place.paragraph, charOffset: 0, length: e.place.length }).catch(() => {})}
                      >
                        리비전 {e.revision_seq}
                      </button>{" "}
                      {e.summary ?? e.tool ?? e.type}
                    </li>
                  ))}
              </ol>
            </section>
          )}
          <ChatPanel documentId={tab.id} onChanged={() => {}} onBeforeSend={() => shell.flush(tab.id)} onBusy={onBusy} getSelection={tab.format === "hwpx" ? getSelection : undefined} />
        </div>
        {section === "tools" && <AiPanel documentId={tab.id} events={events} onChanged={() => {}} />}
        {section === "find" && (
          <>
            <FindPanel documentId={tab.id} onJump={jump} />
            {tab.format === "hwpx" && <p className="muted">서버 인덱스(블록 번호 기준)에서 찾습니다. 편집기 안에서 찾아 바꾸려면 도구 막대의 찾기(Ctrl+F)를 쓰세요.</p>}
          </>
        )}
        {section === "history" && (
          <section className="panel">
            <div className="row">
              <h2>리비전</h2>
              <button type="button" onClick={() => shell.undoAi(tab.id)} disabled={revision <= 1}>
                한 단계 되돌리기
              </button>
            </div>
            <p className="muted">편집기에서 고친 내용과 AI의 편집이 모두 리비전으로 남습니다. 되돌리면 과거 내용이 새 리비전으로 복제됩니다.</p>
            <ol className="revisions">
              {revisions
                .slice()
                .reverse()
                .map((r) => (
                  <li key={r.seq}>
                    <b>{r.seq}</b> <span className={`tag ${r.actor}`}>{r.actor}</span> {r.summary} <span className="muted small">{serverDate(r.created_at).toLocaleTimeString("ko-KR")}</span>
                  </li>
                ))}
            </ol>
          </section>
        )}
      </div>
    </aside>
  );
}
