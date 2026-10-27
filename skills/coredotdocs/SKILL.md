---
name: coredotdocs
description: Read and edit HWPX (Hancom) and DOCX documents that are open in coredotdocs through its MCP tools — find text, replace, insert paragraphs and tables, fill table cells and form fields, change character and paragraph formatting, insert images, undo. Use when the user asks to read, summarize, fix, fill in or rewrite a Hangul (.hwpx/.hwp) or Word document in coredotdocs, or to make a new one. Edits are saved as revisions, show in the editor immediately, and can be undone.
metadata:
  version: 1.0.2
  server: coredotdocs 1.0.0
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
| `list_documents` | 읽기 | 이 세션이 다룰 수 있는 문서들의 ID, 제목, 형식, 최신 리비전. | — |
| `read_document` | 읽기 | 문서를 블록 번호와 함께 읽는다: [번호] (모양) 글. 표는 '표 N (R행 × C열)' 아래 (r,c) 칸 글 요약. 같은 모양의 빈 문단은 [5~9]로 묶는다. 길면 블록 경계에서 끊고 이어 읽을 from을 알려 준다. table을 주면 그 표만 칸 글 전체(안쪽 표 포함)로 읽고, offset·max_chars로 긴 본문을 이어 읽는다. | from, to, table, include_format, row_from, row_to, offset, max_chars |
| `document_info` | 읽기 | 블록·표·그림·누름틀 수, 용지와 여백, 글자 수, 쓰인 문단 스타일. | — |
| `find_text` | 읽기 | 문서 하나(document_id) 또는 세션의 모든 문서에서 글을 글자 그대로 찾는다 (대소문자 구분 없음, 표 칸 안 포함). 블록 번호와 앞뒤 글을 돌려준다. | **query** |
| `list_fields` | 읽기 | 문서의 누름틀(클릭 필드) 목록: 번호, 블록, 이름, 안내문, 지금 글. 읽기 전용 필드는 표시만 되고 fill_fields로 채울 수 없다. 이름이 겹치면 #번호를 쓴다. | from, to |
| `replace_text` | 편집 | find를 replace로 바꾼다. 여러 곳이면 all: true 또는 block으로 좁힌다. 바뀐 글은 원래 글자 모양을 따른다. | **find**, **replace**, all, block, match_case, expected_revision |
| `set_paragraph_text` | 편집 | 문단 블록 하나의 글을 통째로 바꾼다. **굵게** *기울임*을 쓸 수 있다. | **block**, **text**, expected_revision |
| `insert_content` | 편집 | 마크다운(# 제목, - 목록, > 인용, | 표 |, <!-- pagebreak -->, **굵게**)을 블록 뒤(after)나 앞(before)에 넣는다. after: 0이면 맨 앞, 둘 다 없으면 맨 끝. like에 블록을 주면 그 문단 모양을 본문 모양으로 쓴다. | **markdown**, after, before, like, expected_revision |
| `delete_blocks` | 편집 | 블록 from~to를 지운다. 표·그림·누름틀이 든 블록은 사용자가 그 개체까지 지우라고 했을 때만 include_objects: true로 지운다. | **from**, to, include_objects, expected_revision |
| `set_table_cells` | 편집 | 표 칸 여러 개의 글과 서식을 바꾼다 (행·열은 1부터, 줄마다 칸 안 문단 하나). 빈 칸에만 쓴다: 글이 있는 칸은 사용자가 바꾸라고 했을 때만 overwrite: true. 개체(그림·안쪽 표)가 든 칸은 쓰지 않는다. 하나라도 걸리면 아무 칸도 바꾸지 않는다. text를 빼면 글은 두고 format만 바꾼다. 합친 칸은 그 칸이 덮는 아무 좌표로 가리킨다. | **table**, **cells**, overwrite, expected_revision |
| `set_page_setup` | 편집 | 용지 크기·방향과 쪽 여백(본문과 용지 가장자리 사이), 머리말·꼬리말 거리를 바꾼다. 문단 간격이나 표 칸 안 여백이 아니라 '용지 여백'을 고칠 때 쓴다. 지금 값은 document_info의 '쪽 설정' 줄. section을 주지 않으면 모든 구역에 적용. 단위 mm. | section, paper, width_mm, height_mm, orientation, margins_mm, header_mm, footer_mm, gutter_mm, expected_revision |
| `format_table` | 편집 | 표의 모든 칸에 같은 서식(글자 크기·굵게·정렬·세로 정렬·줄 간격·칸 안 여백)을 준다. | **table**, **format**, expected_revision |
| `insert_table_rows` | 편집 | 표에 행을 넣는다. after_row 행(0이면 맨 위, 없으면 맨 아래) 뒤에, 그 근처 행의 모양을 본떠 만든다. rows로 칸 글을 함께 줄 수 있다. 한 번에 최대 1,000행·10,000칸. | **table**, after_row, rows, count, expected_revision |
| `delete_table_rows` | 편집 | 표의 행 from~to를 지운다 (1부터). 모든 행을 지울 수는 없다. | **table**, **from**, to, expected_revision |
| `insert_table` | 편집 | 블록 뒤에 새 표를 넣는다 (가는 실선, 첫 행은 옅은 회색 머리 행). | after, **rows**, header, expected_revision |
| `insert_image` | 편집 | 업로드한 그림(image_id, PNG·JPEG·GIF·BMP)을 블록 뒤에 글자처럼 넣는다. width_mm로 너비를 정한다 (없으면 원래 크기, 본문 폭까지). | **image_id**, after, width_mm, align, expected_revision |
| `fill_fields` | 편집 | 누름틀에 글을 넣는다. values의 열쇠는 이름, 안내문(또는 일부), 또는 list_fields의 "#번호". 모든 대상을 검증한 뒤 한 번에 적용한다. | **values**, expected_revision |
| `list_fonts` | 읽기 | 이 컴퓨터에 설치된 글꼴을 읽는다 (가족명과 한국어 이름). 글꼴을 바꾸기 전에 불러 가족명을 확인한다. query로 이름을 좁힌다. 웹판처럼 목록을 못 받으면 그렇다고 알려 준다. | query |
| `format_text` | 편집 | 찾은 글(find)의 글자 모양만 바꾼다: 굵게, 기울임, 밑줄, 취소선, 색, 크기(pt), 글꼴. 문서 전체나 여러 블록의 글꼴·크기는 format_paragraphs(all 또는 from~to)로 바꾼다 (find에 마침표·공백 같은 기호를 넣어 전체를 바꾸려 하지 말 것). 글꼴 이름은 list_fonts의 가족명(영문)을 쓴다. | **find**, all, block, bold, italic, underline, strike, color, size, font, expected_revision |
| `format_paragraphs` | 편집 | 블록 from~to(all: true면 문서 전체, 표 칸 안 글 포함)의 문단 모양을 바꾼다: 정렬, 줄 간격(%), 왼쪽 여백·첫 줄 들여쓰기(pt, 음수는 내어쓰기), 문단 위·아래 간격(pt), 쪽 나누기. 그 블록들의 모든 글자 모양도 바꿀 수 있다: 글꼴(font, list_fonts의 가족명), 크기(size pt), 색, 굵게, 기울임. '문서 전체 글꼴을 X로'는 all: true + font. | from, to, all, align, line_spacing, left, indent, space_before, space_after, page_break, font, size, color, bold, italic, expected_revision |
| `create_document` | 편집 | 마크다운 내용으로 새 문서(HWPX 또는 DOCX)를 만들어 저장한다. 결과로 document_id를 돌려준다. | **title**, **markdown**, format |
| `read_selection` | 읽기 | 사용자가 편집기에서 지금 선택한 글을 문단(토막)별로 읽는다. 편집기가 열려 있을 때만 된다. 선택이 없으면 그렇다고 알려 준다. | — |
| `replace_selection` | 편집 | 사용자가 편집기에서 선택한 부분을 새 글로 바꾼다. texts는 토막(문단)마다 하나. 한 줄기로 이어진 문단들이면 더 많거나 적은 글을 주어 문단을 늘리거나 줄일 수 있다. 요청을 보낸 뒤 선택이 바뀌었으면 고치지 않는다. 편집기가 열려 있을 때만 된다. | **texts**, expected_revision |
| `format_selection` | 편집 | 사용자가 편집기에서 선택한 부분의 글자·문단 모양을 바꾼다 (말한 속성만). 편집기가 열려 있을 때만 된다. | bold, italic, underline, strike, color, size, font, align, line_spacing, expected_revision |
| `merge_table_cells` | 편집 | 표의 칸 범위(from~to, 1부터)를 한 칸으로 합친다. 각 칸의 글은 차례로 문단이 되어 들어간다. 병합 칸을 일부만 걸치는 범위는 거절. 편집기가 열려 있을 때만 된다. | **table**, **from**, **to**, expected_revision |
| `split_table_cell` | 편집 | 표의 칸 하나를 rows×cols로 나눈다 (한 방향 10칸까지). 글은 첫 칸에 남는다. 합친 칸에 rows·cols를 주지 않으면 병합을 푼다. 편집기가 열려 있을 때만 된다. | **table**, **row**, **col**, rows, cols, expected_revision |
| `shade_table_cells` | 편집 | 표 칸들의 배경색을 바꾼다 (#RRGGBB, 'none'이면 없앰). 편집기가 열려 있을 때만 된다. | **table**, **cells**, **color**, expected_revision |
| `insert_note` | 편집 | 본문의 글(find) 바로 뒤에 각주(footnote)나 미주(endnote)를 넣는다. 표 칸·글상자 안은 안 된다. 편집기가 열려 있을 때만 된다. | **kind**, **find**, **text**, expected_revision |
| `list_notes` | 읽기 | 본문의 각주·미주를 번호·종류·앞 글·내용과 함께 읽는다. 편집기가 열려 있을 때만 된다. | — |
| `edit_note` | 편집 | list_notes의 번호로 각주·미주의 내용을 바꾸거나(text) 지운다(delete: true). 편집기가 열려 있을 때만 된다. | **note**, text, delete, expected_revision |
| `insert_toc` | 편집 | 제목 글들(entries: find·level)로 차례(제목 | 쪽 번호의 2칸 표)를 anchor 글 뒤에 넣는다. 쪽 번호는 편집기의 쪽 배치로 센다. 편집기가 열려 있을 때만 된다. | anchor, title, **entries**, expected_revision |
| `undo_last_edit` | 편집 | 마지막 편집을 되돌린다 (리비전 기준, 1~50단계). 그 뒤에 사용자가 편집기에서 고친 내용이 있으면 되돌리지 않는다 (force: true면 그것까지 되돌린다). | steps, force, expected_revision |

편집 도구는 모두 선택 인자 `expected_revision`을 받는다.

## 실패했을 때 — 오류 코드

응답이 `오류[CODE] 메시지`로 시작하면 코드로 분기한다. 메시지는 사람이 읽는 말이고 바뀔 수 있다.

| `CODE` | 뜻 | 다음 할 일 |
|---|---|---|
| `TARGET_NOT_FOUND` | 찾을 글·문서·누름틀이 없다 | find_text·read_document로 다시 확인 |
| `AMBIGUOUS_TARGET` | 찾은 말이 여러 곳 (후보 목록이 함께 온다) | block으로 좁히거나 all: true, 또는 사용자에게 묻기 |
| `OUT_OF_RANGE` | 블록·표·칸 번호가 범위 밖 | read_document로 지금 번호를 다시 읽기 |
| `HOLDS_OBJECT` | 표·그림·누름틀·안쪽 표가 든 블록/칸 | 그 개체를 다루는 도구를 쓰거나, 사용자가 시켰으면 include_objects: true |
| `CELL_NOT_EMPTY` | 글이 있는 칸에 쓰려 함 (아무 칸도 바뀌지 않음) | 사용자가 바꾸라고 했으면 overwrite: true |
| `STALE_REVISION` | expected_revision 뒤에 문서가 바뀜 | read_document로 다시 읽고 새 리비전으로 다시 부르기 |
| `FOREIGN_CHANGES` | 되돌릴 구간에 사용자가 편집기에서 고친 리비전이 있음 | 사용자에게 묻고 force: true |
| `NOTHING_TO_UNDO` | 되돌릴 편집이 없음 | — |
| `UNEXPECTED_CHANGE` | 도구가 의도하지 않은 구조 변화를 만들어 적용하지 않음 | 범위를 좁혀 다시 시도 |
| `INVALID_ARGUMENT` | 입력이 스키마나 문서 상태와 맞지 않음, 모르는 도구 | 메시지의 안내대로 고쳐 다시 부르기 |
| `FORBIDDEN` | 이 세션이 다룰 수 없는 문서 | list_documents로 확인 |
| `UNSUPPORTED` | 편집기가 지원하지 않는 자리(표 안의 표 등) | 다른 방법이나 서버 실행(편집기를 닫고) |

## 공문서 문체

본문에 마크다운 기호(#, *, **)를 넣지 않는다. 항목 기호는 □ → ㅇ → - → 1. → 가. 순서를 쓴다. 될 수 있으면 적게 바꾼다.

## 연결

- 데스크톱 앱: 메뉴 AI → "Claude Code에 연결…"/"Codex에 연결…"이 MCP 서버와 이 스킬을 함께 등록한다.
- 직접 등록: `claude mcp add-json --scope user coredotdocs '{"command": "<앱>/editor-server", "args": ["--mcp"], "env": {"EDITOR_STATE_FILE": "<userData>/server.json"}}'` (앱의 시작 화면 "AI 연결"에 완성된 조각이 있다).
- 웹 서버로 띄웠으면 `EDITOR_API_URL=http://127.0.0.1:8000`을 브리지에 준다.
