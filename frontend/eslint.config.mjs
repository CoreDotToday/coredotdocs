import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/**", // rhwp-studio 배포본·WASM 글루 (외부 산출물)
    "vendor/**", // third_party/genoffice-docx 복사본 (Apache-2.0, 우리 코드 아님)
  ]),
]);

export default eslintConfig;
