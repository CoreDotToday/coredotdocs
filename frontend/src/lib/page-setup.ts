// 편집 용지(쪽 설정) 대화상자의 값 다루기. 고치기는 도구 set_page_setup (backend/app/engine/pagesetup.py).

/** 메뉴에서 Word 문서의 편집 용지를 여는 창 이벤트 (detail.tabId) */
export const PAGE_SETUP_EVENT = "coredotdocs:page-setup";

export const PAPERS: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A5: [148, 210], B4: [257, 364], B5: [182, 257], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
export const PAGE_EDGES = [
  ["top", "위"],
  ["bottom", "아래"],
  ["left", "왼쪽"],
  ["right", "오른쪽"],
] as const;
export type PageSetupForm = { paper: string; width: string; height: string; landscape: boolean; top: string; bottom: string; left: string; right: string; header: string; footer: string; gutter: string };

/** 폼 → 도구 인자. 값이 틀리면 고칠 말을 돌려준다 (도구 스키마와 같은 범위) */
export function pageSetupArgs(f: PageSetupForm): Record<string, unknown> | string {
  const num = (v: string, label: string, min = 0, max = 200) => {
    const x = Number(v.trim().replace(",", "."));
    if (!v.trim() || !Number.isFinite(x) || x < min || x > max) throw new Error(`${label} 값은 ${min}~${max}mm 숫자로 넣어 주세요.`);
    return x;
  };
  try {
    const args: Record<string, unknown> = { orientation: f.landscape ? "landscape" : "portrait" };
    if (f.paper === "custom") {
      args.width_mm = num(f.width, "용지 너비", 50, 1000);
      args.height_mm = num(f.height, "용지 높이", 50, 1000);
    } else args.paper = f.paper;
    args.margins_mm = Object.fromEntries(PAGE_EDGES.map(([k, label]) => [k, num(f[k], `${label} 여백`)]));
    args.header_mm = num(f.header, "머리말");
    args.footer_mm = num(f.footer, "꼬리말");
    args.gutter_mm = num(f.gutter, "제본");
    return args;
  } catch (e) {
    return (e as Error).message;
  }
}

