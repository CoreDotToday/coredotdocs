"use client";

// 앱 셸: 탭 줄 + (시작 화면 | 열린 문서들). 파일 열기/저장, 단축키, 끌어다 놓기, 데스크톱 메뉴·파일 연결을 여기서 받는다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type DocFormat } from "@/lib/api";
import { buildPrintHtml, collectPages } from "@/lib/print";
import { desktopBridge, isDesktop, downloadBytes, type AiTarget } from "@/lib/desktop";
import { PAGE_SETUP_EVENT } from "@/lib/page-setup";
import { convertHwpToHwpx } from "@/lib/rhwp";
import { runCommand } from "@/lib/studio";
import { formatFromName, ShellContext, stripExt, type LocalFile, type ShellApi, type StudioHandle } from "@/lib/shell";
import { readableTitle, useWorkspace, workspace, type RecentEntry, type Tab } from "@/lib/tabs";
import { DocumentView } from "./DocumentView";
import { StartScreen } from "./StartScreen";
import { TabBar } from "./TabBar";
import { HelpDialog } from "./HelpDialog";
import type { HelpSectionId } from "@/lib/help";

const MEDIA = { hwpx: "application/hwp+zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", hwp: "application/x-hwp" };

export function AppShell({ initialDocId }: { initialDocId?: string }) {
  const ws = useWorkspace();
  const studios = useRef(new Map<string, StudioHandle>());
  const flushers = useRef(new Map<string, () => Promise<boolean>>()); // DOCX 편집기(Tiptap)의 올리기
  const printRenderers = useRef(new Map<string, () => Promise<string>>());
  const editEpochs = useRef(new Map<string, number>());
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [helpSection, setHelpSection] = useState<HelpSectionId | null>(null);

  const shell = useMemo<ShellApi>(() => {
    const desktop = () => desktopBridge();
    const tabOf = (id: string): Tab => {
      const t = workspace.get().tabs.find((x) => x.id === id);
      if (!t) throw new Error("탭이 없습니다");
      return t;
    };
    const notify: ShellApi["notify"] = (text, kind = "info") => {
      setToast({ text, kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), kind === "error" ? 8000 : 4000);
    };
    const guard = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (err) {
        notify(String(err instanceof Error ? err.message : err), "error");
        return undefined;
      }
    };

    const openLocalFiles: ShellApi["openLocalFiles"] = async (files) => {
      for (const f of files) {
        await guard(async () => {
          const existing = f.path ? workspace.get().tabs.find((t) => t.path === f.path) : undefined;
          if (existing) return workspace.activate(existing.id);
          const kind = formatFromName(f.name);
          if (!kind) throw new Error(`${f.name}: HWPX·HWP·DOCX 파일만 열 수 있습니다.`);
          let bytes: Uint8Array = new Uint8Array(f.data);
          let name = f.name;
          let format: DocFormat = kind === "hwp" ? "hwpx" : kind;
          if (kind === "hwp") {
            notify("HWP 문서를 HWPX로 바꾸는 중…");
            bytes = await convertHwpToHwpx(bytes);
            name = f.name.replace(/\.hwp$/i, ".hwpx");
            format = "hwpx";
          }
          const doc = await api.upload(new Blob([bytes as BlobPart], { type: MEDIA[format] }), name);
          // 옛 HWP는 원본을 덮어쓰지 않는다→ 저장할 때 위치를 묻는다
          workspace.open({ id: doc.id, title: stripExt(name), filename: name, format, path: kind === "hwp" ? undefined : f.path });
        });
      }
    };

    /** 각 편집기가 계산한 쪽을 독립 인쇄용 HTML로 만든다. */
    const printHtml = async (tab: Tab): Promise<string> => {
      if (tab.format === "docx") {
        const render = printRenderers.current.get(tab.id);
        if (!render) throw new Error("편집기가 아직 준비되지 않았습니다.");
        return render();
      }
      const h = studios.current.get(tab.id);
      if (!h) throw new Error("편집기가 아직 준비되지 않았습니다.");
      const pages = await collectPages(h.studio, (done, total) => {
        if (total > 8 && (done % 8 === 0 || done === total)) notify(`인쇄 준비 중… ${done}/${total}쪽`);
      });
      return buildPrintHtml(pages, tab.title);
    };
    const saveBytes = async (tab: Tab): Promise<Uint8Array> => {
      if (tab.format === "hwpx") {
        const h = studios.current.get(tab.id);
        if (h) {
          // 서버가 받아 준(검증을 통과한) 내용만 디스크에 쓴다 — 거절되면 저장도 하지 않는다 (설계 문서 04 §2 A3)
          if (!(await h.flush())) throw new Error("편집기 내용을 서버가 받아 주지 않아 저장하지 않았습니다. 상태 표시의 오류를 확인하세요.");
          const bytes = await h.studio.exportHwpx();
          if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error("편집기가 내보낸 결과가 HWPX(zip)가 아닙니다. 저장하지 않았습니다.");
          return bytes;
        }
      }
      const flush = flushers.current.get(tab.id);
      if (flush && !(await flush())) throw new Error("편집기 내용을 서버가 받아 주지 않아 저장하지 않았습니다. 상태 표시의 오류를 확인하세요.");
      return api.downloadBytes(tab.id);
    };

    const save: ShellApi["save"] = async (tabId, as = false) => {
      const tab = tabOf(tabId);
      const result = await guard(async () => {
        if (!(await api_.flush(tabId))) throw new Error("변경 내용을 보관하지 못해 저장하지 않았습니다. 상태 표시의 오류를 확인하세요.");
        const savedEpoch = editEpochs.current.get(tabId) ?? 0;
        const bytes = await saveBytes(tab);
        const d = desktop();
        if (d) {
          const r = await d.saveFile({ data: bytes, path: as ? undefined : tab.path, suggestedName: tab.filename });
          if (!r) return false;
          const title = stripExt(r.name);
          const changedDuringSave = (editEpochs.current.get(tabId) ?? 0) !== savedEpoch;
          workspace.update(tab.id, { path: r.path, filename: r.name, title, dirty: changedDuringSave });
          api.rename(tab.id, { title, filename: r.name }).catch(() => {});
          if (!changedDuringSave) await studios.current.get(tab.id)?.studio.notifySaved(r.name).catch(() => {});
          notify(changedDuringSave ? `저장했습니다: ${r.path} — 저장 중 추가된 변경은 다시 저장하세요.` : `저장했습니다: ${r.path}`);
          return !changedDuringSave;
        }
        downloadBytes(bytes, tab.filename, MEDIA[tab.format]);
        const changedDuringSave = (editEpochs.current.get(tabId) ?? 0) !== savedEpoch;
        workspace.update(tab.id, { dirty: changedDuringSave });
        if (!changedDuringSave) await studios.current.get(tab.id)?.studio.notifySaved(tab.filename).catch(() => {});
        return !changedDuringSave;
      });
      return result ?? false;
    };

    const api_: ShellApi = {
      notify,
      openHelp: (section = "start") => setHelpSection(section),
      openLocalFiles,
      save,
      async openFileDialog() {
        const d = desktop();
        if (!d) {
          // 웹판: 시작 화면의 파일 입력을 쓴다
          (document.querySelector('input[type="file"][aria-label="HWPX, HWP 또는 DOCX 파일"]') as HTMLInputElement | null)?.click();
          return;
        }
        const files = await guard(() => d.openFileDialog());
        if (files?.length) await openLocalFiles(files);
      },
      async openServerDocument(id) {
        await guard(async () => {
          const d = await api.getDocument(id);
          const recent = workspace.get().recent.find((r) => r.id === id);
          workspace.open({ id: d.id, title: d.title, filename: d.filename, format: d.format, path: recent?.path });
        });
      },
      async openRecent(entry: RecentEntry) {
        const d = desktop();
        if (entry.path && d) {
          const file = await guard(() => d.readPath(entry.path!));
          if (file) return openLocalFiles([file]);
          notify(`파일을 다시 열지 않아 앱 안의 사본을 엽니다: ${entry.path}`);
        }
        await api_.openServerDocument(entry.id).catch(() => {
          workspace.removeRecent(entry.id);
          notify("문서가 더 이상 없습니다.", "error");
        });
      },
      async newDocument(format) {
        await guard(async () => {
          const n = workspace.get().recent.filter((r) => r.title.startsWith("새 문서")).length + 1;
          const title = format === "docx" ? `새 Word 문서 ${n}` : `새 문서 ${n}`;
          const d = await api.createBlank(title, "", format);
          workspace.open({ id: d.id, title: d.title, filename: `${d.title}.${format}`, format });
        });
      },
      async exportAs(tabId, format) {
        const tab = tabOf(tabId);
        await guard(async () => {
          let bytes: Uint8Array;
          if (format === "hwp") {
            const h = studios.current.get(tab.id);
            if (!h) throw new Error("편집기가 아직 준비되지 않았습니다.");
            // HWP는 편집기가 직렬화 결과를 스스로 다시 읽어 쪽수가 같은지 본 뒤에만 내보낸다 (A3)
            const v = await h.studio.exportHwpVerify();
            if (!v.recovered) throw new Error("HWP로 내보낸 결과를 편집기가 다시 읽지 못했습니다. 내보내지 않았습니다.");
            if (v.pageCountBefore !== v.pageCountAfter) throw new Error(`HWP로 내보내면 쪽수가 달라집니다 (${v.pageCountBefore}→${v.pageCountAfter}). 내보내지 않았습니다.`);
            bytes = await h.studio.exportHwp();
            if (!(bytes[0] === 0xd0 && bytes[1] === 0xcf)) throw new Error("내보낸 결과가 HWP(OLE) 파일이 아닙니다. 내보내지 않았습니다.");
          } else bytes = await saveBytes(tab);
          const name = `${stripExt(tab.filename)}.${format}`;
          const d = desktop();
          if (d) {
            const r = await d.saveFile({ data: bytes, suggestedName: name });
            if (r) notify(`내보냈습니다: ${r.path}`);
          } else downloadBytes(bytes, name, MEDIA[format]);
        });
      },
      async exportPdf(tabId) {
        const tab = tabOf(tabId);
        await guard(async () => {
          const html = await printHtml(tab);
          const d = desktop();
          if (d) {
            const r = await d.printToPdf({ html, suggestedName: `${stripExt(tab.filename)}.pdf` });
            if (r) notify(`PDF로 저장했습니다: ${r.path}`);
          } else openPrintWindow(html, true);
        });
      },
      async printDocument(tabId) {
        const tab = tabOf(tabId);
        await guard(async () => {
          const html = await printHtml(tab);
          const d = desktop();
          if (d) {
            const r = await d.printHtml({ html, title: tab.title });
            if (!r.ok) throw new Error(r.message ?? "인쇄하지 못했습니다.");
          } else openPrintWindow(html, true);
        });
      },
      async closeTab(tabId) {
        if (!workspace.get().tabs.some((t) => t.id === tabId)) return;
        if (!(await api_.flush(tabId))) {
          notify("변경 내용을 보관하지 못해 문서를 닫지 않았습니다. 오류를 확인한 뒤 다시 저장하세요.", "error");
          return;
        }
        const tab = workspace.get().tabs.find((t) => t.id === tabId);
        if (!tab) return;
        if (tab.dirty) {
          const ok = confirm(`'${tab.title}'에 저장하지 않은 내용이 있습니다. 저장할까요?\n(확인: 저장 후 닫기 / 취소: 닫지 않음)`);
          if (!ok) return;
          if (!(await save(tabId))) return;
        }
        workspace.close(tabId);
        editEpochs.current.delete(tabId);
      },
      registerStudio(tabId, handle) {
        if (handle) studios.current.set(tabId, handle);
        else studios.current.delete(tabId);
      },
      getStudio(tabId) {
        return studios.current.get(tabId);
      },
      registerFlusher(tabId, flush) {
        if (flush) flushers.current.set(tabId, flush);
        else flushers.current.delete(tabId);
      },
      registerPrintRenderer(tabId, render) {
        if (render) printRenderers.current.set(tabId, render);
        else printRenderers.current.delete(tabId);
      },
      async flush(tabId) {
        const f = flushers.current.get(tabId);
        if (f) return f();
        return (await studios.current.get(tabId)?.flush()) ?? true;
      },
      activeTabId() {
        return workspace.get().activeId ?? undefined;
      },
      markDirty(tabId, dirty = true) {
        if (dirty) editEpochs.current.set(tabId, (editEpochs.current.get(tabId) ?? 0) + 1);
        const t = workspace.get().tabs.find((x) => x.id === tabId);
        if (t && t.dirty !== dirty) workspace.update(tabId, { dirty });
      },
      async undoAi(tabId) {
        await guard(async () => {
          if (!(await api_.flush(tabId))) throw new Error("편집 중인 내용을 보관하지 못해 되돌리지 않았습니다. 오류를 확인한 뒤 다시 시도하세요.");
          try {
            await api.undo(tabId, 1);
          } catch (err) {
            // 그 뒤에 사용자가 편집기에서 고친 리비전이 있으면 서버가 거절한다(FOREIGN_CHANGES) — 사용자에게 묻고 강제로
            if (err instanceof ApiError && err.code === "FOREIGN_CHANGES" && confirm(`${err.message}\n\n사용자가 그 뒤에 고친 내용까지 함께 되돌릴까요?`)) await api.undo(tabId, 1, true);
            else throw err;
          }
        });
      },
      toggleAi() {
        workspace.setAiOpen(!workspace.get().aiOpen);
      },
      async connectAi(target: AiTarget) {
        const d = desktop();
        if (!d) return notify("외부 AI 앱 연결은 데스크톱 앱에서 메뉴로, 웹판은 시작 화면의 설정 조각으로 합니다.");
        const r = await d.connectAi(target);
        notify(r.message, r.ok ? "info" : "error");
        if (!r.ok) throw new Error(r.message);
      },
    };
    return api_;
  }, []);

  // 시험·디버그용 훅: 열린 탭의 스튜디오 핸들 (E2E가 문서 상태를 읽는다)
  useEffect(() => {
    (window as unknown as { __coredotdocs?: unknown }).__coredotdocs = {
      studio: (id: string) => studios.current.get(id)?.studio,
      workspace,
      // 점검용: 탭의 쪽 SVG를 모아 인쇄용 HTML을 돌려준다
      printHtml: async (id: string) => {
        const render = printRenderers.current.get(id);
        if (render) return render();
        const h = studios.current.get(id);
        return h ? buildPrintHtml(await collectPages(h.studio), id) : "";
      },
    };
    const d = desktopBridge();
    if (d) document.body.classList.add("is-desktop", `is-${d.platform}`); // macOS: 탭 줄이 신호등 단추 자리를 비운다
  }, []);

  // 처음 열 문서 (/documents/{id} 호환)
  useEffect(() => {
    if (initialDocId) shell.openServerDocument(initialDocId);
  }, [initialDocId, shell]);

  // 데스크톱 메뉴·파일 연결
  useEffect(() => {
    const d = desktopBridge();
    if (!d) return;
    const offMenu = d.onMenu((id) => {
      const active = workspace.get().activeId;
      switch (id) {
        case "help:guide":
          return shell.openHelp();
        case "help:shortcuts":
          return shell.openHelp("shortcuts");
        case "help:about":
          return shell.openHelp("about");
        case "file:new":
          return shell.newDocument("hwpx");
        case "file:new-docx":
          return shell.newDocument("docx");
        case "file:open":
          return shell.openFileDialog();
        case "file:save":
          return active && shell.save(active);
        case "file:save-as":
          return active && shell.save(active, true);
        case "file:close-tab":
          return active && shell.closeTab(active);
        case "file:export-pdf":
          return active && shell.exportPdf(active);
        case "file:print":
          return active && shell.printDocument(active);
        case "file:page-setup": {
          if (!active) return;
          const studio = shell.getStudio(active)?.studio; // 한글 문서: 스튜디오의 편집 용지 대화상자
          if (studio) return runCommand(studio, "file:page-setup").catch((err) => shell.notify(`편집 용지를 열지 못했습니다: ${String(err)}`, "error"));
          return void window.dispatchEvent(new CustomEvent(PAGE_SETUP_EVENT, { detail: { tabId: active } })); // Word 문서
        }
        case "view:toggle-ai":
          return shell.toggleAi();
        case "ai:undo":
          return active && shell.undoAi(active);
        case "ai:connect-claude-desktop":
          return shell.connectAi("claude-desktop").catch(() => {});
        case "ai:connect-claude-code":
          return shell.connectAi("claude-code").catch(() => {});
        case "ai:connect-codex":
          return shell.connectAi("codex").catch(() => {});
      }
    });
    const offOpen = d.onOpenFiles((files) => shell.openLocalFiles(files));
    return () => {
      offMenu();
      offOpen();
    };
  }, [shell]);

  // 단축키 (편집기 iframe 안에 포커스가 있으면 스튜디오가 먼저 받는다; 데스크톱은 네이티브 메뉴 가속키가 받는다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDesktop()) return; // 데스크톱은 네이티브 메뉴 가속키가 받는다 (Windows·Linux는 키 이벤트도 함께 오므로 두 번 실행을 막는다)
      if (e.key === "F1") { e.preventDefault(); shell.openHelp(); return; }
      if (!(e.metaKey || e.ctrlKey)) return;
      const active = workspace.get().activeId;
      const k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); void shell.openFileDialog(); }
      else if (k === "n" && !e.shiftKey) { e.preventDefault(); void shell.newDocument("hwpx"); }
      else if (k === "s" && active) { e.preventDefault(); void shell.save(active, e.shiftKey); }
      else if (k === "w" && active) { e.preventDefault(); void shell.closeTab(active); }
      else if (k === "j") { e.preventDefault(); shell.toggleAi(); }
      else if (k === "p" && active) { e.preventDefault(); void shell.printDocument(active); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);

  // 창 제목·저장 안 됨 표시
  const activeTab = ws.tabs.find((t) => t.id === ws.activeId);
  useEffect(() => {
    const title = activeTab ? `${activeTab.dirty ? "● " : ""}${readableTitle(activeTab.title)} — Core.Docs` : "Core.Docs";
    document.title = title;
    desktopBridge()?.setDocumentState({ title: activeTab ? readableTitle(activeTab.title) : "", dirty: ws.tabs.some((t) => t.dirty), path: activeTab?.path });
  }, [activeTab, ws.tabs]);

  // 웹판 닫기 보호
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (workspace.get().tabs.some((t) => t.dirty)) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const d = desktopBridge();
    const files: LocalFile[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      let path: string | undefined;
      try {
        path = d?.pathForFile(f) || undefined;
      } catch {}
      files.push({ name: f.name, data: await f.arrayBuffer(), path });
    }
    if (files.length) await shell.openLocalFiles(files);
  }

  const showStart = !activeTab;
  return (
    <ShellContext.Provider value={shell}>
      <div
        className={`app ${dragging ? "is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={onDrop}
      >
        <TabBar />
        {helpSection && <HelpDialog key={helpSection} initialSection={helpSection} onClose={() => setHelpSection(null)} />}
        {showStart && <StartScreen />}
        {ws.tabs.map((t) => (
          <DocumentView key={t.id} tab={t} active={t.id === ws.activeId} />
        ))}
        {dragging && <div className="drop-hint">여기에 놓으면 문서를 엽니다 (HWPX · HWP · DOCX)</div>}
        {toast && (
          <div className={`toast ${toast.kind}`} role="status">
            {toast.text}
          </div>
        )}
      </div>
    </ShellContext.Provider>
  );
}


/** 웹판: 인쇄용 HTML을 새 창(blob URL)에 열고 바로 인쇄 대화상자를 띄운다 (사용자가 PDF로 저장할 수 있다). */
function openPrintWindow(html: string, autoPrint: boolean) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) {
    URL.revokeObjectURL(url);
    throw new Error("팝업이 막혀 인쇄 창을 열지 못했습니다. 이 사이트의 팝업을 허용하세요.");
  }
  if (autoPrint) {
    w.addEventListener("load", () => {
      w.focus();
      w.print();
    });
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
