// @rhwp/core(MIT, npm)의 WASM을 정적 경로(/rhwp-core/rhwp_bg.wasm)로 복사한다. dev·build 전에 실행된다.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve("@rhwp/core/package.json"));
const { version } = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
const out = path.join(process.cwd(), "public", "rhwp-core");
mkdirSync(out, { recursive: true });
copyFileSync(path.join(pkg, "rhwp_bg.wasm"), path.join(out, "rhwp_bg.wasm"));
copyFileSync(path.join(pkg, "rhwp.js"), path.join(out, "rhwp.js")); // 서버 쪽 Node 사이드카(backend/app/engine/rhwp_convert.mjs)가 같은 폴더에서 글루와 WASM을 읽는다
copyFileSync(path.join(pkg, "LICENSE"), path.join(out, "LICENSE"));
writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module", private: true }));
console.log(`rhwp ${version} WASM → public/rhwp-core/`);
