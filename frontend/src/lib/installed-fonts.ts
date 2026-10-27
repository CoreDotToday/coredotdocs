// 설치된 글꼴(데스크톱). 메인 프로세스가 글꼴 파일을 직접 읽어 준다(desktop/fonts.js) — 화면의 queryLocalFonts는 한글 탭이 많으면
// 줄을 서서 끝나지 않는다(관측). 창 하나에 한 번만 묻고 모든 편집기(HWPX·DOCX)의 서식 막대가 나눠 쓴다. 웹판은 null.
import { useEffect, useState } from "react";
import { api } from "./api";
import { desktopBridge, type InstalledFont } from "./desktop";

let cache: InstalledFont[] | null = null;
let inflight: Promise<InstalledFont[] | null> | null = null;

export function installedFonts(): Promise<InstalledFont[] | null> {
  if (cache) return Promise.resolve(cache);
  const list = desktopBridge()?.listFonts;
  if (!list) return Promise.resolve(null);
  inflight ??= list()
    .then((fonts) => {
      if (!fonts.length) return null;
      cache = fonts;
      // 서버(AI 도구)도 알아야 한다: "에이투지체" → 가족명 "A2Z"로 적고, list_fonts로 목록을 보여 준다. 실패해도 편집은 된다.
      api.postFonts(fonts.map((f) => ({ family: f.family, localized: f.localized }))).catch(() => undefined);
      return fonts;
    })
    .catch(() => null)
    .finally(() => (inflight = null));
  return inflight;
}

/** 서식 막대용: undefined = 읽는 중, null = 쓸 수 없음(웹판·실패), 배열 = 설치 글꼴 */
export function useInstalledFonts(): InstalledFont[] | null | undefined {
  const [fonts, setFonts] = useState<InstalledFont[] | null | undefined>(() => cache ?? undefined);
  useEffect(() => {
    if (cache) return;
    let alive = true;
    void installedFonts().then((f) => alive && setFonts(f));
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}

/** 목록에 보일 이름: 한국어 이름이 있으면 "한국어 (영문)" */
export function fontLabel(f: InstalledFont): string {
  return f.localized ? `${f.localized} (${f.family})` : f.family;
}
