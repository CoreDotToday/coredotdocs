# 이음오피스(openoffice)·한글의 달인(master-of-hwp) 분석과 coredotdocs 반영 계획

작성일 2026-10-22. §1~§7은 이음오피스, §8은 한글의 달인, **§9가 두 프로젝트를 종합한 최종 방향**이다.

분석 대상 1: IeumOffice 저장소 — GenOffice(Apache-2.0, Mainfunc, Inc.)의 포크 **IeumOffice 0.12.3**. 워드·엑셀·파워포인트·PDF·마크다운·HTML·마인드맵·**한글(HWP·HWPX)** 편집기를 Electron 한 창에 넣은 AI 오피스. 한글 편집기는 우리와 같은 **rhwp 0.8.7 + rhwp-studio + `@rhwp/editor` 0.8.7**을 쓰므로 직접 비교가 된다.

읽은 것: `CLAUDE.md`/`AGENTS.md`, `docs/{architecture,contracts,business-rules,security}.md`, 결정 기록 0001~0052(특히 한글 0021~0028·0050), `docs/tracking/{status,findings}.md`, `apps/hwp`·`packages/{agent-core,ai-provider,ui,ai-search,project-store,file-parse,cli,docx-engine,zip-gate,electron-utils}`·`apps/shell`·`apps/docs` 소스(서브에이전트 4건, 총 262회 파일 열람), 그리고 우리 쪽 `@rhwp/editor` 타입 선언과 공개 rhwp-studio 번들.

표기: **[확인]** 코드·문서에서 직접 본 것, **[추론]** 그로부터 유추한 것, **[미확인]** 우리 쪽에서 아직 재현·검증하지 않은 것.

---

## 0. 결론 먼저

1. **가장 큰 구조 차이는 "AI가 어느 문서를 고치느냐"다.** 이음오피스는 편집기 안의 **살아 있는 문서**를 자체 플러그인으로 고친다(변경 하나 = 실행 취소 한 단계, 바뀐 자리로 화면 이동, 쪽 위 표시). 우리는 FastAPI의 HWPX XML을 고치고 편집기를 다시 읽는다(리비전·외부 MCP·웹에는 강하지만, 편집기 실행 취소·커서·선택이 끊긴다). 이음오피스는 이 방식을 "택하지 않은 것"으로 기록했다(결정 0022) [확인].
2. **그 방식은 공개 rhwp-studio 빌드로는 불가능하다.** 공개 번들은 플러그인 `hwpctrl` 하나만 허용한다(`허용되지 않은 플러그인` 예외) [확인, 우리 `public/rhwp` 번들에서 직접 확인]. 이음오피스는 rhwp-studio 소스를 받아 **직접 빌드**하면서 패치 5묶음(스킴 허용·암호 플래그·플러그인 허용·표 안 표 지우기)을 건다 [확인].
3. **그래서 반영은 3층으로 나눈다.** (A) 공개 빌드 그대로 가능한 것(즉시), (B) 스튜디오 자체 빌드로 열리는 것(핵심 투자), (C) 선택·장기(DOCX WYSIWYG, CLI, 구독 CLI 경로).
4. **우리가 지켜야 할 강점**: 외부 MCP 클라이언트(Claude Desktop·Claude Code·Codex)가 **HWPX를 고칠 수 있다**는 점(이음오피스의 한글 MCP는 읽기 전용 [확인]), 서버 리비전·되돌리기·SSE, 웹판, core.today 게이트웨이의 사용자 키. B층은 이것을 버리지 않고 **"편집기가 열려 있으면 편집기가 실행, 아니면 서버가 실행"**의 혼합으로 설계한다.
5. **라이선스**: Apache-2.0이므로 코드 이식은 허용되고 NOTICE·출처 표시만 남기면 된다. 아래에서 "이식(Apache 출처 표시)"과 "동작만 보고 재구현" 중 무엇을 택할지 항목마다 표시했다. 결정은 사용자 몫이다.

---

## 1. 구조 대조표

| 영역 | 이음오피스 [확인] | coredotdocs 지금 | 격차 |
|---|---|---|---|
| 편집기 | rhwp-studio를 소스에서 자체 빌드, `createEditor(…?chrome=embed&lang=ko)`, 엔진은 `vendor/rhwp-core` 0.8.7-ieum.3(조판 패치 9개, 저장 바이트 불변) | 공개 GitHub Pages 빌드 미러링, `createStudio(chrome:{menu:false,toolbar:false})`, npm `@rhwp/core` 0.8.7 | 플러그인·패치 불가, `chrome=embed` 미사용 |
| 변경 감지 | `commands.context().isDirty` 400ms 폴링 + 입력 이벤트 후 50ms 확인. `getDocumentState()`는 전체 해시라 큰 문서에서 ~1초 걸려 쓰지 않음 | `getDocumentState().changeSeq` 1.2초 폴링 → `exportHwpx` → 서버 리비전 | 큰 문서 성능, 1.2초 경합 |
| 저장 | 3단계(begin/export/commit). HWP는 `exportHwpVerify`(재읽기·쪽수 비교) 통과 후만, 매직 바이트(OLE/ZIP) 검사, 첫 덮어쓰기 전 `.bak`, 암호 문서 저장 거절, HWP 바이트 보정 3종(탭 폭·필드 종류·바탕쪽/메모/수식 캡션) | `exportHwpx`→`pushRevision`, 데스크톱 `saveFile` 임시파일+rename, 서버 `load_document` 검증 | 검증·백업·HWP 보정 없음 |
| AI 편집 | 편집기 안 플러그인(3,972줄) 호출. 도구 30여 개(글자 찍어 바꾸기·문단·표 칸/행/열·합치기·서식·누름틀·각주·차례·선택 범위). 글자로 자리 지정, 중복이면 거절하고 후보 반환. 변경 전후 개체 수·누름틀 값 비교(`keepingObjects`) | 서버 lxml 도구 13개(블록 번호 지정), 리비전 되돌리기 | 살아 있는 문서 편집, 되돌리기 1단계, 표시·이동 |
| AI 루프 | `agent-core`: 인자 검증·강제변환, 폭주 차단(동일 턴 3회·전부 실패 8턴·불량 인자 3회·100턴), 실패 실행 이력 롤백, `verifyResponse`, 256KB 압축, 첫 변경 전 스냅샷 | ChatPanel에서 게이트웨이 호출, 도구 실행, 최근 20턴 | 검증·폭주 차단·롤백 없음 |
| 문맥 | 문서 글 8,000자 인라인(초과 시 `read_document` 24,000자 페이지), 누름틀 번호 목록, 표 수, 각주 수, 문단 스타일 목록, 선택 6,000자 | `read_document`·`document_info` 도구에 맡김 | 구조화 문맥 부재 |
| 선택 | 0.7초마다 플러그인에 선택 질의, 문단별 토막(`segments`), 고치기 직전 글자 동일성 검사 | 없음 | 선택 범위 편집 없음 |
| 되돌리기 | `foreignChanges` 카운터 — 사용자 변경이 끼면 거절, 편집기 undo N회 | 서버 리비전 `undo` → 편집기 다시 읽기 | 편집기 실행 취소와 어긋남 |
| PDF/인쇄 | 플러그인 `printPages`(인쇄 프로파일 SVG, 2초 묶음) → 그림 중복 제거 → `@page` HTML → 숨은 창 `printToPDF` | 스튜디오 `file:print-to-pdf`(embed 모드에선 사라짐) | embed 전환 시 대체 필요 |
| 셸 | `WebContentsView` 탭, 떼어내기·도킹·분할, 홈(최근 200·별표·폴더 나무·FTS5 검색), 설정 모달, 첫 실행 안내, electron-updater, 테마 토큰 검사, 21개 언어 | Next 렌더러 한 장 + 탭(상태), 시작 화면(최근 20), 네이티브 메뉴 | 업데이트·온보딩·분할 없음(필요성 낮음) |
| 파일 안전 | zip-gate(실제 해제량 계측, 10,000부분/512MiB/1.5GiB, zip64·암호 거절), CLI 경로 검사(`..`·NUL, 압축비 200:1), SSRF 가드, 네비게이션 가드 | 업로드 크기 413만 | ZIP 폭탄·XML 검사 없음 |
| 파일 연결 | Windows는 hwp/hwpx를 "연결 프로그램" 후보로만(`OpenWithProgids`), 기본 프로그램 안 바꿈. mac xmind `rank: Alternate` | `fileAssociations` hwpx/hwp/docx 전부 등록 | 한컴 기본값 가로챌 위험 |
| MCP | (1) CLI MCP: 디스크 파일, stdio/HTTP+토큰, 도구=명령 1:1, 봉투 `{status,command,summary,detail}`·종료코드 0~4·고정 `error` 어휘; (2) 앱 안 MCP 3093: 열린 문서 편집; (3) 에이전트 세션 MCP. 한글은 **읽기만** | FastAPI MCP stdio 브리지, HWPX 읽고 **고침**, 이벤트 | 우리가 앞섬(편집). 오류 어휘·스킬 문서는 뒤짐 |
| 에이전트 스킬 | `skills/ieumoffice/SKILL.md`(버전 2.70.1), 명령 표에서 생성, 버전 안 올리면 검사 실패, `skill install <agent>` | 없음 | 스킬 문서 필요 |
| DOCX | `docx-engine`(31k LOC, 브라우저·Node 겸용, 좁은 패치 저장) + Tiptap WYSIWYG(137k LOC, Electron 결합) | lxml 블록 편집 | WYSIWYG는 수개월 |
| LLM 경로 | Claude Code/Codex **구독 프로그램**을 도구 0개로 띄워 한 턴씩(결정 0001·0005), 키 제공자 24개는 고급, 무료(OpenRouter/Gemini) | core.today 게이트웨이(Claude/GPT/Gemini), 사용자 키 | 설계 목표가 다름(우리는 게이트웨이) |

