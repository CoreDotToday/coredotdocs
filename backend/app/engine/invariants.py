"""편집 앞뒤의 구조 비교 — "검증-후-확정".

편집 도구가 의도하지 않은 것(표·그림·누름틀의 수, 누름틀 값, 블록 수)을 바꿨으면 리비전으로 확정하지 않고 거절한다.
이음오피스의 `keepingObjects`(변경 앞뒤 개체 수·누름틀 값 비교, 다르면 통째로 되돌림)와 한글의 달인의 `FidelityReport`
(sections/paragraphs/tables 일치 보고)를 합친 것이다. 설계 문서 04 §9.1-2.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Fingerprint:
    blocks: int
    paragraphs: int
    tables: int
    pictures: int
    fields: tuple[tuple[int, str], ...]  # (번호, 지금 글)

    @property
    def field_count(self) -> int:
        return len(self.fields)

    def line(self) -> str:
        return f"문단 {self.paragraphs}, 표 {self.tables}, 그림 {self.pictures}, 누름틀 {self.field_count}"


def fingerprint(doc) -> Fingerprint:
    blocks = doc.blocks()
    tables = 0
    for b in blocks:
        if b.kind == "table":
            tables += 1 + _count_inner(doc, b.table)
    try:
        fields = tuple((f.number, f.text) for f in doc.fields())
    except Exception:  # 형식이 누름틀을 지원하지 않으면 빈 목록
        fields = ()
    return Fingerprint(blocks=len(blocks), paragraphs=sum(1 for b in blocks if b.kind == "paragraph"), tables=tables, pictures=doc.picture_count(), fields=fields)


def _count_inner(doc, tbl) -> int:
    n = 0
    for cell in doc.ops.table_grid(tbl).cells:
        for inner in doc.ops.inner_tables_of_cell(cell.element):
            n += 1 + _count_inner(doc, inner)
    return n


# 도구별로 허용하는 변화. 적지 않은 것은 "같아야 한다".
#   tables/pictures: "+"(늘 수 있음) "-"(줄 수 있음) "±"(둘 다) None(불변)
#   field_values: 누름틀 값이 바뀌어도 되는가, field_count: 누름틀 수가 바뀌어도 되는가, blocks: 블록 수가 바뀌어도 되는가
ALLOW: dict[str, dict] = {
    "replace_text": {"field_values": True},
    "set_paragraph_text": {},
    "insert_content": {"tables": "+", "blocks": True},
    "delete_blocks": {"tables": "-", "pictures": "-", "field_count": True, "field_values": True, "blocks": True},
    "set_table_cells": {"field_values": True},
    "format_table": {},
    "insert_table_rows": {"field_count": True},
    "delete_table_rows": {"field_count": True, "field_values": True},
    "insert_table": {"tables": "+", "blocks": True},
    "insert_image": {"pictures": "+", "blocks": True},
    "fill_fields": {"field_values": True},
    "format_text": {},
    "format_paragraphs": {},
    "replace_selection": {"blocks": True, "field_values": True},
    "format_selection": {},
    "merge_table_cells": {"field_count": True, "field_values": True},
    "split_table_cell": {},
    "shade_table_cells": {},
    "insert_note": {"blocks": True},
    "edit_note": {"blocks": True},
    "insert_toc": {"tables": "+", "blocks": True},
}


def _ok(delta: int, rule: str | None) -> bool:
    if rule == "±":
        return True
    if rule == "+":
        return delta >= 0
    if rule == "-":
        return delta <= 0
    return delta == 0


def violation(tool: str, before: Fingerprint, after: Fingerprint) -> str | None:
    """허용되지 않은 변화가 있으면 사람이 읽는 이유를, 없으면 None."""
    allow = ALLOW.get(tool, {})
    problems: list[str] = []
    if not _ok(after.tables - before.tables, allow.get("tables")):
        problems.append(f"표 수 {before.tables}→{after.tables}")
    if not _ok(after.pictures - before.pictures, allow.get("pictures")):
        problems.append(f"그림 수 {before.pictures}→{after.pictures}")
    if not allow.get("field_count") and after.field_count != before.field_count:
        problems.append(f"누름틀 수 {before.field_count}→{after.field_count}")
    elif not allow.get("field_values") and after.field_count == before.field_count and after.fields != before.fields:
        changed = [str(n) for (n, a), (_, b) in zip(before.fields, after.fields) if a != b]
        problems.append(f"누름틀 #{', #'.join(changed[:5])}의 글")
    if not allow.get("blocks") and after.blocks != before.blocks:
        problems.append(f"블록 수 {before.blocks}→{after.blocks}")
    if not problems:
        return None
    return "의도하지 않은 변화가 생겨 적용하지 않았습니다: " + ", ".join(problems) + ". 대상이 개체(표·그림·누름틀)를 품고 있으면 그 개체를 다루는 도구를 쓰거나 범위를 좁히세요."
