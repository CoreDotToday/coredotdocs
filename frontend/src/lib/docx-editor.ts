// DOCX 편집기 — third_party/genoffice-docx의 편집기 핵심(Tiptap 확장·변환·페이지네이션, Apache-2.0)에 대한 우리 쪽 유일한 입구 (설계 문서 04 §12 D3).
// 다른 코드는 `@genoffice/docs-renderer/*`를 직접 가져오지 않고 이 파일의 함수만 쓴다 (scripts/check-third-party.mjs가 지킨다).
//
// 흐름: 바이트 → 모델(docx-engine.ts) → 블록을 ProseMirror 문서로(blocksToPmDoc) → 사용자가 타이핑 → 저장 계획(pmDocToSavePlan:
// 안 바뀐 블록은 원본 그대로, 바뀐 블록만 다시 생성) → saveDocx → 서버 리비전. 쪽 모양은 캔버스 페이지네이션(cdd-canvas-pagination)이
// 쪽 사이 띠를 그린다. 서식 막대는 FormatSource로 마크·문단 속성을 읽고 쓴다.
import "@genoffice/docs-renderer/styles.scoped.css";
import { Editor, Extension, type JSONContent } from "@tiptap/core";
import { editorExtensions } from "@genoffice/docs-renderer/editor/extensions";
import { blocksToPmDoc, pmDocOptions, pmDocToSavePlan, type PmNode } from "@genoffice/docs-renderer/editor/convert";
import { setModuleLang } from "@genoffice/docs-renderer/i18n/locale";
import { canvasGeometry, commitHfEdit, commitNoteEdit, paginateCanvas, pendingSaveOptions, resetColumnPasses, startStripEdit, type CanvasGeometry, type CanvasPagination } from "@genoffice/docs-renderer/cdd-canvas-pagination";
import { docBodyFont, docStyleCss, docThemeCss } from "@genoffice/docs-renderer/doc-style-css";
import { newWidthPassState, paperWidthPx } from "@genoffice/docs-renderer/pagination-sections";
import type { SectionSettings } from "@genoffice/docx-engine";
import { saveDocxBytes, sectionsOf, visibleBlocks, type DocxModel } from "./docx-engine";
import type { CharMods, FormatSource, ParaMods, ToggleKind } from "./format-source";
import type { FormatState, StudioContext } from "./studio";
import { buildDocxPrintHtml, embedPrintResources, screenStyleSheet } from "./docx-print";

export const DOCX_ENGINE = "tiptap 3.31 + genoffice docx-engine (8ab58a5)";
export type { DocxModel, CanvasGeometry };

/**
 * 실행 취소 단축키는 기록이 비어 있어도 편집기가 먹는다. 명령이 false를 돌려주면 ProseMirror가 키를 넘겨 브라우저가
 * contenteditable 자체 실행 취소를 하는데, 그것은 편집기 상태 밖에서 DOM·선택을 바꿔 다음 입력의 선택 기록이 어긋난다.
 */
const KeepUndoInEditor = Extension.create({
  name: "cddKeepUndoInEditor",
  priority: 50, // 원래 실행 취소 확장(기본 100)이 먼저 처리하고, 처리하지 못한 경우에만 여기서 삼킨다
  addKeyboardShortcuts() {
    return { "Mod-z": () => true, "Mod-Shift-z": () => true, "Mod-y": () => true };
  },
});

/** Tiptap 확장 목록 (편집기 핵심 그대로: 문단·표·그림·각주·변경 추적·찾기·페이지 띠…) + 우리 단축키 보정. */
export function docxExtensions() {
  setModuleLang("ko"); // 확장이 쓰는 문자열(표 라벨 등)
  return [...editorExtensions, KeepUndoInEditor];
}

/** 모델 → ProseMirror 문서 JSON. */
export function docxContent(model: DocxModel): JSONContent {
  return blocksToPmDoc(visibleBlocks(model), sectionsOf(model), pmDocOptions(model)) as JSONContent;
}

/** 첫 구역의 용지 설정 (쪽 크기·여백, 트윕). */
export function docxSection(model: DocxModel): SectionSettings | null {
  return sectionsOf(model)[0]?.settings ?? null;
}

/** 쪽 모양 기하: 구역들·머리말/꼬리말 높이·쪽 나누기 규칙·`.doc-page` CSS 변수. 리비전을 읽을 때마다 한 번. */
export function docxGeometry(model: DocxModel): CanvasGeometry | null {
  return canvasGeometry(model, sectionsOf(model));
}

