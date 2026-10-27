// @vitest-environment node
// DOCX 모델(third_party/genoffice-docx 엔진의 우리 래퍼): 읽기·블록 대응·paragraph-patch 저장 왕복.
import JSZip from "jszip";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blockText, editorIndexOf, engineBlockAt, openDocx, originalSaveBlocks, saveDocxBytes, saveWithParagraphText, visibleBlocks } from "./docx-engine";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** 백엔드 테스트의 샘플과 같은 모양: 제목 / 본문(run 둘) / 2×2 표 / 콘텐츠 컨트롤 문단 / 빈 문단 — 우리가 직접 쓴 XML. */
async function sampleDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file("_rels/.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`);
  zip.file(
    "word/document.xml",
    `${DECL}<w:document xmlns:w="${W}"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>AI 편집 샘플</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t xml:space="preserve">이 문서는 관측용 샘플입니다 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>hello</w:t></w:r></w:p>` +
      `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>구분</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>내용</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>가</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>나</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
      `<w:sdt><w:sdtPr><w:alias w:val="이름"/><w:tag w:val="name"/><w:text/></w:sdtPr><w:sdtContent><w:p><w:r><w:t xml:space="preserve">성명: </w:t></w:r><w:r><w:t>여기에 입력</w:t></w:r></w:p></w:sdtContent></w:sdt>` +
      `<w:p/>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1701" w:bottom="850" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>` +
      `</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
}

describe("docx-engine 래퍼", () => {
  it("블록을 읽고 서버 셈법(index)과 맞는다", async () => {
    const model = await openDocx(await sampleDocx());
    const blocks = visibleBlocks(model);
    expect(blocks.map((b) => [b.type, b.docxIndex])).toEqual([
      ["heading", 0],
      ["paragraph", 1],
      ["table", 2],
      ["paragraph", 3],
      ["paragraph", 4],
    ]);
    expect(blockText(blocks[1])).toBe("이 문서는 관측용 샘플입니다 hello");
    expect(blocks[0].level).toBe(1);
    // 서버 블록 4 = index 3, sub 0 (콘텐츠 컨트롤 안 문단)
    const sdt = engineBlockAt(model, 3, 0)!;
    expect(blockText(sdt)).toBe("성명: 여기에 입력");
    expect(sdt.sdtShell?.alias).toBe("이름");
  });

  it("고친 것이 없으면 document.xml이 바이트 그대로다", async () => {
    const src = await sampleDocx();
    const model = await openDocx(src);
    const out = await saveDocxBytes(model, originalSaveBlocks(model));
    expect(await documentXml(out)).toBe(await documentXml(src));
  });

  it("한 문단만 고치면 다른 블록의 원본 XML은 그대로다", async () => {
    const src = await sampleDocx();
    const model = await openDocx(src);
    const out = await saveWithParagraphText(model, 1, "바뀐 본문");
    const again = await openDocx(out);
    const before = visibleBlocks(model);
    const after = visibleBlocks(again);
    expect(after.map((b) => b.docxIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(blockText(after[1])).toBe("바뀐 본문");
    for (const i of [0, 2, 3, 4]) expect(after[i].originalXml).toBe(before[i].originalXml);
    // 콘텐츠 컨트롤 안 문단을 고쳐도 껍데기(sdt)가 남는다
    const out2 = await saveWithParagraphText(again, 3, "성명: 홍길동");
    const third = await openDocx(out2);
    expect(blockText(visibleBlocks(third)[3])).toBe("성명: 홍길동");
    expect(visibleBlocks(third)[3].sdtShell?.tag).toBe("name");
    expect(await documentXml(out2)).toContain("<w:sdt>");
  });

  it("콘텐츠 컨트롤 번호 셈법이 서버(test_block_index_matches_editor_engine_numbering)와 같다", async () => {
    const zip = await JSZip.loadAsync(await sampleDocx());
    zip.file(
      "word/document.xml",
      `${DECL}<w:document xmlns:w="${W}"><w:body>` +
        `<w:p><w:r><w:t>앞</w:t></w:r></w:p>` +
        `<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>차례1</w:t></w:r></w:p><w:sdt><w:sdtContent><w:p><w:r><w:t>안쪽</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><w:r><w:t>차례3</w:t></w:r></w:p></w:sdtContent></w:sdt>` +
        `<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>하나뿐</w:t></w:r></w:p></w:sdtContent></w:sdt>` +
        `<w:p><w:r><w:t>뒤</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    );
    const model = await openDocx(await zip.generateAsync({ type: "uint8array" }));
    const got = visibleBlocks(model).map((b) => [blockText(b), b.docxIndex]);
    expect(got).toEqual([["앞", 0], ["차례1", 1], ["안쪽", 2], ["차례3", 3], ["하나뿐", 4], ["뒤", 5]]);
    for (let i = 0; i <= 5; i++) expect(editorIndexOf(model, i)).toBe(i); // altChunk가 없으면 같다
  });

  it("altChunk(끼워 넣은 .docx)를 펼친 블록 뒤의 서버 자리도 엔진 번호로 옮긴다", async () => {
    const chunk = await sampleDocx(); // 블록 5개짜리 문서를 조각으로 끼운다
    const zip = await JSZip.loadAsync(await sampleDocx());
    zip.file("word/chunk1.docx", chunk);
    zip.file("word/_rels/document.xml.rels", (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace("</Relationships>", '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk1.docx"/></Relationships>'));
    zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml")!.async("string")).replace("</Types>", '<Override PartName="/word/chunk1.docx" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/></Types>'));
    zip.file(
      "word/document.xml",
      `${DECL}<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>앞</w:t></w:r></w:p><w:altChunk r:id="rId20"/><w:p><w:r><w:t>뒤</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    );
    const model = await openDocx(await zip.generateAsync({ type: "uint8array" }));
    const blocks = visibleBlocks(model);
    const back = blocks.find((b) => blockText(b) === "뒤")!;
    expect(blocks.length).toBeGreaterThan(3); // 조각이 펼쳐졌다
    expect(back.docxIndex).toBeGreaterThan(2); // 그래서 엔진 번호는 밀렸다
    // 서버는 [앞=0, altChunk=1, 뒤=2]로 센다
    expect(editorIndexOf(model, 0)).toBe(0);
    expect(editorIndexOf(model, 1)).toBe(1);
    expect(editorIndexOf(model, 2)).toBe(back.docxIndex);
  });

  // 실제 Word 문서(저장소 밖): CDD_DOCX_SAMPLES=디렉터리 로 지정하면 돈다
  const dir = process.env.CDD_DOCX_SAMPLES;
  const samples = dir && existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".docx")) : [];
  it.each(samples)("실제 문서 %s: 보이는 블록 = 본문 맨 위 p·tbl·sdt 수, 무변경 저장은 바이트 동일", async (name) => {
    const src = new Uint8Array(readFileSync(path.join(dir!, name)));
    const model = await openDocx(src);
    const topLevel = model.extras.elements.filter((e) => e.name === "w:p" || e.name === "w:tbl" || e.name === "w:sdt").length;
    expect(visibleBlocks(model).length).toBe(topLevel);
    const out = await saveDocxBytes(model, originalSaveBlocks(model));
    expect(await documentXml(out)).toBe(await documentXml(src));
  });
});
