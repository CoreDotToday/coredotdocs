// 채팅 모델 선택 목록 묶기 (ChatPanel).
import type { ChatModel } from "./api";

/** 모델 선택 묶음: 추천(도구 호출 확인)은 공급자별로 위에, 게이트웨이의 그 밖의 모델은 아래 "… 그 밖의 모델"로 */
export function modelGroups(models: ChatModel[]): { label: string; models: ChatModel[] }[] {
  const out: { label: string; models: ChatModel[] }[] = [];
  const add = (label: string, m: ChatModel) => {
    const g = out.find((x) => x.label === label);
    if (g) g.models.push(m);
    else out.push({ label, models: [m] });
  };
  for (const m of models) if (m.verified !== false) add(m.group ?? "모델", m);
  for (const m of models) if (m.verified === false) add(`${m.group ?? "모델"} — 그 밖의 모델`, m);
  return out;
}

export function fmtCredit(n: number): string {
  return n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
}
