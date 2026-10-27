"use client";

// 탭 하나의 화면: 메뉴·도구 막대 + 본문(HWPX는 rhwp-studio, DOCX는 Tiptap 편집기) + AI 사이드바 + "AI가 … 중" 알림.
// 모든 탭을 그대로 두고 display로만 숨긴다 — iframe을 DOM에서 떼면 편집 상태가 사라진다(@rhwp/editor 안내).
import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorEvent } from "@/lib/format";
import { useShell } from "@/lib/shell";
import type { FormatSource } from "@/lib/format-source";
import { studioFormatSource, type RhwpEditor } from "@/lib/studio";
import { api } from "@/lib/api";
import { useWorkspace, type Tab } from "@/lib/tabs";
import { AiSidebar } from "./AiSidebar";
import { DocxEditor } from "./DocxEditor";
import { EditorChrome } from "./EditorChrome";
import { HwpxEditor, type EditorStatus } from "./HwpxEditor";

const TOOL_LABELS: Record<string, string> = {
  replace_text: "글을 바꾸는",
  set_paragraph_text: "문단을 고치는",
  insert_content: "내용을 넣는",
  delete_blocks: "블록을 지우는",
  set_table_cells: "표 칸을 채우는",
  format_table: "표 모양을 바꾸는",
  insert_table_rows: "표 줄을 넣는",
  delete_table_rows: "표 줄을 지우는",
  insert_table: "표를 넣는",
  insert_image: "그림을 넣는",
  fill_fields: "누름틀을 채우는",
  list_fonts: "설치된 글꼴을 읽는",
  format_text: "글자 모양을 바꾸는",
  format_paragraphs: "문단 모양을 바꾸는",
  undo_last_edit: "되돌리는",
};

export function DocumentView({ tab, active }: { tab: Tab; active: boolean }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [events, setEvents] = useState<EditorEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<EditorEvent | null>(null);
  const onLiveRequest = useRef<((e: EditorEvent) => void) | null>(null); // HwpxEditor가 라이브 세션을 열 때 채운다
  const [status, setStatus] = useState<EditorStatus>({ loading: true });
  const [studio, setStudio] = useState<RhwpEditor | null>(null);
  const [docxSource, setDocxSource] = useState<FormatSource | null>(null); // DocxEditor가 준비되면 준다
  const formatSource = useMemo(() => (tab.format === "hwpx" ? (studio ? studioFormatSource(studio) : null) : docxSource), [tab.format, studio, docxSource]);
  const [aiWorking, setAiWorking] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 서버 이벤트(SSE): 편집·되돌리기·AI 활동·라이브 요청. 보이는 탭만 연다 — 브라우저는 출처당 연결 6개가 상한이라
  // 탭마다 열어 두면 모든 요청이 줄을 선다. 다시 보일 때는 서버 머리를 읽어 따라잡는다(그 사이의 편집).
  useEffect(() => {
    if (!active) return;
    const source = new EventSource(api.eventsUrl(tab.id));
    let open = true;
    // 따라잡기: 연결될 때마다(처음·재연결) 서버 머리를 읽어, 안 보이던/끊겼던 사이의 편집을 한 번 다시 읽는다
    const catchUp = () =>
      api
        .getDocument(tab.id)
        .then((d) => {
          if (!open) return;
          setLastEvent((prev) => (prev?.revision_seq === d.revision_seq ? prev : { type: "edit", document_id: tab.id, revision_seq: d.revision_seq, summary: "따라잡기" }));
        })
        .catch(() => {});
    const handle = (e: MessageEvent) => {
      const event = JSON.parse(e.data) as EditorEvent;
      if (event.type === "live-request") {
        onLiveRequest.current?.(event); // 편집기로 바로 — lastEvent를 거치면 진행 중인 다시 읽기를 끊는다
        return;
      }
      setEvents((prev) => [...prev.slice(-199), event]);
      if (event.type === "ready") {
        setConnected(true);
        void catchUp();
      }
      if (event.type === "edit" || event.type === "undo") setLastEvent(event);
      if (event.type === "activity" && event.actor === "ai") {
        if (event.phase === "start") {
          if (hideTimer.current) clearTimeout(hideTimer.current);
          setAiWorking(event.tool ?? "");
        } else {
          if (hideTimer.current) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(() => setAiWorking(null), 1500);
        }
      }
    };
    for (const kind of ["ready", "edit", "undo", "activity", "live-request"]) source.addEventListener(kind, handle as EventListener);
    source.onerror = () => setConnected(false);
    return () => {
      open = false;
      source.close();
      setConnected(false);
    };
  }, [tab.id, active]);

  // 스튜디오 핸들은 셸 레지스트리에서 가져온다 (HwpxEditor가 등록)
  useEffect(() => {
    if (tab.format !== "hwpx") return;
    const timer = setInterval(() => {
      const s = shell.getStudio(tab.id)?.studio ?? null;
      setStudio((prev) => (prev === s ? prev : s));
    }, 300);
    return () => clearInterval(timer);
  }, [shell, tab.id, tab.format]);

  const working = aiWorking !== null;
  return (
    <section className="docview" style={{ display: active ? "flex" : "none" }} aria-label={`문서 ${tab.title}`} data-testid={`docview-${tab.id}`} aria-hidden={!active}>
      <EditorChrome tab={tab} studio={studio} formatSource={formatSource} status={status} aiOpen={ws.aiOpen} chatBusy={chatBusy} active={active} />
      {working && (
        <div className="ai-banner" role="status">
          <span className="spinner" /> AI가 {TOOL_LABELS[aiWorking ?? ""] ?? "문서를 고치는"} 중… 끝나면 화면에 바로 반영됩니다.
          {!connected && <span className="muted"> (실시간 연결 끊김)</span>}
        </div>
      )}
      <div className="docview-body">
        <div className="editor-host">
          {tab.format === "hwpx" ? <HwpxEditor tab={tab} active={active} lastEvent={lastEvent} liveRequestRef={onLiveRequest} onStatus={(s) => setStatus((prev) => ({ ...prev, ...s }))} /> : <DocxEditor tab={tab} active={active} lastEvent={lastEvent} liveRequestRef={onLiveRequest} onStatus={(s) => setStatus((prev) => ({ ...prev, ...s }))} onFormatSource={setDocxSource} />}
        </div>
        {ws.aiOpen && <AiSidebar tab={tab} events={events} revision={status.revision ?? 1} onBusy={setChatBusy} />}
      </div>
    </section>
  );
}
