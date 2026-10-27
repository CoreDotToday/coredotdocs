# 출처 (ORIGIN)

| 항목 | 값 |
|---|---|
| 원본 저장소 | https://github.com/pblsketch/openoffice (IeumOffice, GenOffice 포크) |
| 라이선스 | Apache-2.0 (`LICENSE`), 원본 NOTICE는 `NOTICE-upstream` |
| 가져온 커밋 | `5fda8298a042318048a768e10fadadcc02a6d49c` (2026-10-22) |
| 가져온 날짜 | 2026-10-23 |

## 가져온 파일

| 이 폴더 | 원본 경로 | 바꾼 점 |
|---|---|---|
| `agent-plugin.mjs` | `apps/hwp/studio-plugin/agent-plugin.mjs` | 식별자만: `ieum-agent`→`coredotdocs-agent`, `ext:ieum-*`→`ext:cdd-*`, `ieum:file-command`→`cdd:file-command`, CSS 클래스 `ieum-change-marks`→`cdd-change-marks` |
| `agent-plugin.d.mts` | `apps/hwp/studio-plugin/agent-plugin.d.mts` | 같은 식별자 치환 |
| `rhwp-patches.mjs` | `apps/hwp/scripts/rhwp-patches.mjs` | 스킴 패치(`sdk-scheme`·`studio-scheme`) 제거(우리는 HTTP로 서빙), 플러그인 모듈 이름 `@coredotdocs/agent-plugin`, 플러그인 id |
| `build-studio.mjs` | `apps/hwp/scripts/build-studio.mjs` | 캐시·출력 경로를 coredotdocs 배치(`frontend/node_modules/.cache`, `frontend/public/rhwp`)로, 엔진은 npm `@rhwp/core` 0.8.7 |

## 경계 (설계 문서 04 §9.3-1)

- 우리 코드는 이 폴더를 두 진입점으로만 쓴다: 편집기 안 플러그인 `plugins.invoke("coredotdocs-agent", method, args)`와 빌드 `node third_party/ieumoffice-hwp/build-studio.mjs`.
- 이 폴더의 코드는 coredotdocs의 다른 코드를 import하지 않는다.
- `scripts/check-third-party.mjs`가 이 폴더 밖에 Apache 출처 표식·이음 식별자가 없는지 검사한다.
- 상위(IeumOffice)의 개선을 다시 받아올 때는 이 표의 "바꾼 점"만 다시 적용한다.
