// 라이브 세션(편집기 쪽): 서버가 이벤트 스트림(SSE `live-request`)에 실어 보낸 편집 도구 요청을 편집기 안 플러그인으로 실행하고,
// 결과와 내보낸 HWPX를 돌려준다. "진실은 서버 리비전, 실행은 편집기" (설계 문서 04 §3 B4, §9.1-1).
// 연결을 따로 열지 않는다(브라우저는 출처당 연결 6개가 상한) — 15초마다 heartbeat만 보낸다.
// 서버가 힌트(hints.method와 글자 지정 인자)를 만들어 주므로 여기서는 플러그인 메서드를 부르고 결과를 우리 말·코드로 옮기기만 한다.
// 플러그인이 "편집기 시각에서는 못 찾음/지원 안 함"이면 LIVE_FALLBACK을 돌려 서버(lxml)가 실행하게 한다.
import type { AgentPluginSurface } from "../../../third_party/ieumoffice-hwp/agent-plugin.d.mts";
import type { AgentBridge } from "./agent-plugin";
import { api, type LiveRequest, type LiveResult } from "./api";
import { studioChangeSeq, type RhwpEditor } from "./studio";

type Place = { sec: number; para: number; offset?: number; length?: number } | undefined;
type Match = { occurrence: number; context?: string };

const HEARTBEAT_MS = 15_000;
const FALLBACK_REASONS = new Set(["not_found", "ambiguous", "no_such_occurrence", "unsupported_place", "in_table", "nested", "no_such_table", "no_such_cell", "no_such_line", "no_such_field", "no_such_style", "would_empty"]);

function ourPlace(place: Place) {
  if (!place) return null;
  return { section: place.sec, paragraph: place.para, length: Math.min(place.length ?? 0, 4000) };
}

function refusal(reason: string, extra?: { count?: number; matches?: Match[]; cells?: { row: number; col: number; text?: string }[] }): LiveResult {
  if (FALLBACK_REASONS.has(reason)) return { ok: false, code: "LIVE_FALLBACK", text: reason };
  const texts: Record<string, string> = {
    occupied: `글이 있는 칸이 있어 아무 칸도 쓰지 않았습니다: ${(extra?.cells ?? []).map((c) => `(${c.row},${c.col})${c.text ? ` '${c.text.slice(0, 20)}'` : ""}`).join(", ")}. 사용자가 바꾸라고 했으면 overwrite: true로 다시 부르세요.`,
    holds_object: `개체(그림·표)가 든 칸이 있어 아무것도 쓰지 않았습니다: ${(extra?.cells ?? []).map((c) => `(${c.row},${c.col})`).join(", ")}.`,
    has_objects: "개체(표·그림·누름틀)를 잃거나 옮기게 되어 편집기가 변경을 통째로 되돌렸습니다. 범위를 좁히거나 그 개체를 다루는 도구를 쓰세요.",
    has_fields: `누름틀이 여럿 든 칸이 있어 쓰지 않았습니다: ${(extra?.cells ?? []).map((c) => `(${c.row},${c.col})`).join(", ")}. fill_fields로 번호를 대어 채우세요.`,
    changed: "요청을 보낸 뒤 그 자리의 글이 바뀌어 고치지 않았습니다. 다시 읽고 다시 부르세요.",
  };
  return { ok: false, code: reason, text: texts[reason] ?? `편집기가 거절했습니다: ${reason}` };
}

/** 두 단계 호출의 둘째 단계가 거절되면 첫 단계를 되돌린다 (편집기에 반쯤 된 변경을 남기지 않는다). */
async function undoOne(bridge: AgentBridge) {
  try {
    await bridge.undo(1, await bridge.foreignChanges());
  } catch {}
}

