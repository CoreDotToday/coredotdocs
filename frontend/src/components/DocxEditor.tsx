"use client";

// DOCX 탭의 본문: Tiptap 편집기(third_party/genoffice-docx의 편집기 핵심, 우리 래퍼 lib/docx-editor.ts) — 자유 타이핑, 쪽 모양(쪽 사이 띠),
// 서식 막대, 자동 저장(paragraph-patch로 내보내 서버 리비전으로), AI·외부 편집 다시 읽기, 라이브 세션(선택 읽기/바꾸기 + "먼저 올리기").
//
// 동기화 규칙(HWPX 편집기와 같다, 설계 문서 02 §9): 진실은 서버 리비전. 타이핑은 1.2초 쉬면 올린다(작업 시작 때의 기준 리비전을
// X-Editor-Base로 → 낡은 머리 위 덮어쓰기는 409). 저장 계획은 늘 "연 리비전"의 모델과 비교한다(올린 뒤 다시 읽지 않아 실행 취소가 이어진다).
// 서버 리비전이 다른 곳(AI·다른 창)에서 올라가면 먼저 올린 뒤 다시 읽고 바뀐 블록을 잠시 표시한다. 올리기·다시 읽기는 한 줄로 차례를 선다.
// 내용 바꿔 넣기(처음·다시 읽기)는 실행 취소 기록에 남기지 않는다. AI 도구가 오면(live-request) 먼저 올리고, 선택 범위 도구는 편집기가,
// 나머지는 서버가 실행한다(LIVE_FALLBACK). 편집기가 실행한 변경은 사용자 편집으로 치지 않으며 서버가 거절하면 "undo" 요청으로 되돌린다.
import { Selection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api, ApiError, type Block, type LiveRequest } from "@/lib/api";
import type { Editor } from "@tiptap/core";
import { docxApplyChar, docxApplyPara, docxBlockElement, docxContent, docxContentChanged, docxExtensions, docxGeometry, docxNotes, docxPrintHtml, docxReplaceSelection, docxSelectionText, docxStyleSheet, docxFormatSource, DOCX_ENGINE, editFootnote, editStrip, exportDocx, footnoteText, paginateDocx, type CanvasGeometry, type DocxModel } from "@/lib/docx-editor";
import { editorIndexOf, openDocx } from "@/lib/docx-engine";
import type { EditorEvent } from "@/lib/format";
import type { FormatSource } from "@/lib/format-source";
import { startLiveSession, type LiveHandle } from "@/lib/live";
import { useShell } from "@/lib/shell";
import { preserveConflictCopy, recoveryNotice } from "@/lib/conflict-recovery";
import type { Tab } from "@/lib/tabs";
import type { EditorStatus } from "./HwpxEditor";
import { PageSetupDialog } from "./PageSetupDialog";
import { PAGE_SETUP_EVENT } from "@/lib/page-setup";

const SAVE_DEBOUNCE_MS = 1200;
const PAGINATE_DEBOUNCE_MS = 250;
const EMPTY_DOC = { type: "doc", content: [{ type: "docParagraph", attrs: { docxIndex: null, styleId: null, aiChanged: false } }] };

type Props = { tab: Tab; active: boolean; lastEvent: EditorEvent | null; liveRequestRef?: MutableRefObject<((e: EditorEvent) => void) | null>; onStatus: (s: EditorStatus) => void; onFormatSource: (s: FormatSource | null) => void };

