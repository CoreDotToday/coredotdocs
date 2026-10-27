"use client";

import { useEffect, useRef, useState } from "react";
import { api, type SearchHit } from "@/lib/api";

export function FindPanel({ documentId, onJump }: { documentId: string; onJump: (blockNo: number) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+F / ⌘F → 브라우저 기본 찾기 대신 문서 찾기 패널로
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setStatus("찾는 중…");
    try {
      const res = await api.search(q, documentId);
      setHits(res.hits);
      setTruncated(res.truncated);
      setStatus(res.hits.length ? `${res.hits.length}곳` : "찾지 못했습니다");
    } catch (err) {
      setStatus(String(err));
    }
  }

  return (
    <section className="panel">
      <h2>찾기 <small className="muted">Ctrl+F</small></h2>
      <form onSubmit={run} className="row">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="찾을 글 (Ctrl+F · 글자 그대로, 대소문자 무시)" maxLength={500} aria-label="찾을 글" />
        <button type="submit">찾기</button>
      </form>
      <p className="muted">{status}</p>
      <ul className="hits">
        {hits.map((h, i) => (
          <li key={i}>
            <button type="button" className="link" onClick={() => onJump(h.block_no)}>
              [{h.block_no}]{h.where ? ` ${h.where}` : ""}
            </button>{" "}
            …{h.before}
            <mark>{h.match}</mark>
            {h.after}…
          </li>
        ))}
      </ul>
      {truncated && <p className="muted">결과가 더 있습니다. 질의를 더 길게 주세요.</p>}
    </section>
  );
}
