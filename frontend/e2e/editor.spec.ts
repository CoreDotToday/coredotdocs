import { expect, test, type Page } from "@playwright/test";
import { hwpxToHwp } from "./hwp-fixture";

const API = "http://127.0.0.1:8000";

async function newHwpx(request: Parameters<Parameters<typeof test>[2]>[0]["request"], title: string, markdown: string) {
  const created = await request.post(`${API}/api/documents/new`, { data: { title, markdown, format: "hwpx" } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { id: string; title: string };
}

/** 스튜디오(iframe)가 문서를 다 불러올 때까지 기다리고, 문서 상태(changeSeq 등)를 읽는 도우미 */
async function studioState(page: Page, docId: string) {
  return page.evaluate(async (id) => {
    const w = window as unknown as { __coredotdocs?: { studio(id: string): { getDocumentState(): Promise<{ changeSeq: number; documentEpoch: number; pageCount: number }> } | undefined } };
    const s = w.__coredotdocs?.studio(id);
    if (!s) throw new Error("studio 없음");
    return s.getDocumentState();
  }, docId);
}

/** 보이는(활성) 탭의 상태 표시 — 숨긴 탭도 DOM에 남아 있으므로 보이는 것만 고른다 */
function status(page: Page) {
  return page.locator(".docview:visible").getByTestId("doc-status");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("coredotdocs.workspace"));
});

test("시작 화면 → 새 문서 → 스튜디오(WYSIWYG) 로드 → AI 도구 편집이 편집기에 반영 → 리비전 되돌리기", async ({ page, request }) => {
  const title = `E2E 문서 ${Date.now()}`;
  const doc = await newHwpx(request, title, "# 제목\n\n본문 글 hello\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Core.Docs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "문서 열기…" })).toBeVisible();

  // '이 앱의 문서'에서 열기 → 탭 + 스튜디오
  await page.getByRole("list", { name: "앱 문서 목록" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("tab", { name: title })).toHaveAttribute("aria-selected", "true");
  const host = page.getByTestId("studio-host");
  await expect(host).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  await expect(status(page)).toContainText(/리비전 1/);
  await expect(status(page)).toContainText(/1쪽/);
  const before = await studioState(page, doc.id);

  // 메뉴 줄: 스튜디오 메뉴(편집·서식·표…)가 모델에서 그려진다
  await page.getByRole("menuitem", { name: "서식" }).click();
  await expect(page.getByRole("menu").getByText("글자 모양")).toBeVisible();
  await page.keyboard.press("Escape");

  // AI 패널 → 활동·도구 → insert_content (AI와 같은 도구) → SSE → 편집기가 새 리비전을 다시 불러온다
  await page.getByRole("navigation", { name: "패널 선택" }).getByRole("button", { name: "활동·도구" }).click();
  await page.getByLabel("도구", { exact: true }).selectOption("insert_content");
  await page.getByPlaceholder("넣을 내용").fill("- 새 항목");
  await page.getByRole("button", { name: "실행" }).click();
  await expect(page.locator(".result")).toContainText("문단 1개를 넣었습니다");
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).toContain("새 항목");
  // 목록 마크다운은 서버가 넣는다 → 편집기가 새 리비전을 다시 읽었다 (documentEpoch 증가)
  await expect.poll(async () => (await studioState(page, doc.id)).documentEpoch).toBeGreaterThan(before.documentEpoch);

  // 되돌리기(AI와 같은 도구) → 리비전 3, 내용은 원래대로
  const undo = await request.post(`${API}/api/tools/undo_last_edit`, { data: { arguments: { document_id: doc.id } } });
  expect((await undo.json()).isError).toBeFalsy();
  await expect(status(page)).toContainText(/리비전 3/, { timeout: 15_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).not.toContain("새 항목");
});

test("편집기에서 타이핑한 내용이 서버 리비전으로 올라가 AI 도구가 읽는다", async ({ page, request }) => {
  const doc = await newHwpx(request, "동기화 문서", "첫 문단");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  // 스튜디오(iframe) 안을 눌러 커서를 두고 실제 키 입력으로 글을 넣는다
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  await frame.locator("body").click({ position: { x: 400, y: 300 } });
  await page.keyboard.press("End");
  await page.keyboard.type(" typed-by-user", { delay: 20 });
  await expect(page.getByRole("tab", { name: /동기화 문서/ })).toContainText("●");
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).toContain("첫 문단 typed-by-user");
  const revs = await (await request.get(`${API}/api/documents/${doc.id}/revisions`)).json();
  expect(revs.at(-1)).toMatchObject({ actor: "user", summary: "편집기에서 고침" });
  // AI 도구가 최신 내용을 바꾸면: 라이브 세션이 있으므로 편집기 플러그인이 실행하고(다시 읽지 않는다, documentEpoch 그대로) 서버는 결과를 리비전 3으로 확정한다
  const epochBefore = (await studioState(page, doc.id)).documentEpoch;
  const r = await request.post(`${API}/api/tools/replace_text`, { data: { arguments: { document_id: doc.id, find: "typed-by-user", replace: "AI가 바꿈" } } });
  const body = await r.json();
  expect(body.isError).toBeFalsy();
  expect(body.content[0].text).toContain("편집기에서 실행");
  await expect(status(page)).toContainText(/리비전 3/, { timeout: 15_000 });
  expect((await studioState(page, doc.id)).documentEpoch).toBe(epochBefore);
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).toContain("첫 문단 AI가 바꿈");
  // 바뀐 자리로 이동했는지: 플러그인이 바뀐 곳(구역 0, 본문 문단 1 = "첫 문단")을 보여 준다
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const w = window as unknown as { __coredotdocs?: { studio(id: string): { getSelectionContext(): Promise<{ page: number; target: { section: number; paragraph: number } | null }> } | undefined } };
          const ctx = await w.__coredotdocs?.studio(id)?.getSelectionContext();
          return ctx?.target ? `${ctx.target.section}/${ctx.target.paragraph}` : null;
        }, doc.id),
      { timeout: 10_000 },
    )
    .toBe("0/1");
});

