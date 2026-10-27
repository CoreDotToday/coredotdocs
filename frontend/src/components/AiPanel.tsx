"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type Tool } from "@/lib/api";
import { describeEvent, parseArguments, schemaToFields, type EditorEvent } from "@/lib/format";

export function AiPanel({ documentId, events, onChanged }: { documentId: string; events: EditorEvent[]; onChanged: () => void }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [selected, setSelected] = useState<string>("read_document");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listTools().then((r) => setTools(r.tools)).catch(() => setTools([]));
  }, []);

  const tool = tools.find((t) => t.name === selected);
  const fields = useMemo(() => (tool ? schemaToFields(tool.inputSchema) : []), [tool]);

  async function call(e: React.FormEvent) {
    e.preventDefault();
    if (!tool) return;
    const { args, errors } = parseArguments(fields, { ...values, document_id: fields.some((f) => f.name === "document_id") ? documentId : "" });
    if (errors.length) {
      setResult({ text: errors.join("\n"), isError: true });
      return;
    }
    setBusy(true);
    try {
      const res = await api.callTool(tool.name, args);
      setResult({ text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError });
      if (!res.isError) onChanged();
    } catch (err) {
      setResult({ text: String(err), isError: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>AI 활동</h2>
      <ul className="activity" aria-label="AI 활동 로그">
        {events.length === 0 && <li className="muted">아직 활동이 없습니다. AI가 고치면 여기에 바로 보입니다.</li>}
        {events
          .slice(-30)
          .reverse()
          .map((e, i) => (
            <li key={i} className={e.type === "activity" && e.ok === false ? "is-error" : ""}>
              {describeEvent(e)}
            </li>
          ))}
      </ul>

      <h2>도구 콘솔</h2>
      <p className="muted">AI가 쓰는 것과 같은 도구를 사람이 직접 불러 봅니다. 입력은 서버의 JSON Schema로 검증됩니다.</p>
      <form onSubmit={call} className="tool-form">
        <select value={selected} onChange={(e) => (setSelected(e.target.value), setValues({}), setResult(null))} aria-label="도구">
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.title ?? t.name} ({t.name})
            </option>
          ))}
        </select>
        {tool && <p className="muted">{tool.description}</p>}
        {fields
          .filter((f) => f.name !== "document_id")
          .map((f) => (
            <label key={f.name}>
              <span>
                {f.name}
                {f.required ? " *" : ""} <small className="muted">{f.type}{f.min !== undefined ? ` ${f.min}~${f.max}` : ""}</small>
              </span>
              {f.type === "boolean" ? (
                <select value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                  <option value="">(생략)</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : f.type === "json" || (f.type === "string" && /markdown|text|replace/.test(f.name)) ? (
                <textarea rows={3} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} placeholder={f.description} />
              ) : (
                <input value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} placeholder={f.description} />
              )}
            </label>
          ))}
        <button type="submit" disabled={busy || !tool}>
          {busy ? "실행 중…" : "실행"}
        </button>
      </form>
      {result && <pre className={result.isError ? "result is-error" : "result"}>{result.text}</pre>}
    </section>
  );
}
