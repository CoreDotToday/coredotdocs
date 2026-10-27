# 설계 — HWPX·DOCX AI 협업 편집기 (Next.js + FastAPI + PostgreSQL)

이 문서는 구현 차수(1차~9차)를 따라 쌓인 설계 기록이다. 앞 절의 결정이 뒤 절에서 바뀐 곳은 뒤 절이 최신이다.

## 0. 범위와 원칙

흔한 로컬 편집기 + MCP stdio 서버 구조와 달리 이 구현은 **웹 서비스**를 기본으로 한다. 그래서 다음을 택한다.

| 로컬 앱 방식 | 이 구현 | 이유 |
|---|---|---|
| 로컬 소켓 + 실행마다 새 토큰 | HTTP API + DB에 저장한 AI 세션 토큰(해시) | 다중 사용자 웹 |
| `aiFolders` 폴더 허락 | 업로드한 문서 단위 접근, 세션별 문서 범위 | 서버에는 사용자 폴더가 없다 |
| 열린 탭(렌더러)이 편집 실행 | 서버가 편집 실행 후 SSE로 화면에 반영 | 화면 상태가 서버에 있다 |
| 편집 히스토리는 렌더러 Undo 스택 | **리비전 테이블**(append-only), undo는 과거 리비전을 새 리비전으로 복제 | 서버 측 되돌리기, 감사 추적 |
| 검색 인덱스 없음(매번 순회) | 리비전마다 블록 텍스트를 `block_index`에 저장, PostgreSQL FTS(GIN)로 후보 축소 | 문서가 많아도 검색 가능 |
| 입력 스키마에 상한 없음 | 모든 숫자에 min/max, 문자열에 maxLength, `additionalProperties: false` | AI가 넘기는 입력의 범위를 막는다 |

구현 범위:
- **1차**: HWPX 블록 읽기, 찾기, 글 바꾸기, 문단 글 바꾸기, 내용 넣기, 블록 지우기, 표 칸 채우기, 되돌리기, 문서 정보, 내보내기.
- **2차(완료)**: DOCX 엔진(같은 명령 층), 글자·문단·칸 서식, 표 행 넣기/지우기, 새 표, 그림(업로드 ID), 누름틀 목록/채우기, 새 문서(HWPX·DOCX), 읽기 확장(모양 요약·빈 문단 묶기·표 전체 읽기·offset 이어 읽기), MCP 취소·진행 알림, Ctrl+F 찾기, docker-compose·CI.
- **3차·4차·5차에 들어온 것**: 옛 HWP 변환, 조판·쪽 수, 앱 내 LLM 채팅, 데스크톱 앱, **WYSIWYG 편집기(rhwp-studio)·탭·메뉴·파일 열기/저장·AI 앱 설정 자동 등록**(§9).
- **범위 밖**: DOCX WYSIWYG(ProseMirror), 폴더 허락 대화상자.

## 1. 아키텍처

```
Next.js 16 (frontend/)                 FastAPI (backend/app)                PostgreSQL 17
┌──────────────────────┐   HTTP/JSON   ┌───────────────────────┐          ┌────────────────┐
│ 문서 목록·업로드      │──────────────▶│ /api/documents        │─SQLAlchemy▶ documents      │
│ 문서 보기(블록 번호)  │◀── SSE ──────│ /api/documents/{id}/  │          │ revisions      │
│ 찾기 패널            │──────────────▶│   events (edit/undo)  │          │ block_index    │
│ AI 활동 패널·도구 콘솔│──────────────▶│ /api/search           │          │ ai_sessions    │
└──────────────────────┘               │ /api/tools, /api/tools/{name}      │ tool_calls     │
                                       │ engine/: HWPX 파서·명령·검색      └────────────────┘
 AI 클라이언트(Claude 등)  stdio JSON-RPC │ mcp_stdio.py ── HTTP(X-AI-Token) ─┘
```

- `engine/hwpx`: 자체 OWPML(HWPX) 파서. zip 안 `Contents/content.hpf`에서 section 파일을 찾고, `hp:p`를 블록으로 센다. lxml로 네임스페이스를 보존해 다시 쓴다.
- `engine/commands`: 블록 모델 위의 편집 명령. 입력은 `tools/registry`의 JSON Schema로 먼저 검증한다.
- `services/documents`: 업로드 → 리비전 1 → 블록 인덱싱. 명령 실행 → 새 리비전 → 재인덱싱 → 이벤트 발행.
- `mcp_stdio.py`: AI 앱용 stdio MCP 서버. `tools/list`·`tools/call`을 HTTP API로 전달한다(데스크톱 앱에서는 상태 파일로 API 주소를 찾는다).

## 2. DB 구조

```sql
documents (
  id uuid pk, title text, filename text, format text default 'hwpx',
  head_revision_id uuid null, created_at timestamptz, updated_at timestamptz,
  layout_pages int null, layout_revision_seq int null, layout_engine text null  -- 브라우저 rhwp가 보고한 조판 쪽 수 (3차)
)
revisions (
  id uuid pk, document_id uuid fk, seq int, content bytea,
  actor text check (actor in ('user','ai','system')),
  command jsonb null,          -- {tool, arguments} (AI 편집일 때)
  summary text,                -- 결과 한 줄
  created_at timestamptz,
  unique (document_id, seq)
)
block_index (
  id bigserial pk, document_id uuid, revision_id uuid, block_no int,
  kind text check (kind in ('paragraph','table')),
  table_no int null, row_no int null, col_no int null, text text not null
)
  index on (document_id, revision_id, block_no)
  gin index on to_tsvector('simple', text)
assets (
  id uuid pk, document_id uuid null, filename text, media_type text, width int, height int,
  data bytea, created_at timestamptz
)
ai_sessions (
  id uuid pk, name text, token_hash text unique, document_ids uuid[] null,  -- null = 모든 문서
  created_at timestamptz, revoked_at timestamptz null
)
tool_calls (
  id bigserial pk, session_id uuid null, document_id uuid null, tool text,
  arguments jsonb, ok bool, result text, error text, duration_ms int, created_at timestamptz
)
```

## 3. API 명세

| 메서드·경로 | 설명 | 요청 | 응답 |
|---|---|---|---|
| `POST /api/documents` | HWPX 업로드 | multipart `file` | `{id,title,block_count}` |
| `GET /api/documents` | 목록 | | `[{id,title,updated_at,revision_seq}]` |
| `GET /api/documents/{id}` | 상세 | | `{id,title,revision_seq,block_count}` |
| `GET /api/documents/{id}/read?from&to&max_chars` | 블록 번호 붙은 읽기 | | `{text,next_from}` |
| `GET /api/documents/{id}/blocks` | 구조화 블록 | | `[{no,kind,text,table:{rows,cols,cells}}]` |
| `GET /api/documents/{id}/download` | 현재 리비전 HWPX | | `application/hwp+zip` |
| `GET /api/documents/{id}/revisions` | 리비전 목록 | | `[{seq,actor,summary,created_at}]` |
| `POST /api/documents/{id}/undo` | 되돌리기 | `{steps}` | `{reverted,revision_seq}` |
| `GET /api/documents/{id}/events` | SSE | | `event: edit\|undo\|activity` |
| `GET /api/search?q=&document_id=` | 찾기 | | `{hits:[{document_id,block_no,where,before,match,after}],truncated}` |
| `GET /api/tools` | 도구 목록(MCP 형식) | | `{tools:[{name,description,inputSchema}]}` |
| `POST /api/tools/{name}` | 도구 호출 | `{arguments}` + `X-AI-Token` | `{content:[{type:'text',text}],isError}` |
| `POST /api/ai/sessions` | AI 세션 발급 | `{name,document_ids?}` | `{id,token}` (토큰은 한 번만) |
| `POST /api/documents/new` | 새 문서 (마크다운) | `{title,markdown,format}` | `{id,title,format}` |
| `POST /api/documents/{id}/images` | 그림 업로드 | multipart `file` | `{image_id,width,height}` |
| `GET /api/documents/{id}/images` | 그림 목록 | | `[{image_id,filename,width,height}]` |
| `POST /api/documents/{id}/layout` | 브라우저 렌더러(rhwp)가 계산한 쪽 수 보고 | `{pages,revision_seq,engine}` | `{accepted}` (현재 리비전이 아니면 false) |
| `GET /api/ai/models` | 앱 내 채팅 모델 목록 (키가 있으면 게이트웨이 단가표로 그 밖의 모델·단가를 채움) | `X-CDT-Key`(선택) | `{models:[{id,label,provider,group,note?,verified,input_per_1k?,output_per_1k?}],default,pricing}` |
| `GET /api/ai/key` | core.today 키 확인 (무료 모델 목록 호출) | `X-CDT-Key` | `{ok,key_hint}` / 401 |
| `POST /api/ai/chat` | 앱 내 LLM 채팅 (에이전트 루프) | `{document_id,model,message,history[]}` + `X-CDT-Key` | SSE `text\|tool_call\|tool_result\|done\|error\|end` |

오류: 입력 검증 실패는 **200 + isError** (MCP 규약과 같게, AI가 읽고 고치도록), 인증 실패는 401, 없는 문서는 404.

## 4. 도구와 입력 스키마 (경계 포함) — 20개

| 도구 | 필수 | 경계 |
|---|---|---|
| `list_documents` | | |
| `read_document` | document_id | from,to 1..100000; table `^\d+(-\d+)*$`; row_from/row_to; include_format; offset 0..10M; max_chars 256..18000 |
| `document_info` | document_id | |
| `find_text` | query | query 1..500자; document_id 선택 |
| `list_fields` | document_id | from,to |
| `replace_text` | document_id, find, replace | find 1..2000, replace 0..20000, all, block, match_case |
| `set_paragraph_text` | document_id, block, text | text 0..20000 (인라인 마크다운) |
| `insert_content` | document_id, markdown | markdown 1..200000; after 0.. 또는 before; like |
| `delete_blocks` | document_id, from | to ≥ from |
| `set_table_cells` | document_id, table, cells[1..500] | row,col 1..10000; text 또는 format(size 1..200, bold, align, vertical_align, line_spacing 50..500, padding_mm 0..30) |
| `format_table` | document_id, table, format | 위 format과 같음 |
| `insert_table_rows` | document_id, table | after_row 0..; rows ≤1000×200; count 1..1000 |
| `delete_table_rows` | document_id, table, from | to |
| `insert_table` | document_id, rows | rows 1..1000행 × ≤200열; after; header |
| `insert_image` | document_id, image_id | width_mm 1..300; align left/center/right; after |
| `fill_fields` | document_id, values | 키 ≤500자, 값 ≤20000자, 1..500개 |
| `format_text` | document_id, find | bold/italic/underline/strike, color `#RRGGBB`, size 1..200, font ≤50자 |
| `format_paragraphs` | document_id (from 또는 all) | align, line_spacing 50..500, left/indent -500..500pt, space_before/after 0..500, page_break; 글자 모양 font/size/color/bold/italic은 범위 안 모든 글(표 칸 포함)에 — "문서 전체 글꼴"은 `all: true` + font |
| `list_fonts` | (query) | 데스크톱 앱이 `POST /api/fonts`로 올린 설치 글꼴(가족명·한국어 이름). 편집 도구의 `font`는 서버가 가족명으로 정규화하고, 목록에 없으면 결과에 주의를 붙인다 |
| `create_document` | title, markdown | title 1..80, format hwpx/docx |
| `undo_last_edit` | document_id | steps 1..50 |

