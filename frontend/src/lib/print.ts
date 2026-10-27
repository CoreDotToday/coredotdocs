// 자체 PDF·인쇄 (설계 문서 04 §2 A6). embed 모드의 스튜디오는 자기 인쇄 명령을 내놓지 않으므로,
// 스튜디오가 그린 쪽 SVG(getPageSvg, 화면 프로파일)를 모아 쪽마다 제 용지 크기(@page)인 HTML 한 장으로 묶는다.
// 데스크톱은 숨은 창에서 printToPDF / 시스템 인쇄, 웹판은 새 창에서 window.print(). 이음오피스의 print-flow·print-document 방식을 동작만 보고 재구현했다.
// 한계: 공개 빌드는 인쇄 프로파일(이식성 글자 폭)을 SDK로 내놓지 않아 화면 프로파일로 그린다 — 글꼴이 다른 PC에서는 줄 나눔이 다를 수 있다.
import type { RhwpEditor } from "./studio";

export type PrintPage = { svg: string; widthMm: number; heightMm: number };

const PX_PER_MM = 96 / 25.4;
/** 표준 용지 (mm). 0.5mm 안이면 표준 크기로 맞춘다 — 인쇄기가 용지를 알아보게. */
const STANDARD_SIZES: [number, number][] = [
  [210, 297], // A4
  [297, 420], // A3
  [148, 210], // A5
  [182, 257], // B5 (JIS)
  [257, 364], // B4 (JIS)
  [215.9, 279.4], // Letter
  [215.9, 355.6], // Legal
];

export function pxToMm(px: number): number {
  return px / PX_PER_MM;
}

export function snapToStandard(widthMm: number, heightMm: number, tolerance = 0.5): [number, number] {
  for (const [w, h] of STANDARD_SIZES) {
    if (Math.abs(w - widthMm) <= tolerance && Math.abs(h - heightMm) <= tolerance) return [w, h];
    if (Math.abs(h - widthMm) <= tolerance && Math.abs(w - heightMm) <= tolerance) return [h, w]; // 가로 용지
  }
  return [Math.round(widthMm * 100) / 100, Math.round(heightMm * 100) / 100];
}

