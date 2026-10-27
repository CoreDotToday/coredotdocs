"""편집 도구를 편집기 플러그인으로 보내기 위한 준비 — 서버의 블록 번호 체계를 플러그인의 글자 지정 체계로 옮긴다.

플러그인(third_party/ieumoffice-hwp/agent-plugin.mjs)은 자리를 글자로 가리킨다("이 말이 든 문단"). 우리 도구는 블록 번호를 쓴다.
그래서 서버가 문서를 읽어 다음 힌트를 만든다:
- replace_text·format_text·set_paragraph_text·delete_blocks·format_paragraphs: 바꿀 글을 문서에서 하나뿐이 되게 앞뒤로 늘린
  `find`(와 그에 맞춘 `replacement`). 문단을 통째로 가리킬 때는 문단 글 전체. 늘려도 유일하지 않으면 라이브로 보내지 않는다.
- 표 도구: 플러그인은 표를 읽는 순서의 통번호(안쪽 표는 든 표 바로 뒤)로 센다 → `flat_table`.
- insert_content·insert_table: 기준 블록의 문단 글을 anchor로.
힌트를 만들 수 없으면 None → 서버(lxml) 실행.
"""

from __future__ import annotations

from typing import Any

from ..engine import markdown_lite
from ..engine.search import find_text

# 라이브로 보낼 수 있는 도구. 그 밖(insert_image, format_table 등)은 서버가 실행한다.
LIVE_TOOLS = {"set_page_setup", "replace_text", "set_paragraph_text", "delete_blocks", "format_text", "format_paragraphs", "set_table_cells", "insert_table_rows", "delete_table_rows", "insert_table", "insert_content", "fill_fields", "read_selection", "replace_selection", "format_selection"}
# 편집기 안에서만 뜻이 있는 도구 (서버 실행이 없다)
LIVE_ONLY_TOOLS = {"read_selection", "replace_selection", "format_selection", "merge_table_cells", "split_table_cell", "shade_table_cells", "insert_note", "list_notes", "edit_note", "insert_toc"}
LIVE_TOOLS |= LIVE_ONLY_TOOLS
MAX_UNIQUE_GROW = 60


def _all_text(doc) -> str:
    return "\n".join(p.text for p in _paragraphs(doc))


def _paragraphs(doc):
    from ..engine.search import paragraphs_of

    return paragraphs_of(doc)


def unique_find(doc, hit, paragraphs_text: str | None = None) -> str | None:
    """hit(문단 글·start·end)를 품은, 문서 전체에서 한 번만 나오는 가장 짧은 글. 못 만들면 None."""
    text = hit.text
    whole = paragraphs_text if paragraphs_text is not None else _all_text(doc)
    left, right = hit.start, hit.end
    for _ in range(MAX_UNIQUE_GROW):
        cand = text[left:right]
        if cand and whole.count(cand) == 1:
            return cand
        grew = False
        if left > 0:
            left -= 1
            grew = True
        if right < len(text):
            right += 1
            grew = True
        if not grew:
            break
    cand = text[left:right]
    return cand if cand and whole.count(cand) == 1 else None


def _flat_table(doc, ref) -> int | None:
    """우리 표 참조('2' 또는 '1-2') → 플러그인의 통번호. 안쪽 표는 든 표 바로 뒤에 깊이 우선으로 센다."""
    target_block, target_tbl, _ = doc.table(ref)
    counter = 0

    def visit(tbl) -> int | None:
        nonlocal counter
        counter += 1
        if tbl is target_tbl:
            return counter
        for cell in doc.ops.table_grid(tbl).cells:
            for inner in doc.ops.inner_tables_of_cell(cell.element):
                found = visit(inner)
                if found is not None:
                    return found
        return None

    for b in doc.tables():
        found = visit(b.table)
        if found is not None:
            return found
    return None


def _paragraph_find(doc, block_no: int, whole: str) -> str | None:
    """블록(문단)을 글로 가리킨다: 문단 글 전체가 문서에 한 번만 나올 때."""
    b = doc.block(block_no)
    if b.kind != "paragraph":
        return None
    t = b.text()
    if not t.strip() or whole.count(t) != 1:
        return None
    return t


def _text_format(args: dict) -> dict:
    out: dict[str, Any] = {}
    for k in ("bold", "italic", "underline", "size", "color", "font"):
        if args.get(k) is not None:
            out[k] = args[k]
    if args.get("strike") is not None:
        out["strikethrough"] = args["strike"]
    return out