---

## 2. 반영 계획 — A층: 공개 빌드 그대로, 바로 가능

우선순위 순. 각 항목에 근거·우리 쪽 변경점·검증을 적는다.

### A1. `chrome=embed` 모드로 전환 (안전 문제)
- **근거 [확인]**: embed 모드는 스튜디오의 `file:new-doc/open/open-recent/clear-recent/save/save-as/save-as-hwp/save-as-hwpx/export-html/export-doc/print-to-pdf/print`와 `edit:compare-documents`를 등록하지 않고, 문서 끌어다 놓기를 끈다. 이음오피스 규칙: "탭이 파일을 갖고 있으므로, 편집기 안에서 문서가 바뀌면 다음 저장이 탭의 파일을 다른 문서로 덮어쓴다."
- **우리 위험 [미확인]**: 지금은 메뉴만 숨겼다. iframe 위에 `.hwpx`를 떨어뜨리면 스튜디오가 그 문서를 열어 **탭의 문서를 바꿔치기**하고, 다음 1.2초 동기화가 서버 리비전으로 밀어 넣을 가능성이 있다. 재현 테스트부터 한다.
- **변경**: `studio.ts`의 `studioUrl()`에 `?chrome=embed&lang=ko`. `studioMenus()`는 이미 "file"을 버리므로 영향 없음. 편집 화면 드롭은 iframe 바깥에서 capture 단계로 가로채 새 탭으로 연다(이음 `editor-drop.ts` 방식).
- **대가**: `file:print-to-pdf`·`file:print`가 사라진다 → A6의 자체 인쇄 경로가 선행 조건. 임시로는 `file:page-setup`도 사라지는지 확인.

### A2. 변경 감지를 `commands.context().isDirty`로 교체
- **근거 [확인]**: `getDocumentState()`는 문서 전체 SHA-256을 계산해 큰 문서에서 1초 가까이 걸린다. 이음오피스는 `isDirty`(싸다) 400ms 폴링 + `keydown/keyup/input/compositionend/pointerup/paste/cut/drop` 뒤 50ms 확인.
- **변경**: `HwpxEditor.tsx`의 1.2초 `changeSeq` 폴링을 `isDirty` 400ms + iframe 이벤트 트리거로 바꾸고, `exportHwpx`→`pushRevision`은 "dirty가 true이고 마지막 입력 후 N초 멈춤" 디바운스로 보낸다. `notifySaved()`로 dirty를 내린다(지금도 호출함).
- **검증**: 300쪽 문서로 폴링 비용 측정(개발자 도구 Performance), e2e `editor.spec.ts`의 타이핑→리비전 2 시나리오 유지.

### A3. 저장 전 검증과 백업
- **근거 [확인]**: `exportHwpVerify()`(SDK에 있음, 재로드 후 쪽수 비교), 매직 바이트 검사, 첫 덮어쓰기 전 `.bak`, 쓰기 실패 시 파일 미손상.
- **변경**:
  - HWP 내보내기(`exportAs(id,"hwp")`) 전 `exportHwpVerify()` → `pageCountBefore !== pageCountAfter` 또는 `recovered`면 거절하고 알림.
  - 서버 `POST /{id}/revisions`는 이미 `load_document`로 검증. 데스크톱 `file:save` IPC에 매직 바이트(HWPX=`PK`, HWP=OLE `D0CF11E0`) 검사와 **첫 덮어쓰기 전 `<이름>.bak`** 추가(세션당 1회, 복사 실패 시 저장 중단).
  - 스튜디오 자동 복구 draft 끄기: 이음은 부팅 전 localStorage에 설정을 심어 autosave/recovery를 끈다(`seededStudioSettings`) — 우리 데스크톱 프로필에 사용자 문서 사본이 쌓이는 것을 막는다. 공개 빌드가 같은 localStorage 키를 읽는지 **[미확인]** → 번들에서 키 이름 확인 후 적용.
- **암호 문서**: 공개 빌드는 `passwordProtected`를 알려 주지 않는다(이음은 패치로 추가) → A층에서는 `commands.context()`에 그 값이 없음을 전제로, 서버가 HWPX 업로드 시 암호 여부를 보고(HWPX `Contents/header.xml`의 암호 표식, HWP는 `FileHeader` 플래그) **열 때 경고·저장 거절**로 대신한다. B층에서 패치로 보강.

### A4. 서버 도구의 안전 규칙 이식(재구현)
- **근거 [확인]**: (1) 찾은 말이 여럿이면 고르지 않고 후보(앞뒤 30자)를 돌려준다. (2) 개체(표·그림·누름틀)가 놓인 문단은 지우지 않고, 그 앞에 넣지 않는다. (3) 변경 전후 개체 수·누름틀 값 비교, 다르면 통째로 되돌린다. (4) 칸 채우기는 빈 칸에만, 하나라도 걸리면 전부 하지 않는다(`overwrite` 명시 시 예외), 글자 없어도 개체 든 칸은 빈 칸이 아니다. (5) 누름틀은 이름이 아니라 **번호**로 가리킨다(이름 없는 누름틀은 모두 같은 안내 문구). (6) 서식은 말한 속성만 바꾼다. (7) 새 문단은 기준 문단의 서식을 받는다(우리 `like`와 같은 방향).
- **우리 변경**: `replace_text`는 `all`/`block` 없이 여러 곳이면 **거절 + 후보 목록**(지금은 어떻게 동작하는지 테스트로 고정 **[미확인]**). `set_table_cells`에 `overwrite` 추가와 전부-아니면-무 규칙. `delete_*`/`insert_content`에 개체 보호. 모든 편집 도구 끝에 개체 수·누름틀 값 불변 검사(lxml 레벨, 간단). `list_fields`를 번호 기준으로.
- **테스트**: `tests/test_tools_*.py`에 각 규칙의 거절 경로.

