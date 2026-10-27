// 앱 셸(AppShell)이 하위 화면에 주는 동작 묶음. 파일 열기·저장·탭 닫기·AI 연결처럼 '앱' 수준의 일.
import { createContext, useContext } from "react";
import type { DocFormat } from "./api";
import type { AiTarget } from "./desktop";
import type { AgentBridge } from "./agent-plugin";
import type { RhwpEditor } from "./studio";
import type { RecentEntry } from "./tabs";
import type { HelpSectionId } from "./help";

export type LocalFile = { name: string; data: ArrayBuffer; path?: string };

export type StudioHandle = { studio: RhwpEditor; flush: () => Promise<boolean>; bridge: AgentBridge };

export interface ShellApi {
  openFileDialog(): Promise<void>;
  openLocalFiles(files: LocalFile[]): Promise<void>;
  openServerDocument(id: string): Promise<void>;
  openRecent(entry: RecentEntry): Promise<void>;
  newDocument(format: DocFormat): Promise<void>;
  save(tabId: string, as?: boolean): Promise<boolean>;
  exportAs(tabId: string, format: "hwp" | "hwpx" | "docx"): Promise<void>;
  /** 쪽 SVG를 모아 PDF로 저장 (데스크톱: 숨은 창 printToPDF, 웹판: 새 창에서 인쇄 대화상자) */
  exportPdf(tabId: string): Promise<void>;
  /** 시스템 인쇄 대화상자 */
  printDocument(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  registerStudio(tabId: string, handle: StudioHandle | null): void;
  getStudio(tabId: string): StudioHandle | undefined;
  /** 스튜디오가 아닌 편집기(DOCX)의 "올리지 않은 변경 올리기" — flush(tabId)·저장이 먼저 부른다 */
  registerFlusher(tabId: string, flush: (() => Promise<boolean>) | null): void;
  /** 편집기가 계산한 실제 쪽을 독립 인쇄 문서로 만든다 (DOCX). */
  registerPrintRenderer(tabId: string, render: (() => Promise<string>) | null): void;
  /** 편집기의 아직 올리지 않은 변경을 서버 리비전으로 밀어 넣는다 (AI에게 부탁하기 직전). 서버가 거절하면 거짓 */
  flush(tabId: string): Promise<boolean>;
  /** 지금 보이는 탭 id */
  activeTabId(): string | undefined;
  markDirty(tabId: string, dirty?: boolean): void;
  undoAi(tabId: string): Promise<void>;
  toggleAi(): void;
  connectAi(target: AiTarget): Promise<void>;
  notify(message: string, kind?: "info" | "error"): void;
  openHelp(section?: HelpSectionId): void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("ShellContext가 없습니다");
  return shell;
}

export function formatFromName(name: string): DocFormat | "hwp" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".hwpx")) return "hwpx";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".hwp")) return "hwp";
  return null;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function stripExt(name: string): string {
  return name.replace(/\.(hwpx|hwp|docx)$/i, "");
}
