"""코딩 에이전트용 스킬 문서(skills/coredotdocs/SKILL.md)를 도구 레지스트리에서 생성한다.

이음오피스처럼 도구 표 하나에서 스킬 문서가 나오므로 레지스트리와 어긋나지 않는다(tests/test_skill.py가 확인).
본문을 고치면 frontmatter의 version을 올린다 — 설치된 사본은 버전이 커질 때만 바뀐다.

실행: uv run python scripts/gen_skill.py [--check]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.mcp_stdio import SERVER_INFO  # noqa: E402
from app.tools import registry  # noqa: E402

SKILL_VERSION = "1.0.2"
OUT = Path(__file__).resolve().parents[2] / "skills" / "coredotdocs" / "SKILL.md"

ERROR_CODES = [
    ("TARGET_NOT_FOUND", "찾을 글·문서·누름틀이 없다", "find_text·read_document로 다시 확인"),
    ("AMBIGUOUS_TARGET", "찾은 말이 여러 곳 (후보 목록이 함께 온다)", "block으로 좁히거나 all: true, 또는 사용자에게 묻기"),
    ("OUT_OF_RANGE", "블록·표·칸 번호가 범위 밖", "read_document로 지금 번호를 다시 읽기"),
    ("HOLDS_OBJECT", "표·그림·누름틀·안쪽 표가 든 블록/칸", "그 개체를 다루는 도구를 쓰거나, 사용자가 시켰으면 include_objects: true"),
    ("CELL_NOT_EMPTY", "글이 있는 칸에 쓰려 함 (아무 칸도 바뀌지 않음)", "사용자가 바꾸라고 했으면 overwrite: true"),
    ("STALE_REVISION", "expected_revision 뒤에 문서가 바뀜", "read_document로 다시 읽고 새 리비전으로 다시 부르기"),
    ("FOREIGN_CHANGES", "되돌릴 구간에 사용자가 편집기에서 고친 리비전이 있음", "사용자에게 묻고 force: true"),
    ("NOTHING_TO_UNDO", "되돌릴 편집이 없음", "—"),
    ("UNEXPECTED_CHANGE", "도구가 의도하지 않은 구조 변화를 만들어 적용하지 않음", "범위를 좁혀 다시 시도"),
    ("INVALID_ARGUMENT", "입력이 스키마나 문서 상태와 맞지 않음, 모르는 도구", "메시지의 안내대로 고쳐 다시 부르기"),
    ("FORBIDDEN", "이 세션이 다룰 수 없는 문서", "list_documents로 확인"),
    ("UNSUPPORTED", "편집기가 지원하지 않는 자리(표 안의 표 등)", "다른 방법이나 서버 실행(편집기를 닫고)"),
]


def tool_rows() -> list[str]:
    rows = []
    for t in registry.TOOLS:
        props = t["inputSchema"].get("properties", {})
        req = set(t["inputSchema"].get("required", []))
        args = ", ".join(f"{'**' if k in req else ''}{k}{'**' if k in req else ''}" for k in props if k != "document_id")
        kind = "읽기" if t.get("annotations", {}).get("readOnlyHint") else "편집"
        rows.append(f"| `{t['name']}` | {kind} | {t['description']} | {args or '—'} |")
    return rows


def render() -> str:
    tools = "\n".join(tool_rows())
    codes = "\n".join(f"| `{c}` | {m} | {n} |" for c, m, n in ERROR_CODES)
    return f"""---
name: coredotdocs
description: Read and edit HWPX (Hancom) and DOCX documents that are open in coredotdocs through its MCP tools — find text, replace, insert paragraphs and tables, fill table cells and form fields, change character and paragraph formatting, insert images, undo. Use when the user asks to read, summarize, fix, fill in or rewrite a Hangul (.hwpx/.hwp) or Word document in coredotdocs, or to make a new one. Edits are saved as revisions, show in the editor immediately, and can be undone.
metadata:
  version: {SKILL_VERSION}
  server: {SERVER_INFO["name"]} {SERVER_INFO["version"]}
---

# coredotdocs — HWPX·DOCX 문서를 MCP 도구로 읽고 고치기

coredotdocs 앱(또는 웹 서버)이 떠 있으면 MCP 서버 `coredotdocs`가 문서를 블록(문단·표) 번호로 읽고 고치는 도구를 내놓는다.
이 스킬은 그 도구를 어떤 순서로, 어떤 규칙으로 부르는지 정한다. 문서 파일을 직접 `unzip`하거나 XML을 고치지 않는다.