### A5. 낡은 문서 보호(stale guard)와 리비전 기대값
- **근거 [확인]**: Docs 편집기는 사용자가 고친 뒤 AI가 다시 읽기 전의 번호 기반 쓰기를 거절한다(`markDocSeen`/`editedExternally`). 우리는 `revision_seq`가 있다.
- **변경**: 편집 도구에 선택 인자 `expected_revision`; 다르면 409와 "read_document로 다시 읽으라". 채팅 패널은 자동으로 마지막 읽은 리비전을 넣는다. 외부 MCP 클라이언트에는 도구 설명으로 권장.
- **"AI 편집 되돌리기" 규칙**: 되돌릴 리비전 뒤에 `source=editor`(사용자) 리비전이 끼었으면 거절하고 이유를 보인다(이음의 `foreignChanges`와 같은 뜻).

### A6. PDF·인쇄를 자체 경로로
- **근거 [확인]**: embed 모드에서 스튜디오 인쇄 명령이 사라짐. 이음은 쪽 SVG(인쇄 프로파일, 이식성 글자 폭)를 모아 쪽마다 `@page` 크기의 HTML 한 장으로 묶고 숨은 창에서 `printToPDF`. 381쪽 81초, 그림 중복 제거(`ieum-image:N`), 쪽별 clip-path id 접두어.
- **공개 빌드에서 가능한가**: SDK `getPageSvg(page)`는 있다 [확인]. 인쇄 프로파일(`renderPageSvgWithProfile(page,'print')`)과 `selectCanvasMetrics(false)`는 플러그인에서 엔진을 직접 부르는 것이라 **[미확인]** — `hwpctrl` 플러그인으로 닿는지 확인. 안 되면 화면 프로파일 SVG로 1차 구현(폰트 폭이 PC마다 달라질 수 있음을 알림).
- **변경**: 데스크톱 `print:pdf` IPC(숨은 `BrowserWindow`, 스크립트 끔, CSP) + 웹판은 `window.print()`용 인쇄 전용 페이지. 서버 쪽 대안(`document_info`가 쓰는 쪽 SVG)도 재사용 가능.

### A7. 업로드 ZIP·XML 방어
- **근거 [확인]**: zip-gate — 실제 해제량을 계측해 선언 크기+1에서 끊는다, 부분 수 1만·부분 512MiB·총 1.5GiB, zip64·암호·stored/deflate 외 거절. CLI는 경로 `..`·NUL과 압축비 200:1 검사.
- **변경**: `services/documents.py` 업로드와 `POST /revisions`에 HWPX/DOCX 공통 게이트 — 항목 수·항목별 해제 상한·총합·압축비·경로 탈출·암호 항목 거절, lxml은 `resolve_entities=False, no_network=True, huge_tree=False`. 413이 아닌 422 + 이유 코드.
- **테스트**: 조작된 central directory(선언 1KB, 실제 100MB), `../` 항목, 외부 엔티티 XML.

### A8. 파일 연결을 "후보"로만
- **근거 [확인]**: Windows `OpenWithProgids`만 등록해 한컴 기본값을 바꾸지 않음, mac은 `rank: Alternate`.
- **변경**: `desktop/package.json` `fileAssociations`에 `role: "Editor"`, mac `rank: "Alternate"`; Windows 빌드 시 NSIS 스크립트로 `OpenWithProgids`만(기본 ProgId 설정 금지). 아이콘은 형식별.

### A9. 에이전트 스킬 문서와 MCP 결과 계약
- **근거 [확인]**: 스킬 한 장이 명령·오류 어휘·"끝났다고 말하기 전 검사"를 정하고, 버전이 올라야만 교체된다. MCP 도구 설명 총량 상한(91KiB) 테스트.
- **변경**: `skills/coredotdocs/SKILL.md`(도구 목록·자리 지정 규칙·실패 코드·되돌리기·검증 순서), `frontmatter.metadata.version`, 검사 스크립트(본문 바뀌면 버전 올렸는지). 도구 결과에 고정 `error` 어휘(`ambiguous_target`, `target_not_found`, `out_of_range`, `holds_object`, `stale_revision`, `unsupported` …)와 `detail`에 재시도 사실(후보·범위). 데스크톱 "AI 연결"이 스킬도 함께 설치(`~/.claude/skills/coredotdocs/` 등).

### A10. 채팅 루프 보강(게이트웨이 유지)
- **근거 [확인]**: 인자 스키마 검증·강제변환, 필수 누락·`null`·잘린 호출 미실행, 동일 턴 3회·전부 실패 8턴·불량 인자 3회 차단, 실패 실행 이력 롤백, 첫 변경 전 스냅샷, `verifyResponse`(해냈다고 썼는데 도구 성공이 없으면 교정 턴 1회), 사용자 메시지에서 키·비밀번호 가리기(`sanitizeAgentPayload`).
- **변경**: `ChatPanel`의 루프를 `lib/agent-loop.ts`로 분리하고 위 규칙 구현. 문맥은 "문서 글 8,000자 + 누름틀 번호 목록 + 표 수 + 스타일 목록"을 매 턴 재구성(`document_info` 확장). 대화는 문서별로 서버에 저장(새 테이블 `chat_messages`, 32,000자/메시지 상한, 실패 실행은 남기지 않음).
- **문구 규칙 이식**: "도구가 해냈다고 알린 편집만 했다고 말하라", "할 일을 적지 말고 도구를 부르라", 공문서 기호(□/ㅇ/-/1./가.) 안내, "시키지 않은 서식은 바꾸지 말라".

### A11. 변경 자리로 이동(공개 빌드 가능)
- **근거 [확인]**: SDK `focusTarget({kind:'body_paragraph', section, paragraph, charOffset:0, length})`와 `getSelectionContext()`가 있다(`target-navigation-v1`, `selection-context-v1`). 이음은 플러그인 내부 커서를 쓰지만, 본문 문단 수준의 이동은 SDK만으로 된다.
- **변경**: 서버 편집 결과에 `place: {section, paragraph}`를 넣고(블록→구역·문단 번호 매핑은 lxml에서 바로 나온다), 편집기가 다시 읽은 뒤 `focusTarget`으로 이동. 표 칸 안은 SDK 대상이 아니므로 **[제한]** 표를 담은 문단으로 이동.

### A12. 데스크톱 잡동사니
- 네비게이션 가드: `will-navigate` 거부(같은 URL 새로고침만 허용), `setWindowOpenHandler`는 `http(s)`만 `openExternal` 후 `deny`(지금은 모든 URL을 외부로 연다 [확인, `main.js:143`]).
- iframe이 삼키는 ⌘S/⌘P: 메인의 `before-input-event`에서 받기(이음 방식). 지금 `AppShell` `keydown`은 초점이 iframe 안이면 받지 못할 가능성 **[미확인]** → e2e로 확인.
- 창 크기·위치 저장(이음도 없음, 우리가 더 낫게), 탭 가운데 클릭 닫기(`onAuxClick`), 최근 문서 200개 + `missing` 표시, 첫 실행 안내(AI 연결 단계 1장), 크래시 로그(허용 필드만).
- 패키징: `afterPack`에서 필수 자원(web/, editor-server, rhwp 번들 `.complete`) 누락 시 빌드 실패; 서드파티 고지 생성(rhwp MIT, Electron, Next 등)과 라이선스 허용 목록 검사.

---

## 3. 반영 계획 — B층: rhwp-studio 자체 빌드와 플러그인

