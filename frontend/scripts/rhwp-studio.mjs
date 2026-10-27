// rhwp-studio 준비: 기본은 소스에서 자체 빌드(third_party/ieumoffice-hwp/build-studio.mjs, 우리 플러그인 포함).
// RHWP_STUDIO_SOURCE=mirror 면 공개 GitHub Pages 배포본을 미러한다(플러그인 없음, 6차까지의 방식 — 폴백).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = process.env.RHWP_STUDIO_SOURCE === "mirror" ? "mirror" : "build";
const script = source === "mirror" ? join(HERE, "fetch-rhwp-studio.mjs") : resolve(HERE, "..", "..", "third_party", "ieumoffice-hwp", "build-studio.mjs");
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