test("표 칸 안에서 타이핑해도 서버에 올라간다 (rhwp 0.8.7은 표 칸 캐럿의 선택 문맥을 못 준다)", async ({ page, request }) => {
  // 관측: 표로만 된 문서에서 타이핑 뒤 getSelectionContext()가 "문단 (sec=0, para=N)이 페이지에 없습니다"를 던져 올리기가 막혔다
  const doc = await newHwpx(request, "표 문서", "| 구분 | 내용 |\n|---|---|\n| 가 | 나 |");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  // 표의 둘째 행 둘째 칸("나") 근처를 눌러 칸 안에 캐럿을 둔다
  await frame.locator("body").click({ position: { x: 500, y: 300 } });
  const inCell = await page.evaluate(async (id) => {
    const w = window as unknown as { __coredotdocs?: { studio(id: string): { getSelectionContext(): Promise<{ target: unknown }> } | undefined } };
    try {
      return JSON.stringify((await w.__coredotdocs?.studio(id)?.getSelectionContext())?.target);
    } catch (e) {
      return "ERR " + String(e);
    }
  }, doc.id);
  test.info().annotations.push({ type: "selection-context", description: inCell });
  await page.keyboard.press("End");
  await page.keyboard.type("표안글", { delay: 20 });
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  await expect(status(page)).not.toContainText(/올리지 못했습니다/);
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).toContain("표안글");
});

