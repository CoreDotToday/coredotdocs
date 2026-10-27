"use client";

// HWPX 탭의 본문: 자체 빌드한 rhwp-studio(iframe, chrome=embed, 우리 플러그인 포함)로 WYSIWYG 편집한다.
// 서버 문서(리비전)와의 동기화 규칙 ("진실은 서버, 실행은 편집기" — 설계 문서 04 §9.1):
//  - 사람이 스튜디오에서 고치면 잠시 뒤 문서 전체를 리비전으로 올린다 → AI는 늘 최신 내용 위에서 일한다.
//    감지는 (1) iframe 창의 입력 이벤트(capture) 뒤 짧은 확인과 (2) 느린 폴링으로, 둘 다 값싼 getSelectionContext().changeSeq를 본다.
//    getDocumentState()는 문서 전체 해시라 큰 문서에서 1초쯤 걸리므로 엔진이 선택 문맥을 못 줄 때(표 칸 안 캐럿)만 쓴다.
//  - 라이브 세션: 편집 도구 호출은 서버가 편집기(플러그인)에 넘기고, 편집기가 실행해 내보낸 파일을 서버가 리비전으로 확정한다
//    (이벤트 source "editor-live" → 다시 불러오지 않는다). 세션이 없거나 편집기가 못 하는 일은 서버가 실행하고 편집기가 다시 읽는다.
//  - 다시 읽는 동안에는 올리기를 멈춘다(사용자 타이핑이 AI 편집을 덮어쓰는 경합 방지). 다시 읽은 뒤 바뀐 자리로 커서를 옮긴다.
//  - 편집 화면 위에 놓은 문서 파일은 스튜디오보다 먼저(capture) 받아 새 탭으로 연다. 그림은 스튜디오로 간다.
//  - iframe에 초점이 있으면 단축키를 스튜디오가 삼키므로 capture 단계에서 앱 단축키를 받는다(웹판). 데스크톱은 네이티브 메뉴가 받는다.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createAgentBridge, type AgentBridge } from "@/lib/agent-plugin";
import { ApiError, api } from "@/lib/api";
import { isDesktop } from "@/lib/desktop";
import type { EditorEvent } from "@/lib/format";
import { startLiveSession, type LiveHandle } from "@/lib/live";
import { useShell } from "@/lib/shell";
import { preserveConflictCopy, recoveryNotice } from "@/lib/conflict-recovery";
import { ACTIVITY_EVENTS, STUDIO_ENGINE, detectLocalFonts, documentFiles, mountStudio, studioChangeSeq, toArrayBuffer, type RhwpEditor } from "@/lib/studio";
import type { Tab } from "@/lib/tabs";

export type EditorStatus = { revision?: number; pages?: number; error?: string; loading?: boolean; live?: boolean };

const SLOW_POLL_MS = 4000; // 입력 이벤트를 놓쳤을 때를 위한 느린 확인
const SETTLE_MS = 900; // 마지막 입력 뒤 이만큼 조용하면 올린다

/** 값싼 변경 번호 (표 칸 안 캐럿에서 엔진이 던지면 문서 상태로 물러선다: studioChangeSeq). */
const changeSeqOf = studioChangeSeq;

