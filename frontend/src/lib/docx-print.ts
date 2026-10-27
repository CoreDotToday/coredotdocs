import { pxToMm, snapToStandard } from "./print";

export type DocxPrintPage = { x: number; y: number; width: number; height: number; header: string; footer: string; notes: string };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Freeze the measured screen rules. Print must crop those sheets, never reflow the editor a second time. */
export function screenStyleSheet(doc: Document = document): string {
  const read = (rules: CSSRuleList, base: string): string => Array.from(rules).map((rule) => {
    if (rule instanceof CSSMediaRule) return matchMedia(rule.conditionText).matches ? read(rule.cssRules, base) : "";
    if (rule instanceof CSSImportRule) {
      if (!rule.styleSheet) return "";
      return read(rule.styleSheet.cssRules, rule.href);
    }
    return rule.cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (all, _quote, url: string) => {
      if (!url || url.startsWith("data:") || url.startsWith("#")) return all;
      return `url("${new URL(url, base).href}")`;
    });
  }).join("\n");
  return Array.from(doc.styleSheets).filter((sheet) => !sheet.disabled && matchMedia(sheet.media.mediaText || "all").matches).map((sheet) => read(sheet.cssRules, sheet.href ?? doc.baseURI)).join("\n");
}

/** Embed local images/fonts so the desktop's isolated file:// print window has the same assets. */
export async function embedPrintResources(css: string, roots: HTMLElement[]): Promise<string> {
  const cache = new Map<string, Promise<string>>();
  const dataUrl = (url: string): Promise<string> => {
    if (!url || url.startsWith("data:") || url.startsWith("#")) return Promise.resolve(url);
    const absolute = new URL(url, document.baseURI);
    if (absolute.origin !== location.origin) throw new Error("문서의 외부 이미지 또는 글꼴을 인쇄에 포함할 수 없습니다. 먼저 파일에 포함해 주세요.");
    let pending = cache.get(absolute.href);
    if (!pending) {
      pending = fetch(absolute.href).then(async (response) => {
        if (!response.ok) throw new Error(`인쇄 자료를 읽지 못했습니다: ${response.status}`);
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("인쇄 자료를 변환하지 못했습니다."));
          reader.readAsDataURL(blob);
        });
      });
      cache.set(absolute.href, pending);
    }
    return pending;
  };
  const inlineUrls = async (text: string) => {
    const matches = [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
    const replacements = await Promise.all(matches.map((m) => dataUrl(m[2])));
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      text = text.slice(0, m.index) + `url("${replacements[i]}")` + text.slice(m.index! + m[0].length);
    }
    return text;
  };
  await Promise.all(roots.map(async (root) => {
    root.querySelectorAll('script,iframe,object,embed,img:not([src]),img[src=""]').forEach((el) => el.remove());
    await Promise.all([root, ...root.querySelectorAll<HTMLElement>("*")].map(async (el) => {
      for (const attr of Array.from(el.attributes)) if (/^on/i.test(attr.name) || attr.name === "contenteditable") el.removeAttribute(attr.name);
      if (el.hasAttribute("style")) el.setAttribute("style", await inlineUrls(el.getAttribute("style")!));
      for (const attr of el.tagName.toLowerCase() === "image" ? ["href", "xlink:href"] : el.tagName.toLowerCase() === "img" ? ["src"] : []) {
        if (el.getAttribute(attr)) el.setAttribute(attr, await dataUrl(el.getAttribute(attr)!));
      }
    }));
  }));
  return inlineUrls(css);
}

export function buildDocxPrintHtml(snapshot: string, pages: DocxPrintPage[], css: string, title: string, scope: string, fontFamily: string): string {
  if (!pages.length) throw new Error("인쇄할 쪽이 없습니다.");
  const sizes = new Map<string, [number, number]>();
  const sheets = pages.map((p, i) => {
    const [w, h] = snapToStandard(pxToMm(p.width), pxToMm(p.height));
    const name = `cdd${w}x${h}`.replace(/\./g, "_");
    sizes.set(name, [w, h]);
    return `<section class="cdd-print-sheet ${name}" data-page="${i + 1}" style="width:${w}mm;height:calc(${h}mm - 1px)">
<div class="cdd-print-snapshot" style="left:${-p.x}px;top:${-p.y}px">${snapshot}</div>
<div class="cdd-docx cdd-print-overlay" data-cdd-doc="${escapeHtml(scope)}" style="font-family:${escapeHtml(fontFamily)};--cdd-doc-font:${escapeHtml(fontFamily)}">${p.header}${p.footer}${p.notes}</div></section>`;
  }).join("\n");
  const pageRules = Array.from(sizes, ([name, [w, h]]) => `@page ${name}{size:${w}mm ${h}mm;margin:0}.cdd-print-sheet.${name}{page:${name}}`).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><title>${escapeHtml(title)}</title><style>${css.replace(/<\/style/gi, "<\\/style")}
html,body{margin:0!important;padding:0!important;height:auto!important;overflow:visible!important;background:white!important}
.cdd-print-sheet{position:relative;overflow:hidden;contain:size;break-after:page;margin:0;padding:0;background:white}
.cdd-print-sheet:last-child{break-after:auto}
.cdd-print-snapshot{position:absolute}
.cdd-print-canvas{position:relative!important;left:0!important;top:0!important;visibility:visible!important;display:block!important;overflow:visible!important;background:white!important}
.cdd-print-canvas .editor-scroll{display:block!important;overflow:visible!important;padding:0!important;height:auto!important;scrollbar-gutter:auto}
.cdd-print-canvas .doc-zoom{zoom:1!important;margin:0!important}
.cdd-print-canvas .page-wrap{margin:0!important}
.cdd-print-canvas .doc-page{box-shadow:none!important;background:white!important;outline:none!important}
.cdd-print-canvas .page-gap-hf,.cdd-print-canvas .cdd-edge-hf,.cdd-print-canvas .page-gap-notes,.cdd-print-canvas .cdd-edge-notes{visibility:hidden!important}
.cdd-print-canvas .page-gap::before,.cdd-print-canvas .page-gap::after,.cdd-print-canvas .page-wrap::before,.cdd-print-canvas .page-wrap::after{display:none!important}
.cdd-print-canvas .doc-sectbreak-label,.cdd-print-canvas .doc-protected-label,.cdd-print-canvas .doc-move-handle,.cdd-print-canvas .img-resize-handle{visibility:hidden!important}
.cdd-print-overlay{position:absolute!important;inset:0!important;display:block!important;height:100%!important;background:transparent!important;overflow:hidden!important;pointer-events:none}
.cdd-print-overlay .page-gap-hf{border-color:transparent!important;cursor:default}
.cdd-print-overlay .page-gap-hf>*{opacity:1!important}
${pageRules}
</style></head><body>${sheets}</body></html>`;
}
