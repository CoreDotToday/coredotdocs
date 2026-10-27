"use client";

// 창 위쪽 탭 줄. 별도 WebContents가 아니라 같은 페이지 안에 둔다.
import { useShell } from "@/lib/shell";
import { readableTitle, useWorkspace, workspace } from "@/lib/tabs";

export function TabBar() {
  const shell = useShell();
  const ws = useWorkspace();
  return (
    <div className="tabbar" role="tablist" aria-label="열린 문서">
      <span className="brand" title="Core.Docs">
        Core.Docs
      </span>
      {ws.tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === ws.activeId} className={`tab ${t.id === ws.activeId ? "is-active" : ""}`} onMouseDown={(e) => e.button === 1 && shell.closeTab(t.id)}>
          <button type="button" className="tab-title" onClick={() => workspace.activate(t.id)} title={t.path ?? t.filename}>
            {t.dirty && <span className="dirty" aria-label="저장 안 됨">●</span>}
            {readableTitle(t.title)}
            <span className={`tag ${t.format}`}>{t.format}</span>
          </button>
          <button type="button" className="tab-close" aria-label={`${t.title} 탭 닫기`} onClick={() => shell.closeTab(t.id)}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="tab-new" title="새 문서 (Ctrl+N)" aria-label="새 문서" onClick={() => shell.newDocument("hwpx")}>
        +
      </button>
      <span className="spacer" />
      <button type="button" className="tab-home" title="코어닷독스 도움말 (F1)" onClick={() => shell.openHelp()}>도움말</button>
      {ws.tabs.length > 0 && (
        <button type="button" className="tab-home" title="시작 화면" onClick={() => workspace.activate("")}>
          시작 화면
        </button>
      )}
    </div>
  );
}
