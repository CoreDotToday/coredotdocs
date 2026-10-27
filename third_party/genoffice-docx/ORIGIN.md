# 출처 (ORIGIN)

| 항목 | 값 |
|---|---|
| 원본 저장소 | https://github.com/genspark-ai/genoffice (GenOffice, Mainfunc, Inc.) |
| 라이선스 | Apache-2.0 (`LICENSE`), 원본 NOTICE는 `NOTICE-upstream`. `ee/`(GenOffice Enterprise License)는 가져오지 않았다 |
| 가져온 커밋 | `8ab58a51433577a1317af4206137cee425b86606` (2026-10-23) |
| 가져온 날짜 | 2026-10-23 |

## 가져온 파일과 원본 경로

| 이 폴더 | 원본 경로 | 용도 |
|---|---|---|
| `packages/docx-engine/` (src·tests·scripts·package.json·tsconfig·vitest.config) | `packages/docx-engine/` | `parseDocx` → Block 나무, `saveDocx` paragraph-patch 저장, OOXML 생성 |
| `packages/zip-gate/` | `packages/zip-gate/` | docx-engine이 쓰는 zip 폭탄 게이트 |
| `tsconfig.base.json` | `tsconfig.base.json` | 패키지 tsconfig가 extends하는 공통 설정 (자체 테스트 실행용) |
| `packages/agent-core/src/redact-range.ts`, `package.json` | `packages/agent-core/` | docx-engine이 가져오는 가리기(redact) 표식 상수 (그 밖의 agent-core는 가져오지 않음) |
| `packages/pptx-engine/src/{chart-workbook,custgeom,crc32,xml-utils,types,chart,theme,color}.ts`, `package.json` | `packages/pptx-engine/` | docx-engine이 가져오는 차트 워크북·사용자 도형 기하(`types.ts`가 참조하는 `chart`·`theme`·`color` 포함; 그 밖은 가져오지 않음) |
| `apps/docs/src/renderer/` | `apps/docs/src/renderer/` 일부 | D3: Tiptap 편집기 확장·변환(`editor/`)·페이지네이션·글꼴 측정 (가져온 범위는 `apps/docs/src/renderer/ORIGIN.md`) |

추가(2026-10-24): `apps/docs/tests/truths.test.ts`(pure truths 실행기, 그대로), `apps/docs/src/renderer/doc-style-css.ts`·`hf-phantom.ts`(그대로).

## 경계 (설계 문서 04 §9.3-1, §12)

- 우리 코드는 이 폴더를 `@genoffice/docx-engine`·`@genoffice/apps/docs/src/renderer/*` 모듈 이름으로만 가져오며, 그 가져오기는 `frontend/src/lib/docx-engine.ts`·`frontend/src/lib/docx-editor.ts`(우리 래퍼)에만 둔다.
  `scripts/check-third-party.mjs`가 다른 곳의 `@genoffice/`·`genoffice` 언급을 막는다.
- 이 폴더의 코드는 coredotdocs의 다른 코드를 import하지 않는다.
- Next.js 번들은 `frontend/scripts/sync-genoffice.mjs`가 `packages/*/src`·`apps/docs/src/renderer`를 `frontend/vendor/genoffice-docx/`(git 무시, 빌드 산출물)로 복사한 것을 tsconfig `paths`로 읽는다.
  `@genoffice/*` 안의 서로 가져오기(zip-gate·agent-core/redact-range·pptx-engine/…)도 같은 `paths`로 푼다.
- 엔진 자체 테스트와 Word 실측 truths 중 pure 등급(`apps/docs/tests/truths.test.ts`, 그대로 복사)은 이 폴더 안에서 그대로 돈다: `cd frontend && pnpm test:genoffice`.
- 상위(GenOffice)의 개선을 다시 받아올 때는 위 표의 파일을 다시 복사하고 커밋 해시를 갱신한다 (아래 로컬 변경과 Git diff를 확인하고 필요한 패치를 다시 적용한다).

## coredotdocs의 변경 (2026)

- renderer 통합·페이지네이션·인쇄 및 보안 경계는 원본을 각색하거나 보완했다. 상세 범위는 renderer/ORIGIN.md와 Git 이력에 기록한다.
- `packages/docx-engine/tests/metafile-render.test.ts`는 Apache POI 문서에서 추출했던 그림 대신 자체 생성한 기하 도형을 사용한다. `scripts/generate-public-test-fixtures.mjs`로 4개 EMF/WMF와 머리말 그림 테스트용 PNG를 재생성한다. 기존 아이콘과 출처가 불명확한 로고는 배포 소스에서 제거했다.
- `tests/fixtures/truths/render-hf-inline-picture/probe.docx`의 그림 내용만 원본 크기의 체크무늬로 바꿨다. 레이아웃 XML과 테스트의 기하 조건은 유지한다. 단색 파란 사각형 fixture는 유지한다.
- `tests/field-display.test.ts`와 `tests/merge-field.test.ts`의 연락처·회사 도메인을 `example.invalid` 합성 값으로 바꿨다. HYPERLINK 캐시 텍스트와 MERGEFIELD 관계의 회귀 조건은 유지한다.
- 가져온 코드의 Apache-2.0 저작권·LICENSE·NOTICE 및 EMF 변환기의 독립 LICENSE는 유지한다.
