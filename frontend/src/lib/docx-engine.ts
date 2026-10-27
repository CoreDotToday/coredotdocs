// DOCX 문서 모델 — third_party/genoffice-docx(Apache-2.0, GenOffice docx-engine 그대로 복사)에 대한 우리 쪽 유일한 입구 (설계 문서 04 §12 D2).
// 다른 코드는 `@genoffice/*`를 직접 가져오지 않고 이 파일의 함수만 쓴다 (scripts/check-third-party.mjs가 지킨다).
//
// 모델: parseDocx → Block[] (각 블록의 docxIndex = 원본 word/document.xml에서 w:body 맨 위 요소의 번호). 서버의 블록 목록(/blocks)은
// 같은 셈법의 `index`(와 콘텐츠 컨트롤 안 문단 번호 `sub`)를 주므로 둘을 맞출 수 있다. 저장은 paragraph-patch: 안 바뀐 블록은
// 원본 XML을 그대로 잇고(`kind: "original"`) 바뀐 블록만 다시 만든다(`kind: "generated"`) — 서버 엔진(docx_fidelity)과 같은 원칙.
import { parseDocx, readSections, saveDocx, type Block, type GeneratedBlock, type ParsedDoc, type ParseExtras, type SaveBlock, type SaveOptions, type SectionInfo } from "@genoffice/docx-engine";

export type DocxModel = ParsedDoc & { extras: ParseExtras };
export type { Block as DocxBlock, GeneratedBlock as DocxGeneratedBlock, SaveBlock as DocxSaveBlock, SectionInfo as DocxSection };

/** 바이트 → 모델. altChunk(HTML 조각)도 펼친다. */
export function openDocx(bytes: Uint8Array): Promise<DocxModel> {
  return parseDocx(bytes, { expandAltChunks: true });
}

/** 편집기에 보이는 블록(숨은 꼬리 요소 제외). */
export function visibleBlocks(model: DocxModel): Block[] {
  return model.blocks.filter((b) => !b.hidden);
}

export function sectionsOf(model: DocxModel): SectionInfo[] {
  return readSections(model);
}

/** 블록의 글(run 이어 붙임; 표·그림 등은 미리보기 글). */
export function blockText(b: Block): string {
  if (b.runs) return b.runs.map((r) => r.text).join("");
  return b.previewText ?? "";
}

/** 서버 블록 자리(index·sub) → 엔진 블록. 콘텐츠 컨트롤 안 문단이 여럿이면 sub번째(없으면 첫째). */
export function engineBlockAt(model: DocxModel, index: number, sub = 0): Block | undefined {
  const same = model.blocks.filter((b) => b.docxIndex === index && !b.hidden);
  return same[sub] ?? same[0];
}

/** 고친 것이 없을 때의 저장 블록 목록: 모두 원본 그대로. */
export function originalSaveBlocks(model: DocxModel): SaveBlock[] {
  return visibleBlocks(model)
    .filter((b): b is Block & { docxIndex: number } => b.docxIndex !== null)
    .map((b) => ({ kind: "original", docxIndex: b.docxIndex }));
}

/** 문단 블록의 글만 바꾼 새 블록(서식·pPr·책갈피·주석 범위·콘텐츠 컨트롤 껍데기는 그대로). 첫 run의 글자 모양을 잇는다. */
export function paragraphWithText(b: Block, text: string): GeneratedBlock {
  const type = b.type === "heading" || b.type === "listItem" ? b.type : "paragraph";
  const first = b.runs?.find((r) => r.text.length > 0) ?? b.runs?.[0];
  return {
    type,
    ...(b.level !== undefined ? { level: b.level } : {}),
    ...(b.outlineOnly ? { outlineOnly: true } : {}),
    ...(b.styleId ? { styleId: b.styleId } : {}),
    ...(b.list ? { list: b.list } : {}),
    ...(b.format ? { format: b.format } : {}),
    ...(b.rawPPr ? { rawPPr: b.rawPPr } : {}),
    ...(b.bookmarks ? { bookmarks: b.bookmarks } : {}),
    ...(b.hiddenBookmarks ? { hiddenBookmarks: b.hiddenBookmarks } : {}),
    ...(b.commentStarts ? { commentStarts: b.commentStarts } : {}),
    ...(b.commentEnds ? { commentEnds: b.commentEnds } : {}),
    ...(b.sdtShell ? { sdtShell: b.sdtShell } : {}),
    runs: [{ ...(first ?? {}), text }],
  };
}

/** 모델 + 저장 블록 목록 → .docx 바이트 (paragraph-patch). */
export function saveDocxBytes(model: DocxModel, blocks: SaveBlock[], options: SaveOptions = {}): Promise<Uint8Array> {
  return saveDocx(model, blocks, options);
}

/** 한 문단의 글만 바꿔 저장한다 (서버 도구가 없을 때의 작은 편집·테스트용). */
export async function saveWithParagraphText(model: DocxModel, index: number, text: string, sub = 0): Promise<Uint8Array> {
  const target = engineBlockAt(model, index, sub);
  if (!target || target.docxIndex === null) throw new Error(`블록 ${index}이(가) 없습니다.`);
  const blocks: SaveBlock[] = originalSaveBlocks(model).map((sb) => (sb.kind === "original" && sb.docxIndex === target.docxIndex ? { kind: "generated", block: paragraphWithText(target, text), docxIndex: target.docxIndex } : sb));
  return saveDocx(model, blocks, {});
}

/**
 * 서버 블록 자리(`index`: w:body 맨 위 요소 번호, 콘텐츠 컨트롤은 엔진과 같은 셈법) → 편집기 엔진의 docxIndex.
 * 엔진은 altChunk(HTML 조각)를 여러 블록으로 펼치며 둘째부터는 길이 0인 자리(start === end)로 둔다 — 서버는 그 요소를
 * 하나로 세므로 길이 0인 자리는 건너뛰며 센다. 맞는 자리가 없으면 null.
 */
export function editorIndexOf(model: DocxModel, serverIndex: number): number | null {
  let ordinal = -1;
  const elements = model.extras.elements;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const synthetic = el.start === el.end && i > 0 && elements[i - 1].end === el.start;
    if (!synthetic) ordinal += 1;
    if (ordinal === serverIndex) return i;
  }
  return null;
}