### B1. 스튜디오 자체 빌드로 전환
- **근거 [확인]**: `apps/hwp/scripts/build-studio.mjs` — rhwp 저장소를 태그에서 sparse clone(`rhwp-studio/src`, `public`(글꼴·샘플 제외), `npm/hwpctrl-ocx/src`, 약 16MB), 자기 vite로 빌드, `__RHWP_DISABLE_EXTERNAL_WEBFONTS__`, `@wasm` 별칭으로 엔진 지정, 스크립트·플러그인·WASM 해시 스탬프로 재빌드 생략. 패치는 글자 그대로 찾아 바꾸고 **정확히 한 번** 걸리지 않으면 빌드 실패(`rhwp-patches.mjs`), CRLF 대응, `pluginHooks`로 의존하는 내부 이름 존재 확인.
- **우리 변경**: `frontend/scripts/fetch-rhwp-studio.mjs`(공개 사이트 미러) → `build-rhwp-studio.mjs`(소스 빌드)로 교체. 패치 최소 2개: 플러그인 허용 목록에 `coredotdocs-agent` 추가, `getContext`에 `passwordProtected`. 스킴 패치는 우리가 HTTP(127.0.0.1)로 서빙하므로 불필요 [추론].
- **대가**: 빌드에 git·네트워크 필요(캐시 폴더), rhwp 올릴 때 패치 재확인. 공개 미러 방식은 폴백으로 남긴다(`RHWP_STUDIO_SOURCE=mirror|build`).

