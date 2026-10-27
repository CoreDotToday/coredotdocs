import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

/** `@genoffice/*`(third_party/genoffice-docx 복사본)를 tsconfig paths와 같게 푼다. */
export function genofficeAliases(root: string) {
  return [
    { find: "@", replacement: path.resolve(__dirname, "src") },
    { find: /^@genoffice\/docx-engine$/, replacement: path.join(root, "shims/docx-engine.ts") },
    { find: /^@genoffice\/docx-engine\/(.*)$/, replacement: path.join(root, "packages/docx-engine/src/$1") },
    { find: "@genoffice/zip-gate", replacement: path.join(root, "packages/zip-gate/src/index.ts") },
    { find: /^@genoffice\/agent-core\/(.*)$/, replacement: path.join(root, "packages/agent-core/src/$1") },
    { find: /^@genoffice\/pptx-engine\/(.*)$/, replacement: path.join(root, "packages/pptx-engine/src/$1") },
    { find: /^@genoffice\/docs-renderer\/(.*)$/, replacement: path.join(root, "apps/docs/src/renderer/$1") },
    { find: "@genoffice/font-metrics/resolve", replacement: path.join(root, "packages/font-metrics/src/resolve.ts") },
    { find: "@genoffice/font-metrics/word-faces.json", replacement: path.join(root, "packages/font-metrics/word-faces.json") },
    { find: /^@genoffice\/font-metrics$/, replacement: path.join(root, "packages/font-metrics/src/metrics.ts") },
    { find: /^@genoffice\/i18n$/, replacement: path.join(root, "packages/i18n/src/index.ts") },
    { find: /^@genoffice\/ui$/, replacement: path.join(root, "shims/ui.ts") },
    { find: /^@genoffice\/pptx-render\/(.*)$/, replacement: path.join(root, "packages/pptx-render/src/$1") },
  ];
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias: genofficeAliases(path.resolve(__dirname, "vendor", "genoffice-docx")) },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
