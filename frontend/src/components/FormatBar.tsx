"use client";

// 서식 막대: 글꼴·크기·배율·굵게/기울임/밑줄/취소선·글자색·형광펜·정렬·줄 간격을 바로 고친다.
// 편집기 종류를 가리지 않는다(FormatSource): HWPX는 자체 빌드 스튜디오의 명령 문맥(`format`)과 `format:set-char`/`format:set-para`(우리 패치),
// DOCX는 Tiptap 편집기의 마크·문단 속성. 상태는 캐럿이 움직일 때마다 짧게 폴링해 읽는다 — 선택이 없으면 다음 타이핑부터(대기 서식).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktop } from "@/lib/desktop";
import type { FormatSource } from "@/lib/format-source";
import { fontLabel, useInstalledFonts } from "@/lib/installed-fonts";
import { useShell } from "@/lib/shell";
import { FONT_SIZES, LINE_SPACINGS, ZOOM_LEVELS, fontGroups, type StudioContext } from "@/lib/studio";

const POLL_MS = 400; // 캐럿 서식은 커서가 움직일 때마다 바뀐다 — 한 번의 postMessage 왕복이라 값싸다
const ALIGNS: { id: "left" | "center" | "right" | "justify"; label: string; title: string }[] = [
  { id: "left", label: "≡", title: "왼쪽 정렬 (Ctrl+Shift+L)" },
  { id: "center", label: "☰", title: "가운데 정렬 (Ctrl+Shift+C)" },
  { id: "right", label: "≡", title: "오른쪽 정렬 (Ctrl+Shift+R)" },
  { id: "justify", label: "☰", title: "양쪽 정렬 (Ctrl+Shift+M)" },
];