test("옛 HWP 끌어다 놓기 → 브라우저에서 HWPX로 바꿔 열린다 · 새 Word 문서는 블록 편집기", async ({ page, request }) => {
  const sample = await (await request.get(`${API}/api/documents/${(await newHwpx(request, "HWP 원본", "옛 한글 문서 본문")).id}/download`)).body();
  const hwp = await hwpxToHwp(new Uint8Array(sample));
  await page.goto("/");
  await page.getByLabel("HWPX, HWP 또는 DOCX 파일").setInputFiles({ name: "옛문서.hwp", mimeType: "application/x-hwp", buffer: hwp });
  await expect(page.getByRole("tab", { name: /옛문서/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  const docs = await (await request.get(`${API}/api/documents`)).json();
  expect(docs.find((d: { filename: string }) => d.filename === "옛문서.hwpx")).toBeTruthy();

  await page.getByRole("button", { name: "시작 화면" }).click();
  await page.getByRole("button", { name: "새 Word 문서", exact: true }).click();
  await expect(page.getByRole("tab", { name: /새 Word 문서/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("docx-editor")).toBeVisible();
  await expect(status(page)).toContainText(/DOCX/);
});

test("편집 화면(iframe) 위에 놓은 HWPX는 새 탭으로 열리고, 열려 있던 문서는 바뀌지 않는다", async ({ page, request }) => {
  const a = await newHwpx(request, `드롭 대상 ${Date.now()}`, "원래 문서 본문");
  const b = await newHwpx(request, `드롭 파일 ${Date.now()}`, "놓은 문서 본문");
  const bBytes = await (await request.get(`${API}/api/documents/${b.id}/download`)).body();
  await page.goto(`/?doc=${a.id}`);
  const host = page.getByTestId("studio-host");
  await expect(host).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  await expect(status(page)).toContainText(/리비전 1/);

  // iframe 안 문서 영역에 파일 드롭 이벤트를 만든다(스튜디오보다 먼저 capture로 받아야 한다)
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  const target = frame.locator("body");
  const dt = await target.evaluateHandle((el, { bytes, name }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: "application/hwp+zip" }));
    return dt;
  }, { bytes: Array.from(bBytes), name: "놓은문서.hwpx" });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });

  await expect(page.getByRole("tab", { name: /놓은문서/ })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
  await expect(page.getByRole("tab", { name: /드롭 대상/ })).toBeVisible();
  // 원래 탭의 서버 문서는 그대로다 (바꿔치기·리비전 증가 없음)
  const read = await (await request.get(`${API}/api/documents/${a.id}/read`)).json();
  expect(read.text).toContain("원래 문서 본문");
  const revs = await (await request.get(`${API}/api/documents/${a.id}/revisions`)).json();
  expect(revs.length).toBe(1);
});

test("iframe에 초점이 있어도 ⌘/Ctrl+S가 앱의 저장으로 간다 (웹판)", async ({ page, request }) => {
  const doc = await newHwpx(request, `단축키 ${Date.now()}`, "단축키 본문");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  await frame.locator("body").click({ position: { x: 400, y: 300 } });
  const download = page.waitForEvent("download");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  expect((await download).suggestedFilename()).toMatch(/단축키 .*\.hwpx$/);
});

test("PDF로 저장(웹판): 쪽 SVG를 모아 쪽마다 @page 크기를 가진 인쇄 창을 연다 · 그림은 한 번만 담는다", async ({ page, request }) => {
  const doc = await newHwpx(request, `인쇄 ${Date.now()}`, "# 인쇄\n\n" + Array.from({ length: 70 }, (_, i) => `${i + 1}. 인쇄 시험 문장입니다. 쪽 나눔을 보려고 길게 씁니다. 한글과 English가 섞여 있습니다.`).join("\n\n") + "\n\n<!-- pagebreak -->\n\n마지막 쪽");
  // 같은 그림을 두 번 넣는다 (그림 공유 확인용)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVQIW2P4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const up = await request.post(`${API}/api/documents/${doc.id}/images`, { multipart: { file: { name: "dot.png", mimeType: "image/png", buffer: png } } });
  const imageId = (await up.json()).image_id;
  for (const after of [2, 3]) {
    const r = await request.post(`${API}/api/tools/insert_image`, { data: { arguments: { document_id: doc.id, image_id: imageId, after, width_mm: 30 } } });
    expect((await r.json()).isError).toBeFalsy();
  }
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  await expect(status(page)).toContainText(/\d+쪽/);
  const pages = Number(/(\d+)쪽/.exec((await status(page).innerText()) ?? "")?.[1]);
  expect(pages).toBeGreaterThan(2);

  const popup = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: "파일" }).click();
  await page.getByRole("menu").getByText("PDF로 저장…").click();
  const print = await popup;
  await print.waitForLoadState();
  await expect(print.locator(".page")).toHaveCount(pages);
  const style = await print.locator("style").innerText();
  expect(style).toContain("@page s210x297 { size: 210mm 297mm; margin: 0; }");
  expect(await print.locator(".page").first().getAttribute("style")).toContain("width:210mm;height:297mm");
  // 같은 id가 쪽마다 반복되지 않는다 (접두어)
  const ids = await print.evaluate(() => [...document.querySelectorAll("[id]")].map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  // 그림: 같은 데이터는 symbol 하나 + use 둘 (브라우저 렌더러가 <image>로 그릴 때)
  const images = await print.evaluate(() => ({ data: document.querySelectorAll("image[href^='data:']").length, symbols: document.querySelectorAll("symbol[id^='img-']").length, uses: document.querySelectorAll("use[href^='#img-']").length }));
  if (images.data + images.symbols > 0) expect(images.symbols === 1 && images.uses === 2).toBeTruthy();
});

