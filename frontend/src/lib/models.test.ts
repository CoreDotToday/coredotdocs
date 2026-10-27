import { describe, expect, it } from "vitest";
import type { ChatModel } from "./api";
import { fmtCredit, modelGroups } from "./models";

describe("모델 선택 묶음", () => {
  it("확인한 추천 모델을 공급자별로 먼저, 단가표의 그 밖의 모델은 아래에 묶는다", () => {
    const m = (id: string, group: string, verified?: boolean): ChatModel => ({ id, label: id, provider: "x", group, verified });
    const g = modelGroups([m("claude-sonnet-5-5", "Claude", true), m("gpt-6.1-sol", "GPT", true), m("gpt-4o", "GPT", false), m("claude-opus-5", "Claude", false), m("gpt-6-luna", "GPT", true)]);
    expect(g.map((x) => [x.label, x.models.map((y) => y.id)])).toEqual([
      ["Claude", ["claude-sonnet-5-5"]],
      ["GPT", ["gpt-6.1-sol", "gpt-6-luna"]],
      ["GPT — 그 밖의 모델", ["gpt-4o"]],
      ["Claude — 그 밖의 모델", ["claude-opus-5"]],
    ]);
  });
  it("단가는 크기에 맞게 자릿수를 줄인다", () => {
    expect([fmtCredit(18.58), fmtCredit(3.716), fmtCredit(0.186)]).toEqual(["18.6", "3.72", "0.186"]);
  });
});
