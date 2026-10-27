// upstream rhwp-studio(MIT) 를 @rhwp/editor SDK로 iframe에 띄운다. 배포본은 우리 서버의 /rhwp/ 에서 제공한다(scripts/fetch-rhwp-studio.mjs).
// rhwp-studio를 iframe으로 띄운다.
import type { CommandInfo, MenuItemNode, MenuNode, RhwpEditor } from "@rhwp/editor";

export type { CommandInfo, MenuItemNode, MenuNode, RhwpEditor };

export const STUDIO_ENGINE = "rhwp-studio 0.8.7";

/**
 * `chrome=embed`: 스튜디오가 자기 파일 명령(새 문서·열기·저장·인쇄)과 문서 끌어다 놓기를 끈다.
 * 탭이 파일을 갖고 있으므로 편집기 안에서 문서가 바뀌면 다음 저장이 탭의 파일을 다른 문서로 덮어쓴다 — 그래서 반드시 embed로 띄운다.
 * (설계 문서 04 §2 A1. 공개 빌드도 URL의 chrome 파라미터를 읽는다.)
 */
export function studioUrl(): string {
  return `${window.location.origin}/rhwp/index.html?chrome=embed&lang=ko`;
}

const SETTINGS_KEY = "rhwp-settings";

/**
 * 스튜디오가 부팅 전에 읽는 설정(localStorage, 같은 출처)을 심는다.
 * 복구용 자동 저장을 끈다: 스튜디오는 문서 사본을 IndexedDB에 남기지만 embed 모드에서는 되돌려 주지 않으므로
 * 켜 두면 사용자 문서의 사본만 프로필에 쌓인다. (설계 문서 04 §2 A3)
 */
export function seedStudioSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const autosave = (data.autosave as Record<string, unknown> | undefined) ?? {};
    if (autosave.recoveryEnabled === false && autosave.idleSaveEnabled === false) return;
    data.autosave = { ...autosave, recoveryEnabled: false, idleSaveEnabled: false };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* 저장소를 못 쓰는 환경(비공개 창 등)이면 그대로 둔다 */
  }
}

/** 스튜디오를 컨테이너에 심는다. 메뉴·도구 막대는 우리 것(EditorChrome)을 쓰므로 숨긴다. */
export async function mountStudio(container: HTMLElement): Promise<RhwpEditor> {
  seedStudioSettings();
  const { createStudio } = await import("@rhwp/editor");
  return createStudio(container, { studioUrl: studioUrl(), chrome: { menu: false, toolbar: false, statusbar: true }, requestTimeoutMs: 60_000 });
}

/** 명령 실행. 대화상자를 여는 명령도 허용한다(사용자가 앞에 있다). 실패하면 메시지를 던진다. */
export async function runCommand(studio: RhwpEditor, id: string, params?: Record<string, unknown>): Promise<void> {
  const r = await studio.commands.execute(id, params, { allowDialog: true });
  if (!r.ok) throw new Error(r.message ?? r.reason);
}

/**
 * 캐럿 자리의 서식 — 자체 빌드 스튜디오의 명령 문맥에 실려 온다(`frontend/scripts/studio-format-patches.mjs`, cdd-format-context).
 * fontSize는 HWPUNIT(1pt = 100). 공개 미러 빌드에는 없다(그러면 null → 서식 막대는 토글만 보여 준다).
 */
export type FormatState = {
  fontFamily?: string;
  fontFamilies?: string[];
  fontSize?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textColor?: string;
  shadeColor?: string;
  alignment?: string;
  lineSpacing?: number;
  /** 선택 없이 고른 서식이 캐럿에 대기 중(다음 타이핑부터) */
  pending?: boolean;
};

export type StudioContext = { format: FormatState | null; documentFonts: string[]; localFonts: string[]; zoom: number; canUndo: boolean; canRedo: boolean; hasDocument: boolean };