/**
 * 문서의 스타일 시트(문단 스타일·기본 글꼴·줄 높이 비율·테마 글꼴/색). 원본은 전역 <style>로 넣지만 우리 셸은 DOCX 탭이 여럿이라
 * CSS 중첩으로 그 탭의 컨테이너(`[data-cdd-doc="…"]`) 아래로 좁힌다.
 */
export function docxStyleSheet(model: DocxModel, scope: string): string {
  const css = docStyleCss(model) + "\n" + docThemeCss(model.themeFonts, model.themeColors, !!docBodyFont(model));
  return `[data-cdd-doc="${scope.replace(/"/g, "")}"] {\n${css}\n}`;
}

/** 미주 목록 (각주는 쪽 아래 영역에 그린다; 미주는 문서 끝에 모아 보인다). */
export function docxNotes(model: DocxModel): { kind: "footnote" | "endnote"; no: number; id: string; text: string }[] {
  return model.endnotes.map((n, i) => ({ kind: "endnote" as const, no: model.noteNumbers?.[`endnote:${n.id}`] ?? i + 1, id: n.id, text: n.text }));
}

/**
 * 편집기 내용 → .docx 바이트 (paragraph-patch). 쪽 화면에서 고친 머리말·꼬리말·각주(geo)도 함께 저장한다.
 * changed = 다시 만든/지운 블록 수 + 고친 머리말·각주 (0이면 원본과 같은 내용).
 */
export async function exportDocx(editor: Editor, model: DocxModel, pageCount: number, geo?: CanvasGeometry | null): Promise<{ bytes: Uint8Array; changed: number }> {
  const plan = pmDocToSavePlan(editor.getJSON() as PmNode, model.blocks);
  const pending = geo ? pendingSaveOptions(geo) : null;
  const bytes = await saveDocxBytes(model, plan.saveBlocks, { pageCount, newPictures: Object.keys(plan.newPictures).length > 0 ? plan.newPictures : undefined, ...(pending ?? {}) });
  return { bytes, changed: plan.changedCount + plan.deletedCount + (pending ? 1 : 0) };
}

/** 머리말·꼬리말 띠를 그 자리에서 고친다 (두 번 클릭). 고친 띠는 같은 부분을 쓰는 모든 쪽에 보이고 본문과 함께 저장된다. */
export function editStrip(geo: CanvasGeometry, el: HTMLElement, onChanged: () => void, onExit: () => void): boolean {
  return startStripEdit(
    geo,
    el,
    (si, kind, variant, next) => {
      if (commitHfEdit(geo, si, kind, variant, next)) onChanged();
    },
    onExit,
  );
}

/** 각주 글을 바꾼다 (쪽 아래 각주를 두 번 클릭). 바뀌면 true. */
export function editFootnote(geo: CanvasGeometry, id: string, text: string): boolean {
  return commitNoteEdit(geo, id, text);
}

export function footnoteText(geo: CanvasGeometry, id: string): string | null {
  return geo.footnotes.find((n) => n.id === id)?.text ?? null;
}

/** 본문이 바뀌면 여러 단의 너비 기록을 버린다. */
export function docxContentChanged(geo: CanvasGeometry | null): void {
  if (geo) resetColumnPasses(geo);
}

/** 쪽 나누기 한 번: 쪽 사이 띠(머리말·꼬리말 포함)를 다시 그리고 쪽수를 돌려준다. 캔버스 배율은 1로 재고 되돌린다(원본과 같은 규칙). */
export function paginateDocx(editor: Editor, geo: CanvasGeometry, zoomEl: HTMLElement | null, edgeHost: HTMLElement | null): CanvasPagination | null {
  const live = zoomEl?.style.zoom || "";
  if (zoomEl && live && live !== "1") zoomEl.style.zoom = "1";
  try {
    return paginateCanvas(editor, geo, { zoomFactor: 1, edgeHost });
  } finally {
    if (zoomEl && live && live !== "1") zoomEl.style.zoom = live;
  }
}

