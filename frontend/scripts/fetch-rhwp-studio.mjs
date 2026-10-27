// upstream rhwp-studio(MIT, https://github.com/edwardkim/rhwp) 배포본을 public/rhwp/ 로 내려받는다.
// @rhwp/editor 는 기본으로 https://edwardkim.github.io/rhwp/ 를 iframe에 띄우는데, 데스크톱 앱은 오프라인에서도
// 동작해야 하므로 같은 배포본을 우리 서버가 /rhwp/ 경로로 직접 제공한다. 배포본은 /rhwp/ 를 base 로 빌드되어
// 있어 경로를 그대로 둔다. 서비스 워커(sw.js)의 precache 목록 + JS/CSS 안의 참조를 따라가 전부 받는다.
// 받은 파일은 저장소에 넣지 않는다(.gitignore). 이미 받아 두었으면(public/rhwp/.complete) 건너뛴다.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.RHWP_STUDIO_ORIGIN || "https://edwardkim.github.io";
const BASE = "/rhwp/";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "rhwp");
const marker = path.join(out, ".complete");
const force = process.argv.includes("--force");

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

if (!force && (await exists(marker))) {
  console.log(`rhwp-studio 이미 있음: ${out} (${(await readFile(marker, "utf8")).trim()})`);
  process.exit(0);
}

const seen = new Set();
const queue = ["index.html", "sw.js", "print.html"];
const textExt = /\.(js|css|html|webmanifest|json|svg)$/;
let bytes = 0;

async function fetchOne(rel) {
  rel = rel.replace(/^\.?\//, "").split("?")[0].split("#")[0];
  if (!rel || seen.has(rel)) return;
  seen.add(rel);
  const url = `${ORIGIN}${BASE}${rel}`;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`  건너뜀 ${rel} (${res.status})`); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  bytes += buf.length;
  const dest = path.join(out, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  if (textExt.test(rel)) {
    const text = buf.toString("utf8");
    // 1) /rhwp/… 절대 참조  2) sw.js precache {url:"…"}  3) assets/… · fonts/… 상대 참조  4) new URL("x.wasm", import.meta.url)
    const found = new Set();
    for (const m of text.matchAll(/\/rhwp\/([A-Za-z0-9_./@-]+\.[A-Za-z0-9]+)/g)) found.add(m[1]);
    for (const m of text.matchAll(/url:"([^"]+)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/["'(]((?:assets|fonts|icons|images|workers?)\/[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+)["')]/g)) found.add(m[1]);
    for (const m of text.matchAll(/["']([A-Za-z0-9_.@-]+\.(?:wasm|woff2|js|css|json|svg|png))["']/g)) {
      const name = m[1];
      if (rel.startsWith("assets/") && !name.includes("/")) found.add(`assets/${name}`);
    }
    for (const f of found) queue.push(f);
  }
}

await mkdir(out, { recursive: true });
while (queue.length) {
  const batch = queue.splice(0, 8);
  await Promise.all(batch.map(fetchOne));
}
const idx = await readFile(path.join(out, "index.html"));
const digest = createHash("sha256").update(idx).digest("hex").slice(0, 16);
await writeFile(marker, `${new Date().toISOString().slice(0, 10)} ${ORIGIN}${BASE} index.html sha256:${digest} files:${seen.size} bytes:${bytes}\n`);
console.log(`rhwp-studio 내려받음: 파일 ${seen.size}개, ${(bytes / 1048576).toFixed(1)}MB → ${out}`);