test("라이브 세션: 편집기가 열려 있으면 AI 편집을 편집기 플러그인이 실행하고 다시 읽지 않는다 (실행 취소 1단계)", async ({ page, request }) => {
  const doc = await newHwpx(request, `라이브 ${Date.now()}`, "첫 문단 apple\n\n둘째 문단\n\n| a | b |\n|---|---|\n|  |  |");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/live/status`)).json()).live, { timeout: 15_000 }).toBe(true);
  const epoch0 = (await studioState(page, doc.id)).documentEpoch;

  // 글 바꾸기 → 편집기 실행 (응답에 "편집기에서 실행"), 화면은 다시 읽지 않는다
  let r = await (await request.post(`${API}/api/tools/replace_text`, { data: { arguments: { document_id: doc.id, find: "apple", replace: "사과" } } })).json();
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("편집기에서 실행");
  expect(r.content[0].text).toContain("리비전 2");
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  expect((await studioState(page, doc.id)).documentEpoch).toBe(epoch0);
  // 서버의 문서에도 반영됐고, 편집기의 글과 같다
  const read = await (await request.get(`${API}/api/documents/${doc.id}/read`)).json();
  expect(read.text).toContain("첫 문단 사과");
  // 표 칸 채우기 → 편집기 실행; 글이 있는 칸은 거절(전부-아니면-무)
  r = await (await request.post(`${API}/api/tools/set_table_cells`, { data: { arguments: { document_id: doc.id, table: 1, cells: [{ row: 2, col: 1, text: "가" }, { row: 2, col: 2, text: "나" }] } } })).json();
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("편집기에서 실행");
  r = await (await request.post(`${API}/api/tools/set_table_cells`, { data: { arguments: { document_id: doc.id, table: 1, cells: [{ row: 2, col: 1, text: "덮" }] } } })).json();
  expect(r.isError).toBeTruthy();
  expect(r.content[0].text).toMatch(/^오류\[CELL_NOT_EMPTY\]/);
  // 문단 넣기(제목 없는 마크다운) → 편집기 실행
  r = await (await request.post(`${API}/api/tools/insert_content`, { data: { arguments: { document_id: doc.id, markdown: "새 문단 하나", after: 2 } } })).json();
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("편집기에서 실행");
  const read2 = await (await request.get(`${API}/api/documents/${doc.id}/read`)).json();
  expect(read2.text).toContain("새 문단 하나");
  // 편집기의 실행 취소 한 단계가 마지막 AI 편집을 되돌린다 (플러그인 undo) — 서버는 다음 동기화로 따라온다
  await page.evaluate(async (id) => {
    const w = window as unknown as { __coredotdocs: { studio(id: string): { plugins: { invoke(p: string, m: string, a: unknown[]): Promise<unknown> } } } };
    await w.__coredotdocs.studio(id).plugins.invoke("coredotdocs-agent", "undo", [1, await (w.__coredotdocs.studio(id).plugins.invoke("coredotdocs-agent", "foreignChanges", []) as Promise<number>)]);
  }, doc.id);
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text, { timeout: 15_000 }).not.toContain("새 문단 하나");
  expect((await studioState(page, doc.id)).documentEpoch).toBe(epoch0); // 여전히 다시 읽지 않았다
});

test("선택 범위 편집: 편집기에서 고른 글을 AI 도구가 읽고 그 부분만 바꾼다", async ({ page, request }) => {
  const doc = await newHwpx(request, `선택 ${Date.now()}`, "앞 문장입니다\n\n고를 문장 하나\n\n뒤 문장입니다");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/live/status`)).json()).live, { timeout: 15_000 }).toBe(true);
  // 선택이 없으면 그렇다고 답한다
  let r = await (await request.post(`${API}/api/tools/read_selection`, { data: { arguments: { document_id: doc.id } } })).json();
  expect(r.content[0].text).toContain("선택한 부분이 없습니다");
  // "고를 문장 하나" 문단을 키보드로 고른다: 둘째 본문 문단 끝으로 가서 Shift+Home
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  await frame.locator("body").click({ position: { x: 400, y: 300 } });
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown"); // 첫 줄은 구역 설정이 든 빈 문단 → "앞 문장입니다"
  await page.keyboard.press("ArrowDown"); // → "고를 문장 하나"
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await expect.poll(async () => (await (await request.post(`${API}/api/tools/read_selection`, { data: { arguments: { document_id: doc.id } } })).json()).content[0].text, { timeout: 10_000 }).toContain("고를 문장 하나");
  // 채팅 패널(기본으로 열려 있다)에 선택 칩이 뜬다
  await expect(page.locator(".selection-chip")).toContainText("고를 문장 하나", { timeout: 10_000 });
  // 선택한 부분만 바꾼다
  r = await (await request.post(`${API}/api/tools/replace_selection`, { data: { arguments: { document_id: doc.id, texts: ["골라서 바꾼 문장"] } } })).json();
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toContain("편집기에서 실행");
  const read = await (await request.get(`${API}/api/documents/${doc.id}/read`)).json();
  expect(read.text).toContain("골라서 바꾼 문장");
  expect(read.text).toContain("앞 문장입니다");
  expect(read.text).not.toContain("고를 문장 하나");
  // 바뀐 곳 카드
  await expect(page.locator(".panel.changes")).toContainText("바뀐 곳", { timeout: 10_000 });
});

