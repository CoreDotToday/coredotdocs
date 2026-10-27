"""블록 모델 위의 읽기·편집 명령. 엔진(HWPX·DOCX)은 같은 메서드 이름을 제공한다.

입력은 도구 레지스트리의 JSON Schema를 통과한 뒤 들어오지만, 문서 상태에 따른 검사(없는 블록·칸)는 여기서 한다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import markdown_lite
from .errors import CommandError
from .images import image_info
from .search import find_text, many_message, not_found_message, paragraphs_of
from .textrules import assert_xml_safe

READ_LIMIT = 18_000
MAX_CELL_CHARS = 200
HEADING_GROW = {1: 6, 2: 4, 3: 2, 4: 1, 5: 0, 6: 0}
ALIGN_CODES = {"left": "LEFT", "center": "CENTER", "right": "RIGHT", "justify": "JUSTIFY", "distribute": "DISTRIBUTE"}


@dataclass
class CommandResult:
    text: str
    edited: bool
    blocks: list[int] = field(default_factory=list)


def _block(doc, no: int):
    try:
        return doc.block(no)
    except IndexError:
        raise CommandError(f"블록 {no}이(가) 없습니다 (전체 {len(doc.blocks())}블록).", "OUT_OF_RANGE")


def _table(doc, ref):
    try:
        return doc.table(ref)
    except IndexError as e:
        tables = doc.tables()
        if not tables:
            raise CommandError("이 문서에는 표가 없습니다.", "TARGET_NOT_FOUND")
        raise CommandError(f"표 {e}이(가) 없습니다. 표는 1~{len(tables)}번이고 안쪽 표는 '1-2'처럼 씁니다.", "OUT_OF_RANGE")


def paragraph_objects(doc, p) -> str:
    """문단이 품은 개체를 사람이 읽는 말로 (없으면 빈 글). 그림·누름틀·표를 센다."""
    kinds = []
    if doc.ops.paragraph_has_picture(p):
        kinds.append("그림")
    if doc.ops.paragraph_has_field(p):
        kinds.append("누름틀")
    if doc.ops.paragraph_has_table(p):
        kinds.append("표")
    return "·".join(kinds)


def cell_objects(doc, tc) -> str:
    if doc.ops.inner_tables_of_cell(tc):
        return "안쪽 표"
    for p in doc.ops.cell_paragraphs(tc):
        held = paragraph_objects(doc, p)
        if held:
            return held
    return ""


# ── 읽기 ────────────────────────────────────────────────────────────────


def _cell_label(c) -> str:
    span = f"~({c.row + c.row_span},{c.col + c.col_span})" if c.row_span > 1 or c.col_span > 1 else ""
    return f"({c.row + 1},{c.col + 1}){span}"


def _table_summary_lines(doc, block, indent: str = "    ") -> list[str]:
    grid = doc.ops.table_grid(block.table)
    lines = [f"[{block.no}] 표 {block.table_no} ({grid.rows}행 × {grid.cols}열)"]
    for row in range(grid.rows):
        parts = []
        for c in grid.row_cells(row):
            text = c.text.replace("\n", " / ")
            inner = len(doc.ops.inner_tables_of_cell(c.element))
            if inner:
                text = (text + " " if text else "") + f"[안쪽 표 {inner}개]"
            if len(text) > MAX_CELL_CHARS:
                text = text[:MAX_CELL_CHARS] + "…"
            parts.append(f"{_cell_label(c)} {text}")
        if parts:
            lines.append(indent + " | ".join(parts))
    return lines


def _table_full_lines(doc, tbl, label: str, include_format: bool, row_from: int | None, row_to: int | None, indent: str = "") -> list[str]:
    grid = doc.ops.table_grid(tbl)
    lines = [f"{indent}표 {label} ({grid.rows}행 × {grid.cols}열)"]
    if row_from is not None and not 1 <= row_from <= grid.rows:
        raise CommandError(f"row_from은 표의 전체 {grid.rows}행 안에서 골라 주세요.")
    r0 = (row_from or 1) - 1
    r1 = min(row_to or grid.rows, grid.rows)
    if r1 < r0 + 1:
        raise CommandError("row_to는 row_from 이상이어야 합니다.")
    inner_no = 0
    for c in sorted(grid.cells, key=lambda c: (c.row, c.col)):
        overlaps = c.row < r1 and c.row + c.row_span > r0
        inner = doc.ops.inner_tables_of_cell(c.element)
        if not overlaps:
            inner_no += len(inner)
            continue
        fmt = ""
        if include_format:
            look = doc.ops.cell_format(doc, c.element)
            fmt = f" [{look['size']:g}pt, 정렬 {look['align'].lower()}, 세로 {look['vertical_align'].lower()}]"
        lines.append(f"{indent}  {_cell_label(c)}{fmt}")
        paragraphs = doc.ops.cell_paragraphs(c.element)
        texts = [doc.ops.paragraph_text(p) for p in paragraphs]
        if not any(t.strip() for t in texts) and not inner:
            lines.append(f"{indent}    (빈 칸)")
        for t in texts:
            if t.strip():
                lines.append(f"{indent}    {t}")
        for t in inner:
            inner_no += 1
            lines.extend(_table_full_lines(doc, t, f"{label}-{inner_no}", include_format, None, None, indent + "    "))
    return lines


def _group_empty(lines_by_block: list[tuple[int, str, list[str]]]) -> list[str]:
    """같은 모양의 빈 문단이 3개 이상 이어지면 [5~9] (모양)(빈 문단 5개)로 묶는다."""
    out: list[str] = []
    i = 0
    while i < len(lines_by_block):
        no, label, lines = lines_by_block[i]
        if label is not None:
            j = i + 1
            while j < len(lines_by_block) and lines_by_block[j][1] == label and lines_by_block[j][0] == lines_by_block[j - 1][0] + 1:
                j += 1
            if j - i >= 3:
                out.append(f"[{no}~{lines_by_block[j - 1][0]}] {label}(빈 문단 {j - i}개)")
                i = j
                continue
        out.extend(lines)
        i += 1
    return out


def read_document(doc, start: int = 1, end: int | None = None, max_chars: int = READ_LIMIT, *, offset: int | None = None, table=None, include_format: bool = False, row_from: int | None = None, row_to: int | None = None) -> tuple[str, int | None, int | None]:
    """(본문, 이어 읽을 from, 이어 읽을 offset). table을 주면 그 표만 칸 글 전체로 읽는다."""
    if table is not None:
        _, tbl, label = _table(doc, table)
        text = "\n".join(_table_full_lines(doc, tbl, label, include_format, row_from, row_to))
        return _page_by_offset(text, offset or 0, max_chars)
    if row_from is not None or row_to is not None:
        raise CommandError("row_from·row_to는 table과 함께 주세요. 문서 블록은 from·to로 골라요.")
    blocks = doc.blocks()
    if start > len(blocks):
        return (f"블록 {start}이(가) 없습니다 (전체 {len(blocks)}블록).", None, None)
    end = min(end or len(blocks), len(blocks))
    if end < start:
        raise CommandError("to는 from 이상의 블록 번호로 주세요.")
    rendered: list[tuple[int, str | None, list[str]]] = []
    for b in blocks[start - 1 : end]:
        if b.kind == "table":
            rendered.append((b.no, None, _table_summary_lines(doc, b)))
        else:
            summary = doc.describe_paragraph(b.paragraph)
            text = b.text()
            prefix = f"{summary} " if summary else ""
            rendered.append((b.no, prefix if not text else None, [f"[{b.no}] {prefix}{text or '(빈 문단)'}"]))
    if offset is not None:
        return _page_by_offset("\n".join(_group_empty(rendered)), offset, max_chars)
    lines: list[str] = []
    size = 0
    last = start - 1
    grouped_blocks = _group_empty_blocks(rendered)
    for last_no, chunk in grouped_blocks:
        length = sum(len(line) + 1 for line in chunk)
        if lines and size + length > max_chars:
            break
        lines.extend(chunk)
        size += length
        last = last_no
    next_from = last + 1 if last < end else None
    if next_from:
        lines.append(f"… 블록 {start}~{last}까지 보였습니다. 이어서 읽으려면 from: {next_from}을 주세요.")
    return ("\n".join(lines), next_from, None)


def _group_empty_blocks(rendered) -> list[tuple[int, list[str]]]:
    out: list[tuple[int, list[str]]] = []
    i = 0
    while i < len(rendered):
        no, label, lines = rendered[i]
        if label is not None:
            j = i + 1
            while j < len(rendered) and rendered[j][1] == label and rendered[j][0] == rendered[j - 1][0] + 1:
                j += 1
            if j - i >= 3:
                out.append((rendered[j - 1][0], [f"[{no}~{rendered[j - 1][0]}] {label}(빈 문단 {j - i}개)"]))
                i = j
                continue
        out.append((no, lines))
        i += 1
    return out


def _page_by_offset(text: str, offset: int, max_chars: int) -> tuple[str, int | None, int | None]:
    if offset > len(text):
        raise CommandError(f"offset은 전체 글 길이 {len(text)} 이하여야 합니다. 조건을 바꿨으면 offset: 0에서 다시 읽으세요.")
    end = min(offset + max_chars, len(text))
    chunk = text[offset:end]
    next_offset = end if end < len(text) else None
    if next_offset is not None:
        chunk += f"\n… 전체 {len(text)}자 중 {offset}~{end}. 이어 읽으려면 offset: {next_offset}을 주세요."
    return chunk, None, next_offset


def document_info(doc) -> str:
    blocks = doc.blocks()
    tables = [b for b in blocks if b.kind == "table"]
    chars = sum(len(b.text()) for b in blocks if b.kind == "paragraph") + sum(len(c.text) for t in tables for c in doc.ops.table_grid(t.table).cells)
    setups = doc.page_setups()
    styles = doc.style_usage()
    used = " · ".join(f"{name} {count}" for name, count in styles.items())
    return "\n".join(
        [
            f"구역 {len(doc.section_paths)}개 · 블록 {len(blocks)}개 · 표 {len(tables)}개 · 그림 {doc.picture_count()}개 · 누름틀 {len(doc.fields())}개",
            *_page_lines(setups),
            f"글자 수: {chars}자",
            f"쓰인 문단 스타일 (문단 수): {used or '(없음)'}",
        ]
    )


def _page_lines(setups) -> list[str]:
    """쪽 설정 줄. 모든 구역이 같으면 한 줄, 다르면 구역마다."""
    if not setups:
        return ["쪽 설정: (없음)"]
    if all(s == setups[0] for s in setups):
        return [f"쪽 설정{' (모든 구역)' if len(setups) > 1 else ''}: {setups[0].line()}"]
    return [f"쪽 설정 구역 {i}: {s.line()}" for i, s in enumerate(setups, 1)]


def set_page_setup(doc, patch: dict, section: int | None = None) -> CommandResult:
    keys = ("paper", "width_mm", "height_mm", "orientation", "margins_mm", "header_mm", "footer_mm", "gutter_mm")
    if not any(patch.get(k) is not None for k in keys):
        raise CommandError("바꿀 쪽 설정(paper·orientation·margins_mm·header_mm·footer_mm 등)을 하나 이상 주세요.", "INVALID_ARGUMENT")
    changed = doc.set_page_setup(section, patch)
    setups = doc.page_setups()
    where = f"구역 {changed[0]}" if section is not None else ("모든 구역" if len(changed) > 1 else "문서")
    return CommandResult(f"{where}의 쪽 설정을 바꿨습니다: {setups[changed[0] - 1].line()}", True, [])


def find(doc, query: str, limit: int = 50) -> str:
    if not query:
        raise CommandError("찾을 글(query)을 주세요.")
    hits = find_text(doc, query, limit=limit)
    if not hits:
        return f"'{query[:40]}'을(를) 찾지 못했습니다."
    return "\n".join(h.line() for h in hits)


def list_fields(doc, start: int | None = None, end: int | None = None, max_chars: int = READ_LIMIT) -> str:
    fields = doc.fields()
    if not fields:
        return "이 문서에는 누름틀(필드)이 없습니다."
    start = start or 1
    end = min(end or len(fields), len(fields))
    if end < start:
        raise CommandError("to는 from 이상의 필드 번호로 주세요.")
    if start > len(fields):
        return f"필드 #{start}이(가) 없습니다 (전체 {len(fields)}개)."
    clip = lambda s, n: s if len(s) <= n else s[:n] + "…"  # noqa: E731
    lines, size, last = [], 0, start - 1
    for f in fields[start - 1 : end]:
        where = f" {f.where}" if f.where else ""
        line = f"#{f.number} [{f.block_no}]{where}{' 이름 ' + repr(clip(f.name, 200)) if f.name else ''}{' 안내 ' + repr(clip(f.direction, 400)) if f.direction else ''} = {repr(clip(f.text, 800)) if f.text else '(비었음)'}{' (읽기 전용: ' + f.type + ')' if f.read_only else ''}"
        if lines and size + len(line) + 1 > max_chars - 256:
            break
        lines.append(line)
        size += len(line) + 1
        last = f.number
    if last < len(fields):
        lines.append(f"… 필드 #{start}~#{last}까지만 보입니다 (전체 {len(fields)}개). 이어서 읽으려면 from: {last + 1}을 주세요.")
    return "\n".join(lines)


# ── 편집 ────────────────────────────────────────────────────────────────


def replace_text(doc, find_: str, replace: str, all_: bool = False, block: int | None = None, match_case: bool = False) -> CommandResult:
    if not find_:
        raise CommandError("바꿀 글(find)을 주세요.")
    assert_xml_safe(replace, "replace")
    paragraphs = paragraphs_of(doc, block)
    if block is not None and not paragraphs:
        raise CommandError(f"블록 {block}이(가) 없습니다.", "OUT_OF_RANGE")
    hits = find_text(doc, find_, limit=10_000, match_case=match_case, only_block=block)
    if not hits:
        raise CommandError(not_found_message(find_, paragraphs, block), "TARGET_NOT_FOUND")
    if len(hits) > 1 and not all_:
        raise CommandError(many_message(find_, hits), "AMBIGUOUS_TARGET")
    by_para: dict[int, list] = {}
    for h in hits:
        by_para.setdefault(id(h.element), []).append(h)
    for group in by_para.values():
        for h in sorted(group, key=lambda x: -x.start):
            doc.ops.replace_in_paragraph(h.element, h.start, h.end, replace)
    blocks = sorted({h.block_no for h in hits})
    return CommandResult(f"{len(hits)}곳을 바꿨습니다 (블록 {', '.join(map(str, blocks[:12]))}{' …' if len(blocks) > 12 else ''}).", True, blocks)


def set_paragraph(doc, block: int, text: str) -> CommandResult:
    assert_xml_safe(text, "text")
    b = _block(doc, block)
    if b.kind == "table":
        raise CommandError(f"블록 {block}은(는) 표입니다. 표 칸은 set_table_cells로 고치세요.", "HOLDS_OBJECT")
    held = paragraph_objects(doc, b.paragraph)
    if held:
        raise CommandError(f"블록 {block}에는 {held}이(가) 있어 글을 통째로 바꾸지 않았습니다. replace_text로 글 일부만 바꾸거나 fill_fields로 누름틀을 채우세요.", "HOLDS_OBJECT")
    doc.set_paragraph_runs(b.paragraph, markdown_lite.inline_runs(text))
    return CommandResult(f"블록 {block}의 글을 바꿨습니다.", True, [block])


def insert_content(doc, markdown: str, after: int | None = None, before: int | None = None, like: int | None = None) -> CommandResult:
    assert_xml_safe(markdown, "markdown")
    specs = markdown_lite.parse(markdown)
    if not specs:
        raise CommandError("넣을 내용(markdown)이 비어 있습니다.")
    total = len(doc.blocks())
    for name, value in (("before", before), ("after", after), ("like", like)):
        if value is not None and value != 0 and not 1 <= value <= total:
            raise CommandError(f"{name} 블록 {value}이(가) 없습니다. 블록은 1~{total}번입니다.", "OUT_OF_RANGE")
    if before is not None and after is not None:
        raise CommandError("after와 before 중 하나만 주세요.")
    elements = doc.build_content(specs, like=like)
    numbers = doc.insert_elements(elements, after=after, before=before)
    return CommandResult(f"문단 {len(numbers)}개를 넣었습니다 (블록 {', '.join(map(str, numbers[:12]))}{' …' if len(numbers) > 12 else ''}).", True, numbers)


def delete_blocks(doc, start: int, end: int | None = None, include_objects: bool = False) -> CommandResult:
    total = len(doc.blocks())
    end = end if end is not None else start
    if not (1 <= start <= end <= total):
        raise CommandError(f"지울 블록 범위가 잘못되었습니다 (1~{total}).", "OUT_OF_RANGE")
    if not include_objects:
        holding = []
        for b in doc.blocks()[start - 1 : end]:
            held = "표" if b.kind == "table" else paragraph_objects(doc, b.paragraph)
            if held:
                holding.append(f"블록 {b.no}({held})")
        if holding:
            raise CommandError(f"{', '.join(holding[:8])}{' …' if len(holding) > 8 else ''}에 개체가 있어 지우지 않았습니다. 사용자가 그 개체까지 지우라고 했으면 include_objects: true로 다시 부르세요.", "HOLDS_OBJECT")
    removed = doc.delete_blocks(start, end)
    return CommandResult(f"블록 {removed}개를 지웠습니다. 뒤 블록 번호가 앞당겨졌으니 다시 읽으세요.", True, list(range(start, end + 1)))


def set_table_cells(doc, table_ref, cells: list[dict], overwrite: bool = False) -> CommandResult:
    assert_xml_safe(cells, "cells")
    block, tbl, label = _table(doc, table_ref)
    grid = doc.ops.table_grid(tbl)
    targets = []
    seen: dict[int, tuple[int, int]] = {}
    notes = []
    occupied: list[str] = []
    holding: list[str] = []
    for spec in cells:
        row, col = int(spec["row"]), int(spec["col"])
        if "text" not in spec and not spec.get("format"):
            raise CommandError(f"({row},{col}) 칸에 넣을 text나 format을 주세요.")
        cell = grid.cell_at(row - 1, col - 1)
        if cell is None:
            raise CommandError(f"표 {label}에 ({row},{col}) 칸이 없습니다. 이 표는 {grid.rows}행 × {grid.cols}열입니다.", "OUT_OF_RANGE")
        if id(cell.element) in seen:
            raise CommandError(f"{seen[id(cell.element)]}과 ({row},{col})은 같은 칸입니다. 한 번만 주세요.")
        seen[id(cell.element)] = (row, col)
        if (cell.row + 1, cell.col + 1) != (row, col):
            notes.append(f"({row},{col})은 합친 칸 {_cell_label(cell)}이라 그 칸에 썼습니다.")
        if "text" in spec:
            held = cell_objects(doc, cell.element)
            if held:
                holding.append(f"({row},{col}): {held}")
            elif cell.text.strip() and not overwrite and cell.text.strip() != str(spec["text"]).strip():
                occupied.append(f"({row},{col}): '{cell.text.strip()[:20]}'")
        targets.append((cell, spec))
    if holding:
        raise CommandError(f"표 {label}의 칸에 개체가 있어 아무것도 쓰지 않았습니다: {'; '.join(holding[:8])}. 그 칸은 빼고 다시 부르세요.", "HOLDS_OBJECT")
    if occupied:
        raise CommandError(f"표 {label}의 칸에 이미 글이 있어 아무것도 쓰지 않았습니다: {'; '.join(occupied[:8])}. 사용자가 바꾸라고 한 것이면 overwrite: true로 다시 부르세요.", "CELL_NOT_EMPTY")
    for cell, spec in targets:
        if "text" in spec:
            doc.ops.write_cell(cell.element, spec["text"])
        if spec.get("format"):
            doc.format_cell(cell.element, spec["format"])
    text = f"표 {label}의 칸 {len(targets)}개를 고쳤습니다."
    if notes:
        text += "\n" + "\n".join(notes)
    return CommandResult(text, True, [block.no])


def format_table(doc, table_ref, fmt: dict) -> CommandResult:
    block, tbl, label = _table(doc, table_ref)
    grid = doc.ops.table_grid(tbl)
    for cell in grid.cells:
        doc.format_cell(cell.element, fmt)
    return CommandResult(f"표 {label}의 칸 {len(grid.cells)}개 서식을 바꿨습니다.", True, [block.no])


def insert_table_rows(doc, table_ref, after_row: int | None = None, rows: list[list[str]] | None = None, count: int | None = None) -> CommandResult:
    rows = rows or []
    assert_xml_safe(rows, "rows")
    block, tbl, label = _table(doc, table_ref)
    try:
        n = doc.insert_table_rows(tbl, after_row, rows, count)
    except ValueError as e:
        raise CommandError(str(e))
    return CommandResult(f"표 {label}에 행 {n}개를 넣었습니다.", True, [block.no])


def delete_table_rows(doc, table_ref, start: int, end: int | None = None) -> CommandResult:
    block, tbl, label = _table(doc, table_ref)
    try:
        n = doc.delete_table_rows(tbl, start, end if end is not None else start)
    except ValueError as e:
        raise CommandError(str(e))
    return CommandResult(f"표 {label}의 행 {n}개를 지웠습니다.", True, [block.no])


def insert_table(doc, rows: list[list[str]], after: int | None = None, header: bool = True) -> CommandResult:
    assert_xml_safe(rows, "rows")
    if not rows or not any(rows):
        raise CommandError("rows에 표 내용을 주세요: [[\"구분\", \"내용\"], …].")
    total = len(doc.blocks())
    if after is not None and not 1 <= after <= total:
        raise CommandError(f"블록 {after}이(가) 없습니다. 블록은 1~{total}번입니다.", "OUT_OF_RANGE")
    element = doc.build_table([[markdown_lite.plain(c) for c in r] for r in rows], header=header)
    numbers = doc.insert_elements([element], after=after)
    table_no = next((b.table_no for b in doc.blocks() if b.no in numbers and b.kind == "table"), None)
    return CommandResult(f"표 {table_no}을(를) 넣었습니다 (블록 {', '.join(map(str, numbers))}).", True, numbers)


def insert_image(doc, data: bytes, after: int | None = None, width_mm: float | None = None, align: str = "center") -> CommandResult:
    info = image_info(data)
    if info is None:
        raise CommandError("PNG·JPEG·GIF·BMP 그림만 넣을 수 있습니다.")
    total = len(doc.blocks())
    if after is not None and not 1 <= after <= total:
        raise CommandError(f"블록 {after}이(가) 없습니다. 블록은 1~{total}번입니다.", "OUT_OF_RANGE")
    element = doc.build_image(data, info, width_mm, align)
    numbers = doc.insert_elements([element], after=after)
    return CommandResult(f"그림을 넣었습니다 (블록 {', '.join(map(str, numbers))}, {info.width}×{info.height}px).", True, numbers)


def fill_fields(doc, values: dict[str, str]) -> CommandResult:
    assert_xml_safe(values, "values")
    if not values:
        raise CommandError("values에 { 누름틀 이름 또는 안내문: 넣을 글 }을 주세요.")
    fields = doc.fields()
    requests = []
    missing = []
    chosen: set[int] = set()
    for key, value in values.items():
        matches = []
        if re.fullmatch(r"#\d+", key):
            n = int(key[1:])
            matches = [f for f in fields if f.number == n]
        elif key.strip():
            for pred in (lambda f: f.name == key, lambda f: f.direction == key, lambda f: key in f.direction and f.direction):
                matches = [f for f in fields if pred(f)]
                if matches:
                    break
        if not matches:
            missing.append(key)
            continue
        if len(matches) > 1:
            raise CommandError(f"누름틀 '{key}'이(가) 여러 개입니다. list_fields의 '#번호'로 하나를 지정하세요.", "AMBIGUOUS_TARGET")
        f = matches[0]
        if f.number in chosen:
            raise CommandError(f"같은 누름틀을 두 번 지정했습니다 ('{key}').")
        if f.read_only:
            raise CommandError(f"누름틀 '{key}'은(는) 읽기 전용입니다 ({f.type}).")
        chosen.add(f.number)
        requests.append((f, value))
    if missing:
        raise CommandError(f"누름틀을 찾지 못했습니다: {', '.join(missing)}. list_fields로 목록을 확인하세요. 요청한 칸은 모두 그대로 두었습니다.", "TARGET_NOT_FOUND")
    for f, value in requests:
        doc.fill_field(f, value)
    blocks = sorted({f.block_no for f, _ in requests})
    return CommandResult(f"누름틀 {len(requests)}개를 채웠습니다 (블록 {', '.join(map(str, blocks))}).", True, blocks)


def format_text(doc, find_: str, all_: bool = False, block: int | None = None, **look) -> CommandResult:
    if not find_:
        raise CommandError("모양을 바꿀 글(find)을 주세요.")
    patch = {k: v for k, v in look.items() if v is not None}
    if not patch:
        raise CommandError("바꿀 모양을 하나 이상 주세요 (bold, italic, underline, strike, color, size, font).")
    paragraphs = paragraphs_of(doc, block)
    if block is not None and not paragraphs:
        raise CommandError(f"블록 {block}이(가) 없습니다.", "OUT_OF_RANGE")
    if all_ and block is None and not any(ch.isalnum() for ch in find_):
        # 마침표·공백 같은 기호를 find로 주고 all을 켜면 기호에만 모양이 붙는다 (관측: '.' 375곳에만 글꼴이 들어감)
        raise CommandError(f"'{find_}' 같은 기호로는 문서 전체를 바꿀 수 없습니다 (그 기호에만 모양이 붙습니다). 문서 전체나 블록 범위의 글꼴·크기·색은 format_paragraphs(all: true 또는 from~to)로 바꾸세요.", "INVALID_ARGUMENT")
    hits = find_text(doc, find_, limit=10_000, only_block=block)
    if not hits:
        raise CommandError(not_found_message(find_, paragraphs, block), "TARGET_NOT_FOUND")
    if len(hits) > 1 and not all_:
        raise CommandError(many_message(find_, hits), "AMBIGUOUS_TARGET")
    by_para: dict[int, list] = {}
    for h in hits:
        by_para.setdefault(id(h.element), []).append(h)
    for group in by_para.values():
        for h in sorted(group, key=lambda x: -x.start):
            doc.format_range(h.element, h.start, h.end, patch)
    blocks = sorted({h.block_no for h in hits})
    return CommandResult(f"{len(hits)}곳의 글자 모양을 바꿨습니다 (블록 {', '.join(map(str, blocks[:12]))}).", True, blocks)


CHAR_LOOK_KEYS = ("font", "size", "color", "bold", "italic")


def format_paragraphs(doc, start: int | None, end: int | None = None, all_: bool = False, **patch) -> CommandResult:
    """블록 범위(또는 문서 전체)의 문단 모양과, 그 안 모든 글(표 칸 포함)의 글자 모양을 바꾼다."""
    total = len(doc.blocks())
    if total == 0:
        raise CommandError("문서에 블록이 없습니다.", "OUT_OF_RANGE")
    if all_:
        start, end = 1, total
    elif start is None:
        raise CommandError("처음 블록(from)을 주거나 all: true로 문서 전체를 지정하세요.", "INVALID_ARGUMENT")
    end = end if end is not None else start
    if not (1 <= start <= end <= total):
        raise CommandError(f"블록 범위가 잘못되었습니다 (1~{total}).", "OUT_OF_RANGE")
    patch = {k: v for k, v in patch.items() if v is not None}
    if not patch:
        raise CommandError("바꿀 문단 모양이나 글자 모양을 하나 이상 주세요.")
    char = {k: v for k, v in patch.items() if k in CHAR_LOOK_KEYS}
    para = {k: v for k, v in patch.items() if k not in CHAR_LOOK_KEYS}
    done = 0
    runs = 0
    for b in doc.blocks()[start - 1 : end]:
        if b.kind == "paragraph":
            if para:
                doc.format_paragraph(b.paragraph, para)
                done += 1
            if char:
                runs += _format_whole(doc, b.paragraph, char)
        elif b.kind == "table" and char:
            # 표 블록: 칸 안 문단(안쪽 표 포함)의 글자 모양. 문단 모양(정렬 등)은 표 칸에는 적용하지 않는다 (format_table의 몫)
            for p in paragraphs_of(doc, b.no):
                runs += _format_whole(doc, p.element, char)
    parts = []
    if para:
        parts.append(f"문단 {done}개의 모양")
    if char:
        parts.append(f"글 {runs}곳의 글자 모양")
    where = "문서 전체" if all_ else f"블록 {start}~{end}"
    return CommandResult(f"{'과 '.join(parts)}을 바꿨습니다 ({where}).", True, list(range(start, end + 1)))


def _format_whole(doc, p, char: dict) -> int:
    """문단 전체의 글자 모양 (빈 문단은 끝 표시·run만 바뀌고 세지 않는다)."""
    return 1 if doc.format_whole_paragraph(p, char) else 0