모든 스키마는 `additionalProperties: false`. 모든 문자열은 XML 1.0 비허용 문자(제어 문자, 짝 없는 서로게이트)를 거절한다.

## 5. UI 구성 (Next.js, app router) — 5차에서 제품 셸로 교체 (§9)

- `/` — 앱 셸(`AppShell`): 탭 줄 + 시작 화면(열기·새 문서·최근 문서·이 앱의 문서·AI 연결) 또는 열린 문서들. `/?doc=<id>`와 `/documents/[id]`는 그 문서를 탭으로 연다.
- 문서 탭(`DocumentView`) — 메뉴 줄·도구 막대(`EditorChrome`), 본문(HWPX: `HwpxEditor` = rhwp-studio iframe, DOCX: `DocxEditor` = 블록 보기 + 인라인 편집), AI 사이드바(`AiSidebar`: 채팅·활동/도구 콘솔·찾기·리비전), "AI가 … 중" 알림.
- 1~4차의 블록 보기·찾기·도구 콘솔·그림·리비전 패널은 사이드바 안으로 들어갔다.

## 6. 단계별 구현 계획

1. HWPX 파서 + 블록 모델 + 라운드트립 (단위 테스트)
2. 편집 명령·검색 엔진 (단위 테스트, 도구 동작 규약 `test_tool_contract.py`)
3. 도구 레지스트리 + JSON Schema 경계 (단위 테스트)
4. DB 모델·리비전·인덱싱 + API (통합 테스트, PostgreSQL 컨테이너)
5. SSE 이벤트 + 되돌리기
6. MCP stdio 브리지 (단위 테스트: 프로토콜 왕복)
7. Next.js 화면 (vitest: 유틸, 컴포넌트 렌더)
8. 도구 동작 규약 테스트 (`tests/test_tool_contract.py`)
9. (2차) header.xml 모델(글자·문단 모양 찾거나 만들기) → 서식·표 행·새 표·그림·누름틀·새 문서 → DOCX 엔진 → 도구 20개 → UI 확장 → docker-compose·CI
10. (3차) rhwp WASM(npm `@rhwp/core`, MIT) 브라우저 통합: 조판 미리보기·쪽 수 보고·옛 HWP 변환 → core.today LLM 게이트웨이로 앱 내 채팅(사용자 키) → 라이브·E2E 검증

## 8. 데스크톱 앱 (4차)

데스크톱 편집기 사용감을 위해 Electron 셸을 두되, 내부는 웹 서비스와 **같은 코드**를 그대로 쓴다.

| 구성 | 웹 서비스 | 데스크톱 앱 |
|---|---|---|
| 백엔드 | uvicorn (Docker) | PyInstaller onedir `editor-server` (앱 Resources/backend) |
| DB | PostgreSQL + pg_trgm | SQLite 파일 (`userData/editor.db`), trigram 인덱스 없음, `ILIKE`는 `lower() LIKE` |
| 화면 | Next standalone (Docker) | 같은 standalone `server.js`를 Electron `utilityProcess`(Node)로 실행 |
| API 주소 | 빌드 인자 `NEXT_PUBLIC_API_URL` | 실행 때 정한 포트를 `API_PUBLIC_URL`로 주면 `layout.tsx`가 `window.__API_BASE__`로 주입 |
| MCP 브리지 | `uv run python -m app.mcp_stdio` | `editor-server --mcp` (화면이 `window.__MCP_COMMAND__`로 받아 설정 조각 생성) |

- DB 겸용을 위해 모델을 바꿨다: `JSONB`→`JSON().with_variant(JSONB,'postgresql')`, `BigInteger` 키→SQLite에서는 `INTEGER`, `ai_sessions.document_ids`는 `uuid[]`→JSON 문자열 목록(기존 PG DB는 `init_db`가 `to_jsonb`로 옮긴다). SQLite는 연결마다 `PRAGMA foreign_keys=ON`, WAL.
- 테스트는 같은 pytest를 `EDITOR_DATABASE_URL=sqlite:///…`로 한 번 더 돌려 확인한다(111 passed, PG와 동일).
- 포트: 47370/47371 선호, 사용 중이면 빈 포트. 창은 `contextIsolation`·`sandbox`로 http://127.0.0.1 만 연다. 외부 링크는 기본 브라우저로.
- macOS 패키징에서 부딪힌 것(모두 해결, README 참고): Apple Silicon의 서명 없는 실행 파일 SIGKILL → ad-hoc 서명; `codesign --deep` 재서명 → Electron SIGTRAP → `@electron/osx-sign`으로 순서·entitlements 지켜 서명; 내려받은 터미널(iTerm2)에서 만든 파일의 `com.apple.provenance` → Gatekeeper "손상됨" → launchd 작업으로 rsync 복사(cp·tar·ditto는 속성을 함께 복사함); 한글 `CFBundleName` → "Unable to find helper app" → 실행 파일명 ASCII + 표시 이름만 한글; extraResources가 node_modules를 버림 → afterPack에서 직접 복사.
- 미구현: 자동 갱신, Developer ID 서명·공증, 파일 연결(.hwpx 더블클릭으로 앱 열기), 앱 아이콘, Windows·Linux 빌드 검증.

## 7. 3차 추가 설계 — rhwp WASM과 앱 내 LLM 채팅

### 7.1 rhwp (조판·HWP 변환)

- **npm에 공개된 upstream `@rhwp/core` 0.8.7(MIT)** 을 의존성으로 받는다(포크·패치 없음). `scripts/copy-rhwp.mjs`가 `rhwp_bg.wasm`과 LICENSE를 `public/rhwp/`로 복사한다(빌드 산출물, 저장소에 넣지 않음).
- 서버(FastAPI)는 WASM을 돌리지 않는다. rhwp는 글자 폭 측정을 호스트 canvas에 맡기므로 브라우저에서만 조판한다.
  - **조판 미리보기**: 현재 리비전을 내려받아 `HwpDocument.pageCount()`·`renderPageSvg(i)`로 쪽 SVG를 그린다. SVG는 `<img>`로 넣어 문서 안 스크립트·외부 참조가 실행되지 않게 한다. 앞 30쪽까지 그린다.
  - **쪽 수 보고**: `POST /api/documents/{id}/layout`로 (pages, revision_seq, engine)을 기록한다. `document_info`의 "화면 쪽 수"가 이 값이며, 그 뒤 편집이 있으면 "리비전 N 기준"이라고 밝힌다. 화면을 연 사람이 있을 때만 갱신된다.
  - **옛 HWP 업로드**: `.hwp`를 고르면 브라우저에서 `exportHwpx()`로 바꾼 뒤 `.hwpx`로 올린다. 서버는 HWPX·DOCX만 받는다.
- DOCX는 rhwp 대상이 아니므로 미리보기 버튼을 숨긴다.

### 7.2 앱 내 LLM 채팅 (core.today 게이트웨이)

