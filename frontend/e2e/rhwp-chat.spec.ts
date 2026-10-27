import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8000";
const CDT_KEY = process.env.CDT_API_KEY;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("coredotdocs.workspace"));
});

// 실제 게이트웨이로 시험할 모델 (쉼표로 여럿). 기본은 Responses 경로를 쓰는 GPT-6.1 Sol.
const MODELS = (process.env.CDT_E2E_MODELS ?? "gpt-6.1-sol").split(",").map((m) => m.trim()).filter(Boolean);

for (const model of MODELS) {
  test(`AI 채팅(${model}): 키 입력 → 확인 → 도구로 읽고 고친다 (실제 게이트웨이)`, async ({ page, request }) => {
    test.skip(!CDT_KEY, "CDT_API_KEY가 없어 실제 게이트웨이 시험을 건너뜁니다");
    test.setTimeout(180_000);
    const created = await request.post(`${API}/api/documents/new`, { data: { title: "채팅 문서", markdown: "# 제목\n\n사과는 빨갛다.", format: "hwpx" } });
    const { id } = await created.json();
    await page.goto(`/?doc=${id}`);
    await expect(page.getByTestId("studio-host")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });
    const chat = page.getByRole("region", { name: "AI 채팅" });
    await chat.getByLabel("core.today API 키").fill(CDT_KEY!);
    await chat.getByRole("button", { name: "키 저장·확인" }).click();
    await expect(chat).toContainText("키 확인됨");
    // 키가 있으면 게이트웨이 단가표로 목록이 넓어진다 (추천 묶음 + 그 밖의 모델)
    await expect(chat.getByLabel("모델").locator("optgroup")).not.toHaveCount(0);
    await expect.poll(async () => chat.getByLabel("모델").locator("optgroup").evaluateAll((gs) => gs.map((g) => (g as HTMLOptGroupElement).label))).toContain("GPT — 그 밖의 모델");
    await chat.getByLabel("모델").selectOption(model);
    await expect(chat.locator(".chat-model-info")).toContainText(/크레딧/);
    await chat.getByLabel("AI에게 보낼 글").fill("문서를 읽고 '사과는 빨갛다.'를 '사과는 달다.'로 고쳐줘. 고친 뒤 한 줄로 알려줘.");
    await chat.getByRole("button", { name: "보내기" }).click();
    await expect(chat.getByTestId("chat-tool").first()).toBeVisible({ timeout: 90_000 });
    await expect(chat.locator(".msg.assistant").last()).toContainText(/달다|고쳤|바꿨|변경/, { timeout: 120_000 });
    await expect.poll(async () => JSON.stringify((await (await request.get(`${API}/api/documents/${id}/blocks`)).json()).blocks), { timeout: 30_000 }).toContain("사과는 달다");
  });
}