/** 명령 문맥 한 번 읽기 (postMessage 왕복 하나; 문서 해시 없음). */
export async function readStudioContext(studio: RhwpEditor): Promise<StudioContext> {
  const ctx = await studio.commands.context();
  const f = ctx.format as Partial<FormatState> | undefined;
  return {
    format: f ? { bold: !!f.bold, italic: !!f.italic, underline: !!f.underline, strikethrough: !!f.strikethrough, fontFamily: f.fontFamily, fontFamilies: f.fontFamilies, fontSize: f.fontSize, textColor: f.textColor, shadeColor: f.shadeColor, alignment: f.alignment, lineSpacing: f.lineSpacing, pending: f.pending === true } : null,
    documentFonts: Array.isArray(ctx.documentFonts) ? (ctx.documentFonts as string[]) : [],
    localFonts: Array.isArray(ctx.localFonts) ? (ctx.localFonts as string[]) : [],
    zoom: typeof ctx.zoom === "number" ? ctx.zoom : 1,
    canUndo: ctx.canUndo === true,
    canRedo: ctx.canRedo === true,
    hasDocument: ctx.hasDocument === true,
  };
}

/** 글자 속성 지정 (선택이 없으면 캐럿 대기 서식 — 다음 타이핑부터). fontSize는 pt. */
export function setCharFormat(studio: RhwpEditor, mods: { fontName?: string; fontSizePt?: number; textColor?: string; shadeColor?: string }): Promise<void> {
  const params: Record<string, unknown> = {};
  if (mods.fontName) params.fontName = mods.fontName;
  if (mods.fontSizePt !== undefined) params.fontSize = Math.round(Math.min(4096, Math.max(1, mods.fontSizePt)) * 100);
  if (mods.textColor) params.textColor = mods.textColor;
  if (mods.shadeColor) params.shadeColor = mods.shadeColor;
  return runCommand(studio, "format:set-char", params);
}

/** 문단 속성 지정 (캐럿/선택 문단). */
export function setParaFormat(studio: RhwpEditor, mods: { alignment?: "left" | "center" | "right" | "justify" | "distribute"; lineSpacing?: number }): Promise<void> {
  const params: Record<string, unknown> = {};
  if (mods.alignment) params.alignment = mods.alignment;
  if (mods.lineSpacing !== undefined) {
    params.lineSpacing = mods.lineSpacing;
    params.lineSpacingType = "Percent";
  }
  return runCommand(studio, "format:set-para", params);
}

/** 서식 막대의 글꼴 목록. 문서 글꼴 → 설치된 글꼴(스튜디오가 감지한 것, 한국어 정렬) → 기본 글꼴(앞의 둘에 없는 것만). */
export const COMMON_FONTS = ["함초롬바탕", "함초롬돋움", "바탕", "돋움", "굴림", "궁서", "맑은 고딕", "나눔고딕", "나눔명조", "나눔바른고딕", "Noto Sans KR", "Noto Serif KR", "Arial", "Times New Roman", "Courier New"];
export type FontGroups = { document: string[]; system: string[]; basic: string[] };
export function fontGroups(documentFonts: string[], localFonts: string[], current?: string, labels?: ReadonlyMap<string, string>): FontGroups {
  const seen = new Set<string>();
  const take = (list: string[]) => list.filter((f) => f && !seen.has(f) && (seen.add(f), true));
  const document = take([...(current ? [current] : []), ...documentFonts]);
  const label = (f: string) => labels?.get(f) ?? f;
  const system = take([...localFonts].sort((a, b) => label(a).localeCompare(label(b), "ko")));
  const basic = take(COMMON_FONTS);
  return { document, system, basic };
}
/** 이전 호환: 평평한 목록 */
export function fontChoices(documentFonts: string[], current?: string): string[] {
  const g = fontGroups(documentFonts, [], current);
  return [...g.document, ...g.basic];
}

/** 설치된 글꼴 감지(스튜디오 명령; Local Font Access). 웹판은 사용자 동작 안에서 불러야 하고 브라우저가 허락을 묻는다. */
export function detectLocalFonts(studio: RhwpEditor, force = false): Promise<void> {
  return runCommand(studio, "tools:detect-local-fonts", { force });
}

/** 서식 막대용 공용 인터페이스(format-source.ts)의 rhwp-studio 구현. */
export function studioFormatSource(studio: RhwpEditor): import("./format-source").FormatSource {
  return {
    id: `studio:${studio.element.src}`,
    read: () => readStudioContext(studio),
    setChar: (mods) => setCharFormat(studio, mods),
    setPara: (mods) => setParaFormat(studio, mods),
    toggle: (kind) => runCommand(studio, `format:${kind}`),
    align: (a) => runCommand(studio, `format:align-${a}`),
    zoom: (pct) => runCommand(studio, `view:zoom-${pct}`),
    detectFonts: (force) => detectLocalFonts(studio, force),
  };
}

