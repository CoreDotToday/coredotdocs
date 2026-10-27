// rhwp(MIT) 엔진을 Node에서 돌려 HWP ↔ HWPX를 바꾼다 (서버 쪽 사이드카, 설계 문서 04 §8.2-5).
// 사용: node rhwp_convert.mjs <rhwp-dir> <to: hwpx|hwp> <in> <out>
//   rhwp-dir: rhwp.js와 rhwp_bg.wasm이 있는 폴더 (frontend/public/rhwp-core 또는 설치본 resources/web/public/rhwp-core)
// 조판은 하지 않으므로 measureTextWidth는 상수 스텁이다 — 변환·구조 검증에만 쓰고 쪽수 비교에는 쓰지 않는다(한글의 달인의 함정).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , dir, to, input, output] = process.argv;
if (!dir || !to || !input || !output || !["hwpx", "hwp"].includes(to)) {
  console.error("usage: rhwp_convert.mjs <rhwp-dir> <hwpx|hwp> <in> <out>");
  process.exit(2);
}
globalThis.measureTextWidth = (_font, text) => text.length * 10;
const mod = await import(pathToFileURL(join(dir, "rhwp.js")).href);
mod.initSync({ module: readFileSync(join(dir, "rhwp_bg.wasm")) });
const doc = new mod.HwpDocument(readFileSync(input));
try {
  const bytes = to === "hwpx" ? doc.exportHwpx() : doc.exportHwp();
  writeFileSync(output, Buffer.from(bytes));
  console.log(JSON.stringify({ ok: true, bytes: bytes.length, version: typeof mod.version === "function" ? mod.version() : null }));
} finally {
  doc.free();
}
