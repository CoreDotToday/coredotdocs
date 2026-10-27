# coredotdocs

**HWPX·DOCX 문서를 AI와 함께 고치는 편집기** — 데스크톱 앱(Electron)과 웹 서비스(Docker)로 같은 코드를 씁니다.

[![CI](https://github.com/CoreDotToday/coredotdocs/actions/workflows/ci.yml/badge.svg)](https://github.com/CoreDotToday/coredotdocs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**1.0.0 Windows x64** — [릴리스 노트](docs/releases/v1.0.0.md) · [검증 결과](docs/releases/v1.0.0-validation.md) · [GitHub 릴리스 및 다운로드](https://github.com/CoreDotToday/coredotdocs/releases).

> **English** — coredotdocs is an AI-assisted editor for Korean Hangul (HWPX/HWP) and Word (DOCX) documents.
> It pairs a WYSIWYG editor (rhwp-studio for HWPX, Tiptap for DOCX) with an AI side panel and an MCP server,
> so Claude Desktop, Claude Code, Codex or the built-in chat can read and edit the open document.
> Every edit — by a person or by AI — is stored as an append-only revision and can be undone.
> Ships as a desktop app (FastAPI + SQLite bundled, no Docker needed) or as a Docker web service (PostgreSQL).

```
┌ 탭 줄: Core.Docs │ 문서1 ● │ 문서2 │ + ───────────────────────── 시작 화면 ┐
│ 메뉴: 파일 편집 보기 입력 서식 쪽 표 도구 AI 도움말                      │
│ 도구 막대: 저장 ↶ ↷ 글꼴 크기 가 가 가 가 글자색 형광펜 정렬 … 표 그림 [AI] │
│ ┌────────── WYSIWYG 편집기 ───────────────────────┐ ┌─ AI 패널 ──────┐ │
│ │  HWPX: rhwp-studio · DOCX: Tiptap                  │ │ AI 채팅         │ │
│ │  쪽 단위 조판 · 커서 · 표 · 그림 · 서식            │ │ 활동·도구 콘솔  │ │
│ │                                                   │ │ 찾기            │ │
│ │  상태 표시줄: 1/1 쪽 · 100%                        │ │ 리비전·되돌리기 │ │
│ └───────────────────────────────────────────────────┘ └────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

## 주요 기능

- **HWPX WYSIWYG 편집** — [rhwp-studio](https://github.com/edwardkim/rhwp) 0.8.7(MIT)을 소스에서 직접 빌드해 우리 서버가 제공합니다(오프라인 동작). 옛 HWP(.hwp)는 열 때 HWPX로 바꾸고, 저장할 때 위치를 묻습니다(원본 파일은 그대로).
- **DOCX WYSIWYG 편집** — Tiptap 편집기로 쪽 모양 그대로 타이핑하고 서식 막대로 글꼴·크기·색·정렬·줄 간격을 고칩니다. 머리말·꼬리말·각주는 두 번 눌러 그 자리에서 고치고, 여러 단 구역은 단 자리대로 그립니다. 저장할 때 바뀌지 않은 문단은 원본 XML 바이트를 그대로 둡니다.
- **앱 안 AI 채팅** — [core.today](https://core.today) LLM 게이트웨이를 쓰며, 사용자가 자기 `CDT_API_KEY`를 넣습니다. Claude·GPT·Gemini·Grok·DeepSeek·Meta·OpenRouter 모델을 고를 수 있고, 고른 모델의 1K 토큰당 크레딧이 표시됩니다.
- **외부 AI 앱 연결(MCP)** — 메뉴 AI → *Claude Desktop / Claude Code / Codex에 연결…* 을 누르면 각 앱 설정에 이 앱의 MCP 서버가 등록됩니다.
- **살아 있는 편집** — 편집기가 문서를 열고 있으면 AI 편집은 편집기 안의 플러그인이 실행합니다. 변경 하나가 실행 취소 한 단계이고, 바뀐 곳이 표시되며, 문서를 다시 읽지 않습니다. 편집기가 없으면 서버(lxml)가 실행합니다.
- **리비전** — 사람과 AI의 모든 편집이 append-only 리비전으로 남습니다(행위자·도구 인자 기록). 되돌리기는 과거 리비전을 새 리비전으로 복제합니다.
- **실시간 반영과 충돌 복구** — SSE로 AI 편집이 화면에 반영되고, 사람이 입력을 잠시 멈추면 앱의 사본과 동기화합니다. 외부 변경과 미동기화 입력이 겹치면 입력 내용을 별도의 ‘충돌 복구’ 문서에 보관한 뒤 외부 변경을 받습니다. 사본 생성에 실패하면 화면의 편집 내용을 유지하고 오류를 알립니다.
- **코어닷독스 도움말** — `F1` 또는 **도움말 → 코어닷독스 도움말**에서 문서 열기·저장, 편집, AI 설정, 외부 앱 연결, 리비전, 단축키, 문제 해결을 검색합니다. 도움말은 앱에 포함되어 오프라인에서도 열리며, **코어닷독스 정보**에서 현재 버전과 GitHub 릴리스 링크를 확인할 수 있습니다.

## 빠른 시작

```bash
git clone https://github.com/CoreDotToday/coredotdocs.git
cd coredotdocs
```

필요한 것: Python 3.13+와 [uv](https://docs.astral.sh/uv/), Node.js 24와 pnpm 12. 웹 서비스는 Docker도 필요합니다.

### 데스크톱 앱 (권장)

Windows에서는 PowerShell로 빌드합니다(Windows x64):

```powershell
cd desktop
pnpm build:win       # NSIS 설치 파일 + 실행 폴더
pnpm build:win dir   # 설치 파일 없이 실행 폴더만
# pnpm 스크립트 대신 직접 실행:
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

기본 출력은 `desktop/dist/coredotdocs-1.0.0-setup.exe`와 `desktop/dist/win-unpacked/coredotdocs.exe`입니다. 설치 없이 실행할 때나 실행 폴더를 옮길 때는 `win-unpacked` 전체를 함께 보관하세요.

Windows 1.0 설치 파일은 관리자 권한 없이 현재 사용자에게 설치하며, 기본 위치는 `%LOCALAPPDATA%\Programs\coredotdocs`입니다. 설치 폴더 선택 화면 없이 진행하고, 기존 현재 사용자 설치를 업그레이드할 때는 등록된 설치 위치를 유지합니다. 문서 사본과 로그는 `%APPDATA%\coredotdocs`에 보관합니다.

기존 `dist`의 앱이 실행 중이면 별도 출력 폴더로 빌드하세요. 이번 1.0.0 검증 빌드는 다음과 같이 `desktop/dist-next`에 만들었습니다.

```powershell
# desktop 폴더에서 실행
$env:OUT_DIR = "dist-next"
pnpm build:win
$env:OUT_DIR = $null
```

이 경우 설치 파일은 `desktop/dist-next/coredotdocs-1.0.0-setup.exe`, 앱은 `desktop/dist-next/win-unpacked/coredotdocs.exe`입니다. Windows 패키지 실행, 현재 사용자 설치·제거와 파일 연결, 실제 AI 요청, Word·한컴오피스 왕복 검사를 수행했습니다. DOCX PDF의 빈 페이지와 반복 서식 문제, 패키지 라이선스 누락은 수정하고 회귀 검증했습니다. 설치 파일은 코드 서명이 없는 배포본이며, GitHub Actions가 계정 결제·지출 한도 문제로 차단되어 로컬 검사 결과를 사용합니다. 최종 설치 파일의 해시와 재검증 상태, 구체적인 검사 범위는 [1.0.0 검증 결과](docs/releases/v1.0.0-validation.md)에 기록합니다.

저장소 루트에서 패키지 점검을 다시 실행할 수 있습니다. 점검은 별도 사용자 데이터 폴더를 쓰며 결과와 화면을 `desktop/dist/smoke-*/`에 남깁니다.

```powershell
node desktop/scripts/smoke-app-win.cjs desktop/dist-next/win-unpacked/coredotdocs.exe
```

macOS·Linux용 셸 스크립트도 있습니다. 현재 공개 배포 검증과 Python 네이티브 라이브러리 고지 검증은 Windows x64만 완료했습니다. 다른 플랫폼은 해당 플랫폼의 실제 런타임 구성과 고지를 검토하여 `desktop/licenses/python-runtime-3.13.18.json`에 검증 자료를 추가하기 전까지 패키징을 중단합니다. 기존 Mac DMG는 이번 공개 릴리스에 포함하지 않습니다. 검토 후 사용하는 빌드 명령은 다음과 같습니다:

```bash
cd desktop
./build.sh dir     # 실행 폴더만 (빠름) → dist/mac-arm64/coredotdocs.app
./build.sh         # macOS: .app + .dmg · Windows: NSIS · Linux: AppImage
pnpm start         # 개발: 패키징 없이 Electron으로 실행 (먼저 ./build.sh dir 한 번)
```

앱 안에 백엔드(PyInstaller로 묶은 FastAPI, **SQLite**), Next.js 서버, rhwp-studio, rhwp WASM이 모두 들어 있어 Docker나 PostgreSQL 없이 실행됩니다.
`.hwpx`·`.hwp`·`.docx` 파일 연결을 지원하고, 데이터와 로그는 `~/Library/Application Support/coredotdocs/`(macOS), `%APPDATA%\coredotdocs\`(Windows)에 둡니다.

<details>
<summary>macOS 서명 메모</summary>

- Developer ID 서명이 없으면 ad-hoc 서명으로 빌드됩니다. 외부 배포용 Mac 패키지는 해당 Mac에서 의존성 고지·실행 검증을 마치고 서명·공증 상태를 함께 안내해야 합니다.
- `MAC_SIGN_IDENTITY` 환경 변수로 실제 인증서 서명을 할 수 있습니다(공증은 별도).
- ad-hoc 서명은 Developer ID 서명이나 Apple 공증을 대신하지 않습니다. Gatekeeper 차단 시 배포 출처와 서명 상태를 먼저 확인하세요.
- Linux 빌드는 설정만 있고 아직 검증하지 않았습니다.

</details>

### 내 컴퓨터에서 웹판 실행 (Docker)

현재 웹판과 데스크톱 API는 **신뢰할 수 있는 내 컴퓨터의 단일 사용자용**입니다. Docker 포트도 `127.0.0.1`에만 연결합니다. 포트 전달·공유 터널·공인 서버에 그대로 공개하지 마세요. 여러 사용자가 이용하는 서버로 운영하려면 문서·채팅·업로드·세션 발급을 포함한 모든 API에 별도의 인증과 문서별 권한 검사가 필요합니다. CORS와 AI 세션 토큰은 사용자 로그인이나 서버 전체의 접근 통제를 대신하지 않습니다.

DOCX의 외부 연결 그림은 열 때 자동으로 다운로드하지 않으며, 화면에 **외부 그림 차단됨**으로 표시합니다. 문서에 포함된 그림은 표시되고, 원본의 외부 연결 관계는 저장할 때 유지됩니다. 외부 그림을 표시하려면 신뢰할 수 있는 그림 파일을 문서에 포함해 주세요.

```bash
./start.sh          # 빌드 + PostgreSQL·백엔드·프런트엔드 → http://localhost:3000
./start.sh dev      # PostgreSQL 컨테이너 + uvicorn --reload + next dev
./start.sh stop     # 그 밖에 logs, test
```

macOS Finder에서는 `start.command`, Windows 탐색기에서는 `start.bat`을 두 번 누르면 됩니다.

직접 띄우려면:

```bash
docker compose up --build

# 또는 개별 실행
docker run -d --name coredotdocs-pg -e POSTGRES_USER=coredotdocs -e POSTGRES_PASSWORD=coredotdocs \
  -e POSTGRES_DB=coredotdocs -p 127.0.0.1:5441:5432 postgres:17-alpine
cd backend && uv sync && uv run uvicorn app.main:app --port 8000
cd frontend && pnpm install && pnpm dev   # 처음 한 번 rhwp WASM 복사와 rhwp-studio 빌드
```

웹판에서는 저장이 내려받기이고, 외부 AI 앱 연결은 시작 화면의 **AI 세션 토큰 발급**이 Claude Desktop 설정 JSON과 `claude mcp add-json` 명령을 만들어 줍니다.

### 환경 변수

백엔드 설정은 `EDITOR_` 접두어를 씁니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `EDITOR_DATABASE_URL` | `127.0.0.1:5441`의 PostgreSQL | PostgreSQL URL 또는 `sqlite:///경로` |
| `EDITOR_CORS_ORIGINS` | `localhost:3000` | 허용할 출처(JSON 배열) |
| `EDITOR_ALLOW_ANONYMOUS_TOOLS` | `true` | `false`는 도구 호출에 AI 토큰을 요구하는 옵션입니다. 문서 API·토큰 발급을 보호하는 인증 설정은 아닙니다 |
| `EDITOR_ALLOWED_HOSTS` | `localhost`, `127.0.0.1`, `::1` | 허용할 Host 이름(JSON 배열). Docker는 내부 서비스 이름도 명시하며 호스트 포트는 loopback에만 연결합니다 |
| `EDITOR_MAX_UPLOAD_BYTES`, `EDITOR_OUTPUT_LIMIT` | 50MiB, 24,000자 | 업로드·도구 출력 상한 |
| `EDITOR_CDT_API_BASE` | `https://api.core.today` | core.today 게이트웨이 주소 |
| `EDITOR_CDT_API_KEY` | | 화면에서 키를 넣지 않은 요청의 대체값(개발용) |
| `EDITOR_CHAT_MAX_ROUNDS`, `EDITOR_CHAT_MAX_TOKENS` | `12`, `4096` | 채팅 에이전트 상한 |

MCP 브리지는 `EDITOR_API_URL` 또는 `EDITOR_STATE_FILE`(데스크톱 앱의 `server.json`)로 서버를 찾고, `EDITOR_AI_TOKEN`으로 인증합니다.

## AI 도구

앱 안 채팅과 외부 MCP 클라이언트가 같은 도구를 씁니다. 모든 입력은 경계가 있는 JSON Schema로 먼저 검증합니다.

| 분류 | 도구 |
|---|---|
| 읽기 | `list_documents` `read_document` `document_info` `find_text` `list_fields` `list_fonts` `list_notes` |
| 글 편집 | `replace_text` `set_paragraph_text` `insert_content` `delete_blocks` `fill_fields` `insert_image` |
| 서식 | `format_text` `format_paragraphs` `set_page_setup` |
| 표 | `insert_table` `set_table_cells` `format_table` `insert_table_rows` `delete_table_rows` `merge_table_cells` `split_table_cell` `shade_table_cells` |
| 편집기 전용 | `read_selection` `replace_selection` `format_selection` `insert_note` `edit_note` `insert_toc` |
| 문서 | `create_document` `undo_last_edit` |

선택 범위 편집, 각주, 차례, 칸 합치기·나누기·음영은 HWPX 편집기가 열려 있을 때만 됩니다.
코딩 에이전트용 사용 규칙은 [`skills/coredotdocs/SKILL.md`](skills/coredotdocs/SKILL.md)에 있습니다(`backend/scripts/gen_skill.py`가 레지스트리에서 생성).

## 테스트

```bash
cd backend && uv run pytest                      # 엔진·레지스트리·MCP stdio·DB 통합 (CDT_API_KEY가 있으면 실제 LLM 호출도)
cd frontend && pnpm test && pnpm typecheck && pnpm lint
cd frontend && pnpm test:genoffice               # third_party/genoffice-docx 엔진 자체 테스트
cd frontend && pnpm test:e2e                     # Playwright: 문서 열기 → AI 편집 반영 → 되돌리기 → 저장 등
```

백엔드 통합 테스트는 기본으로 PostgreSQL(`127.0.0.1:5441`)을 쓰며, `EDITOR_DATABASE_URL=sqlite:///…`로 SQLite에서도 돌릴 수 있습니다.
CI(`.github/workflows/ci.yml`)는 PostgreSQL 서비스와 함께 같은 명령을 실행합니다.

## 저장소 구조

```
backend/            FastAPI 서버
  app/engine/         HWPX(OWPML)·DOCX(WordprocessingML) 파서와 편집 명령
  app/tools/          AI 도구 정의(registry)와 실행기(runner)
  app/services/       문서·리비전·검색·SSE·AI 세션
  app/llm/            core.today 게이트웨이 어댑터와 채팅 에이전트
  app/mcp_stdio.py    AI 앱용 stdio MCP 브리지
frontend/           Next.js 화면 (AppShell, 편집기, 서식 막대, AI 패널)
desktop/            Electron 셸 (서버 기동, 네이티브 메뉴, 파일 연결, AI 앱 등록, 서명·dmg 스크립트)
third_party/        Apache-2.0 파생 코드 (아래 참고)
skills/coredotdocs/ 코딩 에이전트용 스킬 문서
docs/               설계 기록
```

설계 기록은 [`docs/02-design.md`](docs/02-design.md)(API·DB·UI·데스크톱 패키징)와 [`docs/04-openoffice-upgrade-plan.md`](docs/04-openoffice-upgrade-plan.md)(편집기 자체 빌드·DOCX 편집기 도입 계획)에 있습니다.

## 호환성과 한계

- 이번 1.0.0에서는 실제 Windows Microsoft Word와 한컴오피스에서 시험 문서를 열고 재저장한 뒤 다시 읽는 왕복을 확인했습니다. 대상과 결과는 [검증 기록](docs/releases/v1.0.0-validation.md)에 있습니다. 모든 문서의 완전한 호환성을 뜻하지는 않으며, macOS·Linux의 1.0.0 빌드는 아직 검증하지 않았습니다.
- DOCX의 HTML 조각(altChunk)은 변환하지 않고 미리보기로 보이며 저장할 때 그대로 남습니다. 미주는 문서 끝에 모아 보입니다.
- 외부 편집과 입력이 겹쳐 복구 사본이 만들어졌다면 **시작 화면 → 이 앱의 문서**에서 이름에 ‘충돌 복구’가 들어간 문서를 열어 비교하고 필요한 내용을 옮기세요. 앱의 사본에 동기화하는 것과 원본 파일에 저장하는 것은 별개이며, 닫기 전에 `Ctrl+S`로 저장하세요.

## 서드파티 코드와 라이선스

이 저장소는 [Apache License 2.0](LICENSE)으로 배포합니다. 서드파티 고지는 [`NOTICE`](NOTICE)에 있습니다.

| 구성 | 라이선스 | 위치 |
|---|---|---|
| [GenOffice](https://github.com/genspark-ai/genoffice) docx-engine·docs 편집기 핵심 | Apache-2.0 | `third_party/genoffice-docx/` (가져온 범위는 `ORIGIN.md`) |
| [IeumOffice](https://github.com/pblsketch/openoffice) 편집기 플러그인·빌드 스크립트 | Apache-2.0 | `third_party/ieumoffice-hwp/` |
| [rhwp](https://github.com/edwardkim/rhwp) `@rhwp/core`·rhwp-studio 0.8.7 | MIT | 빌드할 때 받거나 빌드(저장소에 넣지 않음) |

Apache 파생 코드는 `third_party/`의 두 폴더에만 있고, `scripts/check-third-party.mjs`가 그 경계를 검사합니다.

## 공개 저장소 이력

개인 이메일이 포함된 이전 개발 이력은 비공개 보관본에 남기고, 공개 저장소는 GitHub 비공개 이메일 주소로 새 이력을 시작했습니다. 이전 비공개 저장소의 클론이 있다면 새로 클론해서 작업해 주세요. 과거 브랜치·태그를 새 저장소로 병합하거나 강제 푸시하지 마세요.
