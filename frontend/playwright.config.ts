import { defineConfig } from "@playwright/test";

// 백엔드(8000)와 프런트엔드(3000)를 함께 띄운다. PostgreSQL(5441)은 미리 떠 있어야 한다.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: "http://localhost:3000", locale: "ko-KR" },
  webServer: [
    { command: "cd ../backend && uv run uvicorn app.main:app --port 8000", url: "http://127.0.0.1:8000/api/health", reuseExistingServer: true, timeout: 120_000 },
    { command: "pnpm dev --port 3000", url: "http://localhost:3000", reuseExistingServer: true, timeout: 180_000 },
  ],
});
