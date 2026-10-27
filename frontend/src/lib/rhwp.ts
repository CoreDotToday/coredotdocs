// @rhwp/core(Rust→WASM, MIT, npm 패키지)를 브라우저에서 늦게 불러온다.
// 쓰임: 조판 미리보기(쪽 SVG·쪽 수), 옛 HWP → HWPX 변환. 서버는 WASM을 돌리지 않는다.
import type { HwpDocument as HwpDocumentType } from "@rhwp/core";

export const RHWP_WASM_URL = "/rhwp-core/rhwp_bg.wasm";
export const RHWP_ENGINE = "rhwp 0.8.7";

type RhwpModule = typeof import("@rhwp/core");
let loading: Promise<RhwpModule> | null = null;

declare global {
  // rhwp는 글자 폭 측정을 호스트(canvas)에 맡긴다
  var measureTextWidth: ((font: string, text: string) => number) | undefined;
}

function installMeasure() {
  if (globalThis.measureTextWidth) return;
  let ctx: CanvasRenderingContext2D | null = null;
  let lastFont = "";
  globalThis.measureTextWidth = (font, text) => {
    if (!ctx) ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return text.length * 10;
    if (font !== lastFont) {
      ctx.font = font;
      lastFont = font;
    }
    return ctx.measureText(text).width;
  };
}

export function loadRhwp(): Promise<RhwpModule> {
  if (!loading) {
    loading = (async () => {
      installMeasure();
      const mod = await import("@rhwp/core");
      await mod.default({ module_or_path: RHWP_WASM_URL });
      return mod;
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

export type PageRender = { pages: number; svgs: string[] };

/** HWPX/HWP 바이트를 열어 쪽 수와 앞 maxPages쪽의 SVG를 만든다. */
export async function renderPages(bytes: Uint8Array, maxPages = 30): Promise<PageRender> {
  const mod = await loadRhwp();
  const doc: HwpDocumentType = new mod.HwpDocument(bytes);
  try {
    const pages = doc.pageCount();
    const svgs: string[] = [];
    for (let i = 0; i < Math.min(pages, maxPages); i++) svgs.push(doc.renderPageSvg(i));
    return { pages, svgs };
  } finally {
    doc.free();
  }
}

/** 옛 HWP(5.0 바이너리)를 HWPX로 바꾼다. 업로드 전에 브라우저에서 수행한다. */
export async function convertHwpToHwpx(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const mod = await loadRhwp();
  const doc: HwpDocumentType = new mod.HwpDocument(bytes);
  try {
    return new Uint8Array(doc.exportHwpx()); // WASM 메모리에서 복사해 둔다 (free 뒤에도 유효)
  } finally {
    doc.free();
  }
}

export function isHwpFile(file: File): boolean {
  return /\.hwp$/i.test(file.name);
}

export function svgToObjectUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}