/** SVG 루트의 width/height(px, 96dpi)에서 용지 크기를 읽는다. 없으면 A4. */
export function pageSizeMm(svg: string): [number, number] {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const w = parseFloat(/\swidth="([\d.]+)/.exec(root)?.[1] ?? "");
  const h = parseFloat(/\sheight="([\d.]+)/.exec(root)?.[1] ?? "");
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [210, 297];
  return snapToStandard(pxToMm(w), pxToMm(h));
}

/**
 * 쪽마다 같은 id(clipPath 등)를 쓰므로 한 문서에 모으면 충돌한다. id와 그 참조(url(#…), href="#…")에 쪽 접두어를 붙인다.
 */
export function prefixIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  svg.replace(/\sid="([^"]+)"/g, (_m, id: string) => {
    ids.add(id);
    return _m;
  });
  if (!ids.size) return svg;
  let out = svg.replace(/\sid="([^"]+)"/g, (_m, id: string) => ` id="${prefix}-${id}"`);
  out = out.replace(/url\(#([^)]+)\)/g, (m, id: string) => (ids.has(id) ? `url(#${prefix}-${id})` : m));
  out = out.replace(/(\s(?:xlink:)?href=")#([^"]+)"/g, (m, head: string, id: string) => (ids.has(id) ? `${head}#${prefix}-${id}"` : m));
  return out;
}

/**
 * 같은 그림(data: URI)이 여러 쪽에 있으면 한 번만 담는다: 첫 SVG 앞에 숨은 <svg><defs><symbol id="img-N"><image …/></symbol></defs></svg>를 두고
 * 각 자리는 <use href="#img-N" x y width height/>로 바꾼다. 같은 HTML 문서 안의 인라인 SVG끼리는 참조가 통한다.
 */
export function shareImages(svgs: string[]): { svgs: string[]; defs: string; shared: number } {
  const seen = new Map<string, { id: string; w: string; h: string }>();
  const images: string[] = [];
  const counts = new Map<string, number>();
  for (const svg of svgs) svg.replace(/<image\b[^>]*\shref="(data:[^"]+)"[^>]*\/?>/g, (m, data: string) => (counts.set(data, (counts.get(data) ?? 0) + 1), m));
  const out = svgs.map((svg) =>
    svg.replace(/<image\b([^>]*)\shref="(data:[^"]+)"([^>]*)\/?>/g, (m, before: string, data: string, after: string) => {
      if ((counts.get(data) ?? 0) < 2) return m; // 한 번만 나오는 그림은 그대로
      const attrs = `${before} ${after}`;
      const get = (name: string) => new RegExp(`\\s${name}="([^"]+)"`).exec(attrs)?.[1];
      const w = get("width") ?? "0";
      const h = get("height") ?? "0";
      let entry = seen.get(data);
      if (!entry) {
        entry = { id: `img-${seen.size + 1}`, w, h };
        seen.set(data, entry);
        images.push(`<symbol id="${entry.id}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><image width="${w}" height="${h}" href="${data}"/></symbol>`);
      }
      const keep = ["x", "y", "width", "height", "transform", "opacity", "clip-path"].map((n) => (get(n) ? ` ${n}="${get(n)}"` : "")).join("");
      return `<use href="#${entry.id}"${keep}/>`;
    }),
  );
  const defs = images.length ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${images.join("")}</defs></svg>` : "";
  return { svgs: out, defs, shared: images.length };
}

/** 쪽 SVG 목록 → 인쇄용 HTML 한 장. 쪽마다 이름 붙인 @page로 제 용지 크기를 쓰고 여백은 0이다. */
export function buildPrintHtml(pages: PrintPage[], title: string): string {
  const { svgs, defs } = shareImages(pages.map((p) => p.svg));
  const sizes = new Map<string, [number, number]>();
  const body = pages
    .map((p, i) => {
      const key = `s${p.widthMm}x${p.heightMm}`.replace(/\./g, "_");
      sizes.set(key, [p.widthMm, p.heightMm]);
      const svg = prefixIds(svgs[i], `p${i + 1}`).replace(/<svg\b([^>]*)>/, (m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="100%" height="100%">`);
      return `<div class="page ${key}" data-page="${i + 1}" style="width:${p.widthMm}mm;height:${p.heightMm}mm">${svg}</div>`;
    })
    .join("\n");
  const pageRules = [...sizes].map(([key, [w, h]]) => `@page ${key} { size: ${w}mm ${h}mm; margin: 0; }\n.page.${key} { page: ${key}; }`).join("\n");
  const safeTitle = title.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src 'none'">
<title>${safeTitle}</title>
<style>
html, body { margin: 0; padding: 0; background: #fff; }
.page { position: relative; overflow: hidden; break-after: page; page-break-after: always; margin: 0 auto; }
.page:last-child { break-after: auto; page-break-after: auto; }
.page > svg { display: block; }
@media screen { body { background: #888; padding: 12px 0; } .page { box-shadow: 0 2px 8px rgba(0,0,0,.4); margin-bottom: 12px; } }
${pageRules}
</style></head><body>${defs}
${body}
</body></html>`;
}

/**
 * 스튜디오에서 쪽을 모은다. 한 번에 BATCH쪽씩 그리고 사이에 화면에 숨을 돌려 준다. 도중에 쪽 수가 바뀌면 멈춘다(사용자가 고치는 중).
 */
export async function collectPages(studio: RhwpEditor, onProgress?: (done: number, total: number) => void, signal?: AbortSignal, batch = 4): Promise<PrintPage[]> {
  const total = await studio.pageCount();
  const pages: PrintPage[] = [];
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error("인쇄 준비를 중단했습니다.");
    const svg = await studio.getPageSvg(i);
    const [widthMm, heightMm] = pageSizeMm(svg);
    pages.push({ svg, widthMm, heightMm });
    onProgress?.(i + 1, total);
    if ((i + 1) % batch === 0) {
      await new Promise((r) => setTimeout(r, 0));
      if ((await studio.pageCount()) !== total) throw new Error("문서가 바뀌어 인쇄 준비를 멈췄습니다. 다시 시도하세요.");
    }
  }
  return pages;
}