/** 서버 힌트 → 플러그인 호출 → 우리 결과. 문서를 바꾸지 못했으면 ok:false. */
export async function executeLive(req: LiveRequest, bridge: AgentBridge): Promise<LiveResult> {
  const h = req.hints;
  const str = (k: string) => String(h[k] ?? "");
  const num = (k: string) => Number(h[k]);
  switch (h.method) {
    case "replaceText": {
      const r = await bridge.replaceText(str("find"), str("replacement"), null);
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: `1곳을 바꿨습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "replaceAllText": {
      const r = await bridge.replaceAllText(str("find"), str("replacement"));
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: `${r.count}곳을 바꿨습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "formatText": {
      const r = await bridge.formatText(str("find"), null, Boolean(h.all), h.format as Parameters<AgentPluginSurface["formatText"]>[3]);
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: `${r.count}곳의 글자 모양을 바꿨습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "formatParagraph": {
      const r = await bridge.formatParagraph(str("find"), null, h.format as Parameters<AgentPluginSurface["formatParagraph"]>[2]);
      if (!r.ok) return refusal(r.reason, r as { count?: number });
      return { ok: true, text: "문단 1개의 모양을 바꿨습니다.", place: ourPlace(r.place) };
    }
    case "deleteParagraph": {
      const r = await bridge.deleteParagraph(str("find"), null);
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: r.emptied ? "블록 1개의 글을 지웠습니다 (칸이나 구역의 첫 문단이라 빈 줄로 남았습니다)." : "블록 1개를 지웠습니다. 뒤 블록 번호가 앞당겨졌으니 다시 읽으세요.", place: ourPlace(r.place) };
    }
    case "insertParagraphs": {
      const paragraphs = (h.paragraphs as string[]) ?? [];
      const r = await bridge.insertParagraphs(str("anchor"), null, (h.where as "after" | "before" | "end") ?? "end", paragraphs);
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: `문단 ${r.count}개를 넣었습니다. 블록 번호가 바뀌었으니 다시 읽으세요.`, place: ourPlace(r.place), count: r.count };
    }
    case "insertTable": {
      const r = await bridge.insertTable(str("anchor"), null, (h.where as "after" | "before" | "end") ?? "end", (h.rows as string[][]) ?? [], Boolean(h.header));
      if (!r.ok) return refusal(r.reason, r as { count?: number });
      return { ok: true, text: `표를 넣었습니다 (${r.rows}행 × ${r.cols}열). 블록 번호가 바뀌었으니 다시 읽으세요.`, place: ourPlace(r.place) };
    }
    case "fillCells": {
      const cells = (h.cells as { row: number; col: number; text: string }[]) ?? [];
      const r = await bridge.fillCells(num("table"), cells, Boolean(h.overwrite));
      if (!r.ok) return refusal(r.reason, r as { count?: number; cells?: { row: number; col: number; text?: string }[] });
      return { ok: true, text: `표의 칸 ${r.count}개를 고쳤습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "addTableLines": {
      const r = await bridge.addTableLines(num("table"), "rows", num("at"), (h.where as "after" | "before") ?? "after", num("count"));
      if (!r.ok) return refusal(r.reason, r as { count?: number });
      const rows = (h.rows as string[][]) ?? [];
      if (rows.length) {
        const cells = rows.flatMap((row, i) => row.map((text, j) => ({ row: r.first + i, col: j + 1, text })));
        const f = await bridge.fillCells(num("table"), cells, true);
        if (!f.ok) {
          await undoOne(bridge); // 넣은 행을 남기지 않는다
          return refusal(f.reason, f as { count?: number });
        }
      }
      return { ok: true, text: `표에 행 ${r.count}개를 넣었습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "removeTableLines": {
      const r = await bridge.removeTableLines(num("table"), "rows", num("at"), num("count"));
      if (!r.ok) return refusal(r.reason, r as { count?: number });
      return { ok: true, text: `표의 행 ${r.count}개를 지웠습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "fillField": {
      const calls = (h.calls as { field: number; value: string }[]) ?? [];
      let place: ReturnType<typeof ourPlace> = null;
      let done = 0;
      for (const c of calls) {
        const r = await bridge.fillField(c.field, c.value);
        if (!r.ok) {
          for (let i = 0; i < done; i++) await undoOne(bridge); // 전부-아니면-무
          return refusal(r.reason, r);
        }
        done += 1;
        place = place ?? ourPlace(r.place);
      }
      return { ok: true, text: `누름틀 ${calls.length}개를 채웠습니다.`, place, count: calls.length };
    }
    case "selection": {
      const r = await bridge.selection();
      if (!r.ok) return { ok: false, code: "NONE", text: r.reason === "none" ? "선택한 부분이 없습니다. 사용자에게 편집기에서 고칠 부분을 선택해 달라고 하거나 블록 번호로 고치세요." : r.reason === "unsupported" ? "선택한 자리는 다룰 수 없는 곳입니다(각주·머리말 등)." : "선택이 너무 깁니다." };
      const lines = r.segments.map((seg, i) => `${i + 1}) ${seg.text}`);
      return { ok: true, text: `선택 ${r.segments.length}토막${r.inTable ? " (표 안)" : ""}${r.contiguous ? ", 한 줄기(문단 수를 바꿀 수 있음)" : ""}:\n${lines.join("\n")}` };
    }
    case "replaceSelection": {
      const sel = await bridge.selection();
      if (!sel.ok) return { ok: false, code: "TARGET_NOT_FOUND", text: "선택한 부분이 없습니다." };
      if (sel.own) return { ok: false, code: "TARGET_NOT_FOUND", text: "지금 선택은 AI가 바뀐 곳을 보여 주려고 만든 것이라 대상이 아닙니다. 사용자가 다시 선택해야 합니다." };
      const r = await bridge.replaceSelection(sel.segments, (h.texts as string[]) ?? []);
      if (!r.ok) return r.reason === "count" ? { ok: false, code: "INVALID_ARGUMENT", text: `토막 수(${r.count})만큼 글을 주세요 (표 칸이나 떨어진 자리의 선택은 늘리거나 줄일 수 없습니다).` } : refusal(r.reason, r as { count?: number });
      return { ok: true, text: `선택한 부분(${r.segments.length}토막)을 바꿨습니다.`, place: ourPlace(r.place) };
    }
    case "formatSelection": {
      const sel = await bridge.selection();
      if (!sel.ok || sel.own) return { ok: false, code: "TARGET_NOT_FOUND", text: "선택한 부분이 없습니다." };
      const r = await bridge.formatSelection(sel.segments, h.format as Parameters<AgentPluginSurface["formatSelection"]>[1]);
      if (!r.ok) return refusal(r.reason, r as { count?: number });
      return { ok: true, text: `선택한 부분 ${r.count}곳의 모양을 바꿨습니다.`, place: ourPlace(r.place) };
    }
    case "mergeCells": {
      const r = await bridge.mergeCells(num("table"), h.from as { row: number; col: number }, h.to as { row: number; col: number });
      if (!r.ok) return r.reason === "crosses_merged" || r.reason === "named_cells" ? { ok: false, code: "UNSUPPORTED", text: r.reason === "crosses_merged" ? "병합 칸을 일부만 걸치는 범위는 합칠 수 없습니다." : `칸 이름이 있는 칸(${r.cells.map((c) => `(${c.row},${c.col})`).join(", ")})은 서식이 그 이름으로 채우므로 합치지 않았습니다.` } : refusal(r.reason, r as { count?: number });
      return { ok: true, text: `칸 ${r.merged}개를 한 칸으로 합쳤습니다.`, place: ourPlace(r.place) };
    }
    case "splitCell": {
      const r = await bridge.splitCell(num("table"), num("row"), num("col"), (h.rows as number | null) ?? null, (h.cols as number | null) ?? null);
      if (!r.ok) return r.reason === "not_merged" ? { ok: false, code: "INVALID_ARGUMENT", text: "합친 칸이 아니라 병합을 풀 수 없습니다. rows·cols로 나눌 수를 주세요." } : refusal(r.reason, r as { count?: number });
      return { ok: true, text: r.unmerged ? "칸의 병합을 풀었습니다." : "칸을 나눴습니다. 글은 첫 칸에 남았습니다.", place: ourPlace(r.place) };
    }
    case "formatCells": {
      const r = await bridge.formatCells(num("table"), (h.cells as { row: number; col: number }[]) ?? [], str("background"));
      if (!r.ok) return refusal(r.reason, r as { count?: number; cells?: { row: number; col: number }[] });
      return { ok: true, text: `칸 ${r.count}개의 배경색을 바꿨습니다.`, place: ourPlace(r.place), count: r.count };
    }
    case "listNotes": {
      const r = await bridge.listNotes();
      if (!r.count) return { ok: true, text: "본문에 각주·미주가 없습니다." };
      const lines = r.notes.map((n) => `#${n.note} ${n.kind === "footnote" ? "각주" : "미주"} ${n.number}) …${n.after} → ${n.text}${n.objects ? " [개체 있음]" : ""}`);
      return { ok: true, text: `각주·미주 ${r.count}개${r.elsewhere ? ` (표·글상자 안 ${r.elsewhere}개는 번호 없음)` : ""}:\n${lines.join("\n")}` };
    }
    case "insertNote": {
      const r = await bridge.insertNote(h.kind as "footnote" | "endnote", str("anchor"), null, str("text"));
      if (!r.ok) return refusal(r.reason, r);
      return { ok: true, text: `${r.kind === "footnote" ? "각주" : "미주"}${r.number ? ` ${r.number}` : ""}을(를) 넣었습니다.`, place: ourPlace(r.place) };
    }
    case "editNote": {
      const r = await bridge.editNote(num("note"), str("text"));
      if (!r.ok) return refusal(r.reason === "no_such_note" ? "no_such_field" : r.reason, r as { count?: number });
      return { ok: true, text: `${r.kind === "footnote" ? "각주" : "미주"} ${r.number}의 내용을 바꿨습니다 (전: ${r.was.slice(0, 40)}).`, place: ourPlace(r.place) };
    }
    case "deleteNote": {
      const r = await bridge.deleteNote(num("note"));
      if (!r.ok) return refusal(r.reason === "no_such_note" ? "no_such_field" : r.reason, r as { count?: number });
      return { ok: true, text: `${r.kind === "footnote" ? "각주" : "미주"} ${r.number}을(를) 지웠습니다 (${r.text.slice(0, 40)}).`, place: ourPlace(r.place) };
    }
    case "insertToc": {
      const anchor = str("anchor");
      const r = await bridge.insertToc(anchor, null, anchor ? "after" : "end", (h.title as string | null) ?? null, (h.entries as { find: string; level: number }[]) ?? []);
      if (!r.ok) return r.reason === "no_heading" ? { ok: false, code: "TARGET_NOT_FOUND", text: `제목 '${r.heading}'을(를) 정하지 못했습니다 (${r.why}). 문서에 하나뿐인 글로 주세요.` } : refusal(r.reason, r as { count?: number });
      return { ok: true, text: `차례(${r.count}줄)를 넣었습니다. 쪽 번호: ${r.pages.join(", ")}`, place: ourPlace(r.place), count: r.count };
    }
    case "undo": {
      // 서버가 되돌리라고 할 때는 실행 직후 읽어 둔 foreign(h.foreign)으로 — 그 사이 사용자가 쳤으면 플러그인이 거절한다
      const foreign = typeof h.foreign === "number" ? (h.foreign as number) : await bridge.foreignChanges();
      const r = await bridge.undo(num("steps") || 1, foreign);
      return r.ok ? { ok: true, text: `${r.undone}단계 되돌렸습니다.` } : { ok: false, code: "FOREIGN_CHANGES", text: "그 사이 사용자가 고쳐 되돌리지 않았습니다. 편집기의 실행 취소(Ctrl+Z)로 되돌리세요." };
    }
    default:
      return { ok: false, code: "LIVE_FALLBACK", text: `모르는 방법: ${h.method}` };
  }
}

export type LiveHandle = {
  /** 이벤트 스트림으로 온 요청을 넘긴다 (세션이 다르면 무시) */
  handle(event: { session_id?: string; request?: LiveRequest }): void;
  stop(): void;
  sessionId(): string | null;
};

/** 편집기가 요청을 스스로 실행하는 쪽(DOCX Tiptap 편집기): 결과와, 문서를 바꿨으면 내보낸 바이트·그 시점의 변경 번호 */
export type LiveExecutor = (request: LiveRequest) => Promise<{ result: LiveResult; bytes?: Uint8Array; seq?: number }>;

export type LiveOptions = {
  documentId: string;
  /** HWPX: rhwp-studio + 에이전트 플러그인이 실행한다 */
  studio?: RhwpEditor;
  bridge?: AgentBridge;
  /** DOCX: 편집기 쪽 실행기 (studio·bridge 대신) */
  executor?: LiveExecutor;
  client: string;
  /** 실행 직전: 올리지 않은 변경을 먼저 올린다. 거짓이면 지금은 못 한다(다시 읽는 중 등) → 서버가 실행 */
  beforeExecute: () => Promise<boolean>;
  /** 서버가 결과를 받아들인 뒤: 이 changeSeq까지는 서버가 가졌다 */
  onApplied: (changeSeq: number) => void;
  onNotice?: (message: string) => void;
  onGone?: () => void;
  /** 편집기가 아는 서버 리비전: 그보다 오래된 머리를 보고 만든 요청은 거절한다(서버가 최신 위에서 실행) */
  knownSeq?: () => number;
  /** 실행 시작(비우기 뒤)부터 결과 전송이 끝날 때까지 참: 그 사이 느린 폴링이 AI 내용을 사용자 리비전으로 올리지 않는다 */
  onBusy?: (busy: boolean) => void;
};

const REGISTER_RETRY_MS = 3000;
const REREGISTER_AFTER_GONE_MS = 5000;

/**
 * 세션을 등록하고(보이는 탭 하나가 가진다) heartbeat를 보낸다. 요청은 문서의 이벤트 스트림에서 `handle`로 들어온다.
 * 실행 뒤 `exportHwpx`로 내보낸 파일과 함께 결과를 올린다.
 */
export function startLiveSession(opts: LiveOptions): LiveHandle {
  let session: string | null = null;
  let stopped = false;
  let heartbeat: number | null = null;
  let chain: Promise<void> = Promise.resolve(); // 요청은 하나씩 차례로

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (heartbeat) window.clearInterval(heartbeat);
    if (retry) window.clearTimeout(retry);
    if (session) api.liveClose(opts.documentId, session).catch(() => {});
    session = null;
  };

  let retry: number | null = null;
  const later = (fn: () => void, ms: number) => {
    if (retry) window.clearTimeout(retry);
    retry = window.setTimeout(() => {
      retry = null;
      if (!stopped) fn();
    }, ms);
  };

  /** 등록한다. 실패하면(백엔드가 아직 안 떴을 때 등) 잠시 뒤 다시 — 문서가 없으면(404) 끝. */
  const register = async () => {
    if (stopped || session) return;
    try {
      const r = await api.liveRegister(opts.documentId, opts.client);
      if (stopped) api.liveClose(opts.documentId, r.session_id).catch(() => {});
      else session = r.session_id;
    } catch (err) {
      session = null;
      if ((err as { status?: number }).status === 404) stop();
      else later(register, REGISTER_RETRY_MS);
    }
  };

  /** 세션을 잃었다(서버 재시작·다른 창이 가져감). 이 창이 초점을 가질 때 다시 연다 — 두 창이 번갈아 빼앗는 핑퐁을 막는다. */
  const reclaimWhenFocused = () => {
    if (stopped || session) return;
    if (document.hasFocus()) later(register, REREGISTER_AFTER_GONE_MS);
    else window.addEventListener("focus", () => later(register, REREGISTER_AFTER_GONE_MS), { once: true });
  };

  (async () => {
    if (!opts.executor) {
      if (!opts.bridge || !(await opts.bridge.available())) {
        opts.onNotice?.("편집기 플러그인이 없어 AI 편집은 서버에서 실행됩니다.");
        return;
      }
    }
    await register();
    heartbeat = window.setInterval(async () => {
      if (stopped || !session) return;
      try {
        await api.liveHeartbeat(opts.documentId, session);
      } catch (err) {
        if ((err as { status?: number }).status === 410) {
          session = null;
          opts.onGone?.();
          reclaimWhenFocused();
        }
      }
    }, HEARTBEAT_MS);
  })();

  const run = async (request: LiveRequest) => {
    if (!session) return;
    const sid = session;
    let result: LiveResult;
    let bytes: Uint8Array | undefined;
    let seq = 0;
    let busy = false;
    try {
      const known = opts.knownSeq?.() ?? 0;
      if (typeof request.revision_seq === "number" && request.revision_seq < known) {
        // 서버가 이 요청을 만들 때 본 머리보다 편집기가 더 새 것을 안다(그 사이 올라간 리비전): 서버가 최신 위에서 실행한다
        result = { ok: false, code: "LIVE_FALLBACK", text: `stale request (server ${request.revision_seq} < editor ${known})` };
      } else if (!(await opts.beforeExecute())) result = { ok: false, code: "LIVE_FALLBACK", text: "editor busy" };
      else if (opts.executor) {
        busy = true;
        opts.onBusy?.(true);
        const r = await opts.executor(request);
        result = r.result;
        bytes = r.bytes;
        seq = r.seq ?? 0;
      } else if (opts.studio && opts.bridge) {
        busy = true;
        opts.onBusy?.(true);
        result = await executeLive(request, opts.bridge);
        if (result.ok) {
          seq = await studioChangeSeq(opts.studio); // 내보내기 전의 번호: 그 뒤 타이핑은 다음 올리기가 가져간다
          bytes = await opts.studio.exportHwpx();
          result.foreign = await opts.bridge.foreignChanges(); // 서버가 되돌리라고 할 때의 기준
        }
      } else result = { ok: false, code: "LIVE_FALLBACK", text: "no executor" };
    } catch (err) {
      result = { ok: false, code: "LIVE_FALLBACK", text: String(err) };
    }
    try {
      await api.liveResult(opts.documentId, sid, request.id, result, bytes);
      if (result.ok && bytes) opts.onApplied(seq); // 서버가 받은 뒤에만 '올라간 것'으로 친다
    } catch {
      /* 404(이미 시간 초과)·410: 서버가 실행했거나 세션이 바뀌었다 — 다음 올리기가 이 변경을 사용자 리비전으로 올린다 */
    } finally {
      if (busy) opts.onBusy?.(false);
    }
  };

  return {
    handle(event) {
      if (stopped || !session || event.session_id !== session || !event.request) return;
      const req = event.request;
      chain = chain.then(() => run(req)).catch(() => {});
    },
    stop,
    sessionId: () => session,
  };
}
