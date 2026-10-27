#!/usr/bin/env node
// Apache-2.0 코드는 third_party/ieumoffice-hwp/·third_party/genoffice-docx/ 안에만 둔다 (설계 문서 04 §9.3-1, §12).
// 그 폴더 밖의 소스에 이음오피스·GenOffice 식별자나 Apache 출처 표식이 보이면 실패한다. `@genoffice/*` 가져오기는 정해진 래퍼 파일에서만 허용한다.
// ieumoffice-hwp 안 파일은 머리에 출처 표기가 있어야 한다 (genoffice-docx는 그대로 복사한 것이라 ORIGIN.md가 대신한다).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const THIRD = join(ROOT, "third_party", "ieumoffice-hwp");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".venv", "__pycache__", "public", "test-results", "resources", ".git", "third_party", "docs", ".agents", ".claude", "vendor"]);
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);
const FORBIDDEN = [/\bieum[-_]/i, /genoffice/i, /@ieum\//, /Mainfunc/];
const ALLOWED_REFS = [/third_party\/ieumoffice-hwp/, /third_party\/genoffice-docx/, /vendor\/genoffice-docx/, /docs\/04-openoffice-upgrade-plan/, /이음오피스/, /GenOffice 기준|genoffice 기준|\(GenOffice\)|GenOffice\)/]; // 경로·문서 언급은 허용
// `@genoffice/*` 모듈을 가져와도 되는 우리 파일 (래퍼·빌드 설정)
const GENOFFICE_IMPORTERS = new Set(["frontend/src/lib/docx-engine.ts", "frontend/src/lib/docx-editor.ts", "frontend/src/lib/docx-engine.test.ts", "frontend/vitest.config.ts", "frontend/vitest.genoffice.config.ts", "frontend/vitest.truths.config.ts", "frontend/src/lib/docx-editor.test.ts", "frontend/scripts/sync-genoffice.mjs"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (EXT.has(name.slice(name.lastIndexOf(".")))) yield p;
  }
}

const problems = [];
const SELF = fileURLToPath(import.meta.url);
for (const file of walk(ROOT)) {
  if (file === SELF) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const importer = GENOFFICE_IMPORTERS.has(relative(ROOT, file));
  lines.forEach((line, i) => {
    if (ALLOWED_REFS.some((r) => r.test(line))) return;
    if (importer && /@genoffice\/|genoffice-docx|genofficeAliases|genoffice/i.test(line) && !/Mainfunc/.test(line)) return;
    for (const pat of FORBIDDEN) {
      if (pat.test(line)) problems.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}
for (const name of readdirSync(THIRD)) {
  if (!/\.(mjs|mts|ts|js)$/.test(name)) continue;
  const head = readFileSync(join(THIRD, name), "utf8").slice(0, 2000);
  if (!/Apache-2\.0|Apache License/.test(head) && !/derived from|Derived from/i.test(head) && !name.endsWith(".d.mts")) problems.push(`third_party/ieumoffice-hwp/${name}: 머리에 출처(Apache-2.0, derived from) 표기가 없습니다`);
}
if (problems.length) {
  console.error("third-party 경계 검사 실패:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("third-party 경계 OK");
