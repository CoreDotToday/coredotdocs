# apps/docs/src/renderer — 출처

GenOffice `apps/docs/src/renderer/`(커밋 `8ab58a51433577a1317af4206137cee425b86606`, 2026-10-23)에서 **편집기 핵심만** 처음 복사한 뒤 coredotdocs 통합에 맞게 보완했다.
가져온 범위 = `editor/extensions.ts`·`editor/convert.ts`·페이지네이션(`pagination-*.ts`, `editor/pagination-gaps.ts`)·`page-margins.ts`·`doc-state.ts`·`hf-sections.ts`·`editor/local-edit.ts`에서
상대 가져오기로 닿는 파일의 닫힘(132개) + `i18n/` 전체 + `fonts/stand-in-boxes.json` + `styles.css` + `ai/redact.ts` + 문서 스타일 시트 `doc-style-css.ts`·`hf-phantom.ts`(2026-10-24).
최초 가져온 목록은 `FILES.txt`. 이후 통합·인쇄·외부 그림 차단 변경은 Git 이력과 아래 설명을 참고한다.

가져오지 않은 것: `App.tsx`(리본·대화상자·파일 메뉴·AI 패널을 묶은 8,400줄), `components/`, `ai/`(가리기 표식 상수 파일 하나 제외), `mail-merge/`, `zotero/`, `main/`·`preload/`(Electron),
`fonts/`의 글꼴 파일(12MB; 시스템 글꼴을 쓴다), `env.d.ts`(preload 타입).

## 통합 파일과 각색 범위

| 파일 | 역할 |
|---|---|
| `../shims/ui.ts` | `@genoffice/ui` 대신: 복사한 `font-list.ts`·`wordart-presets.ts`만 다시 내보냄 |
| `../shims/docx-engine.ts` | `@genoffice/docx-engine` 입구: 가져온 커밋의 index.ts가 빠뜨린 resolve-props 내보내기를 보탬 |
| `../shims/env.d.ts` | `window.desktop` 중 쓰는 두 멤버만 선언 |
| `cdd-canvas-pagination.ts` | **각색(Apache-2.0 파생)**: `App.tsx`의 머리말/꼬리말 높이(3296–3470행)와 캔버스 페이지네이션 effect(3688–4900행)를 함수로 줄인 것 — 구역별 쪽 나누기, 쪽 사이 띠의 머리말·꼬리말(쪽 번호), 첫 쪽 머리말·끝 쪽 꼬리말, keepNext·표 행 규칙, 행 채우기·넘치는 줄·떠 있는 표. 머리말 편집·쪽 아래 각주 영역·여러 단·세로 쓰기·빠른 길은 뺐다 |

## 경계

- 우리 코드는 `frontend/src/lib/docx-editor.ts`에서만 `@genoffice/apps/docs/src/renderer/*`를 가져온다.
- 번들은 `frontend/vendor/genoffice-docx/apps/docs/src/renderer/`(sync-genoffice.mjs가 복사; `styles.css`는 `.cdd-docx` 아래로 범위를 좁힌 `styles.scoped.css`로 변환)에서 읽는다.

## 로컬 보완

CoreDotToday(2026)는 편집기 수명주기와 페이지네이션·인쇄 연결을 각색하고, 외부 그림의 자동 네트워크 요청을 제한했다. `cdd-canvas-pagination.ts`는 위에서 명시한 GenOffice 파생 코드이며 Apache-2.0 고지 대상이다. 독립적으로 작성한 shim과 파생 코드의 구분은 위 표를 따른다.
