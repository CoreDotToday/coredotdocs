import { describe, expect, it } from "vitest";
import { buildPrintHtml, collectPages, pageSizeMm, prefixIds, shareImages, snapToStandard } from "./print";

const A4 = '<svg xmlns="http://www.w3.org/2000/svg" width="793.7066666666667" height="1122.48" viewBox="0 0 793.7066666666667 1122.48"><defs><clipPath id="body-clip-3"><rect/></clipPath></defs><g clip-path="url(#body-clip-3)"><text>a</text></g></svg>';
const IMG = (x: number) => `<image x="${x}" y="10" width="40" height="30" href="data:image/png;base64,AAAA"/>`;

describe("print", () => {
  it("용지 크기: px(96dpi) → mm, 표준 크기로 맞춤, 가로 용지, 엉뚱한 값은 A4", () => {
    expect(pageSizeMm(A4)).toEqual([210, 297]);
    expect(snapToStandard(297.1, 209.8)).toEqual([297, 210]);
    expect(snapToStandard(100, 150)).toEqual([100, 150]);
    expect(pageSizeMm("<svg></svg>")).toEqual([210, 297]);
  });

  it("id와 참조에 쪽 접두어를 붙인다", () => {
    const out = prefixIds(A4, "p2");
    expect(out).toContain('id="p2-body-clip-3"');
    expect(out).toContain("url(#p2-body-clip-3)");
    expect(prefixIds('<a href="#x"/><b id="x"/>', "p1")).toBe('<a href="#p1-x"/><b id="p1-x"/>');
    expect(prefixIds('<a href="#other"/>', "p1")).toBe('<a href="#other"/>'); // 모르는 참조는 그대로
  });

  it("같은 그림은 한 번만 담고 use로 가리킨다", () => {
    const { svgs, defs, shared } = shareImages([`<svg>${IMG(1)}</svg>`, `<svg>${IMG(2)}${IMG(3)}</svg>`, `<svg><image href="data:image/png;base64,ONCE" width="1" height="1"/></svg>`]);
    expect(shared).toBe(1);
    expect(defs).toContain('<symbol id="img-1" viewBox="0 0 40 30"');
    expect(svgs[0]).toContain('<use href="#img-1" x="1" y="10" width="40" height="30"/>');
    expect(svgs[1].match(/<use /g)).toHaveLength(2);
    expect(svgs[2]).toContain("base64,ONCE"); // 한 번만 나오는 그림은 그대로
  });

  it("쪽마다 제 용지 크기의 @page를 가진 HTML 한 장을 만든다", () => {
    const html = buildPrintHtml(
      [
        { svg: A4, widthMm: 210, heightMm: 297 },
        { svg: A4, widthMm: 297, heightMm: 210 },
        { svg: A4, widthMm: 210, heightMm: 297 },
      ],
      "견본 <제목>",
    );
    expect(html).toContain("@page s210x297 { size: 210mm 297mm; margin: 0; }");
    expect(html).toContain("@page s297x210 { size: 297mm 210mm; margin: 0; }");
    expect(html.match(/class="page /g)).toHaveLength(3);
    expect(html).toContain('data-page="2"');
    expect(html).toContain('id="p1-body-clip-3"');
    expect(html).toContain('id="p3-body-clip-3"');
    expect(html).toContain("<title>견본 &lt;제목></title>");
    expect(html).toContain('width="100%" height="100%"'); // 루트 svg는 쪽에 꽉 채운다
    expect(html).toContain("Content-Security-Policy");
  });

  it("쪽을 모으며 진행을 알리고, 쪽 수가 바뀌면 멈춘다", async () => {
    let count = 3;
    const studio = { pageCount: async () => count, getPageSvg: async () => A4 } as unknown as Parameters<typeof collectPages>[0];
    const seen: number[] = [];
    const pages = await collectPages(studio, (d) => seen.push(d), undefined, 2);
    expect(pages).toHaveLength(3);
    expect(seen).toEqual([1, 2, 3]);
    count = 5;
    const moving = { pageCount: async () => count++, getPageSvg: async () => A4 } as unknown as Parameters<typeof collectPages>[0];
    await expect(collectPages(moving, undefined, undefined, 1)).rejects.toThrow("문서가 바뀌어");
  });
});