export function DocxEditor({ tab, active, lastEvent, liveRequestRef, onStatus, onFormatSource }: Props) {
  const shell = useShell();
  const [clientId] = useState(() => `docx-${Math.random().toString(36).slice(2, 10)}`);
  const model = useRef<DocxModel | null>(null);
  const knownSeq = useRef(0);
  const dirty = useRef(false);
  const editSeq = useRef(0); // 사용자 편집마다 하나씩 (다시 읽는 사이 친 글을 알아챈다)
  const recoveredSeq = useRef<number | null>(null);
  const applying = useRef(false); // 내용 바꿔 넣기·AI 실행 중: update를 사용자 편집으로 치지 않는다
  const pages = useRef(1);
  const saveTimer = useRef<number | null>(null);
  const pageTimer = useRef<number | null>(null);
  const pageTimerFollow = useRef<number | null>(null);
  const paginateRef = useRef<() => void>(() => {});
  const [noteEdit, setNoteEdit] = useState<{ id: string; text: string; base: string; geo: CanvasGeometry } | null>(null);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const inflight = useRef<Promise<boolean>>(Promise.resolve(true));
  const zoomEl = useRef<HTMLDivElement>(null);
  const pageWrap = useRef<HTMLDivElement>(null);
  const geometry = useRef<CanvasGeometry | null>(null);
  const [pageVars, setPageVars] = useState<Record<string, string>>({});
  const [styleSheet, setStyleSheet] = useState("");
  const [notes, setNotes] = useState<ReturnType<typeof docxNotes>>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const statusRef = useRef(onStatus);
  const shellRef = useRef(shell);
  useEffect(() => {
    statusRef.current = onStatus;
    shellRef.current = shell;
  });

  const extensions = useMemo(() => docxExtensions(), []);
  const editor = useEditor({
    extensions,
    content: EMPTY_DOC,
    immediatelyRender: false,
    editorProps: { attributes: { class: "doc-page", spellcheck: "false", "data-testid": "docx-canvas" } },
    onUpdate: ({ transaction }) => {
      if (!transaction.docChanged) return;
      docxContentChanged(geometry.current); // 여러 단 너비 기록은 본문이 바뀌면 다시 잰다
      if (applying.current) return;
      editSeq.current += 1;
      dirty.current = true;
      shellRef.current.markDirty(tab.id);
      scheduleSave();
      schedulePaginate();
    },
  });
  const editorRef = useRef<typeof editor>(null);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const reloadNowRef = useRef<(changedBlocks: number[] | undefined) => Promise<boolean>>(async () => false);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // 쪽 나누기 ------------------------------------------------------------------------
  const paginate = useCallback(() => {
    const ed = editorRef.current;
    const geo = geometry.current;
    if (!ed || ed.isDestroyed || !geo || !ed.view.dom.isConnected) return;
    try {
      const r = paginateDocx(ed, geo, zoomEl.current, pageWrap.current);
      if (!r) return; // 머리말·꼬리말을 고치는 중: 띠를 다시 만들지 않는다 (닫힐 때 다시 나눈다)
      pages.current = r.pages;
      statusRef.current({ pages: r.pages });
      if (r.followUp) pageTimerFollow.current = window.setTimeout(() => paginateRef.current(), 0); // 여러 단: 너비가 바뀌어 줄이 다시 나뉘었다
    } catch (err) {
      console.warn("[docx] pagination failed", err);
    }
  }, []);
  useEffect(() => {
    paginateRef.current = paginate;
  }, [paginate]);
  const schedulePaginate = useCallback(() => {
    if (pageTimer.current) window.clearTimeout(pageTimer.current);
    pageTimer.current = window.setTimeout(() => {
      pageTimer.current = null;
      paginate();
    }, PAGINATE_DEBOUNCE_MS);
  }, [paginate]);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // 내용 넣기 (처음·다시 읽기·rebase) ------------------------------------------------
  const setModel = useCallback(
    (next: DocxModel, keepSelection: boolean) => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) return;
      // 새 내용 위에서는 옛 기하의 띠 편집기·각주 창이 뜻이 없다 (확정할 것은 부르는 쪽이 먼저 확정했다)
      geometry.current?.editingStrip?.discard();
      setNoteEdit(null);
      const sel = keepSelection ? { from: ed.state.selection.from, to: ed.state.selection.to } : null;
      const stored = keepSelection ? ed.state.storedMarks : null; // 서식 막대로 고른 "다음 입력부터" 서식은 다시 읽어도 남긴다
      applying.current = true;
      try {
        // 한 트랜잭션으로 바꿔 넣고 실행 취소 기록에 남기지 않는다 (⌘Z가 빈 문서·옛 모델의 블록으로 돌아가지 않게)
        const doc = ed.schema.nodeFromJSON(docxContent(next));
        const tr = ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc.content).setMeta("addToHistory", false).setMeta("preventUpdate", true);
        if (sel) {
          const max = tr.doc.content.size;
          tr.setSelection(Selection.near(tr.doc.resolve(Math.min(sel.from, max))));
        }
        if (stored?.length) tr.setStoredMarks(stored);
        ed.view.dispatch(tr);
      } finally {
        applying.current = false;
      }
      model.current = next;
      const geo = docxGeometry(next);
      geometry.current = geo;
      setPageVars(geo?.vars ?? {});
      setStyleSheet(docxStyleSheet(next, tab.id));
      setNotes(docxNotes(next));
      schedulePaginate();
    },
    [schedulePaginate, tab.id],
  );

  /** 본문 밖(머리말·꼬리말·각주)을 고쳤다: 사용자 편집으로 치고 올리기를 예약한다 */
  const markChanged = useCallback(() => {
    editSeq.current += 1;
    dirty.current = true;
    shellRef.current.markDirty(tab.id);
    scheduleSave();
  }, [tab.id, scheduleSave]);

  // 쪽 화면의 두 번 클릭: 머리말·꼬리말 띠는 그 자리에서, 각주는 작은 창에서 고친다
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const geo = geometry.current;
      const target = e.target as HTMLElement;
      if (!geo) return;
      const stripEl = target.closest<HTMLElement>(".page-gap-hf, .cdd-edge-hf");
      if (stripEl && !stripEl.classList.contains("page-hf-editing")) {
        e.preventDefault();
        e.stopPropagation();
        const started = editStrip(
          geo,
          stripEl,
          () => {
            setPageVars(geo.vars); // 머리말 높이가 바뀌면 첫 쪽 본문 위치도 바뀐다
            markChanged();
          },
          () => schedulePaginate(),
        );
        if (started) statusRef.current({ error: undefined });
        return;
      }
      const noteEl = target.closest<HTMLElement>(".page-gap-note");
      const id = noteEl?.dataset.noteId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        const base = footnoteText(geo, id) ?? "";
        setNoteEdit({ id, text: base, base, geo });
        return;
      }
      // 용지 여백(본문 밖)을 두 번 누르면 편집 용지 (Word가 눈금자를 두 번 누르면 쪽 설정을 여는 것과 같은 자리)
      if (inPageMargin(e.currentTarget as HTMLElement, target, e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopPropagation();
        setPageSetupOpen(true);
      }
    },
    [markChanged, schedulePaginate],
  );

  // 올리기 ---------------------------------------------------------------------------
  const flush = useCallback((): Promise<boolean> => {
    const job = async (): Promise<boolean> => {
      const ed = editorRef.current;
      const m = model.current;
      if (!ed || ed.isDestroyed || !m || !dirty.current) return true;
      const snapshot = ed.state.doc;
      const seqAtStart = editSeq.current; // 본문 밖 편집(머리말·각주)은 문서 노드를 바꾸지 않으므로 편집 번호로도 본다
      const base = knownSeq.current; // 이 내용이 기대는 리비전: 내보내는 동안 다른 일이 knownSeq를 올려도 이것을 보낸다
      try {
        const { bytes, changed } = await exportDocx(ed, m, pages.current, geometry.current);
        if (changed === 0) {
          if (ed.state.doc === snapshot && editSeq.current === seqAtStart) {
            dirty.current = false;
          }
          return true;
        }
        const r = await api.pushRevision(tab.id, bytes, tab.filename, "편집기에서 고침", clientId, base);
        if (r.changed) knownSeq.current = Math.max(knownSeq.current, r.revision_seq);
        statusRef.current({ revision: knownSeq.current, error: undefined });
        api.reportLayout(tab.id, pages.current, knownSeq.current, DOCX_ENGINE).catch(() => {});
        if (ed.state.doc === snapshot && editSeq.current === seqAtStart) {
          dirty.current = false;
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // 충돌한 사용자 편집은 복구 사본으로 보관한 뒤 서버 내용을 읽는다.
          await reloadNowRef.current(undefined); // 이미 줄 안이다: 줄을 다시 서지 않는다
          return false;
        }
        statusRef.current({ error: String(err) });
        return false;
      }
    };
    const p = inflight.current.then(job, job);
    inflight.current = p;
    return p;
  }, [tab.id, tab.filename, clientId]);

  // 서버에서 다시 읽기 (줄 밖에서 부르지 말 것: reload를 쓴다) ------------------------------------
  const reloadNow = useCallback(
    async (changedBlocks: number[] | undefined) => {
      try {
        const typedBefore = editSeq.current;
        if (dirty.current && recoveredSeq.current !== typedBefore) {
          const ed = editorRef.current;
          const localModel = model.current;
          if (!ed || ed.isDestroyed || !localModel) return false;
          const local = await exportDocx(ed, localModel, pages.current, geometry.current);
          const title = await preserveConflictCopy(local.bytes, tab.filename, "docx");
          recoveredSeq.current = typedBefore;
          shellRef.current.notify(recoveryNotice(title));
        }
        const [bytes, meta] = await Promise.all([api.downloadBytes(tab.id), api.getDocument(tab.id)]);
        const next = await openDocx(bytes);
        if (editSeq.current !== typedBefore) {
          statusRef.current({ error: "동기화 중 새로 입력한 내용을 유지했습니다. 저장을 다시 눌러 최신 편집 내용을 보관하세요." });
          return false;
        }
        const changedSinceLoad = knownSeq.current > 0 && meta.revision_seq !== knownSeq.current;
        knownSeq.current = Math.max(knownSeq.current, meta.revision_seq);
        dirty.current = false;
        // 리비전을 읽거나 올려도 디스크 파일은 바뀌지 않는다. 실제 저장만 이 표시를 푼다.
        if (changedSinceLoad) shellRef.current.markDirty(tab.id);
        setModel(next, true);
        recoveredSeq.current = null;
        setError(null);
        statusRef.current({ revision: meta.revision_seq, loading: false, error: undefined });
        if (changedBlocks?.length) {
          const list = await api.getBlocks(tab.id);
          const ed = editorRef.current;
          if (!ed) return true;
          let first: HTMLElement | null = null;
          for (const no of changedBlocks) {
            const b = list.blocks.find((x) => x.no === no);
            const el = b ? blockElementFor(ed, model.current, b) : null;
            if (!el) continue;
            el.classList.add("cdd-changed");
            setTimeout(() => el.classList.remove("cdd-changed"), 4000);
            first ??= el;
          }
          first?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return true;
      } catch (err) {
        setError(`문서를 읽지 못했습니다: ${String(err)}`);
        statusRef.current({ loading: false, error: String(err) });
        shellRef.current.notify(String(err), "error");
        return false;
      }
    },
    [tab.id, tab.filename, setModel],
  );
  /** 올리기와 같은 줄에 서서 다시 읽는다. atLeast보다 새 리비전을 이미 알면 건너뛴다. */
  const reload = useCallback(
    (changedBlocks: number[] | undefined, atLeast = 0): Promise<boolean> => {
      const job = async () => {
        if (atLeast > 0 && knownSeq.current >= atLeast) return true;
        return reloadNow(changedBlocks);
      };
      const p = inflight.current.then(job, job);
      inflight.current = p;
      return p;
    },
    [reloadNow],
  );

  useEffect(() => {
    flushRef.current = flush;
    reloadNowRef.current = reloadNow;
  }, [flush, reloadNow]);

  // 처음 읽기
  useEffect(() => {
    if (!editor) return;
    let alive = true;
    statusRef.current({ loading: true });
    (async () => {
      const loaded = await reload(undefined);
      if (!alive || !loaded) return;
      setReady(true);
      try {
        await document.fonts.ready;
      } catch {}
      if (alive) paginate();
    })();
    return () => {
      alive = false;
    };
  }, [editor, reload, paginate]);

  // AI·외부 편집 반영
  useEffect(() => {
    if (!ready || !lastEvent || (lastEvent.type !== "edit" && lastEvent.type !== "undo")) return;
    const seq = lastEvent.revision_seq ?? 0;
    if (seq <= knownSeq.current) return;
    if (lastEvent.client && lastEvent.client === clientId) {
      knownSeq.current = seq; // 이 편집기가 올린 리비전: 화면이 이미 그 내용이다
      statusRef.current({ revision: seq });
      return;
    }
    let alive = true;
    (async () => {
      geometry.current?.editingStrip?.exit(); // 고치던 머리말·꼬리말을 확정해 함께 올린다
      if (dirty.current && !(await flush())) return; // 복구에 실패하면 로컬 버퍼를 그대로 둔다.
      if (!alive) return;
      await reload(lastEvent.blocks, seq);
      if (alive && lastEvent.actor === "ai") shellRef.current.markDirty(tab.id);
    })();
    return () => {
      alive = false;
    };
  }, [lastEvent, ready, clientId, flush, reload, tab.id]);

  // 셸: 저장·AI 전에 올리기 / 탭이 숨거나 창을 떠날 때도
  useEffect(() => {
    shell.registerPrintRenderer(tab.id, async () => {
      geometry.current?.editingStrip?.exit();
      if (!(await flush())) throw new Error("문서 내용을 보관하지 못해 인쇄를 중단했습니다.");
      const ed = editorRef.current, m = model.current, geo = geometry.current;
      if (!ed || ed.isDestroyed || !m || !geo) throw new Error("편집기가 아직 준비되지 않았습니다.");
      return docxPrintHtml(ed, m, geo, tab.id, tab.title);
    });
    return () => shell.registerPrintRenderer(tab.id, null);
  }, [shell, tab.id, tab.title, flush]);

  useEffect(() => {
    shell.registerFlusher(tab.id, () => {
      geometry.current?.editingStrip?.exit(); // 저장·AI 전에 고치던 머리말·꼬리말을 확정한다
      return flush();
    });
    const onHide = () => {
      if (document.visibilityState === "hidden" && dirty.current) void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      shell.registerFlusher(tab.id, null);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [shell, tab.id, flush]);
  useEffect(() => {
    if (!active && dirty.current) void flush();
  }, [active, flush]);

  // 창 크기·글꼴 로드 뒤 다시 쪽 나누기
  useEffect(() => {
    if (!ready) return;
    const onResize = () => schedulePaginate();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ready, schedulePaginate]);

  // 설치 글꼴: 데스크톱은 서식 막대가 메인 프로세스의 목록을 직접 쓴다(installed-fonts.ts). 여기서는 웹판의 "불러오기"(사용자 동작)만 맡는다.

  // 편집 용지: 메뉴(파일 › 편집 용지…, 데스크톱 F7)는 창 이벤트로, 웹판 F7은 여기서
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId === tab.id) setPageSetupOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F7" || !active || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setPageSetupOpen(true);
    };
    window.addEventListener(PAGE_SETUP_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(PAGE_SETUP_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [tab.id, active]);
  const flushForDialog = useCallback(async () => {
    geometry.current?.editingStrip?.exit(); // 고치던 머리말·꼬리말도 함께 올린다
    return flushRef.current();
  }, []);

  // 서식 막대
  useEffect(() => {
    if (!editor || !ready) return;
    const src = docxFormatSource({
      id: `docx:${tab.id}`,
      editor,
      model: () => model.current,
      zoomEl: () => zoomEl.current,
      localFonts: () => localFonts,
      afterZoom: () => schedulePaginate(),
      detectFonts: async () => {
        const f = await listLocalFonts();
        if (f?.length) setLocalFonts(f);
      },
    });
    onFormatSource(src);
    return () => onFormatSource(null);
  }, [editor, ready, tab.id, localFonts, onFormatSource, schedulePaginate]);

  // 라이브 세션: 선택 읽기/바꾸기/모양은 편집기가, 나머지 편집 도구는 "먼저 올리기" 뒤 서버가 실행
  useEffect(() => {
    if (!ready || !active || !editor) return;
    /** 편집기가 실행하는 변경: 사용자 편집으로 치지 않는다(자동 저장 없음). 서버가 받아 주면 그 리비전이 이 내용이고, 거절하면 "undo"가 온다. */
    const asAgent = (ed: NonNullable<typeof editor>, fn: () => void) => {
      applying.current = true;
      try {
        ed.view.dispatch(closeHistory(ed.state.tr)); // 이 실행이 실행 취소 한 단계가 되게 앞과 끊는다
        fn();
      } finally {
        applying.current = false;
      }
      schedulePaginate();
    };
    const UNSUPPORTED_PARA = ["indent", "marginLeft", "spacingBefore", "spacingAfter"];
    const executor = async (req: LiveRequest) => {
      const ed = editorRef.current;
      const m = model.current;
      if (!ed || !m) return { result: { ok: false, code: "LIVE_FALLBACK", text: "no editor" } };
      if (req.hints.method === "undo") {
        asAgent(ed, () => ed.commands.undo());
        return { result: { ok: true, text: "편집기의 변경을 되돌렸습니다." } };
      }
      geometry.current?.editingStrip?.exit(); // 고치던 머리말·꼬리말도 확정해 함께 올린다
      // 무엇을 하든 먼저 사용자 타이핑을 올린다: 서버가 최신 머리 위에서 실행하고, 결과 파일에 올리지 않은 글이 섞이지 않게
      if (!(await flush())) return { result: { ok: false, code: "STALE_REVISION", text: "편집기의 변경을 서버에 올리지 못해 실행하지 않았습니다(다른 곳에서 바뀌었거나 연결 문제). read_document로 다시 읽고 다시 부르세요." } };
      switch (req.hints.method) {
        case "flush":
          return { result: { ok: false, code: "LIVE_FALLBACK", text: "flushed" } };
        case "selection": {
          const text = docxSelectionText(ed);
          return { result: { ok: true, text: text ? `선택한 부분:\n${text}` : "선택한 부분이 없습니다." } };
        }
        case "replaceSelection":
        case "formatSelection": {
          if (ed.state.selection.empty) return { result: { ok: false, code: "TARGET_NOT_FOUND", text: "선택한 부분이 없습니다. 사용자에게 먼저 선택해 달라고 하세요." } };
          const f = (req.hints.format ?? {}) as Record<string, unknown>;
          if (req.hints.method === "formatSelection" && UNSUPPORTED_PARA.some((k) => f[k] !== undefined && f[k] !== null))
            return { result: { ok: false, code: "UNSUPPORTED", text: "Word 편집기는 선택 범위의 들여쓰기·문단 간격을 아직 바꾸지 못합니다. format_paragraphs로 블록 번호를 대어 바꾸세요." } };
          asAgent(ed, () => {
            if (req.hints.method === "replaceSelection") docxReplaceSelection(ed, (req.hints.texts as string[]) ?? []);
            else {
              docxApplyChar(ed, { fontName: f.font as string | undefined, fontSizePt: f.size as number | undefined, textColor: f.color as string | undefined });
              for (const k of ["bold", "italic", "underline", "strikethrough"] as const) {
                const mark = k === "strikethrough" ? "strike" : k;
                if (typeof f[k] === "boolean" && ed.isActive(mark) !== f[k]) ed.chain().toggleMark(mark).run();
              }
              docxApplyPara(ed, { alignment: f.align as "left" | "center" | "right" | "justify" | undefined, lineSpacing: f.lineSpacing as number | undefined });
            }
          });
          const { bytes } = await exportDocx(ed, m, pages.current, geometry.current);
          return { result: { ok: true, text: req.hints.method === "replaceSelection" ? "선택한 부분을 바꿨습니다." : "선택한 부분의 모양을 바꿨습니다." }, bytes };
        }
        default:
          return { result: { ok: false, code: "LIVE_FALLBACK", text: `unsupported ${String(req.hints.method)}` } };
      }
    };
    const handle: LiveHandle = startLiveSession({
      documentId: tab.id,
      client: clientId,
      executor,
      beforeExecute: async () => true, // 올리기는 실행기 안에서 (실패하면 서버가 낡은 머리에서 실행하지 않도록 거절한다)
      onApplied: () => shellRef.current.markDirty(tab.id), // 서버가 AI 변경을 받아도 디스크에는 아직 저장하지 않았다
      knownSeq: () => knownSeq.current,
      onNotice: (m) => shellRef.current.notify(m),
    });
    if (liveRequestRef) liveRequestRef.current = (e) => handle.handle(e);
    return () => {
      handle.stop();
      if (liveRequestRef) liveRequestRef.current = null;
    };
  }, [ready, active, editor, tab.id, clientId, flush, liveRequestRef, schedulePaginate]);

  // 시험·디버그용 훅: E2E가 편집기 상태를 읽는다 (AppShell의 __coredotdocs.studio와 짝)
  useEffect(() => {
    if (!editor) return;
    const w = window as unknown as { __coredotdocsDocx?: Record<string, unknown> };
    (w.__coredotdocsDocx ??= {})[tab.id] = editor;
    return () => {
      delete w.__coredotdocsDocx?.[tab.id];
    };
  }, [editor, tab.id]);

  // AI 패널의 "이 블록으로" 이동
  useEffect(() => {
    if (!active || !ready) return;
    const onJump = (e: Event) => {
      const d = (e as CustomEvent<{ documentId: string; blockNo: number }>).detail;
      if (d.documentId !== tab.id) return;
      void api.getBlocks(tab.id).then((list) => {
        const b = list.blocks.find((x) => x.no === d.blockNo);
        const ed = editorRef.current;
        const el = b && ed ? blockElementFor(ed, model.current, b) : null;
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        el?.classList.add("cdd-selected");
        setTimeout(() => el?.classList.remove("cdd-selected"), 2000);
      });
    };
    window.addEventListener("coredotdocs:jump", onJump);
    return () => window.removeEventListener("coredotdocs:jump", onJump);
  }, [active, ready, tab.id]);

  return (
    <div className="cdd-docx" data-testid="docx-editor" data-ready={ready ? "1" : "0"} data-cdd-doc={tab.id}>
      {styleSheet && <style data-doc-css="">{styleSheet}</style>}
      {/* 인쇄 기본값(Letter)과 문서 용지가 다르면 빈 쪽이 생긴다. 보이는 탭의 실제 용지만 적용한다. */}
      {active && pageVars["--page-w"] && pageVars["--page-h"] && <style media="print" data-doc-page-size="">{`@page { size: ${pageVars["--page-w"]} ${pageVars["--page-h"]}; margin: 0; }`}</style>}
      {error && <p className="muted docx-error print-hide">{error}</p>}
      <div className="editor-scroll">
        <div className="doc-zoom" ref={zoomEl}>
          <div className="page-wrap cdd-page-wrap" ref={pageWrap} style={pageVars as React.CSSProperties} onDoubleClickCapture={onCanvasDoubleClick}>
            <EditorContent editor={editor} />
          </div>
          {notes.length > 0 && (
            <section className="cdd-notes" aria-label="미주" style={{ width: pageVars["--page-w"] }}>
              <h2>미주</h2>
              <ol>
                {notes.map((n) => (
                  <li key={`${n.kind}:${n.id}`}>
                    <span className="cdd-note-no">{n.no}</span> {n.text}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
      {pageSetupOpen && <PageSetupDialog documentId={tab.id} flush={flushForDialog} onClose={() => setPageSetupOpen(false)} onApplied={() => shellRef.current.markDirty(tab.id)} />}
      {noteEdit && (
        <div className="cdd-note-dialog" role="dialog" aria-label="각주 고치기">
          <label>
            각주 고치기
            <textarea autoFocus value={noteEdit.text} onChange={(e) => setNoteEdit({ ...noteEdit, text: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setNoteEdit(null)} />
          </label>
          <p className="muted">글자 모양은 지워지고 글만 남습니다.</p>
          <div className="cdd-note-actions">
            <button type="button" className="tb" onClick={() => setNoteEdit(null)}>
              취소
            </button>
            <button
              type="button"
              className="tb is-on"
              onClick={() => {
                const geo = geometry.current;
                // 창을 연 뒤 문서를 다시 읽었으면(AI·다른 창) 옛 글 위에 덮어쓰지 않는다
                if (geo !== noteEdit.geo || footnoteText(geo, noteEdit.id) !== noteEdit.base) {
                  statusRef.current({ error: "각주를 고치는 사이 문서가 바뀌어 저장하지 않았습니다. 다시 열어 고쳐 주세요." });
                } else if (editFootnote(geo, noteEdit.id, noteEdit.text)) {
                  markChanged();
                  schedulePaginate();
                }
                setNoteEdit(null);
              }}
            >
              저장
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 설치 글꼴 이름 (Local Font Access API). 데스크톱은 허락을 묻지 않는다; 웹판은 사용자 동작 안에서 force로만. */
/**
 * 서버 블록 → 편집기 DOM 요소. 자리 번호(index → 엔진 docxIndex, altChunk 보정)로 찾고, 문단 글이 다르면(연 뒤 문단을 넣거나 지워
 * 번호가 밀렸을 때) 같은 글의 맨 위 노드를 찾는다.
 */
function blockElementFor(ed: Editor, model: DocxModel | null, b: Block): HTMLElement | null {
  const idx = b.index !== undefined && model ? editorIndexOf(model, b.index) : null;
  const byIndex = idx !== null ? docxBlockElement(ed, idx, 0) : null;
  if (b.kind !== "paragraph") return byIndex;
  const want = b.text.trim();
  if (byIndex && (byIndex.textContent ?? "").trim() === want) return byIndex;
  if (!want) return byIndex;
  let found: HTMLElement | null = null;
  ed.state.doc.forEach((node, offset) => {
    if (found || node.textContent.trim() !== want) return;
    const el = ed.view.nodeDOM(offset);
    if (el instanceof HTMLElement) found = el;
  });
  return found ?? byIndex;
}

/** 웹판 설치 글꼴(Local Font Access). 사용자 동작 안에서 불러야 브라우저가 허락을 묻는다. 창 하나에 한 번만 묻고 나눠 쓴다. */
let localFontsCache: string[] | null = null;
let localFontsInflight: Promise<string[] | null> | null = null;

async function listLocalFonts(): Promise<string[] | null> {
  if (localFontsCache) return localFontsCache;
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) return null;
  localFontsInflight ??= q
    .call(window)
    .then((fonts) => {
      const names = [...new Set(fonts.map((f) => f.family))];
      if (names.length) localFontsCache = names;
      return names;
    })
    .catch(() => null)
    .finally(() => (localFontsInflight = null));
  return localFontsInflight;
}

/** 두 번 누른 자리가 쪽의 여백(본문 상자 밖)인가. 글·띠·각주가 아니라 쪽 바탕(.ProseMirror의 안쪽 여백이나 쪽 둘레)을 눌렀을 때만 */
function inPageMargin(wrap: HTMLElement, target: HTMLElement, x: number, y: number): boolean {
  const pm = wrap.querySelector<HTMLElement>(".ProseMirror");
  if (!pm) return false;
  if (target !== pm && target !== wrap) return false;
  const rect = pm.getBoundingClientRect();
  const scale = pm.offsetWidth ? rect.width / pm.offsetWidth : 1; // 배율(zoom) 반영
  const cs = getComputedStyle(pm);
  const px = (v: string) => (parseFloat(v) || 0) * scale;
  const inside = x > rect.left + px(cs.paddingLeft) && x < rect.right - px(cs.paddingRight) && y > rect.top + px(cs.paddingTop) && y < rect.bottom - px(cs.paddingBottom);
  return !inside;
}
