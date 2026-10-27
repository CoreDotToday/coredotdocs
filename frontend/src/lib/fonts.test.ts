import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { fontLabel } from "./installed-fonts";
import { fontGroups } from "./studio";

const require = createRequire(import.meta.url);
const { familyNames } = require("../../../desktop/fonts.js") as { familyNames: (name: Buffer) => { en?: string; ko?: string } | null };

/** OpenType name 표 하나 (기록: [platform, encoding, lang, nameId, bytes]) */
function nameTable(records: [number, number, number, number, Buffer][]) {
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let off = 0;
  records.forEach(([p, e, l, id, bytes], i) => {
    const r = 6 + i * 12;
    head.writeUInt16BE(p, r);
    head.writeUInt16BE(e, r + 2);
    head.writeUInt16BE(l, r + 4);
    head.writeUInt16BE(id, r + 6);
    head.writeUInt16BE(bytes.length, r + 8);
    head.writeUInt16BE(off, r + 10);
    off += bytes.length;
  });
  return Buffer.concat([head, ...records.map((r) => r[4])]);
}
const be = (s: string) => Buffer.from(s, "utf16le").swap16();

describe("설치 글꼴 이름 (desktop/fonts.js)", () => {
  it("Windows 기록의 영문·한국어 가족 이름을 읽고, 16번(typographic family)을 1번보다 먼저 쓴다", () => {
    const t = nameTable([
      [3, 1, 0x0409, 1, be("NanumGothic Bold")],
      [3, 1, 0x0409, 16, be("NanumGothic")],
      [3, 1, 0x0412, 1, be("나눔고딕")],
      [1, 0, 0, 1, Buffer.from("NanumGothic Mac", "latin1")],
    ]);
    expect(familyNames(t)).toEqual({ en: "NanumGothic", ko: "나눔고딕" });
  });
  it("Mac 기록에 EUC-KR로 넣은 옛 한글 이름은 한국어로 읽고, 깨진 바이트는 버린다", () => {
    const euckr = Buffer.from([0xc0, 0xfc, 0xc1, 0xd6]); // "전주"
    expect(familyNames(nameTable([[1, 0, 0, 1, euckr]]))).toEqual({ en: undefined, ko: "전주" });
    expect(familyNames(nameTable([[1, 0, 0, 1, Buffer.from([0xff, 0xff])]]))).toBeNull();
  });
});

describe("서식 막대 글꼴 묶음", () => {
  it("설치 글꼴은 보이는 이름 순(한국어 이름이 먼저)으로 정렬하고 문서 글꼴과 겹치지 않는다", () => {
    const labels = new Map([["NanumGothic", fontLabel({ family: "NanumGothic", localized: "나눔고딕" })]]);
    const g = fontGroups(["Arial"], ["Zapfino", "NanumGothic", "Arial", "Apple SD Gothic Neo"], undefined, labels);
    expect(g.document).toEqual(["Arial"]);
    expect(g.system).toEqual(["NanumGothic", "Apple SD Gothic Neo", "Zapfino"]);
    expect(labels.get("NanumGothic")).toBe("나눔고딕 (NanumGothic)");
  });
});
