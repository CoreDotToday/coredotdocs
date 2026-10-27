// E2E용 옛 HWP 파일 만들기: 우리 백엔드가 만든 HWPX를 rhwp(npm, MIT)로 HWP로 저장한다.
// Playwright는 테스트 파일을 CommonJS로 돌리므로 require.resolve로 패키지 위치를 찾고 ESM 글루는 동적 import로 부른다.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function hwpxToHwp(hwpx: Uint8Array): Promise<Buffer> {
  const pkg = path.dirname(require.resolve("@rhwp/core/package.json"));
  (globalThis as { measureTextWidth?: (f: string, t: string) => number }).measureTextWidth = (_f, t) => t.length * 10;
  const mod = await import(pathToFileURL(path.join(pkg, "rhwp.js")).href);
  mod.initSync({ module: readFileSync(path.join(pkg, "rhwp_bg.wasm")) });
  const doc = new mod.HwpDocument(hwpx);
  try {
    return Buffer.from(doc.exportHwp());
  } finally {
    doc.free();
  }
}
