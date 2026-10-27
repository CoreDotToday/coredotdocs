// GenOffice의 Word 실측 truths 중 "pure" 등급(파싱한 속성 위의 공식, fixture 61개)을 그 자리에서 돌린다 (설계 문서 04 §12 D4).
// 파일은 third_party/genoffice-docx/apps/docs/tests/truths.test.ts(그대로 복사)이고 fixture는 packages/docx-engine/tests/fixtures/truths.
// "render" 등급(실제 화면 측정, 원본 e2e/docs-truths.spec.ts)은 원본 앱 화면이 있어야 해 돌리지 않는다.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { genofficeAliases } from "./vitest.config";

const THIRD = path.resolve(__dirname, "..", "third_party", "genoffice-docx");
const nm = (name: string) => path.resolve(__dirname, "node_modules", name);

export default defineConfig({
  root: THIRD,
  resolve: {
    alias: [
      ...genofficeAliases(THIRD),
      { find: /^jszip$/, replacement: nm("jszip") },
      { find: /^fast-xml-parser$/, replacement: nm("fast-xml-parser") },
      { find: /^utif2$/, replacement: nm("utif2") },
      { find: /^react$/, replacement: nm("react") },
      { find: /^react\/jsx-runtime$/, replacement: nm("react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: nm("react/jsx-dev-runtime.js") },
      { find: /^@tiptap\/(.*)$/, replacement: nm("@tiptap/$1") },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["apps/docs/tests/truths.test.ts"],
    setupFiles: [path.join(THIRD, "packages/docx-engine/tests/setup-equality.ts")],
    testTimeout: 20000,
  },
});
