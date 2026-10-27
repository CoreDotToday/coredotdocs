// E2E용 Word 문서: 머리말·꼬리말, 각주 하나, 두 단 둘째 구역 — 우리가 직접 쓴 OOXML (설계 문서 02 §18.7).
import JSZip from "jszip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const pg = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';

export async function featureDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
      `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>`,
  );
  zip.file("_rels/.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file(
    "word/_rels/document.xml.rels",
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/header" Target="header1.xml"/><Relationship Id="rId3" Type="${R}/footer" Target="footer1.xml"/><Relationship Id="rId4" Type="${R}/footnotes" Target="footnotes.xml"/></Relationships>`,
  );
  zip.file("word/styles.xml", `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file("word/header1.xml", `${DECL}<w:hdr xmlns:w="${W}">${para("시험 머리말")}</w:hdr>`);
  zip.file("word/footer1.xml", `${DECL}<w:ftr xmlns:w="${W}">${para("시험 꼬리말")}</w:ftr>`);
  zip.file(
    "word/footnotes.xml",
    `${DECL}<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> 시험 각주 글</w:t></w:r></w:p></w:footnote></w:footnotes>`,
  );
  const first = Array.from({ length: 6 }, (_, i) => para(`첫 구역 ${i + 1}번 문단입니다.`)).join("");
  const noteRef = `<w:p><w:r><w:t xml:space="preserve">각주가 달린 문단</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>`;
  const breakPara = `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>${pg}<w:cols w:space="720"/></w:sectPr></w:pPr></w:p>`;
  const second = Array.from({ length: 30 }, (_, i) => para(`둘째 구역 두 단 ${i + 1}번 문단: 단이 둘로 나뉘어야 합니다. 단이 둘로 나뉘어야 합니다.`)).join("");
  zip.file(
    "word/document.xml",
    `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${first}${noteRef}${breakPara}${second}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>${pg}<w:cols w:num="2" w:space="425"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 저장된 .docx의 한 부분 글 */
export async function partText(bytes: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file(path)?.async("string")) ?? "";
}