export function HwpxEditor({ tab, active, lastEvent, liveRequestRef, onStatus }: { tab: Tab; active: boolean; lastEvent: EditorEvent | null; liveRequestRef?: MutableRefObject<((e: EditorEvent) => void) | null>; onStatus: (s: EditorStatus) => void }) {
  const shell = useShell();
  const container = useRef<HTMLDivElement>(null);
  const studioRef = useRef<RhwpEditor | null>(null);
  const knownSeq = useRef(0); // 우리가 불러오거나 올린 서버 리비전
  const uploadedSeq = useRef(0); // 서버가 이미 가진 스튜디오 changeSeq
  const recoveredSeq = useRef<number | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null); // 진행 중인 flush: 부르는 쪽이 같은 약속을 기다린다
  const reloading = useRef(false); // 서버 내용을 다시 읽는 중에는 올리지 않는다
  const settleTimer = useRef<number | null>(null);
  const liveRef = useRef<LiveHandle | null>(null);
  const bridgeRef = useRef<AgentBridge | null>(null);
  const [clientIdValue] = useState(() => `tab-${tab.id.slice(0, 8)}-${Date.now().toString(36)}`); // 이 편집기가 올린 리비전을 알아보는 표식
  const clientId = useRef(clientIdValue);
  const reloadToken = useRef(0); // 겹치는 다시 읽기: 마지막 것만 reloading을 푼다
  const liveBusy = useRef(false); // 라이브 요청을 실행·전송하는 동안: 느린 폴링이 AI 내용을 사용자 리비전으로 올리지 않는다
  const reloadFrom = useRef<(seq: number, place?: EditorEvent["place"]) => () => void>(() => () => {});
  const [ready, setReady] = useState(false);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    statusRef.current = onStatus;
  });
  const shellRef = useRef(shell);
  useEffect(() => {
    shellRef.current = shell;
  });

  /** 올리지 않은 변경을 지금 올린다. 진행 중이면 그 결과를 함께 기다린다. 서버가 거절하면(422) 거짓. */
  function flush(): Promise<boolean> {
    if (inflight.current) return inflight.current;
    const studio = studioRef.current;
    if (!studio || reloading.current || liveBusy.current) return Promise.resolve(false);
    const run = (async () => {
      try {
        const seq = await changeSeqOf(studio);
        if (seq === uploadedSeq.current) return true;
        // 서버 동기화와 디스크 저장은 별개다. 닫기 직전 flush도 저장 안 됨을 표시한다.
        shellRef.current.markDirty(tab.id);
        const base = knownSeq.current;
        const bytes = await studio.exportHwpx();
        const r = await api.pushRevision(tab.id, bytes, tab.filename, undefined, clientId.current, base);
        uploadedSeq.current = seq;
        if (r.changed) knownSeq.current = Math.max(knownSeq.current, r.revision_seq);
        statusRef.current({ revision: knownSeq.current });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // 다시 읽기는 아직 올리지 못한 내용을 복구 사본으로 보관한 뒤에만 진행한다.
          api.getDocument(tab.id).then((d) => reloadFrom.current(d.revision_seq)).catch(() => {});
          return false;
        }
        statusRef.current({ error: `서버에 올리지 못했습니다: ${String(err)}` });
        return false;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }

  /** 입력이 있었다: 조용해지면 올린다. */
  function noteActivity(event: Event) {
    // 입력 직후 닫아도 0.9초 자동 동기화를 기다리기 전에 닫기 보호가 동작해야 한다.
    // 포인터 이동·방향키처럼 문서를 바꾸지 않는 활동은 변경 번호로만 확인한다.
    const key = event.type === "keydown" || event.type === "keyup" ? event as KeyboardEvent : null;
    const editKey = key && !key.altKey && ((!(key.ctrlKey || key.metaKey) && (key.key.length === 1 || ["Backspace", "Delete", "Enter", "Process"].includes(key.key))) || ((key.ctrlKey || key.metaKey) && ["x", "v", "z", "y"].includes(key.key.toLowerCase())));
    if (["input", "paste", "cut", "compositionend"].includes(event.type) || editKey) shellRef.current.markDirty(tab.id);
    else {
      const studio = studioRef.current;
      if (studio && !reloading.current && !liveBusy.current) {
        void changeSeqOf(studio).then((seq) => {
          if (studioRef.current === studio && seq !== uploadedSeq.current) shellRef.current.markDirty(tab.id);
        }).catch(() => {});
      }
    }
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(async () => {
      settleTimer.current = null;
      const studio = studioRef.current;
      if (!studio || reloading.current || liveBusy.current) return;
      try {
        if ((await changeSeqOf(studio)) !== uploadedSeq.current) {
          shellRef.current.markDirty(tab.id);
          await flush();
        }
      } catch {}
    }, SETTLE_MS);
  }

  // 스튜디오 생성·문서 불러오기 ----------------------------------------------------
  useEffect(() => {
    let alive = true;
    let studio: RhwpEditor | null = null;
    const cleanups: (() => void)[] = [];
    statusRef.current({ loading: true });
    (async () => {
      try {
        if (!container.current) return;
        studio = await mountStudio(container.current);
        if (!alive) return studio.destroy();
        studioRef.current = studio;
        const [bytes, doc] = await Promise.all([api.downloadBytes(tab.id), api.getDocument(tab.id)]);
        const result = await studio.loadFile(toArrayBuffer(bytes), tab.filename, { skipUnsavedGuard: true, suppressDialogs: true });
        knownSeq.current = doc.revision_seq;
        uploadedSeq.current = await changeSeqOf(studio);
        cleanups.push(installFrameHooks(studio, noteActivity, shellRef));
        const bridge = createAgentBridge(studio); // 스튜디오마다 하나 (플러그인을 두 번 올리지 않는다)
        bridgeRef.current = bridge;
        shellRef.current.registerStudio(tab.id, { studio, flush, bridge });
        setReady(true);
        statusRef.current({ revision: doc.revision_seq, pages: result.pageCount, loading: false });
        api.reportLayout(tab.id, result.pageCount, doc.revision_seq, STUDIO_ENGINE).catch(() => {});
        // 데스크톱: 설치된 글꼴을 바로 감지한다 (Electron은 Local Font Access를 묻지 않고 허용; 저장된 감지 결과가 있으면 즉시). 웹판은 서식 막대의 "불러오기" 항목(사용자 동작)으로.
        if (isDesktop()) detectLocalFonts(studio).catch(() => {});
      } catch (err) {
        if (alive) statusRef.current({ error: String(err), loading: false });
      }
    })();
    return () => {
      alive = false;
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      cleanups.forEach((c) => c());
      liveRef.current?.stop();
      liveRef.current = null;
      bridgeRef.current = null;
      shellRef.current.registerStudio(tab.id, null);
      studioRef.current = null;
      studio?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // 라이브 세션: 보이는 탭 하나가 가진다. 편집 도구를 이 편집기가 실행한다 (플러그인이 없는 빌드면 알림만 하고 서버 실행) ----
  useEffect(() => {
    const studio = studioRef.current;
    const bridge = bridgeRef.current;
    if (!ready || !active || !studio || !bridge) return;
    const handle = startLiveSession({
      documentId: tab.id,
      studio,
      bridge,
      client: clientId.current,
      beforeExecute: async () => {
        if (reloading.current) return false; // 서버 내용을 다시 읽는 중: 지금은 서버가 실행한다
        return flush(); // 올리지 않은 타이핑은 먼저 사용자 리비전이 된다 (AI 리비전에 섞이지 않는다)
      },
      onApplied: (seq) => {
        uploadedSeq.current = seq; // 서버가 받아들인 변경 — 다시 올리지 않는다
        shellRef.current.markDirty(tab.id);
      },
      onNotice: (m) => shellRef.current.notify(m),
      knownSeq: () => knownSeq.current,
      onBusy: (b) => {
        liveBusy.current = b;
      },
    });
    liveRef.current = handle;
    if (liveRequestRef) liveRequestRef.current = (e) => handle.handle(e);
    statusRef.current({ live: true });
    const onHide = () => handle.stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      handle.stop();
      liveBusy.current = false;
      if (liveRef.current === handle) liveRef.current = null;
      if (liveRequestRef && liveRequestRef.current) liveRequestRef.current = null;
      statusRef.current({ live: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, active, tab.id]);

  // 느린 폴링: 입력 이벤트를 놓친 변경(메뉴 명령 등)도 결국 올라간다 ----------------------
  useEffect(() => {
    if (!ready || !active) return;
    const timer = setInterval(async () => {
      const studio = studioRef.current;
      if (!studio || inflight.current || settleTimer.current || reloading.current || liveBusy.current) return;
      try {
        if ((await changeSeqOf(studio)) !== uploadedSeq.current) {
          shellRef.current.markDirty(tab.id);
          await flush();
        }
      } catch {}
    }, SLOW_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, active, tab.id]);

  // 서버 내용 다시 읽기(AI·외부 편집, 409 뒤) ---------------------------------------------
  function startReload(seq: number, place?: EditorEvent["place"]): () => void {
    const studio = studioRef.current;
    if (!studio) return () => {};
    let alive = true;
    const token = ++reloadToken.current;
    const isCurrent = () => alive && reloadToken.current === token && studioRef.current === studio;
    reloading.current = true;
    if (settleTimer.current) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    (async () => {
      try {
        await inflight.current; // 올리는 중이면 끝나기를 기다린다
        if (!isCurrent()) return;
        if (seq <= knownSeq.current) return; // 그 올리기가 이미 이 리비전(또는 더 새 것)을 만들었다: 자기 내용 위에 다시 읽지 않는다
        const localSeq = await changeSeqOf(studio);
        if (!isCurrent()) return;
        if (localSeq !== uploadedSeq.current && recoveredSeq.current !== localSeq) {
          const localBytes = await studio.exportHwpx();
          if (!isCurrent()) return;
          const title = await preserveConflictCopy(localBytes, tab.filename, "hwpx");
          shellRef.current.notify(recoveryNotice(title));
          if (!isCurrent()) return;
          recoveredSeq.current = localSeq;
        }
        const bytes = await api.downloadBytes(tab.id);
        if (!isCurrent()) return;
        const currentSeq = await changeSeqOf(studio);
        if (!isCurrent()) return;
        if (currentSeq !== localSeq) {
          statusRef.current({ error: "동기화 중 새로 입력한 내용을 유지했습니다. 저장을 다시 눌러 최신 편집 내용을 보관하세요." });
          return;
        }
        const result = await studio.loadFile(toArrayBuffer(bytes), tab.filename, { skipUnsavedGuard: true, suppressDialogs: true });
        if (!isCurrent()) return;
        knownSeq.current = Math.max(knownSeq.current, seq);
        uploadedSeq.current = await changeSeqOf(studio);
        recoveredSeq.current = null;
        shellRef.current.markDirty(tab.id);
        statusRef.current({ revision: knownSeq.current, pages: result.pageCount });
        api.reportLayout(tab.id, result.pageCount, knownSeq.current, STUDIO_ENGINE).catch(() => {});
        // 바뀐 자리로 화면을 옮긴다 (A11). 표 칸 안은 표를 담은 문단으로 간다. 실패해도 조용히.
        if (place) studio.focusTarget({ kind: "body_paragraph", section: place.section, paragraph: place.paragraph, charOffset: 0, length: place.length }).catch(() => {});
      } catch (err) {
        if (!isCurrent()) return;
        statusRef.current({ error: String(err) });
        shellRef.current.notify(String(err), "error");
      } finally {
        if (reloadToken.current === token) reloading.current = false; // 뒤에 또 다시 읽기가 시작됐으면 그쪽이 푼다
      }
    })();
    return () => {
      alive = false;
    };
  }
  useEffect(() => {
    reloadFrom.current = startReload;
  });

  // AI·외부 편집 반영 ----------------------------------------------------------------
  useEffect(() => {
    if (!ready || !studioRef.current || !lastEvent) return;
    if (lastEvent.type !== "edit" && lastEvent.type !== "undo") return;
    const seq = lastEvent.revision_seq ?? 0;
    if (seq <= knownSeq.current) return;
    if (lastEvent.client && lastEvent.client === clientId.current) {
      // 이 편집기가 올린(또는 실행한) 리비전: 화면이 이미 그 내용이다. 다른 편집기의 것은 다시 읽는다.
      knownSeq.current = seq;
      statusRef.current({ revision: seq });
      return;
    }
    return reloadFrom.current(seq, lastEvent.place);
  }, [lastEvent, ready, tab.id]);

  return <div className="studio-host" ref={container} data-testid="studio-host" data-ready={ready ? "1" : "0"} />;
}

/**
 * iframe(같은 출처) 창에 capture 리스너를 단다: 입력 활동, 문서 파일 드롭, 앱 단축키.
 * 스튜디오보다 먼저 받아야 하므로 capture이고, 돌려주는 함수로 모두 뗀다.
 */
function installFrameHooks(studio: RhwpEditor, onActivity: (event: Event) => void, shellRef: React.MutableRefObject<ReturnType<typeof useShell>>): () => void {
  const w = studio.element.contentWindow;
  if (!w) return () => {};
  const offs: (() => void)[] = [];
  const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
    w.addEventListener(type, fn, true);
    offs.push(() => w.removeEventListener(type, fn, true));
  };
  for (const t of ACTIVITY_EVENTS) on(t, onActivity);
  on("keydown", onActivity);

  on("dragover", (e) => {
    if (documentFiles(e.dataTransfer?.files).length || Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) e.dataTransfer!.dropEffect = "copy";
  });
  on("drop", (e) => {
    const docs = documentFiles(e.dataTransfer?.files);
    if (!docs.length) return; // 그림 등은 스튜디오가 처리한다
    e.preventDefault();
    e.stopImmediatePropagation();
    (async () => {
      const files = await Promise.all(docs.map(async (f) => ({ name: f.name, data: await f.arrayBuffer(), path: pathOf(f) })));
      await shellRef.current.openLocalFiles(files);
    })();
  });

  if (!isDesktop()) {
    on("keydown", (e) => {
      if (e.key === "F1" && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        shellRef.current.openHelp();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const shell = shellRef.current;
      const active = shell.activeTabId();
      let handled = true;
      if (k === "s" || k === "ㄴ") {
        if (active) shell.save(active, e.shiftKey);
      } else if (k === "o" || k === "ㅐ") shell.openFileDialog();
      else if (k === "w" || k === "ㅈ") {
        if (active) shell.closeTab(active);
      } else if (k === "j" || k === "ㅓ") shell.toggleAi();
      else if (k === "p" || k === "ㅔ") {
        if (active) shell.printDocument(active);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
  }
  return () => offs.forEach((f) => f());
}

function pathOf(f: File): string | undefined {
  try {
    return window.coredotdocs?.pathForFile(f) || undefined;
  } catch {
    return undefined;
  }
}
