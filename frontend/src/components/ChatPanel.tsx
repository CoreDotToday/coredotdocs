"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatModel } from "@/lib/api";
import { fmtCredit, modelGroups } from "@/lib/models";
import { readSse } from "@/lib/sse";
import { useLocalStorage } from "@/lib/storage";

type Message =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; ok?: boolean; result?: string }
  | { kind: "error"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "usage"; text: string };

const KEY_DOCS = "https://console.core.today";

/** 앱 안에서 LLM(core.today 게이트웨이)과 대화하며 문서를 고친다. 키는 브라우저(localStorage)에만 둔다. */
export type SelectionPreview = { text: string; segments: number } | null;

export function ChatPanel({ documentId, onChanged, onBeforeSend, onBusy, getSelection }: { documentId: string; onChanged: () => void; onBeforeSend?: () => unknown; onBusy?: (busy: boolean) => void; getSelection?: () => Promise<SelectionPreview> }) {
  const [storedKey, setStoredKey] = useLocalStorage("cdt_api_key");
  const [storedModel, setStoredModel] = useLocalStorage("cdt_model");
  const [keyInput, setKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [defaultModel, setDefaultModel] = useState("claude-sonnet-5-5");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<SelectionPreview>(null);
  const [selectionOff, setSelectionOff] = useState<string | null>(null); // x를 누른 선택(글)은 대상에서 뺀다; 새로 선택하면 다시 대상
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const model = storedModel ?? defaultModel;

  useEffect(() => {
    let alive = true;
    api
      .chatModels(storedKey)
      .then((r) => {
        if (!alive) return;
        setModels(r.models);
        setDefaultModel(r.default);
      })
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [storedKey]);
  const groups = useMemo(() => modelGroups(models), [models]);
  const current = models.find((m) => m.id === model);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  // 문서별 대화 기록은 서버에 남는다 (실패한 실행은 빠진다). 패널을 열면 되살린다.
  useEffect(() => {
    let alive = true;
    api
      .chatHistory(documentId)
      .then((r) => {
        if (!alive) return;
        setMessages(
          r.messages.flatMap((m): Message[] => {
            const tools: Message[] = (m.tools ?? []).map((t, i) => ({ kind: "tool", id: `h${m.seq}-${i}`, name: t.name, args: {}, ok: t.ok, result: t.summary }));
            return m.role === "user" ? [{ kind: "user", text: m.text }] : [...tools, { kind: "assistant", text: m.text }];
          }),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [documentId]);

  // 편집기의 선택을 0.7초마다 묻는다 (요청이 도는 동안은 묻지 않는다). 선택이 있으면 입력 칸 위에 표시가 뜨고 그때 보낸 요청은 그 부분에 대한 것이 된다.
  useEffect(() => {
    if (!getSelection || busy) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const s = await getSelection();
        if (alive) setSelection((prev) => (prev?.text === s?.text && prev?.segments === s?.segments ? prev : s));
      } catch {}
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [getSelection, busy]);
  const activeSelection = selection && selection.text !== selectionOff ? selection : null;

  async function clearHistory() {
    await api.clearChatHistory(documentId).catch(() => {});
    setMessages([]);
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    setKeyStatus({ text: "확인 중…" });
    try {
      const r = await api.checkKey(key);
      setStoredKey(key);
      setKeyInput("");
      setKeyStatus({ text: `키 확인됨 (${r.key_hint}). 이 브라우저에만 저장됩니다.` });
    } catch (err) {
      setKeyStatus({ text: String(err), error: true });
    }
  }

  function clearKey() {
    setStoredKey(null);
    setKeyStatus(null);
    setMessages([]);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !storedKey || busy) return;
    setMessages((prev) => [...prev, { kind: "user", text }]);
    setInput("");
    setBusy(true);
    onBusy?.(true);
    abort.current = new AbortController();
    try {
      const synced = await onBeforeSend?.(); // 편집기의 아직 올리지 않은 변경을 서버에 먼저 반영한다
      if (synced === false) throw new Error("편집기 내용을 서버가 받아 주지 않아 보내지 않았습니다. 상태 표시의 오류를 확인하세요.");
      const res = await api.chat(storedKey, { document_id: documentId, model, message: text, selection: activeSelection?.text ?? null }, abort.current.signal); // history는 서버 기록을 쓴다
      if (!res.ok) {
        let detail = res.statusText;
        try {
          detail = (await res.json()).detail ?? detail;
        } catch {}
        throw new Error(`${res.status} ${detail}`);
      }
      await readSse(res, (ev) => {
        const data = JSON.parse(ev.data) as Record<string, unknown>;
        switch (ev.event) {
          case "text":
            setMessages((prev) => [...prev, { kind: "assistant", text: String(data.text) }]);
            break;
          case "tool_call":
            setMessages((prev) => [...prev, { kind: "tool", id: String(data.id), name: String(data.name), args: (data.arguments as Record<string, unknown>) ?? {} }]);
            break;
          case "tool_result":
            setMessages((prev) => prev.map((m) => (m.kind === "tool" && m.id === data.id ? { ...m, ok: Boolean(data.ok), result: String(data.text) } : m)));
            if (data.ok) onChanged();
            break;
          case "done": {
            const u = data.usage as { input_tokens: number; output_tokens: number } | undefined;
            if (u) setMessages((prev) => [...prev, { kind: "usage", text: `${String(data.model)} · 입력 ${u.input_tokens.toLocaleString()} / 출력 ${u.output_tokens.toLocaleString()} 토큰` }]);
            break;
          }
          case "error":
            setMessages((prev) => [...prev, { kind: "error", text: String(data.message) }]);
            break;
          case "notice":
            setMessages((prev) => [...prev, { kind: "notice", text: String(data.message) }]);
            break;
        }
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setMessages((prev) => [...prev, { kind: "error", text: String(err) }]);
    } finally {
      setBusy(false);
      onBusy?.(false);
      abort.current = null;
    }
  }

  return (
    <section className="panel chat" aria-label="AI 채팅">
      <h2>AI와 대화하며 고치기</h2>
      {activeSelection && (
        <div className="selection-chip" role="status">
          <span>선택한 부분 ({activeSelection.segments}토막): {activeSelection.text.slice(0, 60)}{activeSelection.text.length > 60 ? "…" : ""}</span>
          <button type="button" className="link" onClick={() => setSelectionOff(activeSelection.text)} aria-label="선택을 대상에서 빼기">
            ×
          </button>
        </div>
      )}
      {!storedKey ? (
        <form onSubmit={saveKey} className="tool-form">
          <p className="muted">
            <a href={KEY_DOCS} target="_blank" rel="noreferrer">
              core.today
            </a>
            에서 발급한 API 키(cdt_…)를 넣으세요. 키는 이 브라우저에만 저장되고 서버는 요청을 전달할 때만 씁니다.
          </p>
          <label>
            <span>CDT_API_KEY</span>
            <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="cdt_…" autoComplete="off" aria-label="core.today API 키" />
          </label>
          <button type="submit" disabled={!keyInput.trim()}>
            키 저장·확인
          </button>
          {keyStatus && <p className={keyStatus.error ? "is-error" : "muted"}>{keyStatus.text}</p>}
        </form>
      ) : (
        <>
          <div className="row chat-settings">
            <select className="chat-model" value={model} onChange={(e) => setStoredModel(e.target.value)} aria-label="모델">
              {!current && <option value={model}>{model}</option>}
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.models.map((m) => (
                    <option key={m.id} value={m.id} title={m.id}>
                      {m.label}
                      {m.note ? ` · ${m.note}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" className="link" onClick={clearHistory} disabled={busy || messages.length === 0}>
              새 대화
            </button>
            <button type="button" className="link" onClick={clearKey}>
              키 지우기
            </button>
          </div>
          {current && (
            <p className="muted chat-model-info">
              {current.id}
              {current.input_per_1k !== undefined && current.output_per_1k !== undefined ? ` · 1K 토큰당 입력 ${fmtCredit(current.input_per_1k)} · 출력 ${fmtCredit(current.output_per_1k)} 크레딧` : ""}
              {current.verified === false ? " · 앱의 도구 호출은 확인하지 않은 모델" : ""}
            </p>
          )}
          {keyStatus && <p className={keyStatus.error ? "is-error" : "muted"}>{keyStatus.text}</p>}
          <div className="chat-log" ref={logRef} aria-live="polite">
            {messages.length === 0 && <p className="muted">예: &quot;2번 문단을 더 짧게 다듬어줘&quot;, &quot;표 1에 합계 행을 넣어줘&quot;. AI는 도구로 문서를 읽고 고치며, 편집은 리비전으로 남습니다.</p>}
            {messages.map((m, i) => {
              switch (m.kind) {
                case "user":
                  return (
                    <div key={i} className="msg user">
                      {m.text}
                    </div>
                  );
                case "assistant":
                  return (
                    <div key={i} className="msg assistant">
                      {m.text}
                    </div>
                  );
                case "tool":
                  return (
                    <details key={i} className={`msg tool ${m.ok === false ? "is-error" : ""}`} data-testid="chat-tool">
                      <summary>
                        도구 {m.name} {m.ok === undefined ? "실행 중…" : m.ok ? "✓" : "✗"}
                      </summary>
                      <pre className="result">{JSON.stringify(m.args, null, 1)}</pre>
                      {m.result && <pre className="result">{m.result}</pre>}
                    </details>
                  );
                case "error":
                  return (
                    <div key={i} className="msg is-error">
                      {m.text}
                    </div>
                  );
                case "usage":
                case "notice":
                  return (
                    <div key={i} className="msg muted small">
                      {m.text}
                    </div>
                  );
              }
            })}
          </div>
          <form onSubmit={send} className="row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); // 한글 조합 중 Enter는 전송하지 않는다
              }}
              placeholder="무엇을 고칠까요?"
              aria-label="AI에게 보낼 글"
              disabled={busy}
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>
                중단
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                보내기
              </button>
            )}
          </form>
        </>
      )}
    </section>
  );
}