test("서식 막대: 글꼴·크기·굵게·정렬·줄 간격을 바로 고치고 캐럿 서식을 보여 준다", async ({ page, request }) => {
  const doc = await newHwpx(request, `서식 ${Date.now()}`, "첫 문단 apple\n\n둘째 문단");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  const bar = page.locator(".docview:visible").getByRole("toolbar", { name: "서식 막대" });
  const ctx = () =>
    page.evaluate(async (id) => {
      const w = window as unknown as { __coredotdocs: { studio(id: string): { commands: { context(): Promise<Record<string, unknown>> } } } };
      return (await w.__coredotdocs.studio(id).commands.context()) as { format?: { fontFamily?: string; fontSize?: number; bold?: boolean; alignment?: string; lineSpacing?: number }; documentFonts?: string[] };
    }, doc.id);
  // 문맥이 서식을 싣는다 (자체 빌드 패치) — 막대가 그것을 보여 준다
  const c0 = await ctx();
  expect(c0.format?.fontSize).toBeGreaterThan(0);
  expect(c0.documentFonts?.length).toBeGreaterThan(0);
  await expect(bar.getByRole("combobox", { name: "글꼴" })).toHaveValue(c0.format!.fontFamily!, { timeout: 10_000 });
  await expect(bar.getByRole("combobox", { name: "글자 크기" })).toHaveValue(String(c0.format!.fontSize! / 100).replace(/\.0$/, ""));
  // 본문에 커서를 두고 한 줄을 고른다
  const frame = page.frameLocator('[data-testid="studio-host"] iframe');
  await frame.locator("body").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  // 크기 → 20pt
  const size = bar.getByRole("combobox", { name: "글자 크기" });
  await size.fill("20");
  await size.press("Enter");
  await expect.poll(async () => (await ctx()).format?.fontSize, { timeout: 10_000 }).toBe(2000);
  // 굵게 토글 → 눌림 상태
  await bar.getByRole("button", { name: "굵게" }).click();
  await expect(bar.getByRole("button", { name: "굵게" })).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  expect((await ctx()).format?.bold).toBe(true);
  // 글꼴 → 목록의 다른 글꼴
  const font = bar.getByRole("combobox", { name: "글꼴" });
  await font.selectOption("맑은 고딕");
  await expect.poll(async () => (await ctx()).format?.fontFamily, { timeout: 10_000 }).toBe("맑은 고딕");
  // 가운데 정렬·줄 간격 200%
  await bar.getByRole("button", { name: "가운데 정렬" }).click();
  await expect.poll(async () => (await ctx()).format?.alignment, { timeout: 10_000 }).toBe("center");
  await bar.getByRole("combobox", { name: "줄 간격" }).selectOption("200");
  await expect.poll(async () => Math.round((await ctx()).format?.lineSpacing ?? 0), { timeout: 10_000 }).toBe(200);
  // 선택 없이 고른 서식은 캐럿 대기 서식: 막대가 그것을 보여 주고 "다음 입력부터"를 표시한다
  await page.keyboard.press("End");
  await size.fill("14");
  await size.press("Enter");
  await expect(size).toHaveValue("14", { timeout: 10_000 });
  await expect(bar.getByText("다음 입력부터")).toBeVisible();
  // 편집기의 변경이 서버 리비전으로 올라간다 (서식도 문서 변경이다)
  await expect(status(page)).toContainText(/리비전 [2-9]/, { timeout: 20_000 });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.screenshot({ path: "test-results/format-bar.png" }); // 화면 점검용
});

test("열린 메뉴는 본문(iframe)을 누르면 닫힌다", async ({ page, request }) => {
  const doc = await newHwpx(request, `메뉴 ${Date.now()}`, "첫 문단");
  await page.goto(`/?doc=${doc.id}`);
  await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
  const view = page.locator(".docview:visible");
  await view.getByRole("menuitem", { name: "보기" }).click();
  await expect(view.getByRole("menu").first()).toBeVisible();
  await page.frameLocator('[data-testid="studio-host"] iframe').locator("body").click({ position: { x: 700, y: 500 } }); // 열린 메뉴가 덮지 않는 자리
  await expect(view.getByRole("menu")).toHaveCount(0, { timeout: 5_000 });
});

