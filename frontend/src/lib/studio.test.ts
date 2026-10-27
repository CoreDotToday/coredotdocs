import { describe, expect, it } from "vitest";
import { studioChangeSeq } from "./studio";

describe("studioChangeSeq", () => {
  it("선택 문맥이 되면 그 changeSeq, 엔진이 던지면(표 칸 안 캐럿) 문서 상태의 changeSeq", async () => {
    const ok = { getSelectionContext: async () => ({ changeSeq: 7 }) as never, getDocumentState: async () => ({ changeSeq: 99 }) as never };
    expect(await studioChangeSeq(ok)).toBe(7);
    const broken = {
      getSelectionContext: async () => {
        throw new Error("렌더링 오류: 문단 (sec=0, para=3)이 페이지에 없습니다");
      },
      getDocumentState: async () => ({ changeSeq: 99 }) as never,
    };
    expect(await studioChangeSeq(broken)).toBe(99);
  });
});
