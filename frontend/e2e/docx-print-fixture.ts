import JSZip from "jszip";
import { featureDocx } from "./docx-fixture";

/** Two differently sized sections, distinct repeated strips and page-number fields. */
export async function printDocx(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await featureDocx());
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const paragraph = (text: string) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  for (const [id, name] of [[1, "PORTRAIT"], [2, "LANDSCAPE"]] as const) {
    zip.file(`word/header${id}.xml`, `<w:hdr xmlns:w="${W}">${paragraph(`HEADER_${name}`)}</w:hdr>`);
    zip.file(`word/footer${id}.xml`, `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>FOOTER_${name} PAGE_</w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`);
  }
  const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", contentTypes.replace("</Types>", '<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'));
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  zip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rH2" Type="${R}/header" Target="header2.xml"/><Relationship Id="rF2" Type="${R}/footer" Target="footer2.xml"/></Relationships>`));
  const section = (landscape: boolean) => `<w:sectPr><w:headerReference w:type="default" r:id="${landscape ? "rH2" : "rId2"}"/><w:footerReference w:type="default" r:id="${landscape ? "rF2" : "rId3"}"/><w:pgSz w:w="${landscape ? 16838 : 11906}" w:h="${landscape ? 11906 : 16838}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>`;
  const first = Array.from({ length: 60 }, (_, i) => paragraph(`BODY_P_${i + 1} Printed with repeated margins and header.`)).join("");
  const second = Array.from({ length: 50 }, (_, i) => paragraph(`BODY_L_${i + 1} Landscape section uses its full text width and its own footer.`)).join("");
  zip.file("word/document.xml", `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${first}<w:p><w:pPr>${section(false)}</w:pPr></w:p>${second}${section(true)}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
