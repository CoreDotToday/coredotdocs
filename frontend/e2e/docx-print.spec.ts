import { expect, test } from "@playwright/test";
import { printDocx } from "./docx-print-fixture";
import { featureDocx } from "./docx-fixture";

const API = process.env.EDITOR_E2E_API_URL ?? "http://127.0.0.1:8000";

test("DOCX print freezes mixed paper, repeats header/footer and margins, and leaves the editor unchanged", async ({ page, request, context }, testInfo) => {
  const upload = await request.post(`${API}/api/documents`, { multipart: { file: { name: "print-sections.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await printDocx() } } });
  expect(upload.ok()).toBeTruthy();
  const doc = await upload.json();
  try {
    await page.goto(`/documents/${doc.id}`);
    await expect(page.locator(`[data-cdd-doc="${doc.id}"][data-ready="1"]`)).toBeVisible({ timeout: 60000 });
    const before = await page.evaluate((id) => {
      const ed = (window as unknown as { __coredotdocsDocx: Record<string, { getJSON(): unknown; commands: { setTextSelection(value: { from: number; to: number }): void }; state: { selection: { from: number; to: number } } }> }).__coredotdocsDocx[id];
      ed.commands.setTextSelection({ from: 2, to: 8 });
      (document.querySelector(`[data-cdd-doc="${id}"] .doc-zoom`) as HTMLElement).style.zoom = "0.75";
      return { json: ed.getJSON(), from: ed.state.selection.from, to: ed.state.selection.to, zoom: "0.75" };
    }, doc.id);
    const html = await page.evaluate((id) => (window as unknown as { __coredotdocs: { printHtml(id: string): Promise<string> } }).__coredotdocs.printHtml(id), doc.id);
    const after = await page.evaluate((id) => {
      const ed = (window as unknown as { __coredotdocsDocx: Record<string, { getJSON(): unknown; state: { selection: { from: number; to: number } } }> }).__coredotdocsDocx[id];
      return { json: ed.getJSON(), from: ed.state.selection.from, to: ed.state.selection.to, zoom: (document.querySelector(`[data-cdd-doc="${id}"] .doc-zoom`) as HTMLElement).style.zoom };
    }, doc.id);
    expect(after).toEqual(before);
    const print = await context.newPage();
    await print.setContent(html);
    await print.evaluate(() => document.fonts.ready);
    const sheets = await print.locator(".cdd-print-sheet").count();
    expect(sheets).toBeGreaterThanOrEqual(4);
    const geometry = await print.locator(".cdd-print-sheet").evaluateAll((elements) => elements.map((sheet) => {
      const rect = sheet.getBoundingClientRect();
      const header = sheet.querySelector(".cdd-print-overlay .page-gap-hf[data-hf-kind='header']")!;
      const footer = sheet.querySelector(".cdd-print-overlay .page-gap-hf[data-hf-kind='footer']")!;
      const markers = [...sheet.querySelectorAll(".cdd-print-snapshot p")].filter((p) => p.textContent?.startsWith("BODY_")).map((p) => ({ text: p.textContent!, r: p.getBoundingClientRect() })).filter(({ r }) => r.top >= rect.top && r.bottom <= rect.bottom);
      return { width: rect.width, height: rect.height, header: header.textContent, footer: footer.textContent, firstX: Math.min(...markers.map(({ r }) => r.left - rect.left)), bodyWidth: Math.max(...markers.map(({ r }) => r.width)), firstY: Math.min(...markers.map(({ r }) => r.top - rect.top)), lastY: Math.max(...markers.map(({ r }) => r.bottom - rect.top)), markers: markers.map(({ text }) => text.match(/BODY_[PL]_\d+/)![0]) };
    }));
    expect(geometry.some((g) => g.width > g.height)).toBe(true);
    expect(geometry.some((g) => g.width < g.height)).toBe(true);
    const allMarkers = geometry.flatMap((g) => g.markers);
    expect(allMarkers).toEqual([...Array.from({ length: 60 }, (_, i) => `BODY_P_${i + 1}`), ...Array.from({ length: 50 }, (_, i) => `BODY_L_${i + 1}`)]);
    for (const [i, g] of geometry.entries()) {
      const section = g.width > g.height ? "LANDSCAPE" : "PORTRAIT";
      expect(g.header).toContain(`HEADER_${section}`);
      expect(g.footer).toContain(`FOOTER_${section}`);
      expect(g.footer).toContain(String(i + 1));
      expect(g.firstY).toBeGreaterThanOrEqual(94);
      expect(g.lastY).toBeLessThan(g.height - 90);
      expect(Math.abs(g.firstX - 96)).toBeLessThan(1);
      expect(Math.abs(g.bodyWidth - (g.width - 192))).toBeLessThan(1);
    }
    const pdf = await print.pdf({ path: testInfo.outputPath("mixed-paper.pdf"), preferCSSPageSize: true, printBackground: true });
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(sheets);
    await testInfo.attach("print-html", { body: html, contentType: "text/html" });
    await print.close();
  } finally {
    await request.delete(`${API}/api/documents/${doc.id}`);
  }
});

test("DOCX print embeds images and keeps footnotes and columned text in its page snapshot", async ({ page, request, context }, testInfo) => {
  const uploaded = await request.post(`${API}/api/documents`, { multipart: { file: { name: "print-features.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await featureDocx() } } });
  const doc = await uploaded.json();
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64");
    const image = await request.post(`${API}/api/documents/${doc.id}/images`, { multipart: { file: { name: "dot.png", mimeType: "image/png", buffer: png } } });
    const inserted = await request.post(`${API}/api/tools/insert_image`, { data: { arguments: { document_id: doc.id, image_id: (await image.json()).image_id, after: 2, width_mm: 20 } } });
    expect((await inserted.json()).isError).toBeFalsy();
    await page.goto(`/documents/${doc.id}`);
    await expect(page.locator(`[data-cdd-doc="${doc.id}"][data-ready="1"]`)).toBeVisible({ timeout: 60000 });
    const html = await page.evaluate((id) => (window as unknown as { __coredotdocs: { printHtml(id: string): Promise<string> } }).__coredotdocs.printHtml(id), doc.id);
    const print = await context.newPage();
    await print.setContent(html);
    await expect(print.locator(".cdd-print-overlay .page-gap-notes")).toHaveCount(1);
    await expect(print.locator(".cdd-print-overlay .page-gap-notes")).toContainText("시험 각주 글");
    const images = await print.locator(".cdd-print-snapshot img").evaluateAll((elements) => elements.map((img) => ({ src: (img as HTMLImageElement).src, ok: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0 })));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((img) => img.ok && img.src.startsWith("data:"))).toBe(true);
    const columns = await print.locator(".cdd-print-sheet").evaluateAll((sheets) => sheets.flatMap((sheet) => {
      const page = sheet.getBoundingClientRect();
      return [...sheet.querySelectorAll(".cdd-print-snapshot p")].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.top >= page.top && r.bottom <= page.bottom && r.left >= page.left && r.right <= page.right + 1;
      }).flatMap((p) => [...p.textContent!.matchAll(/둘째 구역 두 단 (\d+)번/g)].map((m) => Number(m[1])));
    }));
    expect(columns).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const sheets = await print.locator(".cdd-print-sheet").count();
    const pdf = await print.pdf({ path: testInfo.outputPath("features.pdf"), preferCSSPageSize: true, printBackground: true });
    expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(sheets);
    await print.close();
  } finally {
    await request.delete(`${API}/api/documents/${doc.id}`);
  }
});
