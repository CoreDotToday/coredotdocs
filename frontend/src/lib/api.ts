// 브라우저는 공개 주소, 서버 컴포넌트는 내부 주소(API_INTERNAL_URL, 런타임 env)를 쓴다. 컨테이너 안에서는 localhost가 백엔드가 아니므로 둘을 나눈다.
// 공개 주소는 빌드 시 굽는 NEXT_PUBLIC_API_URL이 기본이고, 데스크톱 앱처럼 포트가 실행 때 정해지면 layout.tsx가 window.__API_BASE__로 덮어쓴다.
declare global {
  interface Window {
    __API_BASE__?: string;
    __MCP_COMMAND__?: { command: string; args: string[]; env?: Record<string, string> };
  }
}
const PUBLIC_DEFAULT = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
export const API_BASE = typeof window === "undefined" ? process.env.API_INTERNAL_URL || PUBLIC_DEFAULT : window.__API_BASE__ || PUBLIC_DEFAULT;

/** 서버 시각(UTC로 저장). SQLite는 시간대를 떨궈 "2026-10-25T11:59:52"처럼 주므로 시간대가 없으면 UTC로 읽는다 */
export function serverDate(iso: string): Date {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

export type DocFormat = "hwpx" | "docx";
export type DocumentSummary = { id: string; title: string; filename: string; format: DocFormat; revision_seq: number; updated_at: string };
export type Cell = { row: number; col: number; row_span: number; col_span: number; text: string };
/** index·sub: DOCX만 — w:body 맨 위 요소 번호(편집기 엔진의 docxIndex)와 콘텐츠 컨트롤 안 문단 번호 */
export type Block =
  | { no: number; kind: "paragraph"; text: string; index?: number; sub?: number }
  | { no: number; kind: "table"; table_no: number; rows: number; cols: number; cells: Cell[]; index?: number; sub?: number };
export type Revision = { seq: number; actor: string; summary: string; tool: string | null; created_at: string };
export type SearchHit = { document_id: string; document_title: string; block_no: number; where: string; before: string; match: string; after: string };
export type Tool = { name: string; title?: string; description: string; inputSchema: JsonSchema };
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: JsonSchema;
};
export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
export type Layout = { pages: number; revision_seq: number; engine: string } | null;
/** 채팅 모델. group은 화면 묶음(Claude·GPT·Gemini…), verified는 도구 호출 왕복을 확인한 추천 모델, 단가는 1K 토큰당 크레딧(게이트웨이 단가표) */
export type ChatModel = { id: string; label: string; provider: string; group?: string; note?: string; verified?: boolean; input_per_1k?: number; output_per_1k?: number };
/** 한 구역의 쪽 설정 (mm). width·height는 놓인 그대로 */
export type PageSetup = { section: number; paper: string | null; width_mm: number; height_mm: number; orientation: "portrait" | "landscape"; margins_mm: { top: number; bottom: number; left: number; right: number }; header_mm: number; footer_mm: number; gutter_mm: number };
export type ChatHistoryItem = { role: "user" | "assistant"; content: string };
export type LiveRequest = { id: string; tool: string; args: Record<string, unknown>; hints: Record<string, unknown> & { method: string }; revision_seq?: number | null };
export type LiveResult = { ok: boolean; text?: string; code?: string; place?: { section: number; paragraph: number; length: number } | null; blocks?: number[]; count?: number; foreign?: number };
export type ChatStoredMessage = { seq: number; role: "user" | "assistant"; text: string; tools?: { name: string; ok: boolean; summary: string }[] | null; model?: string | null; created_at: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    // FastAPI detail은 문자열이거나 {message, code} 객체다 (undo의 409 등)
    const obj = detail && typeof detail === "object" ? (detail as { message?: string; code?: string }) : null;
    throw new ApiError(res.status, `${res.status} ${obj?.message ?? String(detail)}`, obj?.code);
  }
  return res.json() as Promise<T>;
}

const JSON_HEADERS = { "content-type": "application/json" };