def _para_format(args: dict) -> dict:
    out: dict[str, Any] = {}
    if args.get("align") in ("left", "center", "right", "justify"):
        out["align"] = args["align"]
    if args.get("line_spacing") is not None:
        out["lineSpacing"] = args["line_spacing"]
    if args.get("indent") is not None:
        out["indent"] = args["indent"]
    if args.get("left") is not None:
        out["marginLeft"] = args["left"]
    if args.get("space_before") is not None:
        out["spacingBefore"] = args["space_before"]
    if args.get("space_after") is not None:
        out["spacingAfter"] = args["space_after"]
    return out


# DOCX 편집기(Tiptap, 설계 문서 04 §12 D3)가 라이브로 받는 것: 선택 읽기·바꾸기·모양과, 그 밖의 편집 도구는 "먼저 올리기"(flush).
# flush: 편집기가 올리지 않은 타이핑을 리비전으로 올린 뒤 LIVE_FALLBACK을 답하고, 서버(lxml)가 그 최신 머리 위에서 도구를 실행한다 —
# 도구 구현은 서버 하나(두 번 구현하지 않는다), 편집기는 결과 리비전을 다시 읽는다.
DOCX_LIVE_METHODS = {"read_selection": "selection", "replace_selection": "replaceSelection", "format_selection": "formatSelection"}


