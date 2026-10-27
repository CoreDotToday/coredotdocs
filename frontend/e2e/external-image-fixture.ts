import JSZip from "jszip";
import { featureDocx } from "./docx-fixture";

export const EXTERNAL_IMAGE = "https://document-tracker.invalid/image.png";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const picture = `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="914400" cy="304800"/><wp:docPr id="1" name="linked image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="linked image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="${R}" r:link="rIdExternal"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="304800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

export async function externalImageDocx(target = EXTERNAL_IMAGE): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await featureDocx());
  const relation = `<Relationship Id="rIdExternal" Type="${R}/image" Target="${target}" TargetMode="External"/>`;
  const doc = await zip.file("word/document.xml")!.async("string");
  zip.file("word/document.xml", doc.replace("<w:body>", `<w:body><w:p><w:r><w:t>LINKED_INLINE_TEXT</w:t></w:r>${picture}</w:p><w:p>${picture}</w:p>`));
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  zip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `${relation}</Relationships>`));
  const header = await zip.file("word/header1.xml")!.async("string");
  zip.file("word/header1.xml", header.replace("</w:hdr>", `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>LINKED_HEADER_TEXT</w:t></w:r>${picture}</w:p></w:tc></w:tr></w:tbl></w:hdr>`));
  zip.file("word/_rels/header1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relation}</Relationships>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
