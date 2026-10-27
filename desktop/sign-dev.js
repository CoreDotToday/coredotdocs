// 개발 실행(electron .) 전 준비.
// 1) pnpm이 electron의 postinstall(바이너리 내려받기)을 건너뛰었으면 dist/가 없다 → install.js를 직접 실행한다.
// 2) macOS: npm이 받은 Electron.app은 번들 서명이 없고, 내려받은 터미널 앱에서 만든 파일에는 provenance 속성이 붙어
//    최신 macOS가 "손상됨"으로 막는다. scripts/clean-sign-mac.sh로 깨끗이 복사하고 ad-hoc 서명한다.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.dirname(require.resolve("electron/package.json"));
const dist = path.join(pkgDir, "dist");
const pathTxt = path.join(pkgDir, "path.txt");
if (!fs.existsSync(pathTxt) || !fs.existsSync(path.join(dist, fs.readFileSync(pathTxt, "utf8").trim()))) {
  console.log("Electron 바이너리가 없습니다 → electron/install.js 실행 (pnpm이 postinstall을 건너뛴 경우)");
  execFileSync(process.execPath, [path.join(pkgDir, "install.js")], { stdio: "inherit", cwd: pkgDir });
}
if (process.platform === "darwin") {
  const app = path.join(dist, "Electron.app");
  execFileSync(path.join(__dirname, "scripts", "clean-sign-mac.sh"), [app], { stdio: "inherit" });
}