def prepare(name: str, args: dict, doc) -> dict[str, Any] | None:
    """플러그인 호출 힌트. None이면 서버가 실행한다."""
    if name not in LIVE_TOOLS:
        return None
    if getattr(doc, "format", "hwpx") == "docx":
        return _prepare_docx(name, args)
    if name == "set_page_setup":
        return None  # HWPX: 서버가 고치고 편집기는 새 리비전을 다시 읽는다 (DOCX는 위에서 먼저 올리기)
    if name == "read_selection":
        return {"method": "selection"}
    if name == "replace_selection":
        return {"method": "replaceSelection", "texts": list(args["texts"])}
    if name == "format_selection":
        fmt = {**_text_format(args), **_para_format(args)}
        return {"method": "formatSelection", "format": fmt} if fmt else None
    if name == "list_notes":
        return {"method": "listNotes"}
    if name == "insert_note":
        return {"method": "insertNote", "kind": args["kind"], "anchor": args["find"], "text": args["text"]}
    if name == "edit_note":
        if args.get("delete"):
            return {"method": "deleteNote", "note": int(args["note"])}
        if not args.get("text"):
            return None
        return {"method": "editNote", "note": int(args["note"]), "text": args["text"]}
    if name == "insert_toc":
        return {"method": "insertToc", "anchor": args.get("anchor") or "", "title": args.get("title") or None, "entries": [{"find": e["find"], "level": int(e["level"])} for e in args["entries"]]}
    try:
        if name in ("replace_text", "format_text"):
            find_ = args["find"]
            all_ = bool(args.get("all"))
            block = args.get("block")
            hits = find_text(doc, find_, limit=10_000, match_case=bool(args.get("match_case", False)), only_block=block)
            if not hits:
                return None  # 서버가 TARGET_NOT_FOUND를 낸다
            if all_ and block is None:
                if not args.get("match_case") and any(h.text[h.start : h.end] != find_ for h in hits):
                    return None  # 플러그인은 대소문자를 가린다: 서버의 대소문자 무시 결과와 다르면 서버가 한다
                if name == "replace_text":
                    return {"method": "replaceAllText", "find": find_, "replacement": args["replace"]}
                return {"method": "formatText", "find": find_, "occurrence": None, "all": True, "format": _text_format(args)}
            if len(hits) != 1:
                return None  # 모호함은 서버가 후보와 함께 거절한다
            hit = hits[0]
            whole = _all_text(doc)
            grown = unique_find(doc, hit, whole)
            if grown is None:
                return None
            if name == "replace_text":
                inner = hit.text[hit.start : hit.end]
                head = grown[: grown.index(inner)] if inner in grown else ""
                tail = grown[len(head) + len(inner) :]
                return {"method": "replaceText", "find": grown, "replacement": head + args["replace"] + tail, "occurrence": None}
            if grown != hit.text[hit.start : hit.end]:
                return None  # 서식은 찾은 글자에만 걸어야 하므로 늘린 글로는 보내지 않는다
            return {"method": "formatText", "find": grown, "occurrence": None, "all": False, "format": _text_format(args)}
        whole = _all_text(doc)
        if name == "set_paragraph_text":
            find_ = _paragraph_find(doc, args["block"], whole)
            if find_ is None:
                return None
            return {"method": "replaceText", "find": find_, "replacement": markdown_lite.plain(args["text"]), "occurrence": None}
        if name == "delete_blocks":
            start = args["from"]
            end = args.get("to", start)
            if end != start or args.get("include_objects"):
                return None
            find_ = _paragraph_find(doc, start, whole)
            return None if find_ is None else {"method": "deleteParagraph", "find": find_, "occurrence": None}
        if name == "format_paragraphs":
            start = args["from"]
            end = args.get("to", start)
            if end != start or args.get("page_break") is not None:
                return None
            find_ = _paragraph_find(doc, start, whole)
            fmt = _para_format(args)
            return None if find_ is None or not fmt else {"method": "formatParagraph", "find": find_, "occurrence": None, "format": fmt}
        if name in ("merge_table_cells", "split_table_cell", "shade_table_cells"):
            flat = _flat_table(doc, args["table"])
            if flat is None:
                return None
            if name == "merge_table_cells":
                return {"method": "mergeCells", "table": flat, "from": {"row": int(args["from"]["row"]), "col": int(args["from"]["col"])}, "to": {"row": int(args["to"]["row"]), "col": int(args["to"]["col"])}}
            if name == "split_table_cell":
                return {"method": "splitCell", "table": flat, "row": int(args["row"]), "col": int(args["col"]), "rows": args.get("rows"), "cols": args.get("cols")}
            return {"method": "formatCells", "table": flat, "cells": [{"row": int(c["row"]), "col": int(c["col"])} for c in args["cells"]], "background": args["color"]}
        if name in ("set_table_cells", "insert_table_rows", "delete_table_rows"):
            flat = _flat_table(doc, args["table"])
            if flat is None:
                return None
            if name == "set_table_cells":
                if any(spec.get("format") for spec in args["cells"]):
                    return None
                return {"method": "fillCells", "table": flat, "cells": [{"row": int(c["row"]), "col": int(c["col"]), "text": c["text"]} for c in args["cells"] if "text" in c], "overwrite": bool(args.get("overwrite"))}
            if name == "insert_table_rows":
                rows = args.get("rows") or []
                count = args.get("count") or len(rows) or 1
                _, tbl, _ = doc.table(args["table"])
                grid = doc.ops.table_grid(tbl)
                after = args.get("after_row")
                at, where = (grid.rows, "after") if after is None else ((1, "before") if after == 0 else (after, "after"))
                return {"method": "addTableLines", "table": flat, "what": "rows", "at": at, "where": where, "count": count, "rows": rows}
            return {"method": "removeTableLines", "table": flat, "what": "rows", "at": args["from"], "count": args.get("to", args["from"]) - args["from"] + 1}
        if name in ("insert_table", "insert_content"):
            after = args.get("after")
            before = args.get("before") if name == "insert_content" else None
            if after == 0:
                return None
            anchor_no = before if before is not None else after
            if anchor_no is None:
                anchor, where = "", "end"
            else:
                anchor = _paragraph_find(doc, anchor_no, whole)
                if anchor is None:
                    return None
                where = "before" if before is not None else "after"
            if name == "insert_table":
                return {"method": "insertTable", "anchor": anchor, "occurrence": None, "where": where, "rows": [[markdown_lite.plain(c) for c in r] for r in args["rows"]], "header": bool(args.get("header", True))}
            specs = markdown_lite.parse(args["markdown"])
            if not specs or any(isinstance(s, markdown_lite.TableSpec) or s.kind != "body" for s in specs):
                return None  # 제목·표·목록이 든 마크다운은 서버가 넣는다 (스타일을 입히려면 서버가 낫다)
            texts = [markdown_lite.plain(s.text) for s in specs]
            if any(not t for t in texts) or args.get("like") is not None:
                return None
            return {"method": "insertParagraphs", "anchor": anchor, "occurrence": None, "where": where, "paragraphs": texts}
        if name == "fill_fields":
            fields = doc.fields()
            calls = []
            for key, value in args["values"].items():
                import re

                if re.fullmatch(r"#\d+", key):
                    n = int(key[1:])
                    matches = [f for f in fields if f.number == n]
                else:
                    matches = [f for f in fields if f.name == key] or [f for f in fields if f.direction == key]
                if len(matches) != 1 or matches[0].read_only:
                    return None
                calls.append({"field": matches[0].number, "value": value})
            return {"method": "fillField", "calls": calls}
    except (KeyError, IndexError, ValueError, AttributeError):
        return None
    return None


def _prepare_docx(name: str, args: dict) -> dict[str, Any] | None:
    if name == "read_selection":
        return {"method": "selection"}
    if name == "replace_selection":
        return {"method": "replaceSelection", "texts": list(args["texts"])}
    if name == "format_selection":
        fmt = {**_text_format(args), **_para_format(args)}
        return {"method": "formatSelection", "format": fmt} if fmt else None
    if name in LIVE_ONLY_TOOLS:
        return None  # 각주·차례·칸 합치기는 DOCX 편집기가 아직 받지 않는다
    return {"method": "flush"}