## 순서

1. `list_documents` → `document_id`를 얻는다. 사용자가 "지금 열린 문서"라고 하면 가장 최근(리비전·수정 시각)의 문서다.
2. `read_document`(또는 `find_text`)로 **블록 번호와 글을 읽은 뒤** 고친다. 리비전 번호는 `document_info`(또는 `list_documents`, 직전 편집 응답의 "리비전 N")에서 읽어 편집 도구에 `expected_revision: N`으로 넘긴다.
3. 편집 도구 하나가 리비전 하나다. 응답 끝의 `검증:` 줄(문단·표·그림·누름틀 수)로 의도한 변화만 생겼는지 본다.
4. 글을 넣거나 지우면 뒤 블록 번호가 바뀐다 → 다음 편집 전에 다시 읽는다.
5. 끝나면 무엇을 어느 블록에서 바꿨는지 리비전 번호와 함께 보고한다. **도구가 해냈다고 알린 편집만 했다고 말한다.**

## 자리 지정 규칙

- 글은 `find`로 찍는다. 여러 곳이면 도구가 거절하고 후보(`[블록] …앞【찾은 말】뒤…`)를 돌려준다. `block`으로 좁히거나, 모두 바꾸라는 뜻이면 `all: true`.
- 표 칸은 표 번호(`read_document`의 "표 N", 안쪽 표는 `"1-2"`)와 1부터 세는 행·열로 찍는다. 합친 칸은 덮는 아무 좌표나 된다.
- 누름틀은 이름이 겹칠 수 있으니 `list_fields`의 `#번호`로 찍는다.
- 새 문단은 `insert_content`의 `like`로 본뜰 문단을 주면 그 모양을 받는다(제목 옆에 넣으면 제목처럼 나온다).

## 보호 규칙 (도구가 강제한다)

- 표·그림·누름틀이 든 블록은 `set_paragraph_text`·`delete_blocks`가 거절한다(`HOLDS_OBJECT`). 사용자가 그 개체까지 지우라고 했을 때만 `include_objects: true`.
- `set_table_cells`는 빈 칸에만 쓴다. 글이 있는 칸은 `CELL_NOT_EMPTY`로 거절되고 **아무 칸도 바뀌지 않는다**. 사용자가 바꾸라고 했을 때만 `overwrite: true`. 개체(그림·안쪽 표)가 든 칸은 쓰지 않는다.
- 서식은 말한 속성만 바뀐다. 시키지 않은 서식은 바꾸지 않는다.
- `undo_last_edit`는 그 뒤에 사용자가 편집기에서 고친 리비전이 있으면 거절한다(`FOREIGN_CHANGES`). 사용자에게 묻고 `force: true`.
- 도구가 의도하지 않은 구조 변화(표·그림·누름틀·블록 수)를 만들면 리비전으로 확정하지 않는다(`UNEXPECTED_CHANGE`).

## 도구

| 도구 | 종류 | 하는 일 | 인자 (**굵게**=필수, document_id 생략) |
|---|---|---|---|
{tools}

편집 도구는 모두 선택 인자 `expected_revision`을 받는다.

## 실패했을 때 — 오류 코드

응답이 `오류[CODE] 메시지`로 시작하면 코드로 분기한다. 메시지는 사람이 읽는 말이고 바뀔 수 있다.

| `CODE` | 뜻 | 다음 할 일 |
|---|---|---|
{codes}

## 공문서 문체

본문에 마크다운 기호(#, *, **)를 넣지 않는다. 항목 기호는 □ → ㅇ → - → 1. → 가. 순서를 쓴다. 될 수 있으면 적게 바꾼다.

## 연결

- 데스크톱 앱: 메뉴 AI → "Claude Code에 연결…"/"Codex에 연결…"이 MCP 서버와 이 스킬을 함께 등록한다.
- 직접 등록: `claude mcp add-json --scope user coredotdocs '{{"command": "<앱>/editor-server", "args": ["--mcp"], "env": {{"EDITOR_STATE_FILE": "<userData>/server.json"}}}}'` (앱의 시작 화면 "AI 연결"에 완성된 조각이 있다).
- 웹 서버로 띄웠으면 `EDITOR_API_URL=http://127.0.0.1:8000`을 브리지에 준다.
"""


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(f"{OUT} 가 레지스트리와 다릅니다. `uv run python scripts/gen_skill.py` 로 다시 만드세요.")
            return 1
        print("skill up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} ({len(text):,} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