export const api = {
  listDocuments: (init?: RequestInit) => fetch(`${API_BASE}/api/documents`, { cache: "no-store", ...init }).then((r) => json<DocumentSummary[]>(r)),
  getDocument: (id: string) => fetch(`${API_BASE}/api/documents/${id}`, { cache: "no-store" }).then((r) => json<DocumentSummary & { block_count: number; layout: Layout }>(r)),
  deleteDocument: (id: string) => fetch(`${API_BASE}/api/documents/${id}`, { method: "DELETE" }).then((r) => (r.ok ? undefined : json(r))),
  rename: (id: string, body: { title?: string; filename?: string }) =>
    fetch(`${API_BASE}/api/documents/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }).then((r) => json<{ id: string; title: string; filename: string; format: DocFormat }>(r)),
  createBlank: (title: string, markdown: string, format: DocFormat) =>
    fetch(`${API_BASE}/api/documents/new`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ title, markdown, format }) }).then((r) => json<{ id: string; title: string; format: DocFormat }>(r)),
  reportLayout: (id: string, pages: number, revisionSeq: number, engine: string) =>
    fetch(`${API_BASE}/api/documents/${id}/layout`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ pages, revision_seq: revisionSeq, engine }) }).then((r) => json<{ accepted: boolean }>(r)),
  // 키가 있으면 서버가 게이트웨이 단가표로 그 밖의 모델과 단가를 채운다
  /** 설치 글꼴 목록을 서버에 알린다: AI 도구의 글꼴 이름을 가족명으로 맞추고 list_fonts가 답할 수 있게 */
  postFonts: (fonts: { family: string; localized?: string }[]) => fetch(`${API_BASE}/api/fonts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fonts }) }).then((r) => json<{ count: number }>(r)),
  chatModels: (key?: string | null) => fetch(`${API_BASE}/api/ai/models`, { cache: "no-store", headers: key ? { "X-CDT-Key": key } : {} }).then((r) => json<{ models: ChatModel[]; default: string; docs: string; pricing?: boolean }>(r)),
  checkKey: (key: string) => fetch(`${API_BASE}/api/ai/key`, { cache: "no-store", headers: { "X-CDT-Key": key } }).then((r) => json<{ ok: boolean; key_hint: string }>(r)),
  chat: (key: string, body: { document_id: string; model: string; message: string; history?: ChatHistoryItem[]; selection?: string | null }, signal?: AbortSignal) =>
    fetch(`${API_BASE}/api/ai/chat`, { method: "POST", headers: { ...JSON_HEADERS, "X-CDT-Key": key }, body: JSON.stringify(body), signal }),
  getBlocks: (id: string) => fetch(`${API_BASE}/api/documents/${id}/blocks`, { cache: "no-store" }).then((r) => json<{ revision_seq: number; blocks: Block[] }>(r)),
  getRevisions: (id: string) => fetch(`${API_BASE}/api/documents/${id}/revisions`, { cache: "no-store" }).then((r) => json<Revision[]>(r)),
  upload: (file: File | Blob, filename?: string) => {
    const form = new FormData();
    form.append("file", file, filename ?? (file instanceof File ? file.name : "문서.hwpx"));
    return fetch(`${API_BASE}/api/documents`, { method: "POST", body: form }).then((r) => json<{ id: string; title: string; format: DocFormat; revision_seq: number }>(r));
  },
  /** 화면 편집기(rhwp-studio)가 내보낸 문서 전체를 리비전으로 올린다. 내용이 같으면 changed=false. */
  pushRevision: (id: string, bytes: Uint8Array, filename: string, summary?: string, client?: string, base?: number) => {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: "application/hwp+zip" }), filename);
    if (summary) form.append("summary", summary);
    // X-Editor-Client: 이 편집기가 올린 리비전은 이벤트로 돌아와도 다시 읽지 않는다.
    // X-Editor-Base: 편집기가 알던 머리 — 그 뒤 다른 쪽이 리비전을 만들었으면 409 STALE_REVISION(마지막 쓰기가 이기지 않는다)
    const headers: Record<string, string> = {};
    if (client) headers["X-Editor-Client"] = client;
    if (base !== undefined) headers["X-Editor-Base"] = String(base);
    return fetch(`${API_BASE}/api/documents/${id}/revisions`, { method: "POST", body: form, headers }).then((r) => json<{ revision_seq: number; changed: boolean }>(r));
  },
  downloadBytes: async (id: string) => {
    const r = await fetch(`${API_BASE}/api/documents/${id}/download`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  undo: (id: string, steps = 1, force = false) => fetch(`${API_BASE}/api/documents/${id}/undo`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ steps, force }) }).then((r) => json<{ revision_seq: number }>(r)),
  liveRegister: (id: string, client: string) => fetch(`${API_BASE}/api/documents/${id}/live`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ client }) }).then((r) => json<{ session_id: string; poll_wait_s: number }>(r)),
  liveHeartbeat: (id: string, session: string) => fetch(`${API_BASE}/api/documents/${id}/live/${session}/heartbeat`, { method: "POST" }).then((r) => json<{ ok: boolean }>(r)),
  liveResult: (id: string, session: string, requestId: string, result: LiveResult, bytes?: Uint8Array) => {
    const fd = new FormData();
    fd.append("result", JSON.stringify(result));
    if (bytes) fd.append("file", new Blob([bytes as BlobPart], { type: "application/hwp+zip" }), "live.hwpx");
    return fetch(`${API_BASE}/api/documents/${id}/live/${session}/results/${requestId}`, { method: "POST", body: fd }).then((r) => json<{ ok: boolean }>(r));
  },
  liveClose: (id: string, session: string) => fetch(`${API_BASE}/api/documents/${id}/live/${session}`, { method: "DELETE", keepalive: true }).then((r) => json<{ ok: boolean }>(r)),
  chatHistory: (id: string) => fetch(`${API_BASE}/api/ai/chat/${id}/history`, { cache: "no-store" }).then((r) => json<{ messages: ChatStoredMessage[] }>(r)),
  clearChatHistory: (id: string) => fetch(`${API_BASE}/api/ai/chat/${id}/history`, { method: "DELETE" }).then((r) => json<{ ok: boolean }>(r)),
  search: (q: string, documentId?: string) => {
    const params = new URLSearchParams({ q });
    if (documentId) params.set("document_id", documentId);
    return fetch(`${API_BASE}/api/search?${params}`, { cache: "no-store" }).then((r) => json<{ hits: SearchHit[]; truncated: boolean }>(r));
  },
  listTools: () => fetch(`${API_BASE}/api/tools`, { cache: "no-store" }).then((r) => json<{ tools: Tool[] }>(r)),
  pageSetup: (id: string) => fetch(`${API_BASE}/api/documents/${id}/page-setup`, { cache: "no-store" }).then((r) => json<{ revision_seq: number; sections: PageSetup[] }>(r)),
  callTool: (name: string, args: Record<string, unknown>) =>
    fetch(`${API_BASE}/api/tools/${name}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ arguments: args }) }).then((r) => json<ToolResult>(r)),
  createSession: (name: string, documentIds?: string[]) =>
    fetch(`${API_BASE}/api/ai/sessions`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, document_ids: documentIds ?? null }) }).then((r) => json<{ id: string; token: string }>(r)),
  eventsUrl: (id: string) => `${API_BASE}/api/documents/${id}/events`,
  downloadUrl: (id: string) => `${API_BASE}/api/documents/${id}/download`,
};
