// third_party/genoffice-docx/packages/docx-engine의 자체 테스트(Word 실측 truths fixture 포함)를 그 자리에서 돌린다 (설계 문서 04 §12 D4).
// 그 폴더에는 node_modules가 없으므로 bare import(jszip·fast-xml-parser·utif2)와 `@genoffice/*`를 여기서 푼다.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { genofficeAliases } from "./vitest.config";

const THIRD = path.resolve(__dirname, "..", "third_party", "genoffice-docx");
const ENGINE = path.join(THIRD, "packages", "docx-engine");
const nm = (name: string) => path.resolve(__dirname, "node_modules", name);

export default defineConfig({
  root: ENGINE,
  resolve: {
    alias: [
      ...genofficeAliases(THIRD),
      // 가져온 커밋의 index.ts가 resolve-props 내보내기를 빠뜨려 resolve-props.test.ts가 깨진다: 시험의 '../src/index'만 우리 입구 심으로
      { find: /^\.\.\/src\/index$/, replacement: path.join(THIRD, "shims", "docx-engine.ts") },
      { find: /^jszip$/, replacement: nm("jszip") }, { find: /^fast-xml-parser$/, replacement: nm("fast-xml-parser") }, { find: /^utif2$/, replacement: nm("utif2") }],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: [path.join(ENGINE, "tests/setup-equality.ts")],
    testTimeout: 20000,
  },
});
