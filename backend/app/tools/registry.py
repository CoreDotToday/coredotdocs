"""도구 정의(MCP tools/list 형식)와 JSON Schema 검증.

원칙: 모든 숫자에 minimum/maximum, 모든 문자열에 maxLength, additionalProperties: false.
검증은 문서를 읽거나 DB에 닿기 전에 한다.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

MAX_BLOCK = 100_000
MAX_TEXT = 20_000
MAX_MARKDOWN = 200_000
MAX_QUERY = 500
MAX_FIND = 2_000

DOC_ID = {"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36, "description": "문서 ID (list_documents로 확인)"}
TABLE = {"type": ["integer", "string"], "minimum": 1, "maximum": 10_000, "minLength": 1, "maxLength": 20, "pattern": r"^\d+(-\d+)*$", "description": "표 번호 (read_document의 '표 N'). 칸 안의 안쪽 표는 '1-2'처럼"}
COLOR = {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$", "minLength": 7, "maxLength": 7, "description": '"#C00000" 같은 색'}
ALIGN = {"type": "string", "enum": ["left", "center", "right", "justify", "distribute"]}
CELL_FORMAT = {
    "type": "object",
    "minProperties": 1,
    "additionalProperties": False,
    "properties": {
        "size": {"type": "number", "minimum": 1, "maximum": 200, "description": "글자 크기 pt"},
        "bold": {"type": "boolean"},
        "align": ALIGN,
        "vertical_align": {"type": "string", "enum": ["top", "center", "bottom"]},
        "line_spacing": {"type": "number", "minimum": 50, "maximum": 500, "description": "줄 간격 %"},
        "padding_mm": {"type": "object", "minProperties": 1, "additionalProperties": False, "properties": {s: {"type": "number", "minimum": 0, "maximum": 30} for s in ("top", "bottom", "left", "right")}, "description": "칸 안 여백 mm"},
    },
}


def block(description: str, minimum: int = 1) -> dict:
    return {"type": "integer", "minimum": minimum, "maximum": MAX_BLOCK, "description": description}


def text(max_length: int, description: str, min_length: int = 0) -> dict:
    return {"type": "string", "minLength": min_length, "maxLength": max_length, "description": description}


def obj(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def rows(description: str) -> dict:
    return {"type": "array", "minItems": 1, "maxItems": 1000, "items": {"type": "array", "maxItems": 200, "items": text(MAX_TEXT, "칸 글")}, "description": description}


edit = {"destructiveHint": False, "idempotentHint": False}

TOOLS: list[dict[str, Any]] = [
    {"name": "list_documents", "title": "문서 목록", "description": "이 세션이 다룰 수 있는 문서들의 ID, 제목, 형식, 최신 리비전.", "inputSchema": obj({}, []), "annotations": {"readOnlyHint": True}},
    {
        "name": "read_document",
        "title": "문서 읽기",
        "description": "문서를 블록 번호와 함께 읽는다: [번호] (모양) 글. 표는 '표 N (R행 × C열)' 아래 (r,c) 칸 글 요약. 같은 모양의 빈 문단은 [5~9]로 묶는다. 길면 블록 경계에서 끊고 이어 읽을 from을 알려 준다. table을 주면 그 표만 칸 글 전체(안쪽 표 포함)로 읽고, offset·max_chars로 긴 본문을 이어 읽는다.",
        "inputSchema": obj(
            {
                "document_id": DOC_ID,
                "from": block("이 블록부터 (기본 1)"),
                "to": block("이 블록까지 (기본 끝)"),
                "table": TABLE | {"description": "이 표만 칸 글 전체로 읽는다 (선택)"},
                "include_format": {"type": "boolean", "description": "table을 읽을 때 칸마다 글자 크기·정렬·세로 정렬도"},
                "row_from": {"type": "integer", "minimum": 1, "maximum": 100_000, "description": "table에서 이 행부터"},
                "row_to": {"type": "integer", "minimum": 1, "maximum": 100_000, "description": "table에서 이 행까지"},
                "offset": {"type": "integer", "minimum": 0, "maximum": 10_000_000, "description": "표시 문자열의 이어 읽기 위치 (이전 응답의 next_offset)"},
                "max_chars": {"type": "integer", "minimum": 256, "maximum": 18_000, "description": "본문 길이 예산 (기본 18000)"},
            },
            ["document_id"],
        ),
        "annotations": {"readOnlyHint": True},
    },
    {"name": "document_info", "title": "문서 정보", "description": "블록·표·그림·누름틀 수, 용지와 여백, 글자 수, 쓰인 문단 스타일.", "inputSchema": obj({"document_id": DOC_ID}, ["document_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "find_text", "title": "글 찾기", "description": "문서 하나(document_id) 또는 세션의 모든 문서에서 글을 글자 그대로 찾는다 (대소문자 구분 없음, 표 칸 안 포함). 블록 번호와 앞뒤 글을 돌려준다.", "inputSchema": obj({"query": text(MAX_QUERY, "찾을 글", 1), "document_id": DOC_ID}, ["query"]), "annotations": {"readOnlyHint": True}},
    {
        "name": "list_fields",
        "title": "누름틀 목록",
        "description": "문서의 누름틀(클릭 필드) 목록: 번호, 블록, 이름, 안내문, 지금 글. 읽기 전용 필드는 표시만 되고 fill_fields로 채울 수 없다. 이름이 겹치면 #번호를 쓴다.",
        "inputSchema": obj({"document_id": DOC_ID, "from": block("이 필드 번호부터"), "to": block("이 필드 번호까지")}, ["document_id"]),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "replace_text",
        "title": "글 바꾸기",
        "description": "find를 replace로 바꾼다. 여러 곳이면 all: true 또는 block으로 좁힌다. 바뀐 글은 원래 글자 모양을 따른다.",
        "inputSchema": obj({"document_id": DOC_ID, "find": text(MAX_FIND, "바꿀 글 (read_document로 읽은 그대로)", 1), "replace": text(MAX_TEXT, "새 글 (지우려면 빈 글)"), "all": {"type": "boolean"}, "block": block("이 블록에서만"), "match_case": {"type": "boolean"}}, ["document_id", "find", "replace"]),
        "annotations": edit,
    },
    {"name": "set_paragraph_text", "title": "문단 글 바꾸기", "description": "문단 블록 하나의 글을 통째로 바꾼다. **굵게** *기울임*을 쓸 수 있다.", "inputSchema": obj({"document_id": DOC_ID, "block": block("문단 블록 번호"), "text": text(MAX_TEXT, "새 글")}, ["document_id", "block", "text"]), "annotations": edit},
    {
        "name": "insert_content",
        "title": "내용 넣기",
        "description": "마크다운(# 제목, - 목록, > 인용, | 표 |, <!-- pagebreak -->, **굵게**)을 블록 뒤(after)나 앞(before)에 넣는다. after: 0이면 맨 앞, 둘 다 없으면 맨 끝. like에 블록을 주면 그 문단 모양을 본문 모양으로 쓴다.",
        "inputSchema": obj({"document_id": DOC_ID, "markdown": text(MAX_MARKDOWN, "넣을 내용", 1), "after": block("이 블록 뒤에 (0이면 맨 앞)", 0), "before": block("이 블록 앞에"), "like": block("본뜰 문단 블록")}, ["document_id", "markdown"]),
        "annotations": edit,
    },
    {"name": "delete_blocks", "title": "블록 지우기", "description": "블록 from~to를 지운다. 표·그림·누름틀이 든 블록은 사용자가 그 개체까지 지우라고 했을 때만 include_objects: true로 지운다.", "inputSchema": obj({"document_id": DOC_ID, "from": block("처음 블록"), "to": block("마지막 블록 (기본 from)"), "include_objects": {"type": "boolean", "description": "개체(표·그림·누름틀)가 든 블록도 지운다"}}, ["document_id", "from"]), "annotations": {"destructiveHint": True}},
    {
        "name": "set_table_cells",
        "title": "표 칸 채우기",
        "description": "표 칸 여러 개의 글과 서식을 바꾼다 (행·열은 1부터, 줄마다 칸 안 문단 하나). 빈 칸에만 쓴다: 글이 있는 칸은 사용자가 바꾸라고 했을 때만 overwrite: true. 개체(그림·안쪽 표)가 든 칸은 쓰지 않는다. 하나라도 걸리면 아무 칸도 바꾸지 않는다. text를 빼면 글은 두고 format만 바꾼다. 합친 칸은 그 칸이 덮는 아무 좌표로 가리킨다.",
        "inputSchema": obj(
            {"document_id": DOC_ID, "table": TABLE, "cells": {"type": "array", "minItems": 1, "maxItems": 500, "items": obj({"row": {"type": "integer", "minimum": 1, "maximum": 10_000}, "col": {"type": "integer", "minimum": 1, "maximum": 10_000}, "text": text(MAX_TEXT, "칸 글"), "format": CELL_FORMAT}, ["row", "col"])}, "overwrite": {"type": "boolean", "description": "글이 있는 칸도 덮어쓴다 (사용자가 시켰을 때만)"}},
            ["document_id", "table", "cells"],
        ),
        "annotations": edit,
    },
    {
        "name": "set_page_setup",
        "title": "쪽 설정 (용지·여백)",
        "description": "용지 크기·방향과 쪽 여백(본문과 용지 가장자리 사이), 머리말·꼬리말 거리를 바꾼다. 문단 간격이나 표 칸 안 여백이 아니라 '용지 여백'을 고칠 때 쓴다. 지금 값은 document_info의 '쪽 설정' 줄. section을 주지 않으면 모든 구역에 적용. 단위 mm.",
        "inputSchema": obj(
            {
                "document_id": DOC_ID,
                "section": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "구역 번호 (없으면 모든 구역)"},
                "paper": {"type": "string", "enum": ["A3", "A4", "A5", "B4", "B5", "Letter", "Legal"], "description": "용지 크기"},
                "width_mm": {"type": "number", "minimum": 50, "maximum": 1000, "description": "사용자 정의 용지 너비 mm (놓인 그대로)"},
                "height_mm": {"type": "number", "minimum": 50, "maximum": 1000, "description": "사용자 정의 용지 높이 mm"},
                "orientation": {"type": "string", "enum": ["portrait", "landscape"], "description": "세로(portrait)·가로(landscape)"},
                "margins_mm": {"type": "object", "minProperties": 1, "additionalProperties": False, "properties": {s: {"type": "number", "minimum": 0, "maximum": 200} for s in ("top", "bottom", "left", "right")}, "description": "쪽 여백 mm (준 쪽만 바뀐다)"},
                "header_mm": {"type": "number", "minimum": 0, "maximum": 200, "description": "용지 위 가장자리에서 머리말까지 mm"},
                "footer_mm": {"type": "number", "minimum": 0, "maximum": 200, "description": "용지 아래 가장자리에서 꼬리말까지 mm"},
                "gutter_mm": {"type": "number", "minimum": 0, "maximum": 200, "description": "제본 여백 mm"},
            },
            ["document_id"],
        ),
        "annotations": edit,
    },
    {"name": "format_table", "title": "표 서식 바꾸기", "description": "표의 모든 칸에 같은 서식(글자 크기·굵게·정렬·세로 정렬·줄 간격·칸 안 여백)을 준다.", "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "format": CELL_FORMAT}, ["document_id", "table", "format"]), "annotations": edit},
    {
        "name": "insert_table_rows",
        "title": "표 행 넣기",
        "description": "표에 행을 넣는다. after_row 행(0이면 맨 위, 없으면 맨 아래) 뒤에, 그 근처 행의 모양을 본떠 만든다. rows로 칸 글을 함께 줄 수 있다. 한 번에 최대 1,000행·10,000칸.",
        "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "after_row": {"type": "integer", "minimum": 0, "maximum": 100_000}, "rows": {"type": "array", "maxItems": 1000, "items": {"type": "array", "maxItems": 200, "items": text(MAX_TEXT, "칸 글")}}, "count": {"type": "integer", "minimum": 1, "maximum": 1000}}, ["document_id", "table"]),
        "annotations": edit,
    },
    {"name": "delete_table_rows", "title": "표 행 지우기", "description": "표의 행 from~to를 지운다 (1부터). 모든 행을 지울 수는 없다.", "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "from": {"type": "integer", "minimum": 1, "maximum": 100_000}, "to": {"type": "integer", "minimum": 1, "maximum": 100_000}}, ["document_id", "table", "from"]), "annotations": {"destructiveHint": True}},
    {"name": "insert_table", "title": "새 표 넣기", "description": "블록 뒤에 새 표를 넣는다 (가는 실선, 첫 행은 옅은 회색 머리 행).", "inputSchema": obj({"document_id": DOC_ID, "after": block("이 블록 뒤에 (없으면 맨 끝)"), "rows": rows('[["구분","내용"], ["…","…"]]'), "header": {"type": "boolean", "description": "첫 행을 머리 행으로 (기본 true)"}}, ["document_id", "rows"]), "annotations": edit},
    {
        "name": "insert_image",
        "title": "그림 넣기",
        "description": "업로드한 그림(image_id, PNG·JPEG·GIF·BMP)을 블록 뒤에 글자처럼 넣는다. width_mm로 너비를 정한다 (없으면 원래 크기, 본문 폭까지).",
        "inputSchema": obj({"document_id": DOC_ID, "image_id": DOC_ID | {"description": "그림 ID (화면에서 올린 그림)"}, "after": block("이 블록 뒤에 (없으면 맨 끝)"), "width_mm": {"type": "number", "minimum": 1, "maximum": 300}, "align": {"type": "string", "enum": ["left", "center", "right"]}}, ["document_id", "image_id"]),
        "annotations": edit,
    },
    {"name": "fill_fields", "title": "누름틀 채우기", "description": '누름틀에 글을 넣는다. values의 열쇠는 이름, 안내문(또는 일부), 또는 list_fields의 "#번호". 모든 대상을 검증한 뒤 한 번에 적용한다.', "inputSchema": obj({"document_id": DOC_ID, "values": {"type": "object", "minProperties": 1, "maxProperties": 500, "propertyNames": {"maxLength": 500}, "additionalProperties": text(MAX_TEXT, "넣을 글")}}, ["document_id", "values"]), "annotations": edit},
    {"name": "list_fonts", "title": "설치된 글꼴", "description": "이 컴퓨터에 설치된 글꼴을 읽는다 (가족명과 한국어 이름). 글꼴을 바꾸기 전에 불러 가족명을 확인한다. query로 이름을 좁힌다. 웹판처럼 목록을 못 받으면 그렇다고 알려 준다.", "inputSchema": obj({"query": text(100, "이름 일부 (예: 나눔, A2Z)")}, []), "annotations": {"readOnlyHint": True}},
    {
        "name": "format_text",
        "title": "글자 모양",
        "description": "찾은 글(find)의 글자 모양만 바꾼다: 굵게, 기울임, 밑줄, 취소선, 색, 크기(pt), 글꼴. 문서 전체나 여러 블록의 글꼴·크기는 format_paragraphs(all 또는 from~to)로 바꾼다 (find에 마침표·공백 같은 기호를 넣어 전체를 바꾸려 하지 말 것). 글꼴 이름은 list_fonts의 가족명(영문)을 쓴다.",
        "inputSchema": obj({"document_id": DOC_ID, "find": text(MAX_FIND, "모양을 바꿀 글", 1), "all": {"type": "boolean"}, "block": block("이 블록에서만"), "bold": {"type": "boolean"}, "italic": {"type": "boolean"}, "underline": {"type": "boolean"}, "strike": {"type": "boolean"}, "color": COLOR, "size": {"type": "number", "minimum": 1, "maximum": 200, "description": "글자 크기 pt"}, "font": text(50, "글꼴 이름", 1)}, ["document_id", "find"]),
        "annotations": edit,
    },
    {
        "name": "format_paragraphs",
        "title": "문단·글자 모양 (블록 범위)",
        "description": "블록 from~to(all: true면 문서 전체, 표 칸 안 글 포함)의 문단 모양을 바꾼다: 정렬, 줄 간격(%), 왼쪽 여백·첫 줄 들여쓰기(pt, 음수는 내어쓰기), 문단 위·아래 간격(pt), 쪽 나누기. 그 블록들의 모든 글자 모양도 바꿀 수 있다: 글꼴(font, list_fonts의 가족명), 크기(size pt), 색, 굵게, 기울임. '문서 전체 글꼴을 X로'는 all: true + font.",
        "inputSchema": obj({"document_id": DOC_ID, "from": block("처음 블록 (all이 아니면 필수)"), "to": block("마지막 블록"), "all": {"type": "boolean", "description": "문서의 모든 블록 (from·to 무시)"}, "align": ALIGN, "line_spacing": {"type": "number", "minimum": 50, "maximum": 500}, "left": {"type": "number", "minimum": -500, "maximum": 500}, "indent": {"type": "number", "minimum": -500, "maximum": 500}, "space_before": {"type": "number", "minimum": 0, "maximum": 500}, "space_after": {"type": "number", "minimum": 0, "maximum": 500}, "page_break": {"type": "boolean"}, "font": text(50, "글꼴 이름 (설치 글꼴의 가족명)", 1), "size": {"type": "number", "minimum": 1, "maximum": 200, "description": "글자 크기 pt"}, "color": COLOR, "bold": {"type": "boolean"}, "italic": {"type": "boolean"}}, ["document_id"]),
        "annotations": edit,
    },
    {
        "name": "create_document",
        "title": "새 문서 만들기",
        "description": "마크다운 내용으로 새 문서(HWPX 또는 DOCX)를 만들어 저장한다. 결과로 document_id를 돌려준다.",
        "inputSchema": obj({"title": text(80, "문서 제목", 1), "markdown": text(MAX_MARKDOWN, "내용 (마크다운)"), "format": {"type": "string", "enum": ["hwpx", "docx"], "description": "기본 hwpx"}}, ["title", "markdown"]),
        "annotations": {"destructiveHint": False},
    },
    {"name": "read_selection", "title": "선택한 부분 읽기", "description": "사용자가 편집기에서 지금 선택한 글을 문단(토막)별로 읽는다. 편집기가 열려 있을 때만 된다. 선택이 없으면 그렇다고 알려 준다.", "inputSchema": obj({"document_id": DOC_ID}, ["document_id"]), "annotations": {"readOnlyHint": True}},
    {
        "name": "replace_selection",
        "title": "선택한 부분 바꾸기",
        "description": "사용자가 편집기에서 선택한 부분을 새 글로 바꾼다. texts는 토막(문단)마다 하나. 한 줄기로 이어진 문단들이면 더 많거나 적은 글을 주어 문단을 늘리거나 줄일 수 있다. 요청을 보낸 뒤 선택이 바뀌었으면 고치지 않는다. 편집기가 열려 있을 때만 된다.",
        "inputSchema": obj({"document_id": DOC_ID, "texts": {"type": "array", "minItems": 1, "maxItems": 500, "items": text(MAX_TEXT, "새 글")}}, ["document_id", "texts"]),
        "annotations": edit,
    },
    {
        "name": "format_selection",
        "title": "선택한 부분 서식",
        "description": "사용자가 편집기에서 선택한 부분의 글자·문단 모양을 바꾼다 (말한 속성만). 편집기가 열려 있을 때만 된다.",
        "inputSchema": obj({"document_id": DOC_ID, "bold": {"type": "boolean"}, "italic": {"type": "boolean"}, "underline": {"type": "boolean"}, "strike": {"type": "boolean"}, "color": COLOR, "size": {"type": "number", "minimum": 1, "maximum": 200}, "font": text(50, "글꼴 이름", 1), "align": ALIGN, "line_spacing": {"type": "number", "minimum": 50, "maximum": 500}}, ["document_id"]),
        "annotations": edit,
    },
    {"name": "merge_table_cells", "title": "표 칸 합치기", "description": "표의 칸 범위(from~to, 1부터)를 한 칸으로 합친다. 각 칸의 글은 차례로 문단이 되어 들어간다. 병합 칸을 일부만 걸치는 범위는 거절. 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "from": obj({"row": {"type": "integer", "minimum": 1, "maximum": 10_000}, "col": {"type": "integer", "minimum": 1, "maximum": 10_000}}, ["row", "col"]), "to": obj({"row": {"type": "integer", "minimum": 1, "maximum": 10_000}, "col": {"type": "integer", "minimum": 1, "maximum": 10_000}}, ["row", "col"])}, ["document_id", "table", "from", "to"]), "annotations": edit},
    {"name": "split_table_cell", "title": "표 칸 나누기", "description": "표의 칸 하나를 rows×cols로 나눈다 (한 방향 10칸까지). 글은 첫 칸에 남는다. 합친 칸에 rows·cols를 주지 않으면 병합을 푼다. 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "row": {"type": "integer", "minimum": 1, "maximum": 10_000}, "col": {"type": "integer", "minimum": 1, "maximum": 10_000}, "rows": {"type": "integer", "minimum": 1, "maximum": 10}, "cols": {"type": "integer", "minimum": 1, "maximum": 10}}, ["document_id", "table", "row", "col"]), "annotations": edit},
    {"name": "shade_table_cells", "title": "표 칸 배경색", "description": "표 칸들의 배경색을 바꾼다 (#RRGGBB, 'none'이면 없앰). 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "table": TABLE, "cells": {"type": "array", "minItems": 1, "maxItems": 500, "items": obj({"row": {"type": "integer", "minimum": 1, "maximum": 10_000}, "col": {"type": "integer", "minimum": 1, "maximum": 10_000}}, ["row", "col"])}, "color": {"type": "string", "pattern": "^(#[0-9A-Fa-f]{6}|none)$", "minLength": 4, "maxLength": 7}}, ["document_id", "table", "cells", "color"]), "annotations": edit},
    {"name": "insert_note", "title": "각주·미주 넣기", "description": "본문의 글(find) 바로 뒤에 각주(footnote)나 미주(endnote)를 넣는다. 표 칸·글상자 안은 안 된다. 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "kind": {"type": "string", "enum": ["footnote", "endnote"]}, "find": text(MAX_FIND, "각주를 달 글 (문서에 하나뿐이어야 한다)", 1), "text": text(MAX_TEXT, "각주 내용", 1)}, ["document_id", "kind", "find", "text"]), "annotations": edit},
    {"name": "list_notes", "title": "각주·미주 목록", "description": "본문의 각주·미주를 번호·종류·앞 글·내용과 함께 읽는다. 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID}, ["document_id"]), "annotations": {"readOnlyHint": True}},
    {"name": "edit_note", "title": "각주·미주 고치기", "description": "list_notes의 번호로 각주·미주의 내용을 바꾸거나(text) 지운다(delete: true). 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "note": {"type": "integer", "minimum": 1, "maximum": 100_000}, "text": text(MAX_TEXT, "새 내용"), "delete": {"type": "boolean"}}, ["document_id", "note"]), "annotations": edit},
    {"name": "insert_toc", "title": "차례 넣기", "description": "제목 글들(entries: find·level)로 차례(제목 | 쪽 번호의 2칸 표)를 anchor 글 뒤에 넣는다. 쪽 번호는 편집기의 쪽 배치로 센다. 편집기가 열려 있을 때만 된다.", "inputSchema": obj({"document_id": DOC_ID, "anchor": text(MAX_FIND, "이 글이 든 문단 뒤에 (비우면 문서 끝)"), "title": text(200, "차례 제목 (비우면 없음)"), "entries": {"type": "array", "minItems": 1, "maxItems": 500, "items": obj({"find": text(MAX_FIND, "제목 글 (하나뿐이어야 한다)", 1), "level": {"type": "integer", "minimum": 1, "maximum": 3}}, ["find", "level"])}}, ["document_id", "entries"]), "annotations": edit},
    {"name": "undo_last_edit", "title": "되돌리기", "description": "마지막 편집을 되돌린다 (리비전 기준, 1~50단계). 그 뒤에 사용자가 편집기에서 고친 내용이 있으면 되돌리지 않는다 (force: true면 그것까지 되돌린다).", "inputSchema": obj({"document_id": DOC_ID, "steps": {"type": "integer", "minimum": 1, "maximum": 50}, "force": {"type": "boolean", "description": "사용자 편집이 끼어 있어도 되돌린다"}}, ["document_id"]), "annotations": edit},
]

EXPECTED_REVISION = {"type": "integer", "minimum": 1, "maximum": 1_000_000_000, "description": "읽었을 때의 리비전 번호. 그 뒤 문서가 바뀌었으면 고치지 않고 알려 준다 (낡은 블록 번호로 엉뚱한 곳을 고치는 것을 막는다)"}
EDIT_TOOLS = [t["name"] for t in TOOLS if "document_id" in t["inputSchema"]["properties"] and not t.get("annotations", {}).get("readOnlyHint")]
for _t in TOOLS:
    if _t["name"] in EDIT_TOOLS:
        _t["inputSchema"]["properties"]["expected_revision"] = EXPECTED_REVISION

_VALIDATORS = {tool["name"]: Draft202012Validator(tool["inputSchema"], format_checker=FormatChecker()) for tool in TOOLS}
for _v in _VALIDATORS.values():
    _v.check_schema(_v.schema)


def tool_names() -> list[str]:
    return [t["name"] for t in TOOLS]


def validate(name: str, arguments: Any) -> str | None:
    validator = _VALIDATORS[name]
    errors = sorted(validator.iter_errors(arguments), key=lambda e: list(e.absolute_path))
    if not errors:
        return None
    e = errors[0]
    path = "arguments" + "".join(f".{p}" if isinstance(p, str) else f"[{p}]" for p in e.absolute_path)
    return f"{path}: {e.message}"