export const FONT_SIZES = [7, 8, 9, 10, 10.5, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72];
export const LINE_SPACINGS = [100, 110, 120, 130, 140, 150, 160, 170, 180, 200, 250, 300];
/** 스튜디오에 `view:zoom-N` 명령이 있는 배율. */
export const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200, 300, 500];

/**
 * 값싼 변경 번호: getSelectionContext().changeSeq (문서 해시 없음).
 * 캐럿이 표 칸 안에 있으면 rhwp 0.8.7이 칸 안 문단 번호로 쪽을 찾다 "문단 (sec=0, para=N)이 페이지에 없습니다"를 던진다(관측: 표로만 된
 * 문서에서 타이핑 뒤 올리기가 막힘). 그때는 같은 번호를 주는 getDocumentState()로 물러선다 — 문서 해시라 큰 문서에서 1초쯤 걸리지만 올리기는 된다.
 */
export async function studioChangeSeq(studio: Pick<RhwpEditor, "getSelectionContext" | "getDocumentState">): Promise<number> {
  try {
    return (await studio.getSelectionContext()).changeSeq;
  } catch {
    return (await studio.getDocumentState()).changeSeq;
  }
}

/** 스튜디오 문맥에서 "저장 안 된 변경이 있는가"를 싸게 읽는다. getDocumentState()는 문서 전체 해시라 큰 문서에서 1초쯤 걸린다. */
export async function studioIsDirty(studio: RhwpEditor): Promise<boolean> {
  const ctx = await studio.commands.context();
  return ctx.isDirty === true;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 메뉴 모델에서 우리가 직접 그리는 메뉴(파일)는 빼고, 비어 있는 메뉴도 뺀다. */
export function studioMenus(model: MenuNode[]): MenuNode[] {
  return model.filter((m) => m.menuId !== "file" && m.items.length > 0);
}

/** 메뉴 항목 중 실행 가능한 명령 id를 모두 모은다 (단축키 매핑·테스트용). */
export function collectCommandIds(items: MenuItemNode[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.commandId) out.push(it.commandId);
    if (it.submenu) out.push(...collectCommandIds(it.submenu));
  }
  return out;
}

/** 끌어다 놓은 파일 중 문서(HWPX·HWP·DOCX)만 고른다. 그림은 편집기의 그림 넣기로 가야 하므로 빼 둔다. */
export function documentFiles(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => /\.(hwpx|hwp|docx)$/i.test(f.name));
}

/**
 * 편집 활동으로 볼 입력 이벤트들. 스튜디오는 사람의 타이핑에 대해 이벤트를 내지 않으므로(onDocumentChanged는 agent apply/revert 전용),
 * iframe 창의 입력 이벤트를 capture 단계에서 듣고 잠시 뒤 isDirty를 확인한다.
 */
export const ACTIVITY_EVENTS = ["keyup", "input", "compositionend", "pointerup", "paste", "cut", "drop"] as const;

/** 도구 막대 단추 정의(서식이 아닌 것). 스튜디오 명령 id ↔ 짧은 라벨. 글꼴·크기·굵게·정렬·줄 간격은 서식 막대(FormatBar)에 있다. */
export const TOOLBAR: { id: string; label: string; title: string }[][] = [
  [
    { id: "edit:undo", label: "↶", title: "되돌리기 (Ctrl+Z)" },
    { id: "edit:redo", label: "↷", title: "다시 실행 (Ctrl+Y)" },
  ],
  [
    { id: "table:create", label: "표", title: "표 만들기" },
    { id: "insert:image", label: "그림", title: "그림 넣기" },
    { id: "page:break", label: "쪽 나누기", title: "쪽 나누기 (Ctrl+Enter)" },
  ],
  [
    { id: "format:char-shape", label: "글자 모양", title: "글자 모양 자세히 (대화상자, Alt+L)" },
    { id: "format:para-shape", label: "문단 모양", title: "문단 모양 자세히 (대화상자, Alt+T)" },
    { id: "edit:find", label: "찾기", title: "찾기 (Ctrl+F)" },
    { id: "edit:find-replace", label: "바꾸기", title: "찾아 바꾸기 (Ctrl+H)" },
  ],
];
