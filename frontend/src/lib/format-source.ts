// 서식 막대(FormatBar)가 편집기 종류를 가리지 않게 하는 인터페이스. HWPX는 rhwp-studio(studio.ts의 studioFormatSource),
// DOCX는 Tiptap 편집기(docx-editor.ts의 docxFormatSource)가 구현한다. 값의 단위는 스튜디오 문맥을 따른다(글자 크기 pt×100, 줄 간격 %).
import type { StudioContext } from "./studio";

export type CharMods = { fontName?: string; fontSizePt?: number; textColor?: string; shadeColor?: string };
export type ParaMods = { alignment?: "left" | "center" | "right" | "justify" | "distribute"; lineSpacing?: number };
export type ToggleKind = "bold" | "italic" | "underline" | "strikethrough";

export type FormatSource = {
  /** 편집기가 바뀌면 달라지는 표식 — 막대가 옛 상태를 버리는 기준 */
  id: string;
  read(): Promise<StudioContext>;
  setChar(mods: CharMods): Promise<void>;
  setPara(mods: ParaMods): Promise<void>;
  toggle(kind: ToggleKind): Promise<void>;
  align(a: "left" | "center" | "right" | "justify"): Promise<void>;
  zoom(pct: number): Promise<void>;
  /** 설치 글꼴 감지(웹판은 사용자 동작 안에서만 허락을 묻는다). 없으면 막대가 그 항목을 보이지 않는다 */
  detectFonts?(force: boolean): Promise<void>;
};
