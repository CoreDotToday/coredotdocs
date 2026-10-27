// 데스크톱 앱(Electron) 브리지. preload가 window.coredotdocs로 노출한다. 웹에서는 undefined.
// preload는 작은 API 묶음만 노출한다(sandbox·contextIsolation): 파일 열기/저장, 메뉴, AI 앱 연결.
export type OpenedFile = { path: string; name: string; data: ArrayBuffer };
export type InstalledFont = { family: string; localized?: string };
export type AiTarget = "claude-desktop" | "claude-code" | "codex";

export interface DesktopBridge {
  platform: string;
  version: string;
  /** 설치된 글꼴 가족(메인 프로세스가 글꼴 파일의 name 표를 읽는다). family는 영문 이름, localized는 한국어 이름(있으면) */
  listFonts?(): Promise<InstalledFont[]>;
  /** 열기 대화상자 → 고른 파일들 */
  openFileDialog(): Promise<OpenedFile[]>;
  /** 경로의 파일을 읽는다 (최근 문서). 없으면 null */
  readPath(path: string): Promise<OpenedFile | null>;
  /** 저장. path가 없으면 저장 대화상자. 취소하면 null */
  saveFile(opts: { data: ArrayBuffer | Uint8Array; path?: string; suggestedName: string }): Promise<{ path: string; name: string } | null>;
  /** 인쇄용 HTML을 숨은 창에서 PDF로 만들어 저장한다. path가 없으면 저장 대화상자. 취소하면 null */
  printToPdf(opts: ({ html: string; currentDocument?: false } | { currentDocument: true; html?: never }) & { suggestedName: string; path?: string }): Promise<{ path: string; name: string } | null>;
  /** 인쇄용 HTML을 숨은 창에 띄워 시스템 인쇄 대화상자를 연다 */
  printHtml(opts: { html: string; title: string }): Promise<{ ok: boolean; message?: string }>;
  /** 창 제목·저장 안 됨 표시·닫기 보호에 쓴다 */
  setDocumentState(state: { title: string; dirty: boolean; path?: string }): void;
  /** AI 앱 설정 파일에 이 앱의 MCP 브리지를 등록한다 */
  connectAi(target: AiTarget): Promise<{ ok: boolean; message: string }>;
  /** 네이티브 메뉴 선택 (id: file:open, file:save, …) */
  onMenu(cb: (id: string) => void): () => void;
  /** 파일 연결·끌어다 놓기·두 번째 실행 인자로 들어온 파일 */
  onOpenFiles(cb: (files: OpenedFile[]) => void): () => void;
  showInFolder(path: string): void;
  pathForFile(file: File): string;
  openExternal(url: string): void;
}

declare global {
  interface Window {
    coredotdocs?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.coredotdocs;
}

export function isDesktop(): boolean {
  return !!desktopBridge();
}

/** 브라우저(웹판)에서 파일을 내려받는다. 데스크톱은 saveFile을 쓴다. */
export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
