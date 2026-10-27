import type { JsonSchema } from "./api";

export type EditorEvent = {
  type: "ready" | "edit" | "undo" | "activity" | "live-request";
  /** edit: 어느 편집기가 올렸는지 (그 편집기는 다시 읽지 않는다) */
  client?: string | null;
  /** live-request: 편집기가 실행할 도구 요청 */
  session_id?: string;
  request?: { id: string; tool: string; args: Record<string, unknown>; hints: Record<string, unknown> & { method: string }; revision_seq?: number | null };
  document_id: string;
  at?: string;
  revision_seq?: number;
  restores_seq?: number;
  steps?: number;
  actor?: string;
  summary?: string;
  tool?: string | null;
  blocks?: number[];
  /** edit: 첫 변경 자리 (편집기가 그 문단으로 화면을 옮긴다) */
  place?: { section: number; paragraph: number; length: number } | null;
  ok?: boolean;
  /** edit: 'editor'면 화면 편집기가 올린 리비전 (화면은 다시 불러오지 않는다) */
  source?: string;
  /** activity: 'start' | 'end' (편집 도구만 시작을 알린다) */
  phase?: string;
};

/** SSE 이벤트를 활동 로그 한 줄로. */
export function describeEvent(e: EditorEvent): string {
  const who = e.actor === "ai" ? "AI" : e.actor === "user" ? "사용자" : "";
  switch (e.type) {
    case "ready":
      return "실시간 연결됨";
    case "live-request":
      return `편집기에 실행 요청: ${e.request?.tool ?? ""}`;
    case "edit":
      return `${who} 편집 · 리비전 ${e.revision_seq} · ${e.summary ?? e.tool ?? ""}${e.blocks?.length ? ` (블록 ${e.blocks.join(", ")})` : ""}`;
    case "undo":
      return `${who} 되돌리기 ${e.steps ?? 1}단계 → 리비전 ${e.revision_seq} (리비전 ${e.restores_seq} 내용)`;
    case "activity":
      return e.phase === "start" ? `${who} 도구 ${e.tool} 시작` : `${who} 도구 ${e.tool} ${e.ok ? "성공" : "실패"}`;
  }
}

export type Field = { name: string; type: "string" | "integer" | "number" | "boolean" | "json"; required: boolean; description: string; enumValues?: string[]; min?: number; max?: number };

/** 도구 inputSchema → 폼 필드 목록. 배열·객체는 JSON 텍스트로 받는다. */
export function schemaToFields(schema: JsonSchema): Field[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const t = prop.type;
    const type: Field["type"] = t === "integer" || t === "number" || t === "boolean" || t === "string" ? t : "json";
    return { name, type, required: required.has(name), description: prop.description ?? "", enumValues: prop.enum, min: prop.minimum, max: prop.maximum };
  });
}

/** 폼 문자열 값을 스키마 타입에 맞는 인자로. 비어 있으면 생략한다 (선택 필드). */
export function parseArguments(fields: Field[], values: Record<string, string>): { args: Record<string, unknown>; errors: string[] } {
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const raw = values[f.name];
    if (raw === undefined || raw === "") {
      if (f.required) errors.push(`${f.name}은(는) 필수입니다.`);
      continue;
    }
    switch (f.type) {
      case "integer": {
        const n = Number(raw);
        if (!Number.isInteger(n)) errors.push(`${f.name}은(는) 정수여야 합니다.`);
        else args[f.name] = n;
        break;
      }
      case "number": {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors.push(`${f.name}은(는) 숫자여야 합니다.`);
        else args[f.name] = n;
        break;
      }
      case "boolean":
        args[f.name] = raw === "true";
        break;
      case "json":
        try {
          args[f.name] = JSON.parse(raw);
        } catch {
          errors.push(`${f.name}은(는) JSON이어야 합니다.`);
        }
        break;
      default:
        args[f.name] = raw;
    }
  }
  return { args, errors };
}

/** 검색 결과 문맥을 [앞, 일치, 뒤] 조각으로. */
export function hitParts(h: { before: string; match: string; after: string }): [string, string, string] {
  return [h.before, h.match, h.after];
}
