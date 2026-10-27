"use client";

// 문서 위의 메뉴 줄과 도구 막대. 편집기(rhwp-studio) 자체 메뉴는 숨기고 앱이 메뉴를 그린다.
// 편집·보기·입력·서식·쪽·표·도구 메뉴는 스튜디오의 메뉴 모델(commands.menuModel)을 그대로 그리고, 파일·AI·도움말은 앱의 것이다.
import { useEffect, useRef, useState } from "react";
import { isDesktop } from "@/lib/desktop";
import { useShell } from "@/lib/shell";
import { PAGE_SETUP_EVENT } from "@/lib/page-setup";
import { runCommand, studioMenus, TOOLBAR, type MenuItemNode, type MenuNode, type RhwpEditor } from "@/lib/studio";
import { useWorkspace, type Tab } from "@/lib/tabs";
import type { EditorStatus } from "./HwpxEditor";
import type { FormatSource } from "@/lib/format-source";
import { FormatBar } from "./FormatBar";

type Item = { label: string; shortcut?: string; disabled?: boolean; separator?: boolean; onSelect?: () => void; submenu?: Item[] };
type Menu = { id: string; label: string; items: Item[] };

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

export function EditorChrome({ tab, studio, formatSource, status, aiOpen, chatBusy, active = true }: { tab: Tab; studio: RhwpEditor | null; formatSource: FormatSource | null; status: EditorStatus; aiOpen: boolean; chatBusy: boolean; active?: boolean }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [open, setOpen] = useState<string | null>(null);
  const [studioModel, setStudioModel] = useState<MenuNode[]>([]);
  const bar = useRef<HTMLDivElement>(null);

  // 바깥 클릭·Esc로 닫기. 본문은 iframe(스튜디오) 안이라 그 클릭이 이 창에 오지 않는다 — iframe 창에도 듣고(같은 출처),
  // 초점이 iframe으로 옮겨 가는 blur도 닫는 신호로 쓴다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    const close = () => setOpen(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    const frame = studio?.element.contentWindow ?? null;
    frame?.addEventListener("pointerdown", close, true);
    frame?.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      frame?.removeEventListener("pointerdown", close, true);
      frame?.removeEventListener("keydown", onKey, true);
    };
  }, [open, studio]);

  async function refreshModel() {
    if (!studio) return setStudioModel([]);
    try {
      setStudioModel(studioMenus(await studio.commands.menuModel()));
    } catch {
      setStudioModel([]);
    }
  }

  // 스튜디오가 준비되면 메뉴 모델(편집·보기·입력·서식·쪽·표·도구)을 가져와 메뉴 줄에 그린다; 메뉴를 열 때마다 활성 상태를 다시 읽는다
  useEffect(() => {
    let alive = true;
    const load = studio ? studio.commands.menuModel().then(studioMenus) : Promise.resolve([] as MenuNode[]);
    load.then((m) => alive && setStudioModel(m)).catch(() => alive && setStudioModel([]));
    return () => {
      alive = false;
    };
  }, [studio]);

  function toggle(id: string) {
    if (open === id) return setOpen(null);
    refreshModel();
    setOpen(id);
  }

  function exec(id: string) {
    if (!studio) return;
    runCommand(studio, id).catch((err) => shell.notify(`명령을 실행하지 못했습니다: ${String(err)}`, "error"));
  }

  const recent: Item[] = ws.recent.slice(0, 10).map((r) => ({ label: r.path ? `${r.title}  —  ${r.path}` : r.title, onSelect: () => shell.openRecent(r) }));
  const fileMenu: Menu = {
    id: "file",
    label: "파일",
    items: [
      { label: "새 문서", shortcut: `${MOD}N`, onSelect: () => shell.newDocument("hwpx") },
      { label: "새 Word 문서", onSelect: () => shell.newDocument("docx") },
      { label: "열기…", shortcut: `${MOD}O`, onSelect: () => shell.openFileDialog() },
      { label: "최근 문서", submenu: recent.length ? recent : [{ label: "최근 문서 없음", disabled: true }] },
      { label: "", separator: true },
      { label: "저장", shortcut: `${MOD}S`, onSelect: () => shell.save(tab.id) },
      { label: "다른 이름으로 저장…", shortcut: `⇧${MOD}S`, onSelect: () => shell.save(tab.id, true) },
      ...(tab.format === "hwpx"
        ? [
            { label: "HWP 형식으로 내보내기…", onSelect: () => shell.exportAs(tab.id, "hwp") },
            { label: "PDF로 저장…", disabled: !studio, onSelect: () => shell.exportPdf(tab.id) },
            { label: "인쇄…", shortcut: `${MOD}P`, disabled: !studio, onSelect: () => shell.printDocument(tab.id) },
            { label: "편집 용지…", shortcut: "F7", disabled: !studio, onSelect: () => exec("file:page-setup") },
          ]
        : [
            { label: "PDF로 저장…", onSelect: () => shell.exportPdf(tab.id) },
            { label: "인쇄…", shortcut: `${MOD}P`, onSelect: () => shell.printDocument(tab.id) },
            { label: "편집 용지…", shortcut: "F7", onSelect: () => window.dispatchEvent(new CustomEvent(PAGE_SETUP_EVENT, { detail: { tabId: tab.id } })) },
          ]),
      { label: "", separator: true },
      { label: "탭 닫기", shortcut: `${MOD}W`, onSelect: () => shell.closeTab(tab.id) },
    ],
  };
  const aiMenu: Menu = {
    id: "ai",
    label: "AI",
    items: [
      { label: aiOpen ? "AI 패널 숨기기" : "AI 패널 보이기", shortcut: `${MOD}J`, onSelect: () => shell.toggleAi() },
      { label: "AI 편집 되돌리기", disabled: (status.revision ?? 1) <= 1, onSelect: () => shell.undoAi(tab.id) },
      { label: "", separator: true },
      ...(isDesktop()
        ? [
            { label: "Claude Desktop에 연결…", onSelect: () => shell.connectAi("claude-desktop") },
            { label: "Claude Code에 연결…", onSelect: () => shell.connectAi("claude-code") },
            { label: "Codex에 연결…", onSelect: () => shell.connectAi("codex") },
          ]
        : [{ label: "외부 AI 앱 연결 설정은 시작 화면에서", disabled: true }]),
    ],
  };
  const helpMenu: Menu = {
    id: "help",
    label: "도움말",
    items: [
      { label: "코어닷독스 도움말", shortcut: "F1", onSelect: () => shell.openHelp() },
      { label: "단축키 안내", onSelect: () => shell.openHelp("shortcuts") },
      { label: "코어닷독스 정보", onSelect: () => shell.openHelp("about") },
    ],
  };
  const menus: Menu[] = [fileMenu, ...studioModel.map((m) => ({ id: m.menuId, label: m.label, items: m.items.map(convert) })), aiMenu, helpMenu];

  function convert(node: MenuItemNode): Item {
    return {
      label: node.label,
      disabled: !node.enabled && !node.submenu,
      submenu: node.submenu?.map(convert),
      onSelect: node.commandId ? () => exec(node.commandId!) : undefined,
    };
  }

  const isHwpx = tab.format === "hwpx";

  return (
    <div className="chrome" ref={bar}>
      <div className="menubar" role="menubar" aria-label="메뉴">
        {menus.map((m) => (
          <div key={m.id} className={`menu ${open === m.id ? "is-open" : ""}`}>
            <button type="button" role="menuitem" aria-haspopup="true" aria-expanded={open === m.id} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(m.id)} onMouseEnter={() => open && open !== m.id && toggle(m.id)}>
              {m.label}
            </button>
            {open === m.id && <MenuList items={m.items} onDone={() => setOpen(null)} />}
          </div>
        ))}
      </div>
      <div className="toolbar" role="toolbar" aria-label="도구 막대">
        <button type="button" className={`tb ${tab.dirty ? "is-dirty" : ""}`} title={`저장 (${MOD}S)`} onClick={() => shell.save(tab.id)}>
          저장{tab.dirty ? " •" : ""}
        </button>
        {isHwpx &&
          TOOLBAR.map((group, gi) => (
            <span className="tb-group" key={gi}>
              {group.map((b) => (
                <button type="button" key={b.id} className={`tb ${b.id.replace(":", "-")}`} title={b.title} disabled={!studio} onClick={() => exec(b.id)}>
                  {b.label}
                </button>
              ))}
            </span>
          ))}
        {!isHwpx && (
          <span className="tb-group">
            <button type="button" className="tb" title="되돌리기 (서버 리비전)" disabled={(status.revision ?? 1) <= 1} onClick={() => shell.undoAi(tab.id)}>
              ↶ 되돌리기
            </button>
          </span>
        )}
        <span className="tb-status muted" data-testid="doc-status">
          {status.loading ? "불러오는 중…" : status.error ? <span className="is-error">{status.error}</span> : `${tab.format.toUpperCase()} · 리비전 ${status.revision ?? "-"}${status.pages ? ` · ${status.pages}쪽` : ""}`}
          {chatBusy && " · AI 작업 중"}
        </span>
        <button type="button" className={`tb ai ${aiOpen ? "is-on" : ""}`} title={`AI 패널 (${MOD}J)`} onClick={() => shell.toggleAi()} aria-pressed={aiOpen}>
          AI
        </button>
      </div>
      <FormatBar source={formatSource} active={active} />
    </div>
  );
}

function MenuList({ items, onDone }: { items: Item[]; onDone: () => void }) {
  return (
    <ul className="dropdown" role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <li key={i} className="sep" role="separator" />
        ) : (
          <li key={i} className={`${it.submenu ? "has-sub" : ""} ${it.disabled ? "is-disabled" : ""}`} role="menuitem" aria-disabled={it.disabled}>
            <button
              type="button"
              disabled={it.disabled}
              onClick={() => {
                if (it.submenu) return;
                it.onSelect?.();
                onDone();
              }}
            >
              <span>{it.label}</span>
              {it.shortcut && <kbd>{it.shortcut}</kbd>}
              {it.submenu && <span className="arrow">▸</span>}
            </button>
            {it.submenu && <MenuList items={it.submenu} onDone={onDone} />}
          </li>
        ),
      )}
    </ul>
  );
}