- 외부 AI 앱(Claude Desktop 등)이 MCP로 붙는 브리지에 더해 **화면 안 채팅**을 둔다. LLM은 core.today LLM 게이트웨이(https://console.core.today/docs/llm)를 쓰고, **사용자가 자기 `CDT_API_KEY`를 화면에 넣는다**. 키는 브라우저 localStorage에만 있고 요청마다 `X-CDT-Key` 헤더로 전달되며 서버는 저장하지 않는다(`EDITOR_CDT_API_KEY`는 개발용 대체값).
- 게이트웨이는 모델 계열마다 경로가 다르다(실측): Claude는 Anthropic Messages(`/llm/anthropic/v1/messages`), GPT는 OpenAI Chat Completions(`/llm/openai/v1/chat/completions`), Gemini는 OpenAI 호환 Gemini 경로(`/llm/gemini/v1beta/openai/chat/completions`). OpenAI 경로는 Claude·Gemini 모델을 받지 않는다. `app/llm/gateway.py`가 모델 접두어로 경로를 고르고 대화를 공급자 중립 `Turn`으로 들고 있다가 요청 직전에 변환한다. Gemini의 `tool_calls[].extra_content.google.thought_signature`는 다음 요청에 그대로 돌려줘야 하므로 원본을 보존한다.
- 에이전트 루프(`app/llm/agent.py`): 사용자 메시지 → LLM → tool_use가 있으면 **MCP와 같은 `run_tool`** 로 실행(행위자 `ai`, 문서 범위를 현재 문서로 고정, 모델이 준 `document_id`는 덮어씀) → 결과를 돌려주고 반복 → 최종 글. 상한 `chat_max_rounds`(12). 편집은 평소처럼 리비전·SSE·호출 기록으로 남는다.
- 화면은 `POST /api/ai/chat`의 SSE를 fetch 스트림으로 읽어 글·도구 호출·결과·토큰 사용량을 보여 준다. 대화 이력은 글(user/assistant)만 최근 20턴을 다시 보낸다.
- 테스트: 가짜 전송으로 변환·오류 매핑·도구 루프(PostgreSQL), `CDT_API_KEY`가 있으면 실제 게이트웨이로 Claude Haiku·GPT-4o mini·Gemini 3.8 Flash 각각 한 바퀴(`tests/test_llm_live.py`).


## 9. 제품 셸 (5차) — 데스크톱 문서 편집기 사용감

4차까지는 "웹 폼 + 블록 보기"였다. 문서 편집기답게 시작 화면·탭·메뉴·도구 막대·WYSIWYG 캔버스·AI 연결 메뉴 구조로 화면을 다시 짰다.

| 구성 | coredotdocs |
|---|---|
| WYSIWYG 편집기 | **upstream rhwp-studio 0.8.7 공개 배포본**(MIT)을 `@rhwp/editor` SDK(npm)로 iframe에 띄움. 배포본은 `scripts/fetch-rhwp-studio.mjs`가 GitHub Pages에서 받아 `public/rhwp/`에 두고 우리 서버가 제공(오프라인). SDK는 HTTP(S) origin만 허용하므로 Electron도 http://127.0.0.1 로 연다 |
| 메뉴·도구 막대 | 스튜디오 chrome을 끄고(`chrome:{menu:false}`) 앱이 그림. 편집·보기·입력·서식·쪽·표·도구는 `commands.menuModel()`(191개 명령)을 그대로 메뉴로; 파일·AI·도움말은 앱 것. 명령은 `commands.execute(id, …, {allowDialog:true})` |
| 탭 | 별도 WebContents(tabs.html) | 같은 페이지의 탭 줄. 모든 탭을 DOM에 두고 display로 숨김(iframe을 떼면 편집 상태가 사라짐). 상태는 localStorage(`coredotdocs.workspace`) |
| 문서의 진실 | 렌더러(편집기)가 유일한 진실, AI 편집도 렌더러에서 실행 | 서버 리비전이 진실. **양방향 동기화**: 사람이 스튜디오에서 고치면(iframe 입력 이벤트 capture → 0.9초 조용하면 `commands.context().isDirty` 확인, 놓친 것은 4초 폴링; `getDocumentState()`는 올리기 직전 한 번만 — 6차-1) 문서 전체를 `POST /documents/{id}/revisions`(actor user, summary "편집기에서 고침", 내용이 같으면 리비전 없음)로 올린다. AI가 고치면 SSE `edit`(source≠editor, seq>known)로 알고 `loadFile(bytes,{skipUnsavedGuard})`로 다시 불러온다. 채팅 전송 직전엔 `flush()`로 먼저 올린다 |
| 되돌리기 | 렌더러 Undo 스택(AI 편집 포함) | 스튜디오 자체 Undo(사람 편집) + 서버 리비전 되돌리기("AI 편집 되돌리기", 리비전 복제 → 편집기 다시 불러옴) |
| 파일 | 파일이 문서, 저장은 같은 경로, HWP는 옆에 HWPX | 열면 서버 문서(리비전)가 되고 탭이 경로를 기억. 저장 = `exportHwpx()` → 경로에 임시 파일 후 교체(`file:save` IPC) → `notifySaved()` → 리비전 동기화. HWP는 변환해 열고 저장 때 위치를 묻는다 |
| AI 진행 알림 | `activity` 이벤트에 `phase: start|end`(편집 도구만 시작을 알림) → 배너. 취소는 앱 내 채팅의 중단 단추 |
| AI 앱 등록 | 메뉴 AI → Claude Desktop(`claude_desktop_config.json` 병합, .bak), Claude Code(`claude mcp add-json --scope user`, 로그인 셸로 실행), Codex(`~/.codex/config.toml` 블록). 포트가 실행마다 바뀔 수 있어 설정엔 `EDITOR_STATE_FILE`(`userData/server.json`) 경로만 적고 브리지(`resolve_api_base`)가 읽는다 |
| preload | `window.coredotdocs` 12개: 열기 대화상자·경로 읽기·저장·문서 상태·AI 연결·메뉴 이벤트·파일 연결 이벤트·폴더 보기·외부 링크·pathForFile |
| 파일 연결·끌어다 놓기 | (electron-builder `fileAssociations` hwpx/hwp/docx, `open-file`·`second-instance`·argv, 렌더러 드롭은 `webUtils.getPathForFile`) |
| DOCX | 블록 보기 + 인라인 편집 (WYSIWYG 아님) |

**동기화의 경계값**: 편집기에서 조용해진 0.9초 안에 친 글이 아직 올라가기 전에 AI 편집이 도착하면 AI 편집이 이긴다(그 타이핑은 사라짐). 채팅은 전송 직전에 flush하므로 앱 내 AI에서는 생기지 않고, 외부 MCP 편집에서만 가능하다.

**스튜디오 SDK에서 확인한 사실**: `onDocumentChanged`는 agent apply/revert에만 발생하고 사람의 타이핑에는 발생하지 않아 `getDocumentState()` 폴링으로 감지한다. `chrome.menu=false`면 도구 막대도 함께 숨겨진다(배포본 0.8.7). URL `?chrome=embed`면 스튜디오의 파일 명령(새 문서·열기·저장·인쇄·PDF)과 문서 드롭이 꺼진다 — 6차-1부터 embed로 띄우고 문서 드롭·단축키는 iframe 창을 capture로 가로챈다. 공개 빌드의 `commands.context()`에는 `isDirty`가 있고 `passwordProtected`는 없다. 복구용 자동 저장은 localStorage `rhwp-settings.autosave`를 심어 끈다. `hwpctrl` 플러그인은 `invoke/batch/exportBytes/undo/redo`만 노출한다. 키 입력으로 넣은 글은 `changeSeq`가 올라가고 `exportHwpx()`에 들어 있다(E2E로 확인).


## 10. 6차-1 (2026-10-22) — 안전 (이음오피스·한글의 달인 분석 반영, `docs/04` §2 A1·A2·A3·A7·A8·A12)

| 항목 | 구현 | 검증 |
|---|---|---|
| embed 모드 | `studioUrl()`에 `?chrome=embed&lang=ko`. 스튜디오의 파일 명령·문서 드롭이 꺼진다 | e2e: iframe 위 HWPX 드롭 → 새 탭, 원래 문서 리비전 1 그대로 |
| 드롭 가로채기 | `HwpxEditor`가 iframe 창의 `drop`을 capture로 받아 문서 파일이면 `openLocalFiles`, 그림은 스튜디오로 | 위와 같음 |
| 변경 감지 | `ACTIVITY_EVENTS`(keyup·input·compositionend·pointerup·paste·cut·drop) → 0.9초 조용 → `isDirty` → flush; 4초 느린 폴링. `getDocumentState()`는 flush 안에서만 | e2e 타이핑 → 리비전 2 |
| 저장 검증 | `flush()`가 서버 거절(422) 시 거짓 → 저장 중단. HWPX는 `PK` 매직 확인. HWP 내보내기는 `exportHwpVerify()`(재읽기 성공·쪽수 동일) 통과 후 `D0CF` 확인 | 단위: 없음(SDK 호출), 코드 경로 리뷰 |
| 데스크톱 저장 | `file:save`: 확장자별 매직 바이트 검사 → 이 실행에서 처음 덮어쓰는 파일은 `<이름>.bak`(복사 실패 시 저장 중단) → 임시 파일+rename, 실패 시 임시 파일 제거 | 패키징 앱 CDP로 확인 예정 |
| 자동 복구 끄기 | `seedStudioSettings()`가 localStorage `rhwp-settings.autosave.{recoveryEnabled,idleSaveEnabled}=false` | 수동 |
| ZIP/XML 게이트 | `app/engine/zipgate.py`: 항목 수 1만·항목 256MiB·총 1GiB·압축비 200:1(1MiB 초과), 선언 크기+1에서 실제 해제 중단, 경로 탈출·암호 항목·stored/deflate 외·DOCTYPE/ENTITY 거절. lxml `resolve_entities=False, no_network=True` | `tests/test_zipgate.py` 8개 |
| 파일 연결 | mac `rank: Alternate`, linux MIME만, Windows는 `build/installer.nsh`로 `OpenWithProgids`+`RegisteredApplications`만(기본 프로그램 안 바꿈) | Windows 미검증 |
| 가드 | `will-navigate`는 우리 출처만, 새 창은 http(s)만 바깥 브라우저로. 웹판은 iframe capture `keydown`으로 ⌘S/⇧⌘S/⌘O/⌘W/⌘J를 앱이 받는다(데스크톱은 네이티브 메뉴) | e2e: iframe 초점에서 ⌘S → 내려받기 |


## 11. 6차-2 (2026-10-22) — 도구 품질 (`docs/04` §2 A4·A5·A9·A10·A11, §8.2)

| 항목 | 구현 | 검증 |
|---|---|---|
| 오류 코드 | 도구 실패는 `오류[CODE] 메시지`. 코드: TARGET_NOT_FOUND, AMBIGUOUS_TARGET, OUT_OF_RANGE, HOLDS_OBJECT, CELL_NOT_EMPTY, STALE_REVISION, FOREIGN_CHANGES, NOTHING_TO_UNDO, UNEXPECTED_CHANGE, INVALID_ARGUMENT. HTTP undo 409는 `{message, code}` | `tests/test_guards.py`, `tests/test_skill.py`(코드 표 누락 검사) |
| 개체 보호 | `set_paragraph_text`·`delete_blocks`는 표·그림·누름틀이 든 블록을 거절(`include_objects`로만). `set_table_cells`는 빈 칸에만(같은 글 다시 쓰기는 허용), 글 있는 칸은 `overwrite`, 개체 든 칸은 거절, 하나라도 걸리면 아무 칸도 쓰지 않음 | 위 테스트 |
| 검증-후-확정 | `engine/invariants.py`: 편집 앞뒤 `Fingerprint(blocks, paragraphs, tables(안쪽 포함), pictures, fields(번호·글))`를 도구별 허용표(`ALLOW`)로 비교, 어긋나면 리비전을 만들지 않고 `UNEXPECTED_CHANGE`. 성공 응답 끝에 `검증: 문단 N, 표 T, 그림 P, 누름틀 F (전: …)` | 가짜 명령으로 표를 지우게 한 테스트 |
| 낡은 리비전 | 모든 편집 도구·undo에 `expected_revision`; 다르면 `STALE_REVISION` | 테스트 |
| 되돌리기 규칙 | 되돌릴 구간에 편집기(`tool=editor`) 리비전이 있으면 `FOREIGN_CHANGES`; `force`로만. 화면의 "AI 편집 되돌리기"는 확인 뒤 force | 테스트 + AppShell |
| 자리 이동 | 편집 이벤트에 첫 변경 블록의 `place{section, paragraph, length}`(구역 안 본문 문단 번호) → 편집기가 다시 읽은 뒤 `focusTarget` | e2e(편집 반영) — 이동 자체는 수동 확인 |
| 채팅 루프 | `llm/agent.py`: 매 요청 문맥(문서 정보 + 본문 앞 6,000자), 비밀 가리기(`sanitize_message`), 동일 호출 3회·전부 실패 6턴 차단, 편집 주장 검증(교정 턴 1회, `notice` 이벤트), 성공 실행만 문서별 기록(`chat_messages`), 지시문에 공문서 규칙·"도구가 해냈다고 알린 편집만" | `test_guards.py` 채팅 3건 |
| 대화 기록 | `GET/DELETE /api/ai/chat/{id}/history`; 패널이 열릴 때 되살리고 "새 대화"로 지움. `history`를 보내지 않으면 서버 기록을 모델 문맥으로 씀 | 테스트 |
| 속성 테스트 | Hypothesis: `replace_text` 국소성·멱등성, 항등 왕복 구조 보존 | `test_guards.py` |
| 스킬 문서 | `backend/scripts/gen_skill.py` → `skills/coredotdocs/SKILL.md`(도구 표·코드 표·순서·보호 규칙·문체). 레지스트리와 다르면 테스트 실패. 데스크톱 "Claude Code/Codex에 연결"이 `~/.claude/skills/`·`~/.agents/skills/`에 버전이 클 때만 설치 | `test_skill.py` |
| IME | 채팅 입력란은 한글 조합 중 Enter를 보내지 않는다 | 수동 |
| MCP 지시문 | 오류 코드와 expected_revision 안내 추가 | — |


## 12. 6차-3 (2026-10-23) — 자체 PDF·인쇄 (`docs/04` §2 A6)

| 항목 | 구현 | 검증 |
|---|---|---|
| 쪽 모으기 | `lib/print.ts` `collectPages`: SDK `getPageSvg(i)`(화면 프로파일)를 4쪽씩 모으고 사이에 화면에 숨을 돌리며, 쪽 수가 바뀌면 멈춘다 | vitest |
| HTML 한 장 | `buildPrintHtml`: SVG width/height(px, 96dpi)→mm, 표준 용지(A4·A3·A5·B4·B5·Letter·Legal, 가로 포함)에 0.5mm 안이면 맞춤; 쪽마다 이름 붙인 `@page {size; margin:0}`; id·`url(#)`·`href="#"`에 쪽 접두어; 같은 data: 그림은 `<symbol>` 하나 + `<use>`; CSP로 스크립트·바깥 요청 차단 | vitest 5, e2e(웹 팝업: 쪽 수·@page·id 유일) |
| 데스크톱 | `print:pdf`: 임시 파일에 HTML을 쓰고 숨은 창(sandbox, javascript off)에서 `printToPDF({preferCSSPageSize, margins none})` → `%PDF` 확인 → 임시 파일+rename. `print:html`: 같은 창에서 시스템 인쇄 대화상자. 끝나면 창·임시 폴더 제거. 메뉴 파일 › PDF로 저장…/인쇄…(⌘P) | 패키징 앱 CDP |
| 웹판 | blob URL 새 창 + `window.print()` (브라우저가 PDF 저장을 맡는다) | e2e |
| 한계 | 공개 빌드는 인쇄 프로파일(이식성 글자 폭)을 SDK로 내놓지 않아 화면 프로파일로 그린다 — 글꼴이 다른 PC에서 줄 나눔이 달라질 수 있다. 중단 단추 없음(이음도 없음). DOCX는 브라우저 인쇄 | — |


## 13. 7차 (2026-10-23) — 살아 있는 편집 (`docs/04` §3 B1·B3·B4·B5·B6, §9.1)

| 항목 | 구현 | 검증 |
|---|---|---|
| 스튜디오 자체 빌드 | `third_party/ieumoffice-hwp/build-studio.mjs`(Apache-2.0 파생): rhwp `v0.8.7`(커밋 `1a76570e`) sparse clone → `frontend/node_modules/.cache` → Vite 빌드(`@wasm`=npm `@rhwp/core`, hwpctrl 플러그인, 우리 플러그인 `@coredotdocs/agent-plugin`) → `frontend/public/rhwp` 23MB. 패치 6개(암호 플래그, 플러그인 허용, 칸 안 표 지우기 4) — 정확히 한 번 걸리지 않으면 빌드 실패; `pluginHooks`로 내부 이름 확인. `frontend/scripts/rhwp-studio.mjs`가 기본 빌드, `RHWP_STUDIO_SOURCE=mirror`면 공개 미러(폴백) | 빌드 성공, 기존 e2e 6 통과 |
| Apache 경계 | `third_party/ieumoffice-hwp/`(LICENSE·NOTICE·NOTICE-upstream·ORIGIN.md·agent-plugin.mjs/.d.mts·rhwp-patches.mjs·build-studio.mjs). 우리 코드는 `lib/agent-plugin.ts`의 `plugins.invoke("coredotdocs-agent", …)`와 빌드 진입점으로만 닿는다. `scripts/check-third-party.mjs`가 폴더 밖 식별자·폴더 안 출처 표기를 검사 | 검사 통과 |
| 라이브 세션 | `services/live.py`(문서당 세션 1, 20초 대기·40초 무응답이면 죽은 세션), `api/live.py`. **전달은 문서 이벤트 스트림(SSE `live-request`)에 실어 보내고** 편집기는 15초마다 heartbeat만 보낸다(롱폴 `next`는 브라우저가 아닌 편집기·테스트용). 편집기는 `lib/live.ts`가 등록·실행·결과(JSON+내보낸 HWPX) 전송. 서버는 결과 파일을 **검증-후-확정**(지문 비교, 어긋나면 편집기에 undo 요청 + UNEXPECTED_CHANGE) 뒤 리비전(source `editor-live`)으로 저장. 편집기는 그 이벤트를 다시 읽지 않는다 | `tests/test_live.py` 8, e2e 라이브 1 |
| 블록→글자 지정 | `tools/live_dispatch.py`: 바꿀 글을 문서에서 하나뿐이 되게 앞뒤로 늘려 플러그인에 넘김(`unique_find`), 문단은 문단 글 전체, 표는 통번호(안쪽 표는 든 표 바로 뒤), 마크다운은 본문 문단만. 힌트를 못 만들면 서버 실행 | 단위 테스트 |
| 폴백 | 세션 없음·시간 초과·편집기가 `LIVE_FALLBACK`(편집기 시각에서 못 찾음·지원 안 함)이면 서버 실행 + 다시 읽기. 의미 있는 거절(`occupied`·`holds_object`·`has_objects`·`changed`)은 우리 코드로 옮겨 그대로 | 테스트 |
| 선택 편집 | 도구 `read_selection`·`replace_selection`·`format_selection`(라이브 전용, 없으면 UNSUPPORTED). 채팅 패널이 0.7초마다 선택을 물어 칩으로 보이고 요청에 `selection`으로 붙인다(지시문에 규칙) | e2e 선택 1 |
| 바뀐 곳 카드 | 채팅 위에 AI 편집 이벤트 목록(리비전 → `focusTarget`), "표시 지우기"(`clearMarks`), "AI 편집 되돌리기" | e2e |
| 동기화(리뷰 반영) | `flush`는 진행 중인 약속을 공유(중복 올리기·낡은 저장 방지), 다시 읽는 동안 올리기 정지(AI 편집을 사용자 타이핑이 덮는 경합 제거), 변경 감지는 `getSelectionContext().changeSeq`(해시 없음) | e2e 타이핑 |
| 리뷰 반영(백엔드·데스크톱) | 채팅 중단이 루프를 멈춤(`threading.Event`), DOCTYPE 검사를 XML 전체(주석 제외)로, 해제 상한 256MiB/128MiB, `huge_tree=False`, FOREIGN_CHANGES 구간을 지금 내용의 출처까지로, 오류 코드 접두어 보강(INVALID_ARGUMENT·FORBIDDEN·UNSUPPORTED), 활동 이벤트는 권한 검사 뒤, 데스크톱 쓰기 경로 허용 목록(대화상자·열기·최근 문서로 들어온 경로만)·확장자 제한, 인쇄는 '인쇄 미리보기' 창에서, 하위 프레임 네비게이션 가드, Windows/Linux 키 중복 실행 방지 | 테스트 + 패키징 앱 CDP |


## 14. 8차 (2026-10-23) — 확장 (`docs/04` §9.2 8차)

| 항목 | 구현 | 검증 |
|---|---|---|
| 편집기 전용 도구 7개 | `merge_table_cells`·`split_table_cell`·`shade_table_cells`·`insert_note`·`list_notes`·`edit_note`·`insert_toc`: 서버 실행이 없고 라이브 세션의 플러그인만 실행(없으면 `UNSUPPORTED`). 거절 이유는 우리 코드로 옮김 | 레지스트리·스킬 생성·`test_live.py` |
| Node 사이드카 | `engine/rhwp_node.py` + `engine/rhwp_convert.mjs`: 옛 HWP 업로드를 서버에서 HWPX로 변환(외부 MCP 클라이언트·데스크톱 백엔드). Node 탐색: `EDITOR_NODE_BIN`(데스크톱은 Electron 실행 파일 + `ELECTRON_RUN_AS_NODE=1`) → PATH `node`; 엔진 폴더 `EDITOR_RHWP_DIR`(`resources/web/public/rhwp-core`, 글루 `rhwp.js`+WASM) → 저장소의 `frontend/public/rhwp-core`. 글자 폭 스텁이라 변환에만 쓴다 | `tests/test_rhwp_node.py`(HWPX→HWP→HWPX 왕복, HWP 업로드) |
| 설치본 스모크 | `desktop/scripts/smoke-app.sh`: 앱 실행 → `/api/health`·웹 200 → 종료 | 수동/빌드 뒤 |
| 보류 | 구독 CLI 경로(§9.3-2), docx-engine·CLI·가리기(9차 선택) | — |

## 15. 7차 리뷰 반영과 패키징 앱 결함 수정 (2026-10-23)

**결함(패키징 앱에서만)**: 탭마다 SSE 1개 + 라이브 롱폴 1개를 열어 두니 브라우저의 출처당 연결 상한(6)에 걸려 탭 셋부터 모든 요청이 줄을 섰다(개발 서버에서는 탭이 하나라 안 보였다). 라이브 세션 상태 `false`가 증상이었다.

| 항목 | 수정 |
|---|---|
| 전달 경로 | 라이브 요청은 SSE `live-request` 이벤트(세션 id 포함)로, 결과는 `POST …/results/{id}`, 살아 있음은 heartbeat(15초, `STALE_S` 40). 롱폴 `next`는 남기되 브라우저는 쓰지 않는다(`anyio` 스레드 제한 200으로 기본 스레드풀과 분리) |
| 연결 수 | SSE는 **보이는 탭만** 연다(`DocumentView`). 다시 보일 때 서버 머리를 읽어 리비전이 움직였으면 한 번 다시 읽는다(따라잡기). 라이브 세션도 보이는 탭만 등록한다(새 등록이 이전 것을 밀어내는 서버 규칙과 맞물림), `pagehide`에 닫는다 |
| 자기 리비전 식별 | 편집기마다 `clientId`(`X-Editor-Client` 헤더 → `edit` 이벤트의 `client`). 라이브 실행 리비전은 세션의 client로 찍히므로 그 편집기만 다시 읽지 않고, 같은 문서를 연 다른 창은 다시 읽는다 |
| 실행 전 비우기 | `beforeExecute`: 다시 읽는 중이면 거절(서버 실행), 아니면 올리지 않은 타이핑을 먼저 사용자 리비전으로 올린다(AI 리비전에 섞이지 않음). 겹치는 다시 읽기는 토큰으로 마지막 것만 `reloading`을 푼다 |
| 리뷰(7차) 반영 | 폴백 때 `db.expire_all()` 뒤 다시 적재(낡은 세션 객체로 STALE_REVISION 나던 것), `commit_edit` 머리 검사, `foreign` 포착, `all=True`는 대소문자가 정확히 같을 때만, `onApplied`는 결과 200 뒤·seq는 내보내기 전에 읽기, 2단계 undo, 플러그인 거절 코드 표, 결과 크기 상한(JSON 64KB·파일 업로드 상한), 스튜디오마다 다리 하나(`StudioHandle.bridge`) |
| 검증 | 백엔드 152 통과·4 건너뜀, vitest 22, tsc·eslint 0, Playwright 8(라이브·선택 포함), 패키징 앱 CDP: 라이브 세션 true·플러그인 실행·서버 폴백·경로 거절, **탭 8개**에서 fetch 6ms·세션은 보이는 탭만·활성화 따라감·숨은 탭 따라잡기(리비전 2, epoch +1) |

### 15.1 서브에이전트 리뷰 3회차 (라이브 전달 경로) — 모두 반영 (2026-10-23)

| # | 지적 | 반영 |
|---|---|---|
| 1 | `live-request`가 `lastEvent`로 들어와 진행 중인 다시 읽기를 끊음 | `DocumentView`가 라이브 요청을 ref 콜백(`liveRequestRef`)으로 편집기에 바로 넘긴다; `lastEvent`는 edit/undo만 |
| 2 | 편집기 올리기가 마지막-쓰기-승리 | 편집기는 `X-Editor-Base`(알던 머리)를 보내고, 서버는 머리가 다른 쪽 때문에 움직였으면 409 `STALE_REVISION`(+`revision_seq`), 자기 client 리비전 뒤면 허용(리비전 `command.client` 기록). 편집기는 409면 머리를 읽어 다시 읽는다(타이핑은 AI 편집에 밀린다, §9) |
| 3 | 등록 실패·heartbeat 410 뒤 재등록 없음 | 등록 실패는 3초 뒤 재시도(404는 끝), 410은 세션을 잃은 것으로 보고 **창이 초점을 가질 때** 5초 뒤 다시 등록(두 창이 번갈아 빼앗는 핑퐁 방지) |
| 4 | SSE 재연결 때 따라잡기 없음 | 따라잡기를 50ms 타이머 대신 `ready` 이벤트마다(처음·재연결) |
| 5 | 따라잡기가 자기 올리기 위를 덮음 | `await inflight` 뒤 `seq <= knownSeq` 재검사 |
| 6 | 라이브 실행 중 느린 폴링이 AI 내용을 사용자 리비전으로 올림 | `onBusy`(비우기 뒤 ~ 결과 전송 끝) 동안 flush·settle·poll 정지 |
| 7 | 세션 교체 뒤 결과 리비전 client가 새 세션 것 | `LiveRequest.client`에 요청 세션의 표식 |
| 8 | 시간 초과와 결과 도착의 경합 | 잠금 안에서 `done`을 다시 보고, `complete`는 끝난 요청을 거절 |
| 9 | `request.revision_seq` 미사용 | `revision_seq < knownSeq`면 `LIVE_FALLBACK`(서버가 최신 위에서 실행) |

검증: 백엔드 155 통과(라이브 테스트 +3: 기준 리비전 409/허용, 요청 세션 client, 시간 초과 경합), vitest 22, tsc·eslint 0, Playwright 8, 패키징 앱 CDP 단일 탭·탭 8개 모두 통과.

**패키징 검사 함정**: 이전 실행이 남긴 `editor-server`가 47371을 잡고 있으면 새 앱의 백엔드는 다른 포트로 물러나고(선호 포트 + 폴백), 밖에서 47371로 묻는 검사는 옛 프로세스와 이야기해 "라이브 세션 false·편집 미반영"처럼 보인다. `smoke-app.sh`가 실행 전후로 남은 백엔드를 끝낸다.

## 16. 서식 막대 (2026-10-23) — 글꼴·크기를 바로 고친다

사용자 요청: 이음오피스 화면처럼 글꼴·글자 크기 등을 도구 막대에서 바로 고칠 수 있어야 한다.

| 항목 | 구현 | 검증 |
|---|---|---|
| 스튜디오 패치(우리 코드) | `frontend/scripts/studio-format-patches.mjs` — 공개 SDK에는 글꼴·크기를 지정하는 명령이 없다(토글·대화상자뿐; 자체 도구 막대는 내부 이벤트 `format-char`로 동작). 자체 빌드에 다섯 패치를 더한다(import 포함): 명령 문맥에 캐럿 서식 `format`(글꼴·크기(HWPUNIT)·굵게/기울임/밑줄/취소선·글자색·형광펜·정렬·줄 간격 %)과 `documentFonts`, 매개변수 명령 `format:set-char`(fontName→fontId 변환 뒤 `format-char`: 선택이 없으면 캐럿 대기 서식)·`format:set-para`(`applyParaPropsAtCursor`). 패치는 `third_party/ieumoffice-hwp/rhwp-patches.mjs`의 같은 "정확히 한 번" 기제로 적용되고 빌드 스탬프에 포함된다 | 빌드 통과, 번들에 `format:set-char` 포함 |
| 서식 막대 | `components/FormatBar.tsx`(메뉴 줄·도구 막대 아래 셋째 줄): 글꼴 select(문서 글꼴 + 흔한 글꼴 15, 항목을 그 글꼴로 미리 보기), 크기 입력(pt, datalist 24단계, ▴▾ 1pt, Enter/blur 적용, Esc 취소), 배율 select(`view:zoom-N`, 맞춤 배율은 현재 값으로 표시), 굵게/기울임/밑줄/취소선 토글(눌림 상태), 글자색·형광펜(`<input type=color>`), 정렬 4(눌림 상태), 줄 간격 select(%). 상태는 `commands.context()`를 400ms마다 읽는다(왕복 하나, 문서 해시 없음; 바뀐 것만 렌더). 단추는 `mousedown` preventDefault로 초점을 편집기에 남긴다 | e2e "서식 막대" 1(크기 20pt·굵게·글꼴·가운데·줄 200%·리비전 올라감) |
| 도구 막대 정리 | `TOOLBAR`에서 서식 항목(굵게·크기·정렬·줄 간격)을 빼고 되돌리기·표·그림·쪽 나누기·글자 모양/문단 모양 대화상자·찾기/바꾸기만 남김 | Playwright 9 |
| 캐럿 대기 서식 | 선택 없이 고르면 스튜디오는 서식을 캐럿에 예약한다(다음 타이핑부터, `getPendingCharShape`). 문맥의 `format`은 그 예약을 덮어 보여 주고 `pending`을 세워 막대가 "다음 입력부터"를 표시한다. 고른 글꼴 이름은 `cddFontNames`(id→이름)로 기억해 예약 중에도 이름을 보인다 | e2e(14pt 예약 표시), 패키징 앱 CDP |
| 공개 미러 빌드 | `format`이 없으면 막대는 토글·정렬만 동작하고 안내 문구를 보인다 | — |

**설치된 글꼴 (사용자 질문 "시스템 글꼴을 모두 쓰는 게 아닌가")**: 스튜디오는 Local Font Access API(`queryLocalFonts`)로 설치 글꼴을 감지해 저장하고(IndexedDB) 화면도 그 글꼴 바이트로 그린다 — 공개 빌드에서는 옵션 대화상자 단추로만 되고 embed 모드에서는 닿을 수 없었다. 패치로 명령 `tools:detect-local-fonts`(감지 → `local-fonts-changed`)와 문맥 `localFonts`를 더했다. 데스크톱(Electron)은 이 권한을 묻지 않고 허용하므로(점검: 1,175 face·476 family) 문서를 열면 자동 감지하고(처음 한 번은 글꼴 파일의 이름표를 모두 읽어 수십 초 걸리며 그동안 목록에 "감지 중"을 보인다; 결과는 저장되어 다음 실행부터 즉시), 서식 막대의 글꼴 목록이 **문서 글꼴 / 설치된 글꼴 (N) / 기본 글꼴**로 묶인다. 웹판은 브라우저가 허락을 묻고 사용자 동작이 필요해 목록의 "설치된 글꼴 불러오기…" 항목으로 부른다(Safari·Firefox는 API가 없어 기본 글꼴만).

보류: 언어별 글꼴(한글/영문 따로), 형광펜 지우기, 스타일 select — 수요가 있으면 같은 패치 경로로 더한다.

### 16.1 사용감 수정 (2026-10-23)

| 문제 | 원인 | 수정 | 검증 |
|---|---|---|---|
| 본문을 눌러도 열린 메뉴가 안 닫힘 | 본문은 iframe(스튜디오) 안이라 그 클릭이 셸 창의 `mousedown`에 오지 않는다 | 메뉴가 열려 있는 동안 iframe 창(같은 출처)의 `pointerdown`·`keydown(Esc)`도 듣고, 셸 창 `blur`(초점이 iframe으로 감)도 닫는 신호로 쓴다 (`EditorChrome`) | e2e "열린 메뉴는 본문을 누르면 닫힌다", 패키징 앱 CDP |
| 저장 안 된 문서 대화상자에서 "닫기"를 눌러도 창이 안 닫힘 | 창 `close`에서 묻고 통과시켜도 뒤이어 렌더러의 `beforeunload` 보호(웹판과 같은 것)가 또 막았다 — 두 번째 막음에는 묻지 않아 아무 일도 없어 보였다 | 묻는 곳을 `webContents` `will-prevent-unload` 하나로 옮겼다: 렌더러가 막을 때만 한 번 묻고, "닫기"면 `preventDefault`로 그 막음을 풀어 내린다(`__forceClose`). `CDD_TEST_AUTO_CLOSE=1`이면 자동 점검용으로 "닫기"로 답한 셈 친다 | 패키징 앱 CDP: 편집으로 dirty 표시 → `window.close()` → 앱 종료 |

패키징 앱 점검 메모: `nohup`으로 실행 파일을 직접 띄우면 창이 뜨지 않고 CDP 페이지가 없는 채로 남을 수 있다 — `open -a App --env KEY=V --args …`로 띄운다.

## 17. DOCX 쪽 보기 (2026-10-23)

사용자가 Word 문서(검토본 .docx, 9MB, 문단 430·표 6·그림 2·7쪽)를 열자 번호 붙은 블록 목록("[1] … [2] …")이 떠 "이상하게 보인다"고 했다. HWPX는 rhwp-studio로 WYSIWYG였지만 DOCX는 블록 편집기였다.

| 항목 | 구현 | 검증 |
|---|---|---|
| 쪽 모양 그리기 | `docx-preview` 0.4.1(Apache-2.0, **의존성으로만** 사용; 복사한 코드 없음)로 서버의 현재 리비전 바이트를 쪽 단위로 그린다(머리말·꼬리말·각주·그림·표·글꼴). `components/DocxEditor.tsx` 쪽 보기가 기본, "블록 보기"로 바꿀 수 있다 | 검토본: 7쪽 렌더 |
| 그린 요소 ↔ 블록 번호 | 본문(`section.docx > article`)의 `p`·`table`을 문서 순서로 세면 엔진 `blocks()`와 같은 번호(둘 다 w:body의 문단·표, sdt 안 문단을 펼침). 표 칸은 rowSpan/colSpan을 따라 (행,열)을 세어 `table_grid`와 맞춘다. 자리 칸(gridBefore/After)은 건너뛴다 | 검토본에서 블록 202/202·칸 196/196 글 일치 |
| 그 자리에서 고치기 | 두 번 클릭 → 요소 위에 textarea → `set_paragraph_text`/`set_table_cells(overwrite)` → 리비전 → 다시 그림. AI 편집 이벤트도 다시 그리고 바뀐 블록을 4초 표시·스크롤. AI 패널의 "이 블록으로"도 쪽 보기에서 동작 | e2e "Word 문서는 쪽 모양…" |
| 인쇄 | 쪽 보기는 `@media print`에서 도구 줄·그림자를 빼고 쪽을 그대로 인쇄한다 | — |

미구현이었던 것(자유 타이핑·서식 막대)은 §18(9차)에서 Tiptap 편집기로 해결했다. docx-preview 쪽 보기와 블록 보기는 걷어냈다.


## 18. 9차 (2026-10-24) — DOCX 편집기: GenOffice 기준 반영 D1–D4 (`docs/04` §12)

사용자 결정: "DOCX는 genoffice 기준, HWP는 openoffice의 apps/hwp 기준", "D1·D2·D3·D4 모두 진행". Apache-2.0 코드는 `third_party/genoffice-docx/`에만 둔다(그대로 복사, ORIGIN.md).

### 18.1 D1 저장 충실도 (우리 lxml 엔진, 코드 복사 없음)

| 규칙 | 구현 (`backend/app/engine/docx_fidelity.py`, `docx.py`) | 검증 (`tests/test_docx_fidelity.py`) |
|---|---|---|
| 안 바뀐 본문 요소는 원본 바이트 그대로 | 읽을 때 `word/document.xml`에서 `w:body` 맨 위 자식의 바이트 범위를 재고(태그 스캐너: 따옴표 속 `>`·주석·CDATA·PI) lxml 자식마다 직렬화 지문을 남긴다. 저장할 때 지문이 같으면 원본 범위를 잇고, 바뀐·새 요소만 직렬화한다(루트가 선언한 네임스페이스는 되풀이하지 않음, `with_tail=False`, UTF-8 그대로). 범위와 자식이 어긋나면 전체 직렬화로 폴백 | 무변경 왕복 = 모든 zip 항목 바이트 동일; 문단 하나 고치면 그 범위만 다름; 손으로 쓴 문서(공백·작은따옴표 속성·주석) 유지; 폴백 경로 |
| 다른 부분도 손대지 않으면 그대로 | `styles.xml`·`.rels`·`[Content_Types].xml`은 지문이 같으면 읽은 바이트 | Heading 스타일을 만들 때만 `styles.xml`이 다시 쓰임 |
| zip 항목 | 원래 순서(Word는 Content_Types를 맨 앞에 두지 않기도 함)·압축 방식·시각 보존. 무재압축 복사는 하지 않음(내용 같고 압축 결과만 다를 수 있음) | 실제 Word 문서 3개(`CDD_DOCX_SAMPLES=디렉터리`): 9MB 검토본 202블록·381·509블록 — 무변경 왕복 바이트 동일, 한 문단 고친 결과를 python-docx와 LibreOffice(PDF 변환)가 읽음. 저장 0.44초(9MB) |

바뀐 문단도 나무 편집이라 손대지 않은 자식(pPr·rsid·책갈피·주석 범위)은 그대로다(상위 엔진의 `rawPPr` 보존과 같은 효과). 주석(`<!-- -->`)이 본문에 있던 문서에서 `blocks()`가 깨지던 버그도 고쳤다.

### 18.2 D2 엔진 들여오기 (`third_party/genoffice-docx/`)

- 가져온 것(그대로 복사, 커밋 `8ab58a5` 2026-10-23): `packages/docx-engine`(src·tests·scripts), `zip-gate`, `agent-core`의 `redact-range`·`redact-core`, `pptx-engine`의 차트 워크북·도형 기하(+`types`가 참조하는 `chart`·`theme`·`color`), `tsconfig.base.json`. LICENSE·NOTICE-upstream·NOTICE·ORIGIN.md.
- 우리 입구: `frontend/src/lib/docx-engine.ts`(openDocx·visibleBlocks·engineBlockAt·originalSaveBlocks·paragraphWithText·saveDocxBytes). 서버 `/blocks`가 `index`(w:body 맨 위 요소 번호 = 엔진 `docxIndex`)·`sub`(sdt 안 문단 번호)를 주어 블록 번호를 맞춘다.
- 번들: Next(Turbopack)는 프로젝트 밖 파일을 묶지 않으므로 `frontend/scripts/sync-genoffice.mjs`가 `third_party/genoffice-docx`를 `frontend/vendor/genoffice-docx/`(git 무시)로 복사하고 tsconfig `paths`·vitest alias로 `@genoffice/*`를 푼다. `shims/docx-engine.ts`는 가져온 커밋의 `index.ts`가 빠뜨린 resolve-props 내보내기를 보탠다(파일은 고치지 않음).
- 검증: `docx-engine.test.ts`(읽기·sdt 대응·무변경 저장 바이트 동일·문단 고치기·실제 문서 3개 보이는 블록 = 본문 맨 위 p·tbl·sdt 수). 엔진 자체 테스트 `pnpm test:genoffice` 1,905 통과(1 건너뜀). 처음엔 15개가 실패했는데, 상위 커밋의 `index.ts`가 resolve-props 내보내기를 빠뜨린 탓이라 시험의 `../src/index` 가져오기만 우리 입구 심으로 돌렸다(상위 파일 무수정).

### 18.3 D3 편집기 (Tiptap, `frontend/src/components/DocxEditor.tsx` + `lib/docx-editor.ts`)

| 항목 | 구현 |
|---|---|
| 편집기 핵심 | `apps/docs/src/renderer`의 닫힘(132파일 7.7만 줄: `editor/` 확장 85개·변환 `convert.ts`·페이지네이션·글꼴 측정·i18n·styles.css)을 상위 디렉터리 구조 그대로 복사. 리본·대화상자·AI 패널·Electron·글꼴 12MB는 제외. `shims/ui.ts`(순수 함수 둘만)·`shims/env.d.ts`(window.desktop 멤버 3개) |
| 쪽 모양 | `cdd-canvas-pagination.ts`(App.tsx 3688–4900행에서 **각색**, Apache 파생, third_party 안): 측정 → 엔진 쪽 나누기(`sliceWithLineSplit`) → 쪽 사이 띠(`setPageGaps`; 문단 중간·표 행 사이도). 머리말/꼬리말 띠·떠 있는 개체·여러 단·각주는 뺐다. 검토본 9MB: 열기 2.5초, 17쪽(띠 16), 표 6·그림 2 |
| 동기화 | 타이핑 1.2초 뒤 `pmDocToSavePlan`+`saveDocx`로 내보내, 작업 시작 때의 기준 리비전을 `X-Editor-Base`로 올린다(409면 서버 내용을 다시 읽고 알림). 저장 계획은 늘 연 리비전의 모델과 비교하며 올린 뒤 다시 읽지 않는다(실행 취소가 자동 저장을 넘어 이어진다). 다른 곳의 리비전은 먼저 올린 뒤 다시 읽고 바뀐 블록을 표시 — 올리기·다시 읽기는 한 줄로 차례를 선다. 내용 바꿔 넣기는 실행 취소 기록에 남기지 않는다. 저장·AI 전에 `shell.registerFlusher`로 먼저 올린다 |
| 서식 막대 | `FormatSource` 인터페이스(`lib/format-source.ts`)로 HWPX(`studioFormatSource`)·DOCX(`docxFormatSource`) 공용. DOCX는 `docTextStyle` 마크(글꼴·크기·색·바탕)·bold/italic/underline/strike·문단 속성(align·lineSpacing 배수)을 읽고 쓴다 |
| AI 도구 | 라이브 세션 재사용: 무엇이 오든 편집기는 먼저 타이핑을 올린다(실패하면 STALE_REVISION으로 거절 — 서버가 낡은 머리에서 실행하지 않게). `read_selection`/`replace_selection`/`format_selection`은 편집기가 실행(사용자 편집으로 치지 않음, 실행 취소 한 단계, 결과 + 내보낸 바이트; 서버가 거절하면 `undo` 요청으로 되돌림; 선택 범위 들여쓰기·문단 간격은 UNSUPPORTED). 그 밖의 편집 도구는 **먼저 올리기**(`hints.method = flush` → `LIVE_FALLBACK`) → 서버(lxml)가 최신 머리 위에서 실행 → 편집기가 다시 읽는다. 올린 변경으로 블록 수가 달라졌으면 블록 번호를 쓰는 도구는 STALE_REVISION. 도구 구현은 서버 하나 |
| CSS | `styles.css`(1.4만 줄)+`ui/tokens.css`를 postcss-prefix-selector로 `.cdd-docx` 아래로 좁힌 `styles.scoped.css`를 생성해 우리 셸 모양을 건드리지 않는다 |
| 제외/미구현 | 머리말·꼬리말 편집, 쪽 아래 각주 영역(§18.5에서 본문 뒤 목록으로), 여러 단, 변경 추적 UI, 그림 넣기(AI 도구로는 됨), 찾기/바꾸기 패널(서버 찾기 패널은 있음), 확대 외 보기 모드 |

### 18.4 D4 검증

- 백엔드 163 통과(5 건너뜀; 실제 문서 3개 포함 시 166), vitest 25, Playwright 11(1 건너뜀) — DOCX: 타이핑→자동 저장→서버 읽기, 서식 막대 굵게→`read_document(include_format)`에 "굵게", 서버 도구 `set_paragraph_text`→flush→실행→화면 반영. `pnpm build`(프로덕션) 통과.
- 상위 엔진 테스트 1,890 통과(`pnpm test:genoffice`, truths fixture 83개 디렉터리 포함). Word 실측 truths 실행기(pure 등급)는 §18.5에서 들여왔다.
- Tiptap으로 고쳐 저장한 9MB 검토본: python-docx 읽기, LibreOffice PDF 변환 성공. Word·한컴에서 직접 열어 보지는 못했다.

### 18.5 쪽 모양 보강 (2026-10-24)

| 항목 | 구현 | 검증 |
|---|---|---|
| 문서 스타일 시트 | `doc-style-css.ts`(그대로 복사)의 `docStyleCss`+`docThemeCss` — 문단 스타일·기본 글꼴·줄 높이 비율·테마. GenOffice는 전역 `<style>`이지만 DOCX 탭이 여럿이라 CSS 중첩으로 `[data-cdd-doc="탭"]` 아래로 좁힌다 | 단위 시험(범위 접두어), 브라우저에서 본문 글꼴이 문서 기본 글꼴(Cambria·Arial)로 |
| 구역 | `canvasGeometry`: 구역마다 용지·여백·머리말 높이(`hfReservedHeightPx`)로 `sectionGeoms` → 엔진 쪽 나누기. 첫 쪽 본문 위치는 첫 쪽 머리말 아래 | 두 구역 시험 문서 9쪽 |
| 머리말·꼬리말 | 쪽 사이 띠에 앞 쪽 꼬리말·다음 쪽 머리말(`makeGapHfEl`, 쪽 번호·전체 쪽수 치환, titlePg·짝/홀수·구역별 연결 해석 `resolveHf`), 첫 쪽 머리말·끝 쪽 꼬리말은 쪽 둘레에. 읽기 전용(편집은 AI 도구·Word) | 시험 문서: "머리말…"·"꼬리말 첫 구역"·"둘째 구역 머리말" 표시, 글꼴 일치 |
| 쪽 나누기 규칙 | 파싱한 블록에서 keepNext·keepLines·widow·표 행 플래그(`tblHeader`·`cantSplit`)를 `metaOf`로 | — |
| 엔진 보정 | 높이 지정 행 나누기 채우기·쪽보다 큰 줄 자르기·쪽 기준 떠 있는 개체·떠 있는 표 흐름(`setRowFills`·`setOversizeClips`·`setFloatVShifts`) | — |
| 끝 쪽 | 끝 쪽도 용지 높이까지 채워 꼬리말이 용지 아래에 온다 | — |
| 각주·미주 | 쪽 아래 영역 대신 본문 뒤 목록(`docxNotes`) | 단위 시험(각주 1개) |
| truths | `apps/docs/tests/truths.test.ts`(그대로) + `vitest.truths.config.ts` — pure 등급 | **384 통과**, 4 건너뜀 |

### 18.6 리뷰 반영 (2026-10-24, 서브에이전트 리뷰)

| 지적 | 고침 | 시험 |
|---|---|---|
| 연 직후 ⌘Z가 문서를 비우고 자동 저장 | 내용 바꿔 넣기를 한 트랜잭션(`addToHistory:false`)으로; 올린 뒤 rebase 제거(연 리비전 모델과 비교) | e2e: 연 직후 ⌘Z, 자동 저장 뒤 ⌘Z가 타이핑을 되돌리고 다시 올라감 |
| 다시 읽기와 자동 저장 경합으로 AI 편집이 조용히 되돌려짐 | 기준 리비전을 작업 시작 때 읽음, 다시 읽기를 올리기 줄에 넣음, 다시 읽는 사이 친 글은 알림 | — |
| 편집기 실행이 올리지 않은 타이핑을 섞고, 서버의 undo를 무시하고, dirty를 너무 일찍 지움 | 실행 전 올리기(실패 시 거절), `undo` 처리, 실행은 사용자 편집으로 치지 않음 | e2e: 선택 범위 바꾸기가 편집기에서 실행되고 리비전이 됨 |
| 올리기 실패에도 폴백 / 낡은 블록 번호 | 실패는 STALE_REVISION; 서버는 폴백 뒤 블록 수가 바뀌었으면 블록 번호 도구를 거절 | `test_server_fallback_refuses_block_numbers_after_editor_added_blocks` |
| 서버·편집기의 블록 번호 셈법 차이(콘텐츠 컨트롤) | 서버 `index`를 엔진 셈법대로(부분 둘 이상이면 부분마다, 안쪽 컨트롤 투명) | 같은 XML로 서버(pytest)·엔진(vitest) 양쪽 시험 |
| 선택 범위 모양: 못 하는 키를 했다고 보고 | 들여쓰기·문단 간격은 UNSUPPORTED | — |
| (전체 e2e에서 드러남) 빈 기록에서 ⌘Z가 브라우저 자체 실행 취소로 새어 선택 기록이 어긋남 | ⌘Z·⌘⇧Z·⌘Y를 편집기가 늘 먹는 확장 | 전체 e2e 2회 연속 통과 |

| (패키징 앱에서 드러남) Word 편집기의 설치 글꼴 목록이 비어 있음: 셸이 `local-fonts` 권한을 주지 않아 사용자 동작 없이는 거절되고, 문서를 여는 도중의 첫 `queryLocalFonts`는 답이 오지 않음 | 셸 `grantLocalFonts`(앱 자신의 출처만), 5초 제한 + 늦춰 다시 묻기 + 초점·첫 클릭 때 다시 묻기; 상태는 `.cdd-docx[data-local-fonts]` | 앱 CDP: 476 가족(서식 막대 471) |

남은 차이: altChunk(HTML 조각) 문서는 편집기 엔진이 여러 블록으로 펼쳐 그 뒤의 번호가 서버와 어긋난다(바뀐 블록 표시·이동만 영향).

### 18.7 남은 것 보강 — GenOffice 참고 (2026-10-24)

사용자 요청: "안 되는 것들을 다른 프로젝트 참고하여 잘 개발해 주세요" (머리말·꼬리말 편집, 쪽 아래 각주, 여러 단, altChunk 번호, Word에서 열어 보기).

| 항목 | GenOffice에서 본 방식 | 우리 구현 | 검증 |
|---|---|---|---|
| 머리말·꼬리말 편집 | 띠를 두 번 누르면 띠 안에 작은 Tiptap 편집기(`mountHfEditor`), 바깥으로 초점이 나가면 확정, 고친 부분은 `withHfEdit` 대기 상태 → `hfSaveOptions`로 저장 | `editor/hf-editor.ts`를 그대로 복사, `cdd-canvas-pagination.ts`의 `startStripEdit`/`commitHfEdit`/`pendingSaveOptions`. 쪽 사이 띠·첫 쪽 머리말·끝 쪽 꼬리말 모두(빈 띠도 두 번 누를 자리로 남김). 고치는 동안 쪽 나누기는 쉬고 닫히면 다시 | e2e·브라우저: 고친 머리말이 모든 쪽에, 저장된 `header1.xml`에 |
| 쪽 아래 각주 | 각주 참조가 든 블록이 쪽 아래 높이를 예약(`footnoteExtraPx`)하고, 쪽 사이 띠 위쪽에 앞 쪽 각주 영역(`makeGapNotesEl`), 높이는 DOM 실측 | `blockNoteScanRuns`·`appendNoteRuns`·`measureNoteHeightDom`·`makeNotesEl`을 각색해 넣음. 끝 쪽 각주는 쪽 둘레 요소로. 각주를 두 번 누르면 작은 창에서 글을 고친다(글자 모양은 지워짐 — 원본 대화상자와 같음) | 단위 시험(예약·저장), e2e(쪽 아래 표시·고치기·`footnotes.xml`) |
| 여러 단 | 단이 같은 문서는 CSS 다단(uniform), 아니면 블록마다 단 자리로 옮기는 장식(mixed) | 모든 다단 문서를 mixed 방식으로: 측정은 한 흐름(`measuring-columns`), 엔진이 단 자리를 정하고 `setColumnLayout`, 너비가 바뀌면 한 번 더(`widthPassGate`, 최대 6회), 쪽 사이 띠는 비워진 단 높이만큼 끌어올림 | e2e·브라우저: 두 단 구역의 블록이 두 자리(왼쪽·오른쪽)에 |
| altChunk 번호 | 엔진은 끼워 넣은 .docx 조각을 여러 블록으로 펼치고 둘째부터 길이 0인 자리로 둔다 | `editorIndexOf`(서버 자리 → 엔진 번호, 길이 0인 자리는 건너뜀) + 문단 글이 다르면 같은 글의 노드를 찾는 대체 | 단위 시험(끼운 .docx 조각 뒤 번호) |
| Word에서 열기 | — | Microsoft Word를 AppleScript로 열어 쪽수 세기·PDF 내보내기(Word 샌드박스 폴더의 사본, 끝나면 지우고 Word 종료) | 머리말·각주·두 단 시험 문서: 고친 머리말 모든 쪽, 고친 각주 1쪽 아래, 두 단 — 모두 Word에서 그대로. 9MB 검토본(고침 포함): Word 17쪽 = 우리 17쪽 |

남은 차이:
- HTML altChunk(GenOffice는 숨은 Electron 창으로 HTML→docx 변환)는 변환하지 않는다 — 미리보기 블록으로 보이고 저장 때 그대로 남는다.
- 한컴오피스 HWP는 AppleScript 사전이 없어 자동으로 열어 보지 못했다.
- 시험 문서의 쪽수가 Word 6쪽 / 우리 5쪽이다. 한글 글꼴 대체(Word for Mac의 대체 글꼴 줄 높이)가 다르기 때문이며, 9MB 검토본은 같다.
- 미주는 문서 끝 목록, 머리말의 떠 있는 그림·워터마크는 그리지 않는다.

리뷰 반영(2026-10-24, 서브에이전트 리뷰): ① 머리말·꼬리말을 고치는 도중 다른 곳의 리비전·AI 요청·저장이 오면 편집기를 먼저 확정해 함께 올린다(전에는 다시 읽기가 고치던 글을 조용히 버렸다; e2e로 확인) ② 올리는 사이 확정된 머리말·각주 편집이 "깨끗함"으로 지워지던 것 — 편집 번호로 확인 ③ 표 안에서 끝나는 쪽의 각주는 끝 쪽으로 옮기고 그만큼 끝 쪽을 늘린다 ④ 끝 쪽 높이는 DOM 높이(되풀이 머리 행 포함) 기준 ⑤ 각주 창을 연 뒤 문서가 다시 읽혔으면 저장하지 않고 알린다.

설치 글꼴 목록 보충(2026-10-24): 한글 탭이 여럿 복원되면 rhwp 편집기들이 글꼴 바이트를 읽는 동안 `queryLocalFonts`가 30~60초 줄을 선다(탭 16개에서 관측). Word 편집기는 창마다 한 번만 묻고(탭끼리 결과 공유, 보이는 탭만), 최대 90초 기다린다. 앱에서 탭 16개 복원 상태로 75초 안에 476 가족(서식 막대 471) 확인.

설치 글꼴 목록 다시 고침(2026-10-24, 사용자 보고 "계속 감지 중"): 사용자 창(탭 다수)에서는 90초 기다림·세 번 다시 묻기 뒤에도 "감지 중"에 남았다 — 화면의 `queryLocalFonts`에 기대는 방식을 버렸다. 데스크톱은 메인 프로세스(`desktop/fonts.js`)가 글꼴 폴더(macOS `/System/Library/Fonts`·`/Library/Fonts`·`~/Library/Fonts`·`/System/Library/AssetsV2`, Windows `%WINDIR%\Fonts`·사용자 글꼴, Linux `/usr/share/fonts` 등)의 `.ttf/.otf/.ttc/.otc` 파일에서 **name 표만** 읽어 가족 이름(16번 우선, 영문·한국어)을 모은다(이 맥: 607 가족, 0.2~0.6초, 앱 시작 때 미리 읽음). 프리로드 `listFonts()` → `lib/installed-fonts.ts`가 창마다 한 번 받아 서식 막대가 HWPX·DOCX 모두에 쓴다. 목록 값은 영문 가족 이름(화면 CSS가 언제나 맞춘다 — `Apple SD 산돌고딕 Neo` 같은 시스템 글꼴의 한국어 이름은 Chromium이 못 맞춤을 확인), 보이는 이름은 "한국어 (영문)". Mac 기록에 EUC-KR을 넣은 옛 한글 글꼴(전주 완판본 등)은 EUC-KR로 읽는다. 웹판은 그대로 "설치된 글꼴 불러오기…"(사용자 동작 안의 `queryLocalFonts`).

모델 넓히기(2026-10-24, 사용자 요청 "GPT-6.1 등 모델 추가"): 게이트웨이 단가표(`GET /llm/v1/pricing`, 키 필요)와 도구 호출 왕복 실측으로 정리했다.
- 경로: `gpt-6*`·`gpt-5.6+`·`*-codex`·`gpt-/o*-pro`는 Chat Completions에서 함수 도구를 거부한다(게이트웨이 400 "Function tools with reasoning_effort are not supported … use /v1/responses", 실측) → **OpenAI Responses**(`/llm/openai/v1/responses`, `store:false`, `include:["reasoning.encrypted_content"]`)로 보낸다. 한 실행 안에서는 Responses 출력 항목(추론 항목 포함)을 `Turn.items`로 들고 다음 요청에 그대로 돌려준다. 접두어 규칙이 모르는 새 OpenAI 모델이 같은 400을 내면 Responses로 한 번 더 보낸다. `grok-*`·`deepseek-*`·`muse-*`·`공급자/모델`(OpenRouter)은 OpenAI 호환 Chat Completions(`/llm/{grok|deepseek|meta|openrouter}/v1/…`, `max_tokens`).
- 목록: 추천 26개(도구 왕복 확인 — Claude 4·GPT 7·Gemini 4·Grok 2·DeepSeek 2·Meta 1·OpenRouter 6)를 묶음별로 위에, 단가표의 그 밖의 대화 모델(은퇴·그림·날짜 고정판·다중 에이전트 제외)을 "… — 그 밖의 모델"로 아래에 둔다. 단가표는 앱 전체 10분 캐시. 고른 모델의 1K 토큰당 크레딧을 목록 아래에 보인다.
- 실측(시험 키, 2026-10-24): 도구 왕복 OK — gpt-6.1-sol·gpt-6-sol·gpt-6-astra·gpt-6-luna·gpt-5.6-sol/terra/luna·gpt-5.5·gpt-5.4(mini·nano)·gpt-5·o3·gpt-4.1·gpt-4o, grok-4.7/4.6/4.5/4.3·grok-build-0.1·grok-4.20(reasoning/non-reasoning), deepseek-flash·deepseek-v4-pro, muse-spark-1.3, qwen3.8-max·kimi-k3·glm-5.3·gpt-oss-120b·solar-pro4·minimax-m3·llama-3.3-70b, gemini-4-argon·3.8/3.7/3.6/3.5-flash·3.5-flash-lite·3.1-pro-preview·2.5-pro/flash. 안 됨 — qwen3.8-flash(도구를 부르지 않음), mistral-large-2512(429), claude-haiku-5-5·gemini-pro-latest·gemma·chat-latest(게이트웨이 미지원), o4-mini(은퇴). **Claude 전 모델은 이날 게이트웨이의 Anthropic 잔액 부족(400 "credit balance is too low")으로 실패** — 앱 문제가 아니라 게이트웨이 운영 문제다.
- e2e `rhwp-chat.spec.ts`는 `CDT_E2E_MODELS`(쉼표)로 모델마다 실제 편집(읽고 고치기 → 서버 블록 확인)을 시험한다. gpt-6.1-sol·grok-4.7·gemini-3.8-flash·deepseek-v4-pro·qwen/qwen3.8-max 통과.

편집 용지(쪽 설정, 2026-10-24, 사용자 보고 "여백 부분 수정이 안 된다"): AI가 '여백'을 문단 간격·표 칸 여백으로만 고쳤다 — 용지 여백을 고칠 도구가 없었다.
- 엔진 `engine/pagesetup.py`(공통 mm 모델·용지 크기·검사) + `HwpxDocument/DocxDocument.page_setups()/set_page_setup()`. DOCX는 문단 안 `w:sectPr`(구역 끝)들과 본문 끝 `w:sectPr`의 `w:pgSz`(가로면 w·h를 바꾸고 `w:orient`)·`w:pgMar`(위·아래·왼쪽·오른쪽·머리말·꼬리말·제본, 스키마 순서대로 자리). HWPX는 구역 파일마다 `hp:secPr/hp:pagePr` — 너비·높이는 늘 세로 값, 가로는 `landscape="NARROWLY"`(한글 호환; rhwp 0.8.7 `getPageInfo`가 가로 문서를 1122.5×793.7px로 그림을 확인). 본문이 20mm 미만이 되면 거절.
- 도구 `set_page_setup`(31번째; section 없으면 모든 구역) — `document_info`의 "쪽 설정" 줄이 지금 값. 채팅 규칙에 '여백' 뜻 가르기(쪽 여백/문단 간격/표 칸 여백, 모호하면 묻기). DOCX 라이브 세션은 먼저 올리기(flush) 뒤 서버 실행 → 편집기가 다시 읽어 `docxGeometry`로 쪽 모양을 바꾼다. HWPX는 서버 실행 후 다시 읽기.
- 화면: Word 문서는 `PageSetupDialog`(파일 › 편집 용지…, F7, 쪽 여백 두 번 누르기) — 용지 종류·방향·여백·머리말/꼬리말·제본, 여러 구역이면 적용 범위, 본문 크기 미리 계산. 같은 도구로 서버가 고쳐 리비전으로 남는다. 한글 문서는 스튜디오의 편집 용지 대화상자(같은 메뉴·F7, 데스크톱 메뉴도 추가). 읽기 `GET /api/documents/{id}/page-setup`.
- 시험: `tests/test_pagesetup.py`(HWPX 가로 표기, DOCX 두 구역·한 구역만, 검사, 도구·API), e2e "Word 편집 용지"(메뉴로 왼쪽 15mm·가로 → 리비전 2, 편집기 왼쪽 여백 57px·용지 1123px, 범위·본문 크기 거절, 여백 두 번 누르기).

2026-10-24~25 사용자 보고 수정 묶음:
- **여백 표기(모서리 표시) 어긋남**: GenOffice CSS의 crop mark는 `--page-mt/mb/ml/mr`로 첫 쪽 본문 경계를 그리는데 우리 각색본 `cdd-canvas-pagination.ts`가 그 변수를 안 내보내 1인치 기본값에 그려졌다 → `pageMarginVars()`로 vars에 포함. 검사: 단위(vars)·e2e "편집 용지"(변수 = padding).
- **글꼴 바꾸기 미반영**: 모델이 `format_text find="." all=true`로 마침표에만 글꼴을 넣었고 이름도 한국어("에이투지체")였다. `format_paragraphs`에 `all`과 글자 모양(font/size/color/bold/italic: 범위 안 모든 글·표 칸·문단 끝 표시·빈 문단 run), `format_text`는 all+기호 find 거절, `app/fonts.py`(데스크톱이 `POST /api/fonts`로 설치 글꼴을 올리고 runner가 `font`를 가족명으로 정규화, 모르면 "주의"), `list_fonts` 도구(32개). 검사: `test_fonts.py`·`test_commands_full.py`·`test_docx.py`.
- **빈 머리말 띠가 본문과 겹침**: 머리말이 없는 문서도 두 번 누르기용 빈 띠를 머리말 위치(12.7mm)에 한 줄 높이로 그려 위 여백 15mm 문서에서 제목과 겹쳤다 → 빈 띠(`cdd-hf-empty`, 편집 중 아님)는 여백 띠 안(`--hf-empty-*`)에만 두고 편집을 시작하면 원래 자리로. 검사: e2e "편집 용지"(위 13mm에서 띠 바닥 ≤ 본문 위, 두 번 누르기·Escape).
- **표 칸 안 타이핑이 서버에 안 올라감** (rhwp 0.8.7 제약): 캐럿이 표 칸 안이면 `getSelectionContext()`가 칸 안 문단 번호로 쪽을 찾다 "렌더링 오류: 문단 (sec=0, para=N)이 페이지에 없습니다"를 던진다(`exportHwpx()`는 정상). 올리기 전 변경 번호 읽기가 이 호출이라 막혔다 → `studioChangeSeq()`: 실패하면 `getDocumentState().changeSeq`(문서 해시, 느리지만 같은 번호)로 물러선다. `read_selection` 같은 선택 기반 도구는 표 칸 안에서 여전히 엔진 오류를 돌려준다(상위 rhwp 이슈). 검사: 단위 `studio.test.ts`, e2e "표 칸 안에서 타이핑".