export function FormatBar({ source, active }: { source: FormatSource | null; active: boolean }) {
  const studio = source; // 아래 코드는 편집기 종류를 모른다
  const shell = useShell();
  const [ctx, setCtx] = useState<StudioContext | null>(null);
  const [sizeText, setSizeText] = useState(""); // 입력 중인 크기(확정 전)
  const sizeFocused = useRef(false);
  const last = useRef("");
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!studio || busy.current) return;
    busy.current = true;
    try {
      const c = await studio.read();
      const key = JSON.stringify(c);
      if (key !== last.current) {
        last.current = key;
        setCtx(c);
        if (!sizeFocused.current) setSizeText(c.format?.fontSize !== undefined ? trimPt(c.format.fontSize / 100) : "");
      }
    } catch {
      /* 스튜디오가 아직 없거나 닫히는 중 */
    } finally {
      busy.current = false;
    }
  }, [studio]);

  useEffect(() => {
    if (!studio || !active) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      last.current = ""; // 다음 편집기·탭이 새로 읽는다 (그때까지는 아래서 숨긴다)
    };
  }, [studio, active, refresh]);

  const run = useCallback(
    async (job: () => Promise<void>) => {
      if (!studio) return;
      try {
        await job();
      } catch (err) {
        shell.notify(`서식을 바꾸지 못했습니다: ${String(err)}`, "error");
      }
      last.current = ""; // 바로 다시 읽는다
      void refresh();
    },
    [studio, shell, refresh],
  );

  const shown = studio && active ? ctx : null; // 스튜디오가 바뀌면 새로 읽을 때까지 옛 상태를 보이지 않는다
  const fmt = shown?.format ?? null;
  const enabled = !!studio && !!shown?.hasDocument;
  // 설치 글꼴: 데스크톱은 메인 프로세스가 읽은 목록(installed-fonts.ts)에 편집기가 따로 감지한 것을 더한다
  const installed = useInstalledFonts();
  const labels = useMemo(() => new Map((installed ?? []).filter((f) => f.localized).map((f) => [f.family, fontLabel(f)])), [installed]);
  const fonts = useMemo(
    () => fontGroups(shown?.documentFonts ?? [], [...(installed ?? []).map((f) => f.family), ...(shown?.localFonts ?? [])], fmt?.fontFamily, labels),
    [shown?.documentFonts, shown?.localFonts, fmt?.fontFamily, installed, labels],
  );
  const LOAD_SYSTEM = "\u0000load-system-fonts";
  const zoomPct = Math.round((shown?.zoom ?? 1) * 100);
  const keepFocus = (e: React.MouseEvent) => e.preventDefault(); // 단추를 눌러도 초점은 편집기에 남는다

  function applySize(text: string) {
    const pt = parseFloat(text);
    if (!studio || !Number.isFinite(pt) || pt <= 0) return setSizeText(fmt?.fontSize !== undefined ? trimPt(fmt.fontSize / 100) : "");
    void run(() => studio.setChar({ fontSizePt: pt }));
  }
  function stepSize(delta: number) {
    const cur = fmt?.fontSize !== undefined ? fmt.fontSize / 100 : parseFloat(sizeText) || 10;
    applySize(String(Math.max(1, Math.round((cur + delta) * 2) / 2)));
  }

  return (
    <div className={`formatbar ${enabled ? "" : "is-off"}`} role="toolbar" aria-label="서식 막대">
      <select
        className="fb-font"
        title="글꼴"
        aria-label="글꼴"
        value={fmt?.fontFamily ?? ""}
        disabled={!enabled || !fmt}
        onChange={(e) => {
          if (!studio || !e.target.value) return;
          if (e.target.value === LOAD_SYSTEM) return void run(() => studio.detectFonts?.(true) ?? Promise.resolve()); // 사용자 동작 안: 브라우저가 허락을 묻는다
          void run(() => studio.setChar({ fontName: e.target.value }));
        }}
      >
        {!fmt?.fontFamily && <option value="">글꼴</option>}
        <FontOptions label="문서 글꼴" names={fonts.document} />
        {fonts.system.length > 0 ? (
          <FontOptions label={`설치된 글꼴 (${fonts.system.length})`} names={fonts.system} labels={labels} />
        ) : isDesktop() ? (
          <option value="" disabled>
            {installed === undefined ? "설치된 글꼴 읽는 중…" : "설치된 글꼴을 읽지 못했습니다"}
          </option>
        ) : !studio?.detectFonts ? null : (
          <option value={LOAD_SYSTEM}>설치된 글꼴 불러오기…</option>
        )}
        <FontOptions label="기본 글꼴" names={fonts.basic} />
      </select>
      <span className="fb-size">
        <input
          type="text"
          inputMode="decimal"
          list="fb-sizes"
          title="글자 크기 (pt)"
          aria-label="글자 크기"
          value={sizeText}
          disabled={!enabled || !fmt}
          onFocus={(e) => {
            sizeFocused.current = true;
            e.target.select();
          }}
          onBlur={(e) => {
            sizeFocused.current = false;
            applySize(e.target.value);
          }}
          onChange={(e) => setSizeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setSizeText(fmt?.fontSize !== undefined ? trimPt(fmt.fontSize / 100) : "");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <datalist id="fb-sizes">
          {FONT_SIZES.map((n) => (
            <option key={n} value={String(n)} />
          ))}
        </datalist>
        <span className="fb-unit">pt</span>
        <span className="fb-steps">
          <button type="button" tabIndex={-1} title="글자 크게" aria-label="글자 크게" disabled={!enabled || !fmt} onMouseDown={keepFocus} onClick={() => stepSize(1)}>
            ▴
          </button>
          <button type="button" tabIndex={-1} title="글자 작게" aria-label="글자 작게" disabled={!enabled || !fmt} onMouseDown={keepFocus} onClick={() => stepSize(-1)}>
            ▾
          </button>
        </span>
      </span>
      <select className="fb-zoom" title="화면 배율" aria-label="화면 배율" value={ZOOM_LEVELS.includes(zoomPct) ? String(zoomPct) : ""} disabled={!enabled} onChange={(e) => studio && e.target.value && run(() => studio.zoom(Number(e.target.value)))}>
        {!ZOOM_LEVELS.includes(zoomPct) && <option value="">{zoomPct}%</option>}
        {ZOOM_LEVELS.map((z) => (
          <option key={z} value={String(z)}>
            {z}%
          </option>
        ))}
      </select>
      <span className="fb-group">
        <Toggle label="가" cls="b" title="굵게 (Ctrl+B)" on={!!fmt?.bold} disabled={!enabled} onClick={() => studio && run(() => studio.toggle("bold"))} />
        <Toggle label="가" cls="i" title="기울임 (Ctrl+I)" on={!!fmt?.italic} disabled={!enabled} onClick={() => studio && run(() => studio.toggle("italic"))} />
        <Toggle label="가" cls="u" title="밑줄 (Ctrl+U)" on={!!fmt?.underline} disabled={!enabled} onClick={() => studio && run(() => studio.toggle("underline"))} />
        <Toggle label="가" cls="s" title="취소선" on={!!fmt?.strikethrough} disabled={!enabled} onClick={() => studio && run(() => studio.toggle("strikethrough"))} />
      </span>
      <span className="fb-group">
        <label className="fb-color" title="글자색">
          <span className="fb-color-glyph">가</span>
          <span className="fb-color-bar" style={{ background: fmt?.textColor ?? "#000000" }} />
          <input type="color" aria-label="글자색" value={normalizeColor(fmt?.textColor) ?? "#000000"} disabled={!enabled || !fmt} onChange={(e) => studio && run(() => studio.setChar({ textColor: e.target.value }))} />
        </label>
        <label className="fb-color" title="형광펜">
          <span className="fb-color-glyph fb-hl">가</span>
          <span className="fb-color-bar" style={{ background: fmt?.shadeColor ?? "#ffff00" }} />
          <input type="color" aria-label="형광펜" value={normalizeColor(fmt?.shadeColor) ?? "#ffff00"} disabled={!enabled || !fmt} onChange={(e) => studio && run(() => studio.setChar({ shadeColor: e.target.value }))} />
        </label>
      </span>
      <span className="fb-group">
        {ALIGNS.map((a) => (
          <Toggle key={a.id} label={a.label} cls={`al-${a.id}`} title={a.title} on={fmt?.alignment === a.id} disabled={!enabled} onClick={() => studio && run(() => studio.align(a.id))} />
        ))}
      </span>
      <select className="fb-ls" title="줄 간격 (%)" aria-label="줄 간격" value={fmt?.lineSpacing !== undefined && LINE_SPACINGS.includes(Math.round(fmt.lineSpacing)) ? String(Math.round(fmt.lineSpacing)) : ""} disabled={!enabled || !fmt} onChange={(e) => studio && e.target.value && run(() => studio.setPara({ lineSpacing: Number(e.target.value) }))}>
        <option value="">{fmt?.lineSpacing !== undefined ? `줄 ${Math.round(fmt.lineSpacing)}%` : "줄 간격"}</option>
        {LINE_SPACINGS.map((n) => (
          <option key={n} value={String(n)}>
            줄 {n}%
          </option>
        ))}
      </select>
      {fmt?.pending && <span className="muted fb-note" title="선택한 글이 없어 다음에 입력하는 글부터 적용됩니다">다음 입력부터</span>}
      {shown && !fmt && shown.hasDocument && <span className="muted fb-note">이 편집기 빌드는 서식 읽기를 지원하지 않습니다</span>}
    </div>
  );
}

function FontOptions({ label, names, labels }: { label: string; names: string[]; labels?: ReadonlyMap<string, string> }) {
  if (names.length === 0) return null;
  return (
    <optgroup label={label}>
      {names.map((f) => (
        <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
          {labels?.get(f) ?? f}
        </option>
      ))}
    </optgroup>
  );
}

function Toggle({ label, cls, title, on, disabled, onClick }: { label: string; cls: string; title: string; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`tb fb-${cls} ${on ? "is-on" : ""}`} title={title} aria-label={title.replace(/\s*\(.*\)$/, "")} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {label}
    </button>
  );
}

function trimPt(pt: number): string {
  return Number.isInteger(pt) ? String(pt) : pt.toFixed(1).replace(/\.0$/, "");
}

/** `<input type=color>`는 #rrggbb만 받는다. */
function normalizeColor(c?: string): string | undefined {
  if (!c) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}
