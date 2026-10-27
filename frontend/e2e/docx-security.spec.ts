import { expect, test } from "@playwright/test";
import { externalImageDocx } from "./external-image-fixture";

const API = process.env.EDITOR_E2E_API_URL ?? "http://127.0.0.1:8000";

test("DOCX external pictures never request the network in body, headers or print", async ({ page, context, request }) => {
  const externalRequests: string[] = [];
  await context.route("https://document-tracker.invalid/**", async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  const upload = await request.post(`${API}/api/documents`, { multipart: { file: { name: "external-images.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await externalImageDocx() } } });
  expect(upload.ok()).toBeTruthy();
  const doc = await upload.json();
  try {
    await page.goto(`/documents/${doc.id}`);
    const view = page.locator(`[data-cdd-doc="${doc.id}"][data-ready="1"]`);
    await expect(view).toBeVisible({ timeout: 60000 });
    await expect.poll(() => view.locator('img[data-cdd-external-image="blocked"]').count()).toBeGreaterThanOrEqual(3);
    const html = await page.evaluate((id) => (window as unknown as { __coredotdocs: { printHtml(id: string): Promise<string> } }).__coredotdocs.printHtml(id), doc.id);
    const printed = await context.newPage();
    await printed.setContent(html);
    const sources = await printed.locator('img[data-cdd-external-image="blocked"]').evaluateAll((elements) => elements.map((el) => ({ src: (el as HTMLImageElement).src, complete: (el as HTMLImageElement).complete })));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.every((source) => source.src.startsWith("data:image/") && source.complete)).toBe(true);
    expect(externalRequests).toEqual([]);
    await printed.close();
  } finally { await request.delete(`${API}/api/documents/${doc.id}`); }
});