/** Build separate physical sheets from a detached editor; the live editor's selection, zoom and history stay untouched. */
export async function docxPrintHtml(editor: Editor, model: DocxModel, geometry: CanvasGeometry, scope: string, title: string): Promise<string> {
  const content = editor.getJSON() as JSONContent;
  const notes = docxNotes(model);
  if (notes.length) content.content = [...(content.content ?? []), { type: "docParagraph", content: [{ type: "text", text: "미주" }] }, ...notes.map((n) => ({ type: "docParagraph", content: [{ type: "text", text: `${n.no} ${n.text}` }] }))];
  const geo = { ...geometry, editingStrip: null, colPass: newWidthPassState() };
  const width = paperWidthPx(geo.sections, geo.first);
  const root = document.createElement("div");
  root.className = "cdd-docx";
  root.dataset.cddDoc = scope;
  root.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;display:block;width:${width}px;height:auto;overflow:visible`;
  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";
  scroll.style.cssText = "display:block;height:auto;overflow:visible;padding:0;scrollbar-gutter:auto";
  const wrap = document.createElement("div");
  wrap.className = "page-wrap cdd-page-wrap";
  wrap.style.cssText = `width:${width}px;margin:0`;
  for (const [name, value] of Object.entries(geo.vars)) wrap.style.setProperty(name, value);
  wrap.style.setProperty("--page-w", `${width}px`);
  const host = document.createElement("div");
  wrap.append(host);
  scroll.append(wrap);
  root.append(scroll);
  document.body.append(root);
  let copy: Editor | null = null;
  try {
    copy = new Editor({ element: host, extensions: docxExtensions(), content, editable: false, injectCSS: false, editorProps: { attributes: { class: "doc-page" } } });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>('img[src]:not([src=""])')).map((img) => img.decode().catch(() => { throw new Error("인쇄할 그림을 읽지 못했습니다. 그림을 다시 넣거나 문서를 다시 열어 주세요."); })));
    await document.fonts.ready;
    let layout: CanvasPagination | null = null;
    for (let pass = 0; pass < 8; pass++) {
      layout = paginateCanvas(copy, geo, { zoomFactor: 1, edgeHost: wrap, print: true });
      if (layout && !layout.followUp) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!layout?.printPages?.length || layout.followUp) throw new Error("인쇄용 쪽 구성을 확정하지 못했습니다. 문서를 다시 열고 시도해 주세요.");
    if (layout.unanchored) throw new Error("이 문서의 표 또는 중첩 개체를 쪽 경계에 맞춰 인쇄하지 못했습니다. 해당 부분의 쪽 나누기를 조정해 주세요.");
    const font = getComputedStyle(copy.view.dom).fontFamily;
    const snapshot = root.cloneNode(true) as HTMLElement;
    snapshot.classList.add("cdd-print-canvas");
    snapshot.style.height = `${root.getBoundingClientRect().height}px`;
    const overlays = layout.printPages.map((p) => {
      const el = document.createElement("div");
      el.innerHTML = p.header + p.footer + p.notes;
      return el;
    });
    const css = await embedPrintResources(screenStyleSheet(), [snapshot, ...overlays]);
    return buildDocxPrintHtml(snapshot.outerHTML, layout.printPages.map((p, i) => ({ ...p, header: overlays[i].innerHTML, footer: "", notes: "" })), css, title, scope, font);
  } finally {
    copy?.destroy();
    root.remove();
  }
}

/** 서버 블록 자리(index·sub) → 편집기 DOM 요소. 맨 위 노드의 docxIndex 속성으로 찾는다. */
export function docxBlockElement(editor: Editor, index: number, sub = 0): HTMLElement | null {
  const doc = editor.state.doc;
  let n = -1;
  let found: HTMLElement | null = null;
  doc.forEach((node, offset) => {
    if (found || node.attrs.docxIndex !== index) return;
    n += 1;
    if (n === sub || sub === 0) {
      const el = editor.view.nodeDOM(offset);
      found = el instanceof HTMLElement ? el : null;
    }
  });
  return found;
}

// 선택 -----------------------------------------------------------------------------

export function docxSelectionText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "\n");
}

/** 선택한 부분을 글(여러 줄이면 문단 여럿)로 바꾼다. */
export function docxReplaceSelection(editor: Editor, texts: string[]): void {
  if (texts.length <= 1) editor.chain().focus().insertContent(texts[0] ?? "").run();
  else editor.chain().focus().insertContent(texts.map((t) => ({ type: "docParagraph", content: t ? [{ type: "text", text: t }] : [] }))).run();
}

// 서식 -----------------------------------------------------------------------------

const HIGHLIGHT_HEX: Record<string, string> = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff" };

function hex6(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  return m ? `#${m[1].toLowerCase()}` : HIGHLIGHT_HEX[v];
}

