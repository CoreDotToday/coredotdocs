"""글자 그대로(literal) 찾기. 정규식이 아니라 문자열 검색을 쓰므로 질의 길이와 무관하게 안전하다."""

from __future__ import annotations

from dataclasses import dataclass

from .textrules import slice_keeping_pairs

CONTEXT = 30


@dataclass
class Hit:
    block_no: int
    where: str  # "" 또는 "표 N (r,c)"
    start: int
    end: int
    text: str  # 검색한 문단 전체 글
    element: object = None  # 문단 요소 (치환·서식 대상)

    @property
    def before(self) -> str:
        return slice_keeping_pairs(self.text, self.start - CONTEXT, self.start)

    @property
    def match(self) -> str:
        return self.text[self.start : self.end]

    @property
    def after(self) -> str:
        return slice_keeping_pairs(self.text, self.end, self.end + CONTEXT)

    def line(self) -> str:
        where = f" {self.where}" if self.where else ""
        return f"[{self.block_no}]{where} …{self.before}【{self.match}】{self.after}…"


@dataclass
class Paragraph:
    block_no: int
    where: str
    element: object
    text: str


def paragraphs_of(doc, only_block: int | None = None) -> list[Paragraph]:
    """검색·치환 대상 문단: 문단 블록의 글, 표 블록의 칸 안 문단 글(안쪽 표 포함)."""
    out: list[Paragraph] = []
    ops = doc.ops

    def visit_table(tbl, block_no: int, label: str) -> None:
        grid = ops.table_grid(tbl)
        inner_no = 0
        for cell in grid.cells:
            where = f"표 {label} ({cell.row + 1},{cell.col + 1})"
            for p in ops.cell_paragraphs(cell.element):
                out.append(Paragraph(block_no, where, p, ops.paragraph_text(p)))
            for inner in ops.inner_tables_of_cell(cell.element):
                inner_no += 1
                visit_table(inner, block_no, f"{label}-{inner_no}")

    for b in doc.blocks():
        if only_block is not None and b.no != only_block:
            continue
        if b.kind == "paragraph":
            out.append(Paragraph(b.no, "", b.paragraph, b.text()))
        else:
            visit_table(b.table, b.no, str(b.table_no))
    return out


def find_ranges(text: str, needle: str, match_case: bool = False, limit: int | None = None) -> list[tuple[int, int]]:
    """겹치지 않는 일치 범위. 대소문자 무시는 casefold 길이가 달라질 수 있어 lower()를 쓴다 (길이 보존)."""
    if not needle:
        return []
    haystack, key = (text, needle) if match_case else (text.lower(), needle.lower())
    if len(haystack) != len(text):
        haystack, key = text.casefold(), needle.casefold()
        if len(haystack) != len(text):
            haystack, key = text, needle  # 길이가 바뀌면 원문 위치를 믿을 수 없으니 정확 일치로
    out: list[tuple[int, int]] = []
    at = haystack.find(key)
    while at >= 0 and (limit is None or len(out) < limit):
        out.append((at, at + len(key)))
        at = haystack.find(key, at + len(key))
    return out


def find_text(doc, query: str, limit: int = 50, match_case: bool = False, only_block: int | None = None) -> list[Hit]:
    hits: list[Hit] = []
    for para in paragraphs_of(doc, only_block):
        for start, end in find_ranges(para.text, query, match_case, None if limit is None else limit - len(hits)):
            hits.append(Hit(para.block_no, para.where, start, end, para.text, para.element))
        if len(hits) >= limit:
            break
    return hits


def loose_matches(needle: str, paragraphs: list[Paragraph], limit: int = 5) -> list[tuple[str, Paragraph]]:
    """띄어쓰기를 무시하고 찾은 실제 글 (못 찾았을 때 힌트)."""
    key = "".join(needle.split()).lower()
    if not key:
        return []
    found: list[tuple[str, Paragraph]] = []
    for para in paragraphs:
        positions = [i for i, ch in enumerate(para.text) if not ch.isspace()]
        squeezed = "".join(para.text[i] for i in positions).lower()
        at = squeezed.find(key)
        while at >= 0 and len(found) < limit:
            actual = para.text[positions[at] : positions[at + len(key) - 1] + 1]
            if all(actual != other for other, _ in found):
                found.append((actual, para))
            at = squeezed.find(key, at + len(key))
        if len(found) >= limit:
            break
    return found


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


def not_found_message(needle: str, paragraphs: list[Paragraph], block: int | None = None) -> str:
    scope = f"블록 {block}에서 " if block else ""
    lines = [f"'{clip(needle, 40)}'을(를) {scope}찾지 못했습니다."]
    loose = loose_matches(needle, paragraphs)
    if loose:
        places = ", ".join(f"'{clip(actual, 60)}' (블록 {p.block_no}{' ' + p.where if p.where else ''})" for actual, p in loose)
        lines.append(f"띄어쓰기만 다른 글이 있습니다: {places}. find에 이 글을 그대로 주세요.")
    else:
        lines.append("read_document로 글을 확인하세요 (띄어쓰기까지 같아야 합니다).")
    return "\n".join(lines)


def many_message(needle: str, hits: list[Hit]) -> str:
    shown = []
    for i, h in enumerate(hits[:8], 1):
        where = f" {h.where}" if h.where else ""
        before = h.text[max(0, h.start - 15) : h.start]
        after = h.text[h.end : h.end + 15]
        shown.append(f"{i}) 블록 {h.block_no}{where}: …{before}【{h.match}】{after}…")
    rest = [f"… 외 {len(hits) - 8}곳"] if len(hits) > 8 else []
    blocks = {h.block_no for h in hits}
    narrow = " (또는 block으로 좁히기)" if len(blocks) > 1 else ""
    return "\n".join([f"'{clip(needle, 40)}'이(가) {len(hits)}곳에 있습니다:", *shown, *rest, f"한 곳만 바꾸려면 앞뒤 글을 더 붙여 그곳에만 맞게 find를 주세요{narrow}. 모두 바꾸려면 all: true."])
