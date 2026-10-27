"use client";

// 쪽 설정(편집 용지) 대화상자 — 용지 크기·방향·여백·머리말/꼬리말 거리. 고치기는 AI와 같은 도구 set_page_setup으로 서버가 하고
// (리비전으로 남아 되돌리기·AI 기록과 한 줄), 편집기는 새 리비전을 다시 읽어 쪽 모양을 바꾼다. 열기 전에 편집기의 타이핑을 먼저 올린다.
import { useEffect, useMemo, useState } from "react";
import { api, type PageSetup } from "@/lib/api";
import { PAGE_EDGES as EDGES, PAPERS, pageSetupArgs, type PageSetupForm as Form } from "@/lib/page-setup";

function toForm(s: PageSetup): Form {
  const n = (v: number) => String(Math.round(v * 10) / 10);
  return { paper: s.paper ?? "custom", width: n(s.width_mm), height: n(s.height_mm), landscape: s.orientation === "landscape", top: n(s.margins_mm.top), bottom: n(s.margins_mm.bottom), left: n(s.margins_mm.left), right: n(s.margins_mm.right), header: n(s.header_mm), footer: n(s.footer_mm), gutter: n(s.gutter_mm) };
}

export function PageSetupDialog({ documentId, flush, onClose, onApplied }: { documentId: string; flush: () => Promise<unknown>; onClose: () => void; onApplied: () => void }) {
  const [sections, setSections] = useState<PageSetup[] | null>(null);
  const [scope, setScope] = useState<number | "all">("all");
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await flush(); // 편집기의 타이핑을 먼저 올린다 (서버가 고친 뒤 편집기가 다시 읽는다)
        const r = await api.pageSetup(documentId);
        if (!alive) return;
        setSections(r.sections);
        if (r.sections[0]) setForm(toForm(r.sections[0]));
      } catch (e) {
        if (alive) setError(`쪽 설정을 읽지 못했습니다: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId, flush]);

  const body = useMemo(() => {
    if (!form) return null;
    const [w, h] = form.paper === "custom" ? [Number(form.width), Number(form.height)] : PAPERS[form.paper] ?? [0, 0];
    const [pw, ph] = form.landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
    const bw = pw - Number(form.left) - Number(form.right) - Number(form.gutter);
    const bh = ph - Number(form.top) - Number(form.bottom);
    return Number.isFinite(bw) && Number.isFinite(bh) ? { pw, ph, bw, bh } : null;
  }, [form]);

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const pickSection = (v: string) => {
    const next = v === "all" ? "all" : Number(v);
    setScope(next);
    const s = sections?.[next === "all" ? 0 : next - 1];
    if (s) setForm(toForm(s));
  };

  async function apply() {
    if (!form) return;
    const args = pageSetupArgs(form);
    if (typeof args === "string") return setError(args);
    setBusy(true);
    setError(null);
    try {
      await flush();
      const res = await api.callTool("set_page_setup", { document_id: documentId, ...(scope === "all" ? {} : { section: scope }), ...args });
      const text = res.content?.[0]?.text ?? "";
      if (res.isError) return setError(text.replace(/^오류\[[A-Z_]+\]\s*/, ""));
      onApplied();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cdd-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="cdd-page-setup"
        role="dialog"
        aria-label="편집 용지"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <h2>편집 용지</h2>
        {!form ? (
          <p className="muted">{error ?? "쪽 설정을 읽는 중…"}</p>
        ) : (
          <>
            {sections && sections.length > 1 && (
              <label className="ps-row">
                적용 범위
                <select value={String(scope)} onChange={(e) => pickSection(e.target.value)} aria-label="적용 범위">
                  <option value="all">문서 전체 ({sections.length}개 구역)</option>
                  {sections.map((s) => (
                    <option key={s.section} value={s.section}>
                      구역 {s.section}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset>
              <legend>용지</legend>
              <div className="ps-grid">
                <label>
                  종류
                  <select value={form.paper} onChange={(e) => set({ paper: e.target.value })} aria-label="용지 종류">
                    {Object.keys(PAPERS).map((p) => (
                      <option key={p} value={p}>
                        {p} ({PAPERS[p][0]}×{PAPERS[p][1]}mm)
                      </option>
                    ))}
                    <option value="custom">사용자 정의</option>
                  </select>
                </label>
                <div className="ps-orient" role="radiogroup" aria-label="용지 방향">
                  <label>
                    <input type="radio" name="orient" checked={!form.landscape} onChange={() => set({ landscape: false })} /> 세로
                  </label>
                  <label>
                    <input type="radio" name="orient" checked={form.landscape} onChange={() => set({ landscape: true })} /> 가로
                  </label>
                </div>
                {form.paper === "custom" && (
                  <>
                    <MmField label="너비" value={form.width} onChange={(v) => set({ width: v })} />
                    <MmField label="높이" value={form.height} onChange={(v) => set({ height: v })} />
                  </>
                )}
              </div>
            </fieldset>
            <fieldset>
              <legend>용지 여백</legend>
              <div className="ps-grid">
                {EDGES.map(([k, label]) => (
                  <MmField key={k} label={label} value={form[k]} onChange={(v) => set({ [k]: v } as Partial<Form>)} autoFocus={k === "top"} />
                ))}
                <MmField label="머리말" value={form.header} onChange={(v) => set({ header: v })} />
                <MmField label="꼬리말" value={form.footer} onChange={(v) => set({ footer: v })} />
                <MmField label="제본" value={form.gutter} onChange={(v) => set({ gutter: v })} />
              </div>
            </fieldset>
            {body && (
              <p className={body.bw < 20 || body.bh < 20 ? "is-error" : "muted"}>
                용지 {round(body.pw)}×{round(body.ph)}mm · 본문 {round(body.bw)}×{round(body.bh)}mm
              </p>
            )}
            {error && <p className="is-error">{error}</p>}
          </>
        )}
        <div className="cdd-note-actions">
          <button type="button" className="tb" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="tb is-on" disabled={!form || busy}>
            {busy ? "바꾸는 중…" : "설정"}
          </button>
        </div>
      </form>
    </div>
  );
}

function round(v: number) {
  return Math.round(v * 10) / 10;
}

function MmField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label>
      {label}
      <span className="ps-mm">
        <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} (mm)`} autoFocus={autoFocus} onFocus={(e) => e.target.select()} />
        mm
      </span>
    </label>
  );
}