/** 캐럿(또는 선택)의 서식 — 서식 막대가 읽는 모양(스튜디오 문맥과 같은 단위: 글자 크기 pt×100, 줄 간격 %). */
export function docxReadFormat(editor: Editor, model: DocxModel | null): FormatState {
  const ts = editor.getAttributes("docTextStyle") as Record<string, unknown>;
  const para = { ...editor.getAttributes("docParagraph"), ...editor.getAttributes("docHeading"), ...editor.getAttributes("docListItem") } as Record<string, unknown>;
  const defaultHalf = model?.docDefaults?.sizeHalfPoints ?? 22;
  const half = typeof ts.sizeHalfPoints === "number" ? ts.sizeHalfPoints : defaultHalf;
  const font = (ts.fontAscii as string | null) ?? (ts.font as string | null) ?? model?.docDefaults?.asciiFont ?? undefined;
  const align = para.align as string | null | undefined;
  const lineRule = para.lineRule as string | null | undefined;
  const line = para.lineSpacing as number | null | undefined;
  return {
    fontFamily: font ?? undefined,
    fontSize: Math.round(half * 50),
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strikethrough: editor.isActive("strike"),
    textColor: ts.color && ts.color !== "auto" ? hex6(ts.color) : undefined,
    shadeColor: hex6(ts.highlight) ?? hex6(ts.shading),
    alignment: align === "justify" || align === "left" || align === "center" || align === "right" || align === "distribute" ? align : "left",
    lineSpacing: typeof line === "number" && (!lineRule || lineRule === "auto") ? Math.round(line * 100) : undefined, // 편집기 속성은 배수(1 = 100%)
    pending: editor.state.selection.empty && !!editor.state.storedMarks,
  };
}

export function docxApplyChar(editor: Editor, mods: CharMods): void {
  const attrs: Record<string, unknown> = {};
  if (mods.fontName) {
    attrs.font = mods.fontName;
    attrs.fontAscii = mods.fontName;
  }
  if (mods.fontSizePt) attrs.sizeHalfPoints = Math.round(mods.fontSizePt * 2);
  if (mods.textColor) attrs.color = mods.textColor.replace("#", "").toUpperCase();
  if (mods.shadeColor) {
    attrs.shading = mods.shadeColor.replace("#", "").toUpperCase(); // w:shd (형광펜 이름 제한이 없다)
    attrs.highlight = null;
  }
  if (Object.keys(attrs).length) editor.chain().focus().setMark("docTextStyle", attrs).run();
}

export function docxApplyPara(editor: Editor, mods: ParaMods): void {
  const attrs: Record<string, unknown> = {};
  if (mods.alignment) attrs.align = mods.alignment;
  if (mods.lineSpacing) {
    attrs.lineSpacing = mods.lineSpacing / 100; // 배수
    attrs.lineRule = "auto";
  }
  if (!Object.keys(attrs).length) return;
  editor.chain().focus().updateAttributes("docParagraph", attrs).updateAttributes("docHeading", attrs).updateAttributes("docListItem", attrs).run();
}

export function docxToggle(editor: Editor, kind: ToggleKind): void {
  editor.chain().focus().toggleMark(kind === "strikethrough" ? "strike" : kind).run();
}

/** 문서가 쓰는 글꼴 (글꼴표 + run의 글꼴). */
export function docxFonts(model: DocxModel): string[] {
  const names = new Set<string>();
  for (const n of [model.docDefaults?.asciiFont, model.docDefaults?.eastAsiaFont]) if (n) names.add(n);
  for (const st of model.styles.values()) for (const n of [st.display?.fontAscii, st.display?.font]) if (n) names.add(n);
  for (const f of model.fontTable ?? []) if (f.name) names.add(f.name);
  for (const b of model.blocks) for (const r of b.runs ?? []) for (const n of [r.fontAscii, r.font]) if (n) names.add(n);
  return [...names];
}

/** 서식 막대용 FormatSource (format-source.ts). zoom은 `.doc-zoom`의 CSS zoom. */
export function docxFormatSource(opts: { id: string; editor: Editor; model: () => DocxModel | null; zoomEl: () => HTMLElement | null; localFonts: () => string[]; afterZoom: () => void; detectFonts?: (force: boolean) => Promise<void> }): FormatSource {
  const { editor } = opts;
  const read = async (): Promise<StudioContext> => {
    const model = opts.model();
    const zoom = parseFloat(opts.zoomEl()?.style.zoom || "1") || 1;
    return { format: model ? docxReadFormat(editor, model) : null, documentFonts: model ? docxFonts(model) : [], localFonts: opts.localFonts(), zoom, canUndo: editor.can().undo(), canRedo: editor.can().redo(), hasDocument: !!model };
  };
  return {
    id: opts.id,
    read,
    setChar: async (mods) => docxApplyChar(editor, mods),
    setPara: async (mods) => docxApplyPara(editor, mods),
    toggle: async (kind) => docxToggle(editor, kind),
    align: async (a) => docxApplyPara(editor, { alignment: a }),
    zoom: async (pct) => {
      const el = opts.zoomEl();
      if (el) el.style.zoom = String(pct / 100);
      opts.afterZoom();
    },
    ...(opts.detectFonts ? { detectFonts: opts.detectFonts } : {}),
  };
}
