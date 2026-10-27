// @vitest-environment jsdom
// DOCX 편집기 래퍼: 모델 → 편집기 문서 → 서식 적용 → paragraph-patch 저장 → 다시 읽기.
import { Editor } from "@tiptap/core";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxApplyChar, docxApplyPara, docxContent, docxExtensions, docxFonts, docxGeometry, docxNotes, editFootnote, docxReadFormat, docxSection, docxSelectionText, docxStyleSheet, docxToggle, exportDocx } from "./docx-editor";
import { blockText, openDocx, visibleBlocks } from "./docx-engine";
import { externalImageDocx, EXTERNAL_IMAGE } from "../../e2e/external-image-fixture";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

async function sample(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="맑은 고딕" w:hAnsi="맑은 고딕" w:eastAsia="맑은 고딕"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file(
    "word/document.xml",
    `${DECL}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>첫 문단</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>둘째 굵게</w:t></w:r></w:p><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1701" w:bottom="850" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function makeEditor(content: ReturnType<typeof docxContent>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new Editor({ element: el, extensions: docxExtensions(), content });
}

describe("docx-editor 래퍼", () => {
  it.each([EXTERNAL_IMAGE, "http://127.0.0.1:8000/private.png", "file:///private/image.png", "../private.png"])("외부 그림 요청을 막고 원본 관계는 저장에 유지한다: %s", async (target) => {
    const original = await externalImageDocx(target);
    const zip = await JSZip.loadAsync(original);
    const originalRels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    const model = await openDocx(new Uint8Array(original));
    const editor = makeEditor(docxContent(model));
    try {
      const blocked = editor.view.dom.querySelectorAll('img[data-cdd-external-image="blocked"]');
      expect(blocked.length).toBeGreaterThanOrEqual(2);
      for (const img of blocked) expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
      expect([...editor.view.dom.querySelectorAll("img")].some((img) => img.getAttribute("src") === target)).toBe(false);
      const unedited = await exportDocx(editor, model, 3);
      expect(unedited.changed).toBe(0);
      editor.commands.setTextSelection(2);
      editor.commands.insertContent("edited");
      const edited = await exportDocx(editor, model, 3);
      const saved = await JSZip.loadAsync(edited.bytes);
      expect(await saved.file("word/_rels/document.xml.rels")!.async("string")).toBe(originalRels);
      expect(await saved.file("word/document.xml")!.async("string")).toContain('r:link="rIdExternal"');
      expect(await saved.file("word/_rels/header1.xml.rels")!.async("string")).toBe(await zip.file("word/_rels/header1.xml.rels")!.async("string"));
    } finally { editor.destroy(); }
  });
  it("모델을 편집기 문서로 바꾸고 서식을 읽는다", async () => {
    const model = await openDocx(await sample());
    const editor = makeEditor(docxContent(model));
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).attrs.docxIndex).toBe(0);
    expect(editor.getText()).toContain("둘째 굵게");
    expect(docxSection(model)?.pageWidth).toBe(11906);
    expect(docxFonts(model)).toContain("맑은 고딕");
    // 둘째 문단 안으로 캐럿 → 굵게·14pt·가운데
    const pos = editor.state.doc.child(0).nodeSize + 2;
    editor.commands.setTextSelection(pos);
    const f = docxReadFormat(editor, model);
    expect(f.bold).toBe(true);
    expect(f.fontSize).toBe(1400);
    expect(f.alignment).toBe("center");
    editor.destroy();
  });

  it("서식 막대의 변경이 paragraph-patch로 저장되고 다시 읽힌다", async () => {
    const model = await openDocx(await sample());
    const editor = makeEditor(docxContent(model));
    // 첫 문단 전체 선택 → 기울임 + 12pt + 빨강 + 양쪽 정렬
    editor.commands.setTextSelection({ from: 1, to: 1 + "첫 문단".length });
    expect(docxSelectionText(editor)).toBe("첫 문단");
    docxToggle(editor, "italic");
    docxApplyChar(editor, { fontSizePt: 12, textColor: "#c00000", fontName: "바탕" });
    docxApplyPara(editor, { alignment: "justify", lineSpacing: 150 });
    const f = docxReadFormat(editor, model);
    expect(f.italic).toBe(true);
    expect(f.fontSize).toBe(1200);
    expect(f.textColor).toBe("#c00000");
    expect(f.fontFamily).toBe("바탕");
    expect(f.alignment).toBe("justify");
    expect(f.lineSpacing).toBe(150);
    const { bytes, changed } = await exportDocx(editor, model, 1);
    expect(changed).toBe(1);
    const again = await openDocx(bytes);
    const blocks = visibleBlocks(again);
    expect(blocks.map((b) => b.docxIndex)).toEqual([0, 1, 2]);
    expect(blockText(blocks[0])).toBe("첫 문단");
    const run = blocks[0].runs![0];
    expect(run.italic).toBe(true);
    expect(run.sizeHalfPoints).toBe(24);
    expect(run.color?.toUpperCase()).toBe("C00000");
    expect(blocks[0].format?.align).toBe("justify");
    expect(blocks[0].format?.lineSpacing).toBe(1.5);
    expect(blocks[1].originalXml).toBe(visibleBlocks(model)[1].originalXml); // 안 바뀐 문단은 그대로
    editor.destroy();
  });

  it("타이핑한 글이 저장된다 (바뀐 블록만 다시 생성)", async () => {
    const model = await openDocx(await sample());
    const editor = makeEditor(docxContent(model));
    editor.commands.setTextSelection(1 + "첫 문단".length);
    editor.commands.insertContent(" 그리고 더");
    const { bytes, changed } = await exportDocx(editor, model, 1);
    expect(changed).toBe(1);
    const again = await openDocx(bytes);
    expect(blockText(visibleBlocks(again)[0])).toBe("첫 문단 그리고 더");
    expect(blockText(visibleBlocks(again)[1])).toBe("둘째 굵게");
    editor.destroy();
  });

  it("쪽 기하·문서 스타일 시트·각주 목록", async () => {
    const model = await openDocx(await sample());
    const geo = docxGeometry(model)!;
    expect(geo.sections).toHaveLength(1);
    expect(geo.vars["--page-w"]).toBe(`${(11906 / 1440) * 96}px`);
    expect(geo.top).toBeCloseTo((1134 / 1440) * 96, 3); // 머리말 없음: 위 여백 그대로
    // 모서리 표시(crop mark)가 읽는 첫 쪽 본문 경계: 빠지면 CSS 기본값 96px(1인치)로 그려져 본문과 어긋난다
    expect(geo.vars["--page-mt"]).toBe(`${geo.top}px`);
    expect(geo.vars["--page-ml"]).toBe(`${(1701 / 1440) * 96}px`);
    expect(geo.vars["--page-mr"]).toBe(`${(1701 / 1440) * 96}px`);
    expect(parseFloat(geo.vars["--page-mb"])).toBeGreaterThan(0);
    expect(geo.metaOf(0)).toBeUndefined();
    const css = docxStyleSheet(model, "tab-1");
    expect(css.startsWith('[data-cdd-doc="tab-1"] {')).toBe(true);
    expect(css).toContain(".doc-page");
    expect(docxNotes(model)).toEqual([]);
  });

  it("각주는 쪽 화면 기하로, 미주만 목록으로 모은다", async () => {
    const zip = await JSZip.loadAsync(await sample());
    zip.file("word/footnotes.xml", `${DECL}<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> 출처: 시험 각주</w:t></w:r></w:p></w:footnote></w:footnotes>`);
    const rels = (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace("</Relationships>", '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>');
    zip.file("word/_rels/document.xml.rels", rels);
    const ct = (await zip.file("[Content_Types].xml")!.async("string")).replace("</Types>", '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>');
    zip.file("[Content_Types].xml", ct);
    const doc = (await zip.file("word/document.xml")!.async("string")).replace("<w:t>첫 문단</w:t></w:r>", '<w:t>첫 문단</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>');
    zip.file("word/document.xml", doc);
    const model = await openDocx(await zip.generateAsync({ type: "uint8array" }));
    expect(docxNotes(model)).toEqual([]);
    const geo = docxGeometry(model)!;
    expect(geo.footnotes).toHaveLength(1);
    expect(geo.footnotes[0].text.trim()).toBe("출처: 시험 각주");
    // 각주가 걸린 문단은 쪽 아래 자리를 예약한다
    expect(geo.metaOf(0)?.footnoteExtraPx).toBeGreaterThan(0);
    // 각주를 고치면 저장에 실린다
    expect(editFootnote(geo, geo.footnotes[0].id, "고친 각주")).toBe(true);
    const editor = makeEditor(docxContent(model));
    const { bytes, changed } = await exportDocx(editor, model, 1, geo);
    expect(changed).toBe(1);
    const again = await openDocx(bytes);
    expect(again.footnotes.map((n) => n.text.trim())).toEqual(["고친 각주"]);
    editor.destroy();
  });
});