test("Word 문서는 Tiptap 편집기에서 자유롭게 타이핑하고, 쉬면 자동으로 리비전이 올라가며, 서식 막대가 글자 모양을 바꾼다", async ({ page, request }) => {
  const created = await request.post(`${API}/api/documents/new`, { data: { title: `워드 ${Date.now()}`, markdown: "# 제목\n\n첫 문단 apple\n\n| a | b |\n|---|---|\n| 1 | 2 |", format: "docx" } });
  const doc = await created.json();
  await page.goto(`/?doc=${doc.id}`);
  const editor = page.getByTestId("docx-editor");
  await expect(editor).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  const canvas = page.getByTestId("docx-canvas");
  await expect(canvas.locator("p", { hasText: "첫 문단 apple" })).toHaveCount(1);
  await expect(canvas.locator("table td", { hasText: "2" })).toHaveCount(1);
  // 쪽 모양: 용지 너비가 A4(8.27in × 96dpi ≈ 794px)
  const width = await canvas.evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(794);
  // 쪽 나누기·글꼴 로드가 끝나 배치가 멈춘 뒤에 누른다 (그 전에는 누른 자리가 움직일 수 있다)
  await expect(status(page)).toContainText(/1쪽/, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  // 연 직후 ⌘/Ctrl+Z는 문서를 비우지 않는다 (불러오기는 실행 취소 기록에 남지 않는다)
  await canvas.locator("p", { hasText: "첫 문단 apple" }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(canvas.locator("p", { hasText: "첫 문단 apple" })).toHaveCount(1);
  // 자유 타이핑 → 1.2초 뒤 자동 올리기 → 서버 읽기에 반영
  await page.keyboard.press("End");
  // 편집기가 캐럿 이동(selectionchange)을 받아들인 뒤에 친다 — 그 전에 치면 실행 취소 기록의 "이전 캐럿"이 옛 자리(문서 맨 앞)로 남아,
  // 되돌린 뒤 캐럿이 맨 앞 빈 문단으로 돌아간다 (부하가 큰 전체 실행에서 관측)
  await expect.poll(() => page.evaluate(() => {
    const ed = (document.querySelector('[data-testid="docx-canvas"] .ProseMirror, [data-testid="docx-canvas"].ProseMirror') as unknown as { editor?: { state: { selection: { $from: { parent: { textContent: string; content: { size: number } }; parentOffset: number } } } } } | null)?.editor;
    const $from = ed?.state.selection.$from;
    return !!$from && $from.parent.textContent === "첫 문단 apple" && $from.parentOffset === $from.parent.content.size;
  })).toBe(true);
  await page.keyboard.type(" 그리고 kiwi");
  await expect(canvas.locator("p", { hasText: "첫 문단 apple 그리고 kiwi" })).toHaveCount(1);
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  // 자동 저장 뒤에도 실행 취소가 이어진다 → 되돌린 내용이 다시 올라간다
  await page.keyboard.press("ControlOrMeta+z");
  await expect(canvas.locator("p", { hasText: "kiwi" })).toHaveCount(0);
  await expect(status(page)).toContainText(/리비전 3/, { timeout: 15_000 });
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).not.toContain("kiwi");
  await page.keyboard.type(" 그리고 pear");
  await expect(status(page)).toContainText(/리비전 4/, { timeout: 15_000 });
  const read = await (await request.get(`${API}/api/documents/${doc.id}/read`)).json();
  expect(read.text).toContain("첫 문단 apple 그리고 pear");
  // 서식 막대: 문단 글을 골라 굵게 → 자동 저장 → 서버가 읽은 서식에 "굵게"
  await canvas.locator("p", { hasText: "pear" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  const view = page.locator(".docview:visible");
  const bold = view.getByRole("button", { name: "굵게" });
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(status(page)).toContainText(/리비전 5/, { timeout: 15_000 });
  const info = await (await request.post(`${API}/api/tools/read_document`, { data: { arguments: { document_id: doc.id, include_format: true } } })).json();
  expect(info.content[0].text).toContain("굵게");
  // 서버(AI) 쪽 편집이 화면에 반영된다 (라이브 세션: 편집기가 먼저 올리고 서버가 실행)
  const tool = await request.post(`${API}/api/tools/set_paragraph_text`, { data: { arguments: { document_id: doc.id, block: 1, text: "바뀐 제목" } } });
  expect((await tool.json()).isError).toBeFalsy();
  await expect(canvas.locator("h1, p", { hasText: "바뀐 제목" }).first()).toBeVisible({ timeout: 15_000 });
  // 선택 범위 도구는 편집기가 실행한다: 타이핑을 먼저 올리고, 고른 글만 바꾸고, 결과가 리비전이 된다
  const target = canvas.locator("p", { hasText: "pear" });
  await target.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plum");
  await page.keyboard.press("Shift+Home");
  const sel = await (await request.post(`${API}/api/tools/read_selection`, { data: { arguments: { document_id: doc.id } } })).json();
  expect(sel.content[0].text).toContain("plum");
  const rep = await (await request.post(`${API}/api/tools/replace_selection`, { data: { arguments: { document_id: doc.id, texts: ["AI가 고른 글을 바꿈"] } } })).json();
  expect(rep.isError, rep.content[0].text).toBeFalsy();
  expect(rep.content[0].text).toContain("편집기에서 실행");
  await expect(canvas.locator("p", { hasText: "AI가 고른 글을 바꿈" })).toHaveCount(1);
  await expect.poll(async () => (await (await request.get(`${API}/api/documents/${doc.id}/read`)).json()).text).toContain("AI가 고른 글을 바꿈");
});

test("Word 쪽 화면: 머리말·꼬리말을 그 자리에서 고치고, 각주는 쪽 아래에, 두 단 구역은 두 단으로 보인다", async ({ page, request }) => {
  const { featureDocx, partText } = await import("./docx-fixture");
  const up = await request.post(`${API}/api/documents`, { multipart: { file: { name: "기능.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await featureDocx() } } });
  const doc = await up.json();
  await page.goto(`/?doc=${doc.id}`);
  const editor = page.getByTestId("docx-editor");
  await expect(editor).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(status(page)).toContainText(/쪽/, { timeout: 15_000 });
  const view = page.locator(".docview:visible .cdd-docx");
  // 각주: 쪽 아래 영역 (본문 뒤 목록이 아니다)
  await expect(view.locator(".page-gap-notes .page-gap-note")).toContainText("시험 각주 글");
  // 두 단: 둘째 구역 블록이 두 자리(왼쪽·오른쪽 단)에 놓인다
  await expect.poll(async () => view.evaluate((r) => new Set([...r.querySelectorAll(".doc-col-block")].map((e) => getComputedStyle(e).getPropertyValue("--col-dx").trim())).size)).toBeGreaterThanOrEqual(2);
  // 머리말: 첫 쪽 머리말을 두 번 눌러 고친다 → 바깥을 누르면 확정 → 모든 쪽 띠가 바뀌고 저장된다
  const head = view.locator(".cdd-edge-hf.page-hf-header");
  await expect(head).toContainText("시험 머리말");
  await head.dblclick();
  await expect(view.locator(".page-hf-editing")).toHaveCount(1);
  await page.keyboard.press("End");
  await page.keyboard.type(" 고침");
  await view.locator(".ProseMirror p", { hasText: "첫 구역 3번" }).click();
  await expect(view.locator(".page-hf-editing")).toHaveCount(0);
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  await expect(view.locator(".page-gap-hf.page-hf-header").first()).toContainText("시험 머리말 고침");
  // 각주: 두 번 눌러 작은 창에서 고친다
  await view.locator(".page-gap-note").first().dblclick();
  const dialog = page.getByRole("dialog", { name: "각주 고치기" });
  await dialog.locator("textarea").fill("고친 각주 글");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(status(page)).toContainText(/리비전 3/, { timeout: 15_000 });
  await expect(view.locator(".page-gap-note").first()).toContainText("고친 각주 글");
  // 꼬리말을 고치는 도중에 AI 편집이 와도 고치던 글은 확정되어 함께 올라간다 (버려지지 않는다)
  const foot = view.locator(".cdd-edge-hf.page-hf-footer");
  await foot.dblclick();
  await expect(view.locator(".page-hf-editing")).toHaveCount(1);
  await expect(view.locator(".page-hf-editing:focus-within")).toHaveCount(1); // 띠 편집기가 초점을 받은 뒤에 친다
  await page.keyboard.press("End");
  await page.keyboard.type(" 편집중");
  await expect(view.locator(".page-hf-editing")).toContainText("시험 꼬리말 편집중");
  const ai = await (await request.post(`${API}/api/tools/set_paragraph_text`, { data: { arguments: { document_id: doc.id, block: 1, text: "AI가 바꾼 첫 문단" } } })).json();
  expect(ai.isError, ai.content[0].text).toBeFalsy();
  await expect(view.locator(".ProseMirror p", { hasText: "AI가 바꾼 첫 문단" })).toHaveCount(1, { timeout: 15_000 });
  await expect(view.locator(".page-hf-editing")).toHaveCount(0);
  await expect.poll(async () => partText(Buffer.from(await (await request.get(`${API}/api/documents/${doc.id}/download`)).body()), "word/footer1.xml")).toContain("시험 꼬리말 편집중");
  const saved = Buffer.from(await (await request.get(`${API}/api/documents/${doc.id}/download`)).body());
  expect(await partText(saved, "word/header1.xml")).toContain("시험 머리말 고침");
  expect(await partText(saved, "word/footnotes.xml")).toContain("고친 각주 글");
  expect(await partText(saved, "word/document.xml")).toContain('w:num="2"');
});

test("Word 편집 용지: 메뉴·여백 두 번 누르기로 열어 용지 여백·방향을 바꾸면 리비전으로 남고 쪽 모양이 바뀐다", async ({ page, request }) => {
  const created = await request.post(`${API}/api/documents/new`, { data: { title: `용지 ${Date.now()}`, markdown: "# 제목\n\n본문 문단", format: "docx" } });
  const doc = await created.json();
  await page.goto(`/?doc=${doc.id}`);
  const editor = page.getByTestId("docx-editor");
  await expect(editor).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  await expect(status(page)).toContainText(/1쪽/, { timeout: 15_000 });
  const view = page.locator(".docview:visible");
  const pm = view.locator(".ProseMirror").first();
  const padLeft = () => pm.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  const width = () => pm.evaluate((el) => (el as HTMLElement).offsetWidth);
  expect(Math.round(await padLeft())).toBe(113); // 새 문서: 왼쪽 30mm
  // 모서리 표시(crop mark)가 읽는 --page-ml/--page-mt는 본문 경계(padding)와 같아야 한다 (빠지면 1인치로 그려져 어긋난다)
  const wrap = view.locator(".page-wrap");
  const markVar = (name: string) => wrap.evaluate((el, n) => parseFloat((el as HTMLElement).style.getPropertyValue(n)), name);
  const padTop = () => pm.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
  expect(Math.round(await markVar("--page-ml"))).toBe(113);
  expect(Math.round(await markVar("--page-mt"))).toBe(Math.round(await padTop()));
  // 파일 › 편집 용지… → 왼쪽 15mm, 가로
  await view.getByRole("menuitem", { name: "파일" }).click();
  await view.getByRole("menuitem", { name: /편집 용지/ }).click();
  const dialog = page.getByRole("dialog", { name: "편집 용지" });
  await expect(dialog.getByLabel("왼쪽 (mm)")).toHaveValue("30");
  await dialog.getByLabel("왼쪽 (mm)").fill("15");
  await dialog.getByLabel("위 (mm)").fill("13"); // 머리말 위치(12.7mm)보다 조금 큰 위 여백: 빈 머리말 띠가 본문을 넘보기 쉬운 경우
  await dialog.getByLabel("가로").check();
  await expect(dialog).toContainText("용지 297×210mm");
  await dialog.getByRole("button", { name: "설정" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status(page)).toContainText(/리비전 2/, { timeout: 15_000 });
  const setup = await (await request.get(`${API}/api/documents/${doc.id}/page-setup`)).json();
  expect(setup.sections[0]).toMatchObject({ orientation: "landscape", margins_mm: { left: 15 } });
  // 편집기가 새 리비전을 다시 읽어 쪽 모양을 바꿨다: 왼쪽 여백 15mm(≈57px), 용지 너비 297mm(≈1123px)
  await expect.poll(async () => Math.round(await padLeft())).toBe(57);
  await expect.poll(async () => Math.round(await width())).toBe(1123);
  expect(Math.round(await markVar("--page-ml"))).toBe(57); // 모서리 표시도 새 여백을 따라간다
  // 빈 머리말 띠(두 번 눌러 고치는 자리)는 위 여백 띠 안에만 있어 본문 첫 줄과 겹치지 않는다 (관측: 15mm 여백 문서에서 제목과 겹침)
  const head = view.locator(".cdd-edge-hf.page-hf-header");
  await expect(head).toHaveClass(/cdd-hf-empty/);
  const bodyTop = () => pm.evaluate((el) => el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop));
  // 쪽 나누기(debounce) 뒤에 띠가 새 기하로 다시 그려진다
  await expect.poll(async () => {
    const box = (await head.boundingBox())!;
    return Math.round((box.y + box.height - (await bodyTop())) * 10) / 10;
  }).toBeLessThanOrEqual(0.5);
  expect((await head.boundingBox())!.height).toBeGreaterThan(20); // 13mm ≈ 49px: 여백 띠 전체가 과녁
  // 두 번 누르면 그 자리에서 머리말 편집이 열리고(편집 중엔 원래 자리로), Escape로 닫힌다
  await head.dblclick();
  await expect(view.locator(".page-hf-editing:focus-within")).toHaveCount(1); // 띠 편집기가 초점을 받은 뒤에 Escape (먼저 누르면 본문이 받는다)
  await page.keyboard.press("Escape");
  await expect(view.locator(".page-hf-editing")).toHaveCount(0);
  expect(Math.round(await markVar("--page-mr"))).toBe(Math.round(await pm.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))));
  // 잘못된 값은 서버가 거절하고 창에 이유를 보인다
  await page.keyboard.press("F7");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("오른쪽 (mm)").fill("290");
  await dialog.getByRole("button", { name: "설정" }).click();
  await expect(dialog.locator(".is-error").last()).toContainText("오른쪽 여백 값은 0~200mm");
  await dialog.getByLabel("오른쪽 (mm)").fill("15");
  await dialog.getByLabel("위 (mm)").fill("100");
  await dialog.getByLabel("아래 (mm)").fill("100");
  await dialog.getByRole("button", { name: "설정" }).click();
  await expect(dialog.locator(".is-error").last()).toContainText("여백이 너무 커서"); // 서버(엔진)의 본문 크기 검사
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  // 쪽 여백(본문 밖)을 두 번 누르면 연다
  // 왼쪽 여백(패딩 안) 한 점을 두 번 누른다 (locator라 화면 밖이면 스크롤해 온다; page.mouse는 화면 밖 좌표에서 아무 일도 안 한다)
  await pm.dblclick({ position: { x: 10, y: 200 } });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("왼쪽 (mm)")).toHaveValue("15");
});