### B2. 패치된 엔진(선택)
- **근거 [확인]**: `vendor/rhwp-core` 0.8.7-ieum.3 = v0.8.7 + 조판·그리기 패치 9개(표 겹침·각주 영역·제목 표 쪽 시작·병합 칸 배경 등). 저장 바이트는 불변(18개 문서로 확인), 견본 1,205개 중 쪽 구성 변화 1개. 일부는 상위 PR(#8121·#8144·#8145)로 제출됨. 재빌드는 Rust+wasm-pack(`tools/build-rhwp-core.mjs`, `--remap-path-prefix`).
- **선택지**: (a) 상위가 합칠 때까지 npm 0.8.7 유지, (b) 이음의 빌드된 WASM(11.8MB, Apache-2.0+MIT)을 그대로 쓰기, (c) 패치만 가져와 우리가 빌드. **결정 (a)** (§9.3-3): 공식 릴리스 v0.8.7(커밋 `1a76570e`)을 그대로 쓴다. 우리 문서 묶음에서 겹침 신고가 나오기 전에는 엔진 포크를 늘리지 않는다. B1에서 `@wasm` 별칭만 준비해 두면 뒤에 바꿀 수 있다.

### B3. 편집기 플러그인 — "살아 있는 문서" 편집
- **근거 [확인]**: 플러그인은 호스트가 주는 `read`, `transaction(label, tx => …)`, `events.on('document-changed')`, `automation.execute/registerCommand/addMenuItem`만 쓰고 편집기 소스를 import하지 않는다. 변경은 반드시 트랜잭션 안에서(실행 취소 1단계, 실패 시 전체 롤백). 커서·선택·바뀐 곳 표시는 `registerCommand`의 `execute(services)`로 받는 내부 서비스(`cursor.moveTo`, `virtualScroll`, `#scroll-content`)에 기댄다 → `pluginHooks`로 빌드 때 존재 확인.
- **도구 범위(1차)**: `find_text`, `replace_text`(occurrence), `replace_all`, `insert_paragraphs`(문단 나누기로 서식 상속, 개체 뒤엔 빈 문단), `delete_paragraph`(앞 문단 끝~이 문단 끝 삭제), `format_text`/`format_paragraph`(말한 속성만, HWPUNIT×2 단위 주의, 글꼴은 언어별 `fontIds`), `list_tables`/`read_table`/`fill_cells`(빈 칸만·전부-아니면-무·개체 칸 거절), `add_to_table`/`remove_from_table`(본문 표만), `list_fields`/`fill_field`(번호), `read_selection`/`replace_selection`/`format_selection`(토막 동일성 검사), `undo(steps, expectedForeign)`, `reveal(place)`, `marks`.
- **2차**: `insert_table`(붙여넣기 HTML에 선·여백·높이·글꼴 명시, 머리줄 회색은 칸마다 `setCellProperties`+`patternType:-1`), `merge_cells`/`split_cell`, `format_cells`, 각주·미주, 차례(선 없는 2칸 표).
- **구현 방식 결정 필요**: 이음 `agent-plugin.mjs`(3,972줄, Apache-2.0)를 이식하고 NOTICE에 출처를 남기느냐, 규칙만 가져와 재작성하느냐. 이식이 빠르고(엔진 호출 70여 개의 함정이 이미 풀려 있음) 위험이 낮다. 재작성은 원칙에 맞지만 엔진 테스트(`agent-plugin-engine.test.ts` 유형)를 함께 만들어야 한다.

### B4. 실행 위치 혼합 — 편집기가 열려 있으면 편집기가 실행
- **설계**: 서버에 "라이브 세션" 개념 추가. 편집기가 문서를 열면 `POST /{id}/sessions`로 등록하고 SSE(또는 WebSocket)로 **도구 요청을 받는다**. 외부 MCP나 채팅이 편집 도구를 부르면 서버는 (1) 라이브 세션이 있으면 요청을 편집기로 넘겨 플러그인이 실행하고 결과·`exportHwpx` 바이트를 받아 리비전으로 남긴다(사용자의 실행 취소 스택과 일치), (2) 없으면 지금처럼 lxml로 실행한다. 응답 시간 상한(예 15초) 초과 시 서버 실행으로 폴백하고 편집기는 다시 읽는다.
- **이점**: 외부 MCP 편집(우리 강점) 유지 + 편집기 실행 취소·커서·표시(이음 강점). 1.2초 동기화 경합도 사라진다(편집기가 진실, 서버는 리비전 기록).
- **위험**: 두 실행 경로의 결과가 다를 수 있다 → 같은 입력에 대한 **대조 테스트**(서버 결과 vs 플러그인 결과의 글자·개체 수·쪽수)를 CI에 둔다.

### B5. 바뀐 곳 표시·이동·되돌리기 UI
- 변경 카드(바뀐 곳 목록, 줄 클릭 → `reveal`, "표시 지우기", "되돌리기"), 사용자가 고치면 표시 모두 지움, 되돌리기 거절 사유 표시, 되돌린 뒤 다음 요청에 "사용자가 되돌렸다" 주석.

### B6. 선택 범위 편집
- 0.7초 선택 폴링(요청 중 제외), 입력 칸 위 선택 표시와 해제 x, 긴 선택은 앞부분만 + 번호로 부분 지정, 토막이 바뀌었으면 `changed` 거절.

---

## 4. 반영 계획 — C층: 선택·장기

| 항목 | 이음오피스 사실 [확인] | 우리 선택지 | 추정 |
|---|---|---|---|
| DOCX WYSIWYG | `docx-engine`은 헤드리스 파싱+`SaveBlock` 좁은 패치 저장(원본 바이트 보존, 변경 없으면 동일 바이트), npm 미배포(`private`, `src/*.ts` 직접 export), 브라우저·Node 겸용. WYSIWYG는 Tiptap+DOM 측정 쪽 나눔+번들 글꼴, `App.tsx` 8,171줄, `window.desktop` 112곳 | (a) `docx-engine`만 vendoring해 lxml 블록 편집을 대체(Node 사이드카 또는 브라우저) 1~2주, (b) `apps/docs` 렌더러 포크를 iframe에 넣고 데스크톱 브리지 셈 4~8주, (c) 깨끗한 React 부품 추출 수개월 | (a)부터. (b)는 사용자 수요 확인 후 |
| CLI `coredotdocs` | 명령 표 하나에서 도움말·MCP·README·스킬 생성, 봉투·종료코드, `~/.ieumoffice/launcher`, `open`/`selection`으로 앱과 대화(소켓+토큰, `open-documents.json`) | MCP 브리지에 `--cli` 모드(`read`, `apply`, `info`, `open`), 봉투 동일 | 1주 |
| 구독 CLI 경로 | Claude Code를 `-p --tools "" --restricted --strict-mcp-config …`로, `system:init`의 `tools:[]`를 확인한 뒤만 진행, 요금 환경변수 제거, 셸 없이, 빈 임시 폴더, 자식 등록·정리 | 게이트웨이가 기본. "내 Claude 구독으로" 선택지로 추가 가능하나 약관 판단 필요(이음도 결정 기록으로 관리) | 보류 |
| 가리기 `{{label}}` | Markdown/HTML/PPTX만, DOCX 미지원, 읽기 경로 전체 적용, fail-closed | HWPX 가리기 표식(사용자 정의 속성) 설계 후 `read_document` 전 경로에 적용 | 2주 |
| 홈·분할·떼어내기 | `WebContentsView` 이동으로 미저장 상태 유지 | 수요 낮음, 보류 | — |
| 자동 업데이트 | electron-updater GitHub provider, mac은 ad-hoc 서명이라 비활성 | Developer ID 서명 뒤에 | — |

---

## 5. 단계와 검증 기준 (이음오피스만 반영한 1차 표 — 최종 순서는 §9.2)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| 6차-1 (A1~A3, A7, A8, A12) | embed 모드·드롭 가로채기, isDirty 감지, 저장 검증·`.bak`·draft 끄기, ZIP/XML 게이트, 파일 연결 후보화, 가드·단축키 | 백엔드 테스트 +10, e2e: iframe 드롭이 새 탭으로, 300쪽 문서 타이핑 중 CPU 측정표, 조작 ZIP 422 |
| 6차-2 (A4, A5, A9, A10, A11) | 도구 안전 규칙, stale guard, 스킬 문서·오류 어휘, 루프 보강·문맥·대화 저장, 이동 | 도구 거절 경로 테스트, 라이브 채팅 e2e(키 있을 때)에서 "중복 말 거절→후보→재시도" 시나리오, 스킬 버전 검사 스크립트 |
| 6차-3 (A6) | 자체 PDF·인쇄 | 4쪽 그림 문서·100쪽 문서 PDF 쪽수·용지 크기 일치, 시간 측정 |
| 7차 (B1, B3 1차, B4, B5) | 자체 빌드 + 플러그인 + 혼합 실행 + 표시/되돌리기 | 엔진 단위 테스트(실제 WASM, 트랜잭션은 스냅샷으로 흉내), 서버/플러그인 대조 테스트, 빌드한 앱에서 AI 편집→undo 1단계 확인, rhwp 패치 "정확히 한 번" 테스트 |
| 8차 (B3 2차, B6, C-a) | 표·각주·차례, 선택 편집, docx-engine | 한컴 한글에서 저장 결과 열림 확인(공식 자동화 창구는 Windows 전용 → 사용자 PC 또는 수동) |

---

## 6. 알려진 한계와 미확인 사항

- **이음오피스 자체의 미해결 [확인]**: 암호 문서 저장 불가, 변경 추적 기록 소실(지금 내용으로 열어 추적 없이 저장, 결정 0027), 표 안 표에 행·열 넣기 불가(엔진 호출 없음), 표 칸 안에 표 넣기 불가, 차례 쪽 번호 한 쪽 어긋남 가능, 각주 긴 쪽 겹침 일부, 생성 문서 쪽 수 한글보다 1쪽 김, 한컴 글꼴 없는 PC 조판 차이, 편집기 UI 한/영만, PDF 중단 단추 없음. 이것들은 우리도 같은 엔진이라 그대로 물려받는다.
- **HWP(.hwp) 저장 보정 3종**(바탕쪽·메모·수식 캡션 재부착, 탭 폭, 필드 종류): rhwp 0.8.7이 빠뜨려 **한컴 한글이 열지 못하는** 결과를 만든다 [확인, 결정 0024·0026·0028]. 우리는 HWPX가 주 형식이고 HWP는 "내보내기"라 영향이 작지만, HWP 내보내기를 광고하려면 이 보정(`section-tails.ts`, `tab-widths.ts`, `field-kinds.ts`, CFB 쓰기 보정)이 필요하다. 이식 규모가 크므로 8차 이후 또는 "HWP 내보내기는 베타" 표기.
- **우리 쪽 미확인 → 6차-1에서 확인한 것**: (A1) 공개 빌드는 non-embed에서 `#scroll-container` 드롭으로 문서를 바꿔치기한다 [확인, 번들]; embed 전환+capture 가로채기로 해결(e2e). (A12) iframe 초점에서 ⌘S는 스튜디오가 삼켰다 → capture 리스너로 해결(e2e). (A3) 설정 키는 `rhwp-settings`(`autosave.recoveryEnabled/idleSaveEnabled`) [확인]. (A6) `hwpctrl` 플러그인은 HwpCtrl 호환 편집 호출만 있고 인쇄 프로파일 렌더는 없다 [확인] → 화면 프로파일 `getPageSvg`로 구현(6차-3). (A4) `replace_text`는 이미 중복 시 거절·후보 반환이었고 6차-2에서 코드 `AMBIGUOUS_TARGET`을 붙였다.
- **원칙 결정 대기**: (1) Apache-2.0 코드 이식 허용 범위(플러그인·저장 보정·zip-gate), (2) 엔진 패치 채택 여부(B2), (3) 구독 CLI 경로 추가 여부(C).

## 7. 출처 표기 (이음오피스)

이 문서의 §1~§6 사실은 `pblsketch/openoffice`(IeumOffice, GenOffice 포크, Apache-2.0) 저장소 0.12.3 기준이다. 코드를 이식할 경우 `NOTICE`에 "GenOffice, Copyright 2026 Mainfunc, Inc." 및 IeumOffice 기여자 표기를 남기고, 저장되는 문서 안에 그들의 식별자(`aidocs*`, `go:redact` 등)를 쓰지 않는다. rhwp·rhwp-studio는 MIT(Edward Kim).

---

## 8. 한글의 달인 (master-of-hwp) 분석

분석 대상 2: https://github.com/reallygood83/master-of-hwp — `reallygood83/master-of-hwp`(MIT, 현직 초등교사 개인 프로젝트). Python 라이브러리 `master-of-hwp` 0.2.4(Alpha) + `master-of-hwp-studio` 0.8.3(브라우저 GUI, pywebview 데스크톱, PyInstaller mac/Inno Setup win). 커밋 80개, 마지막 2026-08-26. 읽은 것: 핵심 Python 전부(약 2,600줄: `core/document.py`, `adapters/{hwpx,hwp5}_reader.py`, `ai/*`, `fidelity/*`), `mcp-server/`, `studio/`, `vendor/rhwp-main/`, `patches/rhwp-nested-tables/`, `docs/`, `notes/`, `CHANGELOG.md`.

### 8.1 구조 대조

| 영역 | 한글의 달인 [확인] | coredotdocs 지금 | 판단 |
|---|---|---|---|
| HWPX 편집 | `xml.etree`로 `<p>`를 찾아 **첫 `<t>`에 새 글을 넣고 나머지 `<t>`를 지움** → 문단 안 글자 모양 경계가 사라진다. 문단 통째 바꾸기·표 칸 문단 바꾸기 둘뿐. 삽입·삭제는 `NotImplementedError` | lxml, 블록 단위 13개 도구(바꾸기·넣기·표·서식·그림), 리비전 | **우리가 앞섬** |
| HWP(.hwp) | olefile로 읽기(문단·표 휴리스틱). 쓰기는 같은 길이 치환만, 그 외 `In-place resize required` 예외. CFBF 재작성은 로드맵 | 브라우저에서 `@rhwp/core`로 HWP→HWPX 변환 후 편집 | 우리가 앞섬. 그들도 결국 rhwp 엔진에 기댄다 |
| 저장 경로(스튜디오/MCP) | Node 브리지 `rhwp_save.mjs`: npm `@rhwp/core` **0.7.3**을 `initSync`로 띄워 원본을 다시 파싱하고 **연산 로그(op log)를 재생**한 뒤 `exportHwp/Hwpx`. `measureTextWidth = len*8` 스텁. 검증·타임아웃 없음. 스튜디오 저장은 **항상 `exportHwp()`** 라 `.hwpx` 이름에 HWP 바이트가 들어가는 버그 | 편집기 `exportHwpx` → 서버 리비전 | 재생 방식만 참고 |
| 편집기 연동 | `@rhwp/editor` SDK가 아니라 **rhwp-studio 소스를 포크(0.7.2)해 postMessage RPC 15개를 직접 심음**(`loadFile/exportBytes/getSelection/applyEdit/applyEditTable`). AI 편집을 `executeOperation({kind:'snapshot', operationType:'aiEdit'})`로 감싸 **Ctrl+Z 한 단계**. 선택은 800ms 폴링 + 요청 시점 스냅샷. 표 칸 안 여러 줄은 `insertTextInCell`+`splitParagraphInCell`, 새 표는 쪽 본문 폭에 맞춰 칸 폭 계산 | SDK `createStudio`, 공개 빌드 | 이음오피스와 같은 결론(자체 빌드가 필요) |
| rhwp 패치 | **Rust 패치 4개**: `create_table_in_cell_native`, `insert_text_in_nested_cell_native`와 WASM 바인딩 — 이음오피스가 "엔진에 호출이 없다"고 적은 **표 칸 안에 표 넣기**를 실제로 구현. 그러나 한컴에서 열면 새 표가 칸 밖으로 튀어나오는 **조판 이탈** 발견(IR 왕복은 무손실) → 스튜디오에서 본문 표로 우회. Rust 원본은 `/tmp` 정리로 잃고 Claude 대화 기록에서 복원한 JSON 패치만 남음 | — | 참고용. 지금 채택 금지 |
| AI 루프 | 의도 파서(규칙 → LLM JSON) → `find_paragraphs` 위치 찾기(후보 여럿이면 LLM 재순위) → 치환 → **fidelity 검증 실패 시 롤백** → `AIEditResult(status=applied/refused/failed)`. 신뢰도 임계값 0.5 | 도구 호출 루프 | 검증-후-확정 패턴만 참고 |
| LLM 제공자 | Claude Code `claude -p "<prompt>"`(플래그 없음, 120초), Codex `exec --skip-git-repo-check -i <img> --output-last-message <tmp>`, Anthropic/OpenAI SDK, 규칙 기반 폴백(폴백 결과는 적용 버튼 비활성). Windows에서 PATH에 없으면 `wsl -e <cli>`로 브리지하고 `C:\x`→`/mnt/c/x` 변환 | core.today 게이트웨이 | 이음오피스 방식이 안전(도구 0개 확인·요금 환경변수 제거). WSL 브리지는 아이디어로 가치 |
| 검증 | `FidelityReport{byte_equal, structural_equal, text_equal, sections/paragraphs/tables_match, edited_paragraph_applied, byte_size_delta, score}`; 항등 왕복(문단을 자기 글로 치환) 검사; Hypothesis 속성 테스트(치환의 멱등성·국소성) | pytest 117 | **속성 테스트와 구조 보고서는 가져올 가치** |
| MCP | (a) FastMCP 10개 도구, 봉투 `{ok,message,data,error_code,suggestion}`, 메모리 문서 저장소(잠금·영속 없음), `validate_document`는 글자 추출 여부만 (b) 패키지판 4개 도구(`open_document/find_paragraphs/replace_paragraph/section_tables`, 경로 기반 무상태). `mohwp mcp-config`가 OS별 Claude Desktop 설정 경로를 찍어 줌 | FastAPI MCP 브리지, 13개 도구 | 봉투의 `suggestion` 필드만 참고 |
| 보안 | 스튜디오 HTTP 서버에 경로 제한·Origin 검사 없음, postMessage `'*'`, `gui_ai.py`에 개발자 홈 경로 하드코딩 | — | 반면교사(§2 A7·A12 근거 강화) |

### 8.2 가져올 것

1. **속성 기반 테스트(Hypothesis)**: `replace_text` 멱등성(같은 치환 두 번 = 한 번), 국소성(다른 블록·표 모양·개체 수 불변), 항등 왕복(블록을 자기 글로 바꾸면 XML 정규화 후 동일). 우리 lxml 도구 전부에 적용. → §2 A4의 테스트 항목으로 편입.
2. **구조 보고서를 도구 결과에 싣기**: 편집 도구 응답에 `fidelity: {paragraphs_before/after, tables_shape_same, objects_same, fields_same}`를 넣어 AI와 사용자가 무엇이 변했는지 즉시 보게 한다. 이음오피스의 `keepingObjects`(실패 시 롤백)와 합치면 "검증-후-확정"이 된다.
3. **선택 스냅샷·IME 가드**: 요청 시점의 선택(좌표+글자)을 미리보기와 함께 들고 가고, 적용 직전 다시 읽어 같은지 본다(이음의 `segments`와 같은 뜻). 입력 칸 Enter는 `e.isComposing || e.keyCode === 229`면 무시(한글 조합 중 전송 방지).
4. **표 출력 계약**: AI에게 `{rows, cols, cells}`만 받고 직사각형·상한(50×20)·칸 안 줄바꿈 금지를 검증, 답에 섞인 마크다운 파이프 표는 표로 변환. 우리 `insert_content`의 마크다운 표 처리에 상한·검증 추가.
5. **Node에서 `@rhwp/core` 재생 저장**(선택): 서버/MCP 쪽에 Node 사이드카를 두면 브라우저 없이 HWP↔HWPX 변환과 재직렬화가 가능하다. 단 그들처럼 글자 폭 스텁(`len*8`)으로 쪽수 비교(`exportHwpVerify`)를 하면 무의미하므로, 변환·구조 검증에만 쓰고 쪽수 검증은 편집기에서 한다.
6. **WSL 브리지**(구독 CLI 경로를 넣게 되면): Windows에서 `wsl -e claude` 탐지와 경로 변환.
7. **설치 파일 스모크 테스트**: Inno Setup 무음 설치 후 `--help`, mac 번들 실행 후 `pgrep` — 우리 `build.sh`에 "설치본 실행 → `/api/health` 200 → 종료" 단계 추가.

### 8.3 가져오지 않을 것
- `xml.etree` 문단 치환(글자 모양 파괴), Python HWP5 쓰기(미완), 자체 postMessage RPC(SDK가 있다), 항상 `exportHwp()`인 저장, 보안 미비 HTTP 서버.
- 표 칸 안 표 Rust 패치: 조판 이탈이 미해결이고 Rust 원본이 없다. 상위 rhwp 이슈(그들의 `docs/upstream-rhwp-issue.md` 초안)와 이음오피스의 "엔진 호출 없음" 기록을 함께 두고 **상위 반영을 기다린다**.
- 샘플 문서(`samples/`): 3개뿐이고 출처가 불명확한 공문 1건 포함 → 우리 픽스처로 쓰지 않는다.

---

## 9. 종합 — 가장 좋은 방향

두 프로젝트(이음오피스, 한글의 달인)가 모두 우리처럼 rhwp 위에 있고, **둘 다 rhwp-studio를 자체 빌드해 편집기 안에서 AI 편집을 실행**했다. 서버에서 XML을 고치고 편집기를 다시 읽는 쪽은 우리만이다. 그러나 외부 MCP가 문서를 **고칠 수 있는** 것도 우리만이다. 따라서 방향은 "둘 다"다.

### 9.1 원칙
1. **진실은 하나, 실행은 둘.** 서버 리비전이 문서의 진실로 남는다(웹판·MCP·되돌리기·이벤트의 근거). 편집은 편집기가 열려 있으면 편집기 플러그인이, 아니면 서버 lxml이 실행한다(§3 B4). 두 경로의 결과를 CI에서 대조한다.
2. **검증-후-확정.** 모든 편집은 (a) 자리 지정이 모호하면 거절(후보 반환), (b) 개체·누름틀·표 모양 불변 검사, (c) 구조 보고서 첨부, (d) 실패 시 통째 롤백. 이음의 `keepingObjects`+달인의 `FidelityReport`.
3. **엔진은 상위를 따른다.** rhwp 포크·패치를 늘리지 않는다(이음 결정 0050의 "택하지 않은 것", 달인의 Rust 원본 분실 사례). 자체 빌드는 하되 패치는 플러그인 허용·암호 플래그 두 개로 제한한다.
4. **LLM은 게이트웨이가 기본.** 구독 CLI 경로는 사용자 결정 뒤 이음 방식(도구 0개 확인·요금 환경변수 제거·셸 없음·자식 정리)으로만 넣는다. 달인의 `claude -p` 그대로 호출은 쓰지 않는다.
5. **보안은 셋 중 가장 엄격한 쪽.** 로컬 HTTP라도 Origin/Host 검사, 경로 허용 폴더, ZIP 게이트, 네비게이션 가드, postMessage 출처 고정.

### 9.2 실행 순서 (§5 표를 대체)

| 단계 | 내용 | 출처 | 완료 기준 |
|---|---|---|---|
| **6차-1 안전** (1주) — **완료 2026-10-22** (`docs/02-design.md` §10) | `chrome=embed`+iframe 드롭 가로채기(A1), `isDirty` 변경 감지(A2), 저장 검증·`.bak`·draft 끄기(A3), ZIP/XML 게이트(A7), 파일 연결 후보화(A8), 네비게이션 가드·`before-input-event` 단축키(A12) | 이음 | 백엔드 테스트 +10, e2e 드롭→새 탭, 조작 ZIP 422, 300쪽 문서 CPU 측정 |
| **6차-2 도구 품질** (1~2주) — **완료 2026-10-22** (`docs/02-design.md` §11) | 모호 거절·개체 보호·전부-아니면-무(A4), `expected_revision`·되돌리기 거절 규칙(A5), **Hypothesis 속성 테스트·구조 보고서(§8.2 1·2)**, 표 출력 계약(§8.2 4), 스킬 문서·오류 어휘(A9), 루프 보강·문맥·대화 저장(A10), 변경 자리 이동(A11), IME 가드(§8.2 3) | 이음+달인 | 거절 경로 테스트, 라이브 채팅 e2e "중복→후보→재시도", 스킬 버전 검사 |
| **6차-3 인쇄** (1주) — **완료 2026-10-23** (`docs/02-design.md` §12) | 자체 PDF·인쇄(A6) | 이음 | 4쪽·100쪽 PDF 쪽수·용지 일치 |
| **7차 살아 있는 편집** (3~4주) — **완료 2026-10-23** (`docs/02-design.md` §13) | `third_party/ieumoffice-hwp/` 패키지 신설과 라이선스 검사(§9.3-1), 스튜디오 자체 빌드+패치 2개(B1), 플러그인 1차(B3: 찾기·바꾸기·문단·칸 채우기·누름틀·선택·undo·reveal·marks), 혼합 실행(B4), 변경 카드·되돌리기 UI(B5), 선택 편집(B6) | 이음(설계)+달인(선택 스냅샷·칸 여러 줄·표 폭 계산) | 실제 WASM 엔진 단위 테스트, 서버/플러그인 대조 테스트, 빌드한 앱에서 AI 편집→Ctrl+Z 1단계, 패치 "정확히 한 번" 테스트 |
| **8차 확장** (2~3주) — **완료 2026-10-23** (`docs/02-design.md` §14; 구독 CLI는 보류) | 플러그인 2차(표 넣기·합치기·각주·차례), Node `@rhwp/core` 사이드카로 서버 측 HWP↔HWPX 변환(§8.2 5), 설치본 스모크(§8.2 7), 구독 CLI 경로(사용자 결정 시, 이음 방식) | 이음+달인 | 한컴 한글에서 저장 결과 열림 확인(Windows 자동화 또는 수동) |
| **9차 선택** — **보류(2026-10-23)**: 수요가 확인되면 착수 | docx-engine 도입(C-a), CLI `coredotdocs`, 가리기 | 이음 | 수요 확인 후 |

### 9.3 결정 사항
1. **Apache-2.0 코드는 별도 패키지로 분리한다 (2026-10-22 결정).**
   - 위치 `third_party/ieumoffice-hwp/` 하나. 자체 `LICENSE`(Apache-2.0), `NOTICE`("GenOffice, Copyright 2026 Mainfunc, Inc." + IeumOffice 기여자), `ORIGIN.md`(원본 저장소 URL·커밋·가져온 파일 목록·우리가 바꾼 점).
   - 들어가는 것: 편집기 플러그인(이음 `agent-plugin.mjs`에서 가져온 부분), rhwp-studio 빌드 스크립트·패치 정의(`build-studio`·`rhwp-patches`), 필요 시 HWP 저장 보정(`section-tails`·`tab-widths`·`field-kinds`). zip-gate·AI 루프 규칙·셸 동작은 **재작성**(우리 코드).
   - 경계: 우리 코드(`frontend/src`, `backend/app`, `desktop`)는 이 패키지를 공개 인터페이스 둘로만 부른다 — 플러그인 `plugins.invoke("coredotdocs-agent", method, args)`와 빌드 진입점 `node third_party/ieumoffice-hwp/build-studio.mjs`. 이 패키지는 우리 코드를 import하지 않는다.
   - 검사: CI 스크립트 `scripts/check-third-party.mjs` — 이 폴더 밖에서 Apache 출처 표식·이음 식별자(`ieum`, `genoffice`)가 보이면 실패, 폴더 안 파일은 헤더에 출처 표기 필수. 앱 번들의 `THIRD-PARTY-NOTICES`와 "정보" 화면에 고지.
   - 효과: 나중에 패키지를 통째로 걷어내고 재작성해도 우리 코드는 바뀌지 않는다.
2. **구독 CLI 경로**(사용자 PC에 설치·로그인된 Claude Code/Codex CLI를 앱이 실행해 구독 요금 안에서 LLM을 쓰는 방식): **보류.** 지금은 core.today 게이트웨이(사용자 키)만. 수요가 확인되면 8차에서 이음 방식(도구 0개 확인·요금 환경변수 제거·셸 없음·자식 정리·WSL 브리지)으로만 선택 제공자 추가. 약관 판단이 선행돼야 한다.
3. **엔진은 상위 공식 릴리스 rhwp v0.8.7을 그대로 쓴다 (2026-10-22 결정).** 이음의 패치 엔진(0.8.7-ieum.3)은 쓰지 않는다. 고정값: 태그 `v0.8.7` = 커밋 `1a76570e833917d15817415a53c09ad61ab3203f`(`git ls-remote`로 확인). 지금 상태가 이미 이것이다 [확인]: npm `@rhwp/core` 0.8.7·`@rhwp/editor` 0.8.7, 미러한 공개 스튜디오 번들의 `rhwp_bg.wasm`이 npm 0.8.7의 WASM과 바이트 동일(sha1 `eae5a822…`). 7차의 자체 빌드(B1)도 이 태그·커밋에서 받아 빌드하고, 커밋이 다르면 빌드를 멈춘다. 상위에서 0.8.8+가 나오면 §3 B2의 절차(문서 묶음 왕복·쪽수 비교)로 올린다.

## 10. 출처 표기 (한글의 달인)

§8 사실은 `reallygood83/master-of-hwp`(MIT, moon) 저장소 2026-08-26 시점 기준이다. 코드를 이식하면 MIT 고지를 `NOTICE`에 남긴다. 그들의 `vendor/rhwp-main` 포크 WASM과 Rust 패치는 가져오지 않는다.


## 11. 진행 요약 (2026-10-23)

| 단계 | 상태 | 근거 |
|---|---|---|
| 6차-1 안전 | 완료 | `docs/02-design.md` §10 |
| 6차-2 도구 품질 | 완료 | §11 |
| 6차-3 인쇄 | 완료 | §12 |
| 7차 살아 있는 편집 (자체 빌드·플러그인·라이브 세션·선택·바뀐 곳) | 완료 | §13 |
| 8차 확장 (편집기 전용 도구·Node 사이드카·스모크) | 완료 (구독 CLI 보류) | §14 |
| 9차 선택 (docx-engine·CLI·가리기) | 보류 | 수요 확인 후 |

서브에이전트 리뷰 2회(6차·7차)의 상·중 위험 항목은 모두 반영했고, 남긴 것은 `docs/02-design.md` §13 '리뷰 반영' 표와 §15에 적는다.

## 12. DOCX — GenOffice 기준 반영 계획 (2026-10-23)

기준 저장소: https://github.com/genspark-ai/genoffice (upstream, Mainfunc, Apache-2.0; `ee/`만 Enterprise License인데 비어 있고 docs 앱이 참조하지 않음)와 IeumOffice 0.12.3(GenOffice 포크). **DOCX는 genoffice를 기준**으로 하고(더 최신·upstream·docx 엔진 사실상 동일), **HWP는 지금처럼 openoffice의 `apps/hwp`**를 기준으로 한다(genoffice에는 hwp 앱이 없다).

### 12.1 genoffice의 DOCX 구조 (관찰)

| 층 | 내용 | 규모 |
|---|---|---|
| `packages/docx-engine` | `parseDocx` → `Block{docxIndex, originalXml, rawPPr, runs, format…}`; `saveDocx`는 안 바뀐 블록의 원본 XML 바이트를 그대로 잇는 paragraph-patch, `zip-splice`로 미디어 무재압축 복사, 워커에서 단계적 스트리밍 열기, 암호 문서·altChunk·VML·차트·수식·각주·주석·변경 추적 | 3.6만 줄 |
| `apps/docs/src/renderer/editor` | Tiptap 3(ProseMirror) 확장 85개: 표·그림·글상자·필드·각주·변경 추적·찾기·붙여넣기·페이지네이션(연속 흐름 DOM 측정 + 1문단 빠른 길) | 3.7만 줄 |
| `apps/docs/src/renderer/components` | 리본(홈·삽입·레이아웃·참조·편지·디자인·머리말/꼬리말 탭)·대화상자 57개 | 2.7만 줄 |
| `apps/docs/src/renderer/ai` | 도구 30개(`apply_ops`·`replace_blocks`·`write_document` 스트리밍 초안·각주/주석/변경 추적/머리말), 편집 큐 카드 | 1.4만 줄 |
| 검증 | Word 실측 "truths" 432개를 fixture 82개로(`docs/word-truths-coverage.md`) | — |

렌더러는 Electron에 거의 묶여 있지 않다(렌더러에서 electron을 가져오는 파일 1개; `@genoffice/ui`·`project-store`만 씀). 글꼴 12MB를 함께 담는다.

### 12.2 반영 순서 (제안)

| 단계 | 내용 | 경계 | 완료 기준 |
|---|---|---|---|
| D1 저장 충실도 | 우리 DOCX 엔진(lxml)에 "안 바뀐 문단은 원본 바이트 그대로" 원칙을 명시적으로(지금은 트리 재직렬화) — genoffice의 paragraph-patch 규칙(변경 문단만 재생성, `rawPPr` 보존, 주석/책갈피 범위 재배출)을 **동작으로** 옮겨 적음, 코드 복사 없음 | 우리 코드 | 검토본·변경 추적 문서 왕복 바이트 비교 테스트 |
| D2 엔진 들여오기 | `third_party/genoffice-docx/`에 `packages/docx-engine`(+`zip-gate`·`font-metrics` 필요분)을 LICENSE·NOTICE·ORIGIN.md와 함께. 브라우저에서 `parseDocx`로 Block 나무를 만들고 `saveDocx`로 되돌려 쓰는 **쪽 보기 교체**(docx-preview 대신 그들의 모델로 그림). 서버 리비전은 그대로 "진실" | Apache 격리 | 검토본 202블록 일치, 저장 왕복 |
| D3 편집기 | `apps/docs/src/renderer/editor`(Tiptap 확장)와 페이지네이션을 같은 폴더에 들여와 우리 탭 안에 심음. 리본은 우리 셸의 메뉴·도구 막대·서식 막대로 대체(HWPX와 같은 사용감). AI 도구는 우리 레지스트리(라이브 세션 방식: 편집기가 실행, 서버가 확정)로 — `apply_ops`/`replace_blocks`의 연산 어휘만 참고 | Apache 격리 + 우리 셸 | 자유 타이핑·서식 막대·실행 취소 1단계·Playwright |
| D4 검증 | truths fixture 중 우리가 들여온 범위의 것을 돌려 회귀 방지; 한컴·Word에서 열림 확인 | — | fixture 통과 |

제외: `ee/`(라이선스 다름, 어차피 비어 있음), Electron 메인 코드(`apps/docs/src/main`: 우리 데스크톱이 있음), 리본 UI(우리 셸과 중복), 메일 머지·가리기·마인드맵(수요 확인 뒤).

규모 감각: D2까지는 수 주, D3는 그들의 편집기를 그대로 들여오더라도 셸 결합·테스트에 수 주 이상. 지금의 쪽 보기(docx-preview)는 D2가 끝나면 걷어낸다.


### 12.3 진행 결과 (2026-10-24, 설계 문서 02 §18)

| 단계 | 결과 |
|---|---|
| D1 | 완료 — `docx_fidelity.py`(본문 요소 범위 스캔 + 지문 비교), 실제 Word 문서 3개 무변경 왕복 바이트 동일 |
| D2 | 완료 — `third_party/genoffice-docx/packages/{docx-engine,zip-gate,agent-core(2파일),pptx-engine(8파일)}` 그대로 복사, 래퍼 `lib/docx-engine.ts`, 서버 블록 `index`/`sub` |
| D3 | 완료 — 편집기 핵심 132파일 + i18n + styles.css를 `apps/docs/src/renderer/`에 그대로 복사, 각색 1파일(`cdd-canvas-pagination.ts`), 심 3파일(`shims/`). Tiptap `DocxEditor`(자유 타이핑·쪽 띠·서식 막대·자동 저장·AI 반영). docx-preview 제거 |
| D4 | 완료 — 상위 엔진 테스트 1,905 통과(상위 index 내보내기 누락은 시험 가져오기만 심으로 돌림), Word 실측 truths(pure) 384 통과, 우리 테스트 전부 통과, LibreOffice·python-docx 읽기 |
| 보강 | 완료 — 문서 스타일 시트, 구역별 쪽 나누기, 머리말·꼬리말 띠, keepNext·표 행 규칙, 엔진 보정 (설계 문서 02 §18.5) |
| 보강 2 | 완료 — 머리말·꼬리말 그 자리 편집(`hf-editor.ts` 복사), 쪽 아래 각주와 각주 편집, 여러 단(mixed 방식), altChunk 번호 대응, Microsoft Word 열기 확인 (설계 문서 02 §18.7) |

결정 메모: AI 도구는 두 번 구현하지 않는다 — DOCX 편집기는 "먼저 올리기"(flush) 뒤 서버가 실행하고 다시 읽는다(선택 범위 도구만 편집기 실행). 쪽 모양은 머리말/꼬리말·떠 있는 개체·여러 단을 뺀 축소판이며, 필요해지면 App.tsx의 해당 부분을 같은 방식으로 각색해 넣는다. 상위 저장소 갱신 때는 `ORIGIN.md`의 표대로 다시 복사하고 심 3파일·각색 1파일만 다시 맞춘다.
