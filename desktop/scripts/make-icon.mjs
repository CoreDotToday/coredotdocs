// 앱 아이콘(1024×1024 PNG)을 만든다. 외부 그림 도구 없이 프런트엔드의 Playwright(Chromium)로 HTML을 그려 저장한다.
// 사용: (cd frontend && node ../desktop/scripts/make-icon.mjs ../desktop/build/icon.png)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Playwright는 프런트엔드의 devDependency다 — 그쪽 node_modules에서 찾는다
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const pw = await import(pathToFileURL(createRequire(path.join(frontend, "package.json")).resolve("@playwright/test")).href);
const chromium = pw.chromium ?? pw.default?.chromium;

const out = path.resolve(process.argv[2] || "build/icon.png");
mkdirSync(path.dirname(out), { recursive: true });
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif">
  <div style="width:860px;height:860px;border-radius:190px;background:linear-gradient(145deg,#3b82f6 0%,#1e3a8a 100%);box-shadow:inset 0 -20px 60px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
    <div style="position:absolute;left:150px;top:130px;width:560px;height:600px;background:#fff;border-radius:40px;box-shadow:0 30px 60px rgba(0,0,0,.35)"></div>
    <div style="position:absolute;left:150px;top:130px;width:560px;height:600px;border-radius:40px;background:linear-gradient(180deg,rgba(255,255,255,0) 60%,rgba(30,58,138,.08))"></div>
    <div style="position:absolute;left:210px;top:210px;width:300px;height:36px;border-radius:18px;background:#1e3a8a"></div>
    <div style="position:absolute;left:210px;top:290px;width:440px;height:22px;border-radius:11px;background:#cbd5e1"></div>
    <div style="position:absolute;left:210px;top:340px;width:400px;height:22px;border-radius:11px;background:#cbd5e1"></div>
    <div style="position:absolute;left:210px;top:390px;width:430px;height:22px;border-radius:11px;background:#cbd5e1"></div>
    <div style="position:absolute;left:210px;top:470px;width:440px;height:170px;border-radius:16px;border:10px solid #93c5fd;box-sizing:border-box"></div>
    <div style="position:absolute;left:210px;top:548px;width:440px;height:10px;background:#93c5fd"></div>
    <div style="position:absolute;left:420px;top:470px;width:10px;height:170px;background:#93c5fd"></div>
    <div style="position:absolute;right:90px;bottom:90px;width:250px;height:250px;border-radius:125px;background:#7c3aed;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:120px;letter-spacing:-6px;box-shadow:0 20px 50px rgba(0,0,0,.35)">AI</div>
  </div>
</div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: out, omitBackground: true, type: "png" });
await browser.close();
console.log(`아이콘 → ${out}`);
