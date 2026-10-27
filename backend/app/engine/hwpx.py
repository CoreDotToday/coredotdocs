"""자체 HWPX(OWPML) 파서와 블록 모델.

HWPX는 zip 패키지다. `Contents/content.hpf`(OPF 매니페스트)가 본문 section 파일을 가리키고,
각 section(`hs:sec`)은 문단(`hp:p`)의 나열이다. 문단은 run(`hp:run`)을 품고, run 안에 글(`hp:t`),
표(`hp:tbl`), 그림(`hp:pic`), 구역 설정(`hp:secPr`), 필드 제어(`hp:ctrl`) 등이 온다.
표는 `hp:tr > hp:tc > hp:subList > hp:p`로 중첩된다. 글자·문단 모양은 `Contents/header.xml`의 id를 참조한다.

블록 규칙: 최상위 문단마다 하나의 블록. 문단에 글 없이 표만 있으면 표 블록, 글이 있으면 문단 블록이고
그 안의 표는 다음 번호의 표 블록으로 따로 센다.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field

from lxml import etree

from .errors import CommandError, EngineError
from .hwpx_header import ALIGN_CODES, HeaderModel
from .pagesetup import EDGES, PageSetup, apply_patch, from_unit, to_unit

NS = {
    "hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
    "hs": "http://www.hancom.co.kr/hwpml/2011/section",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "opf": "http://www.idpf.org/2007/opf/",
}
MIMETYPE = "application/hwp+zip"
MAX_INSERTED_ROWS = 1000
MAX_INSERTED_CELLS = 10_000


def q(tag: str) -> str:
    prefix, local = tag.split(":")
    return "{%s}%s" % (NS[prefix], local)


# ── 블록 모델 ────────────────────────────────────────────────────────────


@dataclass
class Cell:
    row: int  # 0부터
    col: int
    row_span: int
    col_span: int
    text: str
    element: etree._Element = field(repr=False)


@dataclass
class TableGrid:
    rows: int
    cols: int
    cells: list[Cell]

    def cell_at(self, row: int, col: int) -> Cell | None:
        for c in self.cells:
            if c.row <= row < c.row + c.row_span and c.col <= col < c.col + c.col_span:
                return c
        return None

    def row_cells(self, row: int) -> list[Cell]:
        return sorted((c for c in self.cells if c.row == row), key=lambda c: c.col)


@dataclass
class Block:
    no: int
    kind: str  # "paragraph" | "table"
    paragraph: etree._Element = field(repr=False)
    table: etree._Element | None = field(default=None, repr=False)
    table_no: int | None = None
    reader: object = field(default=None, repr=False)  # 형식별 문단 글 읽기 함수 (기본 HWPX)
    index: int | None = None  # DOCX: w:body 맨 위 요소 번호(0부터) — 편집기 엔진의 docxIndex와 같은 셈법
    sub: int | None = None  # DOCX: 콘텐츠 컨트롤(sdt) 안 몇 번째 문단인지(0부터)

    def text(self) -> str:
        return (self.reader or paragraph_text)(self.paragraph)


@dataclass
class Field:
    number: int
    block_no: int
    where: str
    name: str
    direction: str
    text: str
    type: str
    read_only: bool
    paragraph: etree._Element = field(repr=False)
    begin_run: etree._Element = field(repr=False)
    end_run: etree._Element | None = field(repr=False)


@dataclass
class PageInfo:
    width: int  # HWPUNIT
    height: int
    left: int
    right: int
    top: int
    bottom: int
    gutter: int

    @property
    def body_width(self) -> int:
        return self.width - self.left - self.right - self.gutter


# ── 글 읽기 ──────────────────────────────────────────────────────────────


def _text_runs(p: etree._Element) -> list[etree._Element]:
    return [t for run in p.findall(q("hp:run")) for t in run.findall(q("hp:t"))]


def _t_text(t: etree._Element) -> str:
    parts = [t.text or ""]
    for child in t:
        local = etree.QName(child).localname
        if local == "tab":
            parts.append("\t")
        elif local == "lineBreak":
            parts.append("\n")
        parts.append(child.tail or "")
    return "".join(parts)


def paragraph_text(p: etree._Element) -> str:
    return "".join(_t_text(t) for t in _text_runs(p))


def first_char_pr(p: etree._Element) -> str:
    for run in p.findall(q("hp:run")):
        if run.find(q("hp:t")) is not None:
            return run.get("charPrIDRef", "0")
    run = p.find(q("hp:run"))
    return run.get("charPrIDRef", "0") if run is not None else "0"


def cell_paragraphs(tc: etree._Element) -> list[etree._Element]:
    sub = tc.find(q("hp:subList"))
    return list(sub.findall(q("hp:p"))) if sub is not None else []


def cell_text(tc: etree._Element) -> str:
    return "\n".join(paragraph_text(p) for p in cell_paragraphs(tc))


def table_grid(tbl: etree._Element) -> TableGrid:
    rows = int(tbl.get("rowCnt") or 0)
    cols = int(tbl.get("colCnt") or 0)
    cells: list[Cell] = []
    for r_index, tr in enumerate(tbl.findall(q("hp:tr"))):
        for tc in tr.findall(q("hp:tc")):
            addr = tc.find(q("hp:cellAddr"))
            span = tc.find(q("hp:cellSpan"))
            row = int(addr.get("rowAddr")) if addr is not None and addr.get("rowAddr") is not None else r_index
            col = int(addr.get("colAddr")) if addr is not None and addr.get("colAddr") is not None else len([c for c in cells if c.row == row])
            cells.append(Cell(row=row, col=col, row_span=int(span.get("rowSpan", "1")) if span is not None else 1, col_span=int(span.get("colSpan", "1")) if span is not None else 1, text=cell_text(tc), element=tc))
    if not rows:
        rows = max((c.row + c.row_span for c in cells), default=0)
    if not cols:
        cols = max((c.col + c.col_span for c in cells), default=0)
    return TableGrid(rows=rows, cols=cols, cells=cells)


def inner_tables(tbl: etree._Element) -> list[etree._Element]:
    """칸 안에 든 표들 (한 단계)."""
    out = []
    for tr in tbl.findall(q("hp:tr")):
        for tc in tr.findall(q("hp:tc")):
            for p in cell_paragraphs(tc):
                for run in p.findall(q("hp:run")):
                    out.extend(run.findall(q("hp:tbl")))
    return out


# ── 글 쓰기 ──────────────────────────────────────────────────────────────


def _set_t_text(t: etree._Element, text: str) -> None:
    for child in list(t):
        t.remove(child)
    t.text = text


def set_paragraph_text(p: etree._Element, text: str) -> None:
    ts = _text_runs(p)
    if ts:
        _set_t_text(ts[0], text)
        for extra in ts[1:]:
            run = extra.getparent()
            run.remove(extra)
            if len(run) == 0:
                p.remove(run)
        return
    run = p.find(q("hp:run"))
    if run is None:
        run = etree.SubElement(p, q("hp:run"), charPrIDRef="0")
    etree.SubElement(run, q("hp:t")).text = text


def set_paragraph_runs(p: etree._Element, runs: list[tuple[str, str]]) -> None:
    """(글, charPrIDRef) 목록으로 문단의 글 run을 새로 만든다. 글이 아닌 요소(구역 설정·필드)는 남긴다."""
    base_run = p.find(q("hp:run"))
    base_char = base_run.get("charPrIDRef", "0") if base_run is not None else "0"
    for run in list(p.findall(q("hp:run"))):
        for t in run.findall(q("hp:t")):
            run.remove(t)
        if len(run) == 0:
            p.remove(run)
    for text, char_pr in runs:
        run = etree.SubElement(p, q("hp:run"), charPrIDRef=char_pr or base_char)
        etree.SubElement(run, q("hp:t")).text = text
    if not runs:
        run = etree.SubElement(p, q("hp:run"), charPrIDRef=base_char)
        etree.SubElement(run, q("hp:t")).text = ""


def replace_in_paragraph(p: etree._Element, start: int, end: int, replacement: str) -> None:
    ts = _text_runs(p)
    offset = 0
    first = True
    for t in ts:
        text = _t_text(t)
        t_start, t_end = offset, offset + len(text)
        offset = t_end
        if t_end <= start or t_start >= end:
            continue
        local_start = max(start, t_start) - t_start
        local_end = min(end, t_end) - t_start
        _set_t_text(t, text[:local_start] + (replacement if first else "") + text[local_end:])
        first = False


def apply_char_pr_range(p: etree._Element, start: int, end: int, resolve) -> None:
    """[start, end) 글자들의 run을 쪼개 resolve(charPrIDRef) → 새 id 로 바꾼다."""
    new_children: list[etree._Element] = []
    offset = 0
    for run in list(p.findall(q("hp:run"))):
        ts = run.findall(q("hp:t"))
        if not ts:
            continue
        char_pr = run.get("charPrIDRef", "0")
        pieces: list[tuple[str, str]] = []
        for t in ts:
            text = _t_text(t)
            t_start, t_end = offset, offset + len(text)
            offset = t_end
            if t_end <= start or t_start >= end:
                pieces.append((text, char_pr))
                continue
            a = max(start, t_start) - t_start
            b = min(end, t_end) - t_start
            if text[:a]:
                pieces.append((text[:a], char_pr))
            pieces.append((text[a:b], str(resolve(char_pr))))
            if text[b:]:
                pieces.append((text[b:], char_pr))
        # 글이 아닌 자식(hp:ctrl 등)은 run을 유지하고, 글 run만 조각으로 다시 만든다
        others = [c for c in run if etree.QName(c).localname != "t"]
        index = p.index(run)
        p.remove(run)
        if others:
            keep = etree.Element(q("hp:run"), charPrIDRef=char_pr)
            keep.extend(others)
            p.insert(index, keep)
            index += 1
        merged: list[tuple[str, str]] = []
        for text, cp in pieces:
            if merged and merged[-1][1] == cp:
                merged[-1] = (merged[-1][0] + text, cp)
            else:
                merged.append((text, cp))
        for text, cp in merged:
            new = etree.Element(q("hp:run"), charPrIDRef=cp)
            etree.SubElement(new, q("hp:t")).text = text
            p.insert(index, new)
            index += 1
        new_children.append(run)


def clone_paragraph_shell(like: etree._Element, text: str = "", char_pr: str | None = None) -> etree._Element:
    p = etree.Element(q("hp:p"))
    for attr in ("paraPrIDRef", "styleIDRef"):
        if like.get(attr) is not None:
            p.set(attr, like.get(attr))
    p.set("pageBreak", "0")
    p.set("columnBreak", "0")
    p.set("merged", "0")
    run = etree.SubElement(p, q("hp:run"), charPrIDRef=char_pr or first_char_pr(like))
    etree.SubElement(run, q("hp:t")).text = text
    return p


# ── 문서 ─────────────────────────────────────────────────────────────────


class HwpxDocument:
    """HWPX 패키지 하나. 메모리에서 고치고 `to_bytes()`로 다시 묶는다."""

    format = "hwpx"

    def __init__(self, entries: dict[str, bytes], order: list[str], section_paths: list[str]):
        self._entries = entries
        self._order = order
        self.section_paths = section_paths
        self._sections: dict[str, etree._ElementTree] = {}
        parser = etree.XMLParser(remove_blank_text=False, huge_tree=False, resolve_entities=False, no_network=True)
        for path in section_paths:
            try:
                self._sections[path] = etree.ElementTree(etree.fromstring(entries[path], parser))
            except (etree.XMLSyntaxError, KeyError) as e:
                raise EngineError(f"본문 XML을 읽지 못했습니다: {path}") from e
        try:
            self.header = HeaderModel(etree.ElementTree(etree.fromstring(entries["Contents/header.xml"], parser)))
        except (etree.XMLSyntaxError, KeyError) as e:
            raise EngineError("Contents/header.xml을 읽지 못했습니다.") from e
        try:
            self._hpf = etree.ElementTree(etree.fromstring(entries["Contents/content.hpf"], parser))
        except etree.XMLSyntaxError as e:
            raise EngineError("Contents/content.hpf를 읽지 못했습니다.") from e

    # 열기 / 저장 ------------------------------------------------------------

    @classmethod
    def load(cls, data: bytes) -> "HwpxDocument":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise EngineError("HWPX(zip) 파일이 아닙니다.") from e
        with zf:
            names = zf.namelist()
            entries = {n: zf.read(n) for n in names}
        mimetype = entries.get("mimetype", b"").strip()
        if mimetype and mimetype != MIMETYPE.encode():
            raise EngineError(f"HWPX 패키지가 아닙니다 (mimetype: {mimetype[:40]!r}).")
        if "Contents/content.hpf" not in entries:
            raise EngineError("Contents/content.hpf가 없는 패키지입니다.")
        section_paths = cls._section_paths(entries["Contents/content.hpf"], names)
        if not section_paths:
            raise EngineError("본문 section을 찾지 못했습니다.")
        return cls(entries, names, section_paths)

    @staticmethod
    def _section_paths(hpf: bytes, names: list[str]) -> list[str]:
        try:
            root = etree.fromstring(hpf, etree.XMLParser(resolve_entities=False, no_network=True))
            items = {i.get("id"): i.get("href") for i in root.iter(q("opf:item"))}
            paths = []
            for ref in root.iter(q("opf:itemref")):
                href = items.get(ref.get("idref"))
                if not href:
                    continue
                candidate = href if href in names else f"Contents/{href}"
                if candidate in names and re.search(r"section\d+\.xml$", candidate):
                    paths.append(candidate)
            if paths:
                return paths
        except etree.XMLSyntaxError:
            pass
        return sorted(n for n in names if re.fullmatch(r"Contents/section\d+\.xml", n))

    def to_bytes(self) -> bytes:
        for path, tree in self._sections.items():
            self._entries[path] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
        self._entries["Contents/header.xml"] = etree.tostring(self.header.tree, xml_declaration=True, encoding="UTF-8", standalone=True)
        self._entries["Contents/content.hpf"] = etree.tostring(self._hpf, xml_declaration=True, encoding="UTF-8", standalone=True)
        self._entries["Preview/PrvText.txt"] = self.plain_text()[:4000].encode("utf-8")
        if "Preview/PrvText.txt" not in self._order:
            self._order.append("Preview/PrvText.txt")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            ordered = (["mimetype"] if "mimetype" in self._entries else []) + [n for n in self._order if n != "mimetype"]
            for name in ordered:
                zf.writestr(name, self._entries[name], compress_type=zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
        return buf.getvalue()

    def plain_text(self) -> str:
        lines = []
        for b in self.blocks():
            if b.kind == "paragraph":
                lines.append(b.text())
            else:
                lines.extend(c.text for c in table_grid(b.table).cells)
        return "\n".join(lines)

    # 블록 ------------------------------------------------------------------

    def _roots(self) -> list[etree._Element]:
        return [self._sections[p].getroot() for p in self.section_paths]

    def blocks(self) -> list[Block]:
        out: list[Block] = []
        table_no = 0
        for root in self._roots():
            for p in root.findall(q("hp:p")):
                tables = [tbl for run in p.findall(q("hp:run")) for tbl in run.findall(q("hp:tbl"))]
                if paragraph_text(p) or not tables:
                    out.append(Block(no=len(out) + 1, kind="paragraph", paragraph=p))
                for tbl in tables:
                    table_no += 1
                    out.append(Block(no=len(out) + 1, kind="table", paragraph=p, table=tbl, table_no=table_no))
        return out

    def place(self, no: int) -> dict | None:
        """블록의 자리: 0부터 세는 구역 번호와 구역 안 본문 문단 번호, 문단 글 길이. 편집기의 body_paragraph 대상과 같은 셈법."""
        try:
            b = self.block(no)
        except IndexError:
            return None
        for section, root in enumerate(self._roots()):
            paragraphs = root.findall(q("hp:p"))
            for index, p in enumerate(paragraphs):
                if p is b.paragraph:
                    return {"section": section, "paragraph": index, "length": min(len(paragraph_text(p)), 4000)}
        return None

    def block(self, no: int) -> Block:
        blocks = self.blocks()
        if not 1 <= no <= len(blocks):
            raise IndexError(no)
        return blocks[no - 1]

    def tables(self) -> list[Block]:
        return [b for b in self.blocks() if b.kind == "table"]

    def table(self, ref: int | str) -> tuple[Block, etree._Element, str]:
        """표 번호(1, 2) 또는 안쪽 표 '1-2' → (블록, 표 요소, 표시 번호)."""
        text = str(ref).strip()
        if not re.fullmatch(r"\d+(-\d+)*", text):
            raise IndexError(text)
        top, *path = [int(x) for x in text.split("-")]
        blocks = [b for b in self.tables() if b.table_no == top]
        if not blocks:
            raise IndexError(text)
        tbl = blocks[0].table
        label = str(top)
        for k in path:
            inner = inner_tables(tbl)
            if not 1 <= k <= len(inner):
                raise IndexError(f"{label}-{k}")
            tbl = inner[k - 1]
            label = f"{label}-{k}"
        return blocks[0], tbl, label

    def page_info(self) -> PageInfo:
        page = self._roots()[0].find(".//" + q("hp:pagePr"))
        if page is None:
            return PageInfo(59528, 84186, 8504, 8504, 5668, 4252, 0)
        margin = page.find(q("hp:margin"))
        g = lambda el, k, d: int(el.get(k, d)) if el is not None else d  # noqa: E731
        return PageInfo(g(page, "width", 59528), g(page, "height", 84186), g(margin, "left", 8504), g(margin, "right", 8504), g(margin, "top", 5668), g(margin, "bottom", 4252), g(margin, "gutter", 0))

    # 쪽 설정 (pagesetup.py) — 구역 파일마다 첫 hp:secPr의 hp:pagePr ---------------------

    def _page_prs(self) -> list[etree._Element]:
        out = []
        for root in self._roots():
            page = root.find(".//" + q("hp:secPr") + "/" + q("hp:pagePr"))
            if page is not None:
                out.append(page)
        return out

    def page_setups(self) -> list[PageSetup]:
        out = []
        for page in self._page_prs():
            m = page.find(q("hp:margin"))
            g = lambda el, k, d: from_unit(int(el.get(k, d)), 7200) if el is not None else from_unit(d, 7200)  # noqa: E731
            w, h = g(page, "width", 59528), g(page, "height", 84186)
            landscape = page.get("landscape") == "NARROWLY"
            if landscape:
                w, h = max(w, h), min(w, h)
            out.append(PageSetup(w, h, landscape, g(m, "top", 5668), g(m, "bottom", 4252), g(m, "left", 8504), g(m, "right", 8504), g(m, "header", 4252), g(m, "footer", 4252), g(m, "gutter", 0)))
        return out

    def set_page_setup(self, section: int | None, patch: dict) -> list[int]:
        pages = self._page_prs()
        targets = range(1, len(pages) + 1) if section is None else [section]
        current = self.page_setups()
        for no in targets:
            if not 1 <= no <= len(pages):
                raise CommandError(f"구역 {no}이(가) 없습니다 (구역 {len(pages)}개).", "OUT_OF_RANGE")
            new = apply_patch(current[no - 1], patch)
            page = pages[no - 1]
            short, long_ = sorted((new.width, new.height))
            page.set("width", str(to_unit(short, 7200)))  # 한글은 늘 세로 값으로 쓰고 방향은 landscape로
            page.set("height", str(to_unit(long_, 7200)))
            page.set("landscape", "NARROWLY" if new.landscape else "WIDELY")
            m = page.find(q("hp:margin"))
            if m is None:
                m = etree.SubElement(page, q("hp:margin"))
            for k in EDGES:
                m.set(k, str(to_unit(getattr(new, k), 7200)))
        return list(targets)

    def body_model(self) -> etree._Element:
        blocks = self.blocks()
        for b in reversed(blocks):
            if b.kind == "paragraph" and b.text().strip() and not self.header.char_look(first_char_pr(b.paragraph)).bold:
                return b.paragraph
        return blocks[-1].paragraph

    # 편집: 문단 -------------------------------------------------------------

    def _anchor(self, blocks: list[Block], after: int | None, before: int | None) -> tuple[etree._Element, int]:
        if before is not None:
            anchor = blocks[before - 1].paragraph
            return anchor.getparent(), anchor.getparent().index(anchor)
        if after is not None and after > 0:
            anchor = blocks[after - 1].paragraph
            return anchor.getparent(), anchor.getparent().index(anchor) + 1
        if after == 0:
            anchor = blocks[0].paragraph
            index = anchor.getparent().index(anchor)
            if anchor.find(".//" + q("hp:secPr")) is not None:
                index += 1
            return anchor.getparent(), index
        anchor = blocks[-1].paragraph
        return anchor.getparent(), len(anchor.getparent())

    def insert_elements(self, elements: list[etree._Element], after: int | None = None, before: int | None = None) -> list[int]:
        parent, index = self._anchor(self.blocks(), after, before)
        for offset, el in enumerate(elements):
            parent.insert(index + offset, el)
        ids = {id(el) for el in elements}
        return [b.no for b in self.blocks() if id(b.paragraph) in ids]

    def insert_paragraphs(self, texts: list[str], after: int | None = None, before: int | None = None, like: int | None = None) -> list[int]:
        blocks = self.blocks()
        model = blocks[like - 1].paragraph if like else self.body_model()
        return self.insert_elements([clone_paragraph_shell(model, t) for t in texts], after, before)

    def delete_blocks(self, start: int, end: int) -> int:
        blocks = self.blocks()
        removed = 0
        seen: set[int] = set()
        for b in blocks[start - 1 : end]:
            p = b.paragraph
            if b.kind == "table":
                run = b.table.getparent()
                run.remove(b.table)
                if len(run) == 0:
                    p.remove(run)
                if not paragraph_text(p) and p.find(".//" + q("hp:tbl")) is None and p.find(".//" + q("hp:secPr")) is None and p.getparent() is not None:
                    p.getparent().remove(p)
                    seen.add(id(p))
                removed += 1
                continue
            if id(p) in seen:
                continue
            seen.add(id(p))
            if p.find(".//" + q("hp:secPr")) is not None:
                for t in _text_runs(p):
                    _set_t_text(t, "")
            else:
                p.getparent().remove(p)
            removed += 1
        for root in self._roots():
            if root.find(q("hp:p")) is None:
                etree.SubElement(root, q("hp:p"), paraPrIDRef="0", styleIDRef="0", pageBreak="0", columnBreak="0", merged="0")
        return removed

    # 편집: 표 ---------------------------------------------------------------

    def insert_table_rows(self, tbl: etree._Element, after_row: int | None, rows: list[list[str]], count: int | None) -> int:
        grid = table_grid(tbl)
        total = len(tbl.findall(q("hp:tr")))
        after = total if after_row is None else after_row
        if not 0 <= after <= total:
            raise ValueError(f"after_row는 0~{total} 사이여야 합니다.")
        new_count = max(len(rows), count or 0, 0 if rows else 1)
        if new_count > MAX_INSERTED_ROWS:
            raise ValueError(f"한 번에 {MAX_INSERTED_ROWS}행까지 넣을 수 있습니다.")
        if any(c.row_span > 1 and c.row < after < c.row + c.row_span for c in grid.cells):
            raise ValueError(f"{after}행 아래는 세로로 합친 칸 속이라 행을 넣을 수 없습니다.")
        trs = tbl.findall(q("hp:tr"))

        def complete(index: int) -> bool:
            cells = grid.row_cells(index)
            return bool(cells) and all(c.row_span == 1 for c in cells) and sum(c.col_span for c in cells) == grid.cols

        near = max(0, after - 1)
        order = sorted(range(len(trs)), key=lambda i: (abs(i - near), -i))
        model_index = next((i for i in order if complete(i)), None)
        if model_index is None:
            raise ValueError("본뜰 수 있는 행(합친 칸 없이 모든 열을 덮는 행)이 없습니다.")
        model_cells = grid.row_cells(model_index)
        if new_count * len(model_cells) > MAX_INSERTED_CELLS:
            raise ValueError(f"한 번에 새 칸 {MAX_INSERTED_CELLS}개까지 넣을 수 있습니다.")
        for i, row in enumerate(rows):
            if len(row) > grid.cols:
                raise ValueError(f"새 {i + 1}행에 {len(row)}열을 주었지만 표는 {grid.cols}열입니다.")
        import copy

        new_trs = []
        for i in range(new_count):
            tr = copy.deepcopy(trs[model_index])
            for tc in tr.findall(q("hp:tc")):
                span = tc.find(q("hp:cellSpan"))
                if span is not None:
                    span.set("rowSpan", "1")
                tc.set("header", "0")
            values = rows[i] if i < len(rows) else []
            for at, tc in enumerate(tr.findall(q("hp:tc"))):
                col = model_cells[at].col if at < len(model_cells) else at
                write_cell(tc, values[col] if col < len(values) else "")
            new_trs.append(tr)
        insert_at = tbl.index(trs[0]) if after == 0 else tbl.index(trs[after - 1]) + 1
        for offset, tr in enumerate(new_trs):
            tbl.insert(insert_at + offset, tr)
        self._renumber(tbl)
        return new_count

    def delete_table_rows(self, tbl: etree._Element, start: int, end: int) -> int:
        trs = tbl.findall(q("hp:tr"))
        if not (1 <= start <= end <= len(trs)):
            raise ValueError(f"지울 행 범위가 잘못되었습니다 (1~{len(trs)}).")
        if end - start + 1 >= len(trs):
            raise ValueError("표의 모든 행을 지울 수는 없습니다. 표를 지우려면 delete_blocks를 쓰세요.")
        grid = table_grid(tbl)
        for c in grid.cells:
            if c.row_span > 1 and ((c.row < start - 1 < c.row + c.row_span) or (start - 1 <= c.row <= end - 1 and c.row + c.row_span > end)):
                raise ValueError("세로로 합친 칸이 걸쳐 있어 그 행들만 지울 수 없습니다.")
        for tr in trs[start - 1 : end]:
            tbl.remove(tr)
        self._renumber(tbl)
        return end - start + 1

    @staticmethod
    def _renumber(tbl: etree._Element) -> None:
        trs = tbl.findall(q("hp:tr"))
        for r, tr in enumerate(trs):
            for tc in tr.findall(q("hp:tc")):
                addr = tc.find(q("hp:cellAddr"))
                if addr is not None:
                    addr.set("rowAddr", str(r))
        tbl.set("rowCnt", str(len(trs)))

    def build_table(self, rows: list[list[str]], header: bool = True, like: etree._Element | None = None) -> etree._Element:
        """새 표 문단(hp:p)을 만든다. 가는 실선, 첫 행은 옅은 회색 머리 행."""
        model = like if like is not None else self.body_model()
        cols = max(len(r) for r in rows)
        rows = [r + [""] * (cols - len(r)) for r in rows]
        width = self.page_info().body_width
        col_width = width // cols
        solid = self.header.ensure_border_fill(solid=True)
        head_fill = self.header.ensure_border_fill(solid=True, fill="#EDEDED")
        para_pr, char_pr = model.get("paraPrIDRef", "0"), first_char_pr(model)
        center = str(self.header.ensure_para_pr(para_pr, align="CENTER", indent=0, left=0, right=0, prev=0, next=0))
        body = str(self.header.ensure_para_pr(para_pr, indent=0, left=0, right=0, prev=0, next=0))
        bold = str(self.header.ensure_char_pr(char_pr, bold=True))
        p = etree.Element(q("hp:p"), paraPrIDRef=para_pr, styleIDRef=model.get("styleIDRef", "0"), pageBreak="0", columnBreak="0", merged="0")
        run = etree.SubElement(p, q("hp:run"), charPrIDRef=char_pr)
        tbl = etree.SubElement(run, q("hp:tbl"), id=str(abs(hash(("tbl", len(rows), cols))) % 2_000_000_000), zOrder="0", numberingType="TABLE", textWrap="TOP_AND_BOTTOM", textFlow="BOTH_SIDES", lock="0", dropcapstyle="None", pageBreak="CELL", repeatHeader="1", rowCnt=str(len(rows)), colCnt=str(cols), cellSpacing="0", borderFillIDRef=str(solid), noAdjust="0")
        etree.SubElement(tbl, q("hp:sz"), width=str(width), widthRelTo="ABSOLUTE", height=str(282 * len(rows)), heightRelTo="ABSOLUTE", protect="0")
        etree.SubElement(tbl, q("hp:pos"), treatAsChar="0", affectLSpacing="0", flowWithText="1", allowOverlap="0", holdAnchorAndSO="0", vertRelTo="PARA", horzRelTo="PARA", vertAlign="TOP", horzAlign="LEFT", vertOffset="0", horzOffset="0")
        etree.SubElement(tbl, q("hp:outMargin"), left="283", right="283", top="283", bottom="283")
        etree.SubElement(tbl, q("hp:inMargin"), left="510", right="510", top="141", bottom="141")
        for r, row in enumerate(rows):
            tr = etree.SubElement(tbl, q("hp:tr"))
            is_header = header and r == 0
            for c, text in enumerate(row):
                tc = etree.SubElement(tr, q("hp:tc"), name="", header="1" if is_header else "0", hasMargin="0", protect="0", editable="0", dirty="0", borderFillIDRef=str(head_fill if is_header else solid))
                sub = etree.SubElement(tc, q("hp:subList"), id="", textDirection="HORIZONTAL", lineWrap="BREAK", vertAlign="CENTER", linkListIDRef="0", linkListNextIDRef="0", textWidth="0", textHeight="0", hasTextRef="0", hasNumRef="0")
                cell_p = etree.SubElement(sub, q("hp:p"), paraPrIDRef=center if is_header else body, styleIDRef=model.get("styleIDRef", "0"), pageBreak="0", columnBreak="0", merged="0")
                cell_run = etree.SubElement(cell_p, q("hp:run"), charPrIDRef=bold if is_header else char_pr)
                etree.SubElement(cell_run, q("hp:t")).text = text
                etree.SubElement(tc, q("hp:cellAddr"), colAddr=str(c), rowAddr=str(r))
                etree.SubElement(tc, q("hp:cellSpan"), colSpan="1", rowSpan="1")
                etree.SubElement(tc, q("hp:cellSz"), width=str(col_width), height="282")
                etree.SubElement(tc, q("hp:cellMargin"), left="510", right="510", top="141", bottom="141")
        return p

    # 편집: 그림 -------------------------------------------------------------

    def add_binary(self, data: bytes, ext: str, media_type: str) -> str:
        existing = [n for n in self._entries if n.startswith("Contents/BinData/")]
        n = len(existing) + 1
        while f"Contents/BinData/image{n}.{ext}" in self._entries:
            n += 1
        name = f"image{n}"
        path = f"Contents/BinData/{name}.{ext}"
        self._entries[path] = data
        self._order.append(path)
        manifest = self._hpf.getroot().find(q("opf:manifest"))
        if manifest is None:
            manifest = etree.SubElement(self._hpf.getroot(), q("opf:manifest"))
        etree.SubElement(manifest, q("opf:item"), id=name, href=f"BinData/{name}.{ext}", attrib={"media-type": media_type, "isEmbeded": "1"})
        return name

    def build_picture_paragraph(self, binary_id: str, px_w: int, px_h: int, width_units: int | None, align: str = "center") -> etree._Element:
        model = self.body_model()
        org_w, org_h = max(1, px_w * 75), max(1, px_h * 75)
        max_w = self.page_info().body_width
        w = min(width_units or org_w, max_w)
        h = max(1, round(org_h * w / org_w))
        para_pr = str(self.header.ensure_para_pr(model.get("paraPrIDRef", "0"), align=ALIGN_CODES.get(align, "CENTER"), indent=0))
        p = etree.Element(q("hp:p"), paraPrIDRef=para_pr, styleIDRef=model.get("styleIDRef", "0"), pageBreak="0", columnBreak="0", merged="0")
        run = etree.SubElement(p, q("hp:run"), charPrIDRef=first_char_pr(model))
        pic = etree.SubElement(run, q("hp:pic"), id=str(abs(hash(binary_id)) % 2_000_000_000), zOrder="0", numberingType="PICTURE", textWrap="TOP_AND_BOTTOM", textFlow="BOTH_SIDES", lock="0", dropcapstyle="None", href="", groupLevel="0", instid=str(abs(hash((binary_id, "i"))) % 2_000_000_000), reverse="0")
        etree.SubElement(pic, q("hp:offset"), x="0", y="0")
        etree.SubElement(pic, q("hp:orgSz"), width=str(org_w), height=str(org_h))
        etree.SubElement(pic, q("hp:curSz"), width=str(w), height=str(h))
        etree.SubElement(pic, q("hp:flip"), horizontal="0", vertical="0")
        etree.SubElement(pic, q("hp:rotationInfo"), angle="0", centerX=str(w // 2), centerY=str(h // 2), rotateimage="1")
        render = etree.SubElement(pic, q("hp:renderingInfo"))
        etree.SubElement(render, q("hc:transMatrix"), e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
        etree.SubElement(render, q("hc:scaMatrix"), e1=f"{w / org_w:.6f}", e2="0", e3="0", e4="0", e5=f"{h / org_h:.6f}", e6="0")
        etree.SubElement(render, q("hc:rotMatrix"), e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
        etree.SubElement(pic, q("hp:lineShape"), color="#000000", width="0", style="NONE", endCap="FLAT", headStyle="NORMAL", tailStyle="NORMAL", headfill="1", tailfill="1", headSz="SMALL_SMALL", tailSz="SMALL_SMALL", outlineStyle="OUTER", alpha="0")
        rect = etree.SubElement(pic, q("hp:imgRect"))
        for name, (x, y) in (("pt0", (0, 0)), ("pt1", (org_w, 0)), ("pt2", (org_w, org_h)), ("pt3", (0, org_h))):
            etree.SubElement(rect, q(f"hc:{name}"), x=str(x), y=str(y))
        etree.SubElement(pic, q("hp:imgClip"), left="0", right=str(org_w), top="0", bottom=str(org_h))
        etree.SubElement(pic, q("hp:inMargin"), left="0", right="0", top="0", bottom="0")
        etree.SubElement(pic, q("hp:imgDim"), dimwidth=str(org_w), dimheight=str(org_h))
        etree.SubElement(pic, q("hc:img"), binaryItemIDRef=binary_id, bright="0", contrast="0", effect="REAL_PIC", alpha="0")
        etree.SubElement(pic, q("hp:effects"))
        etree.SubElement(pic, q("hp:shapeComment")).text = "그림"
        etree.SubElement(pic, q("hp:sz"), width=str(w), widthRelTo="ABSOLUTE", height=str(h), heightRelTo="ABSOLUTE", protect="0")
        etree.SubElement(pic, q("hp:pos"), treatAsChar="1", affectLSpacing="0", flowWithText="1", allowOverlap="0", holdAnchorAndSO="0", vertRelTo="PARA", horzRelTo="COLUMN", vertAlign="TOP", horzAlign="LEFT", vertOffset="0", horzOffset="0")
        etree.SubElement(pic, q("hp:outMargin"), left="0", right="0", top="0", bottom="0")
        return p

    def picture_count(self) -> int:
        return sum(len(root.findall(".//" + q("hp:pic"))) for root in self._roots())

    # 누름틀(필드) -----------------------------------------------------------

    def fields(self) -> list[Field]:
        out: list[Field] = []
        for b in self.blocks():
            targets: list[tuple[etree._Element, str]] = []
            if b.kind == "paragraph":
                targets.append((b.paragraph, ""))
            else:
                for cell in table_grid(b.table).cells:
                    for p in cell_paragraphs(cell.element):
                        targets.append((p, f"표 {b.table_no} ({cell.row + 1},{cell.col + 1})"))
            for p, where in targets:
                runs = p.findall(q("hp:run"))
                for i, run in enumerate(runs):
                    begin = run.find(q("hp:ctrl") + "/" + q("hp:fieldBegin"))
                    if begin is None:
                        continue
                    field_id = begin.get("id", "")
                    end_run = None
                    texts = []
                    for later in runs[i + 1 :]:
                        if later.find(q("hp:ctrl") + "/" + q("hp:fieldEnd") + f"[@beginIDRef='{field_id}']") is not None:
                            end_run = later
                            break
                        texts.extend(_t_text(t) for t in later.findall(q("hp:t")))
                    direction = ""
                    for param in begin.iter(q("hp:stringParam")):
                        if param.get("name") == "Direction":
                            direction = param.text or ""
                    kind = begin.get("type", "")
                    out.append(Field(len(out) + 1, b.no, where, begin.get("name", "") or "", direction, "".join(texts), kind, kind != "CLICK_HERE" or begin.get("editable", "1") == "0" or end_run is None, p, run, end_run))
        return out

    def fill_field(self, f: Field, value: str) -> None:
        p = f.paragraph
        runs = p.findall(q("hp:run"))
        start = runs.index(f.begin_run)
        end = runs.index(f.end_run)
        between = runs[start + 1 : end]
        char_pr = next((r.get("charPrIDRef", "0") for r in between if r.find(q("hp:t")) is not None), f.begin_run.get("charPrIDRef", "0"))
        for r in between:
            p.remove(r)
        new = etree.Element(q("hp:run"), charPrIDRef=char_pr)
        etree.SubElement(new, q("hp:t")).text = value
        p.insert(p.index(f.begin_run) + 1, new)


# ── 칸 쓰기 (표 공용) ───────────────────────────────────────────────────


def write_cell(tc: etree._Element, text: str) -> None:
    paragraphs = cell_paragraphs(tc)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not paragraphs:
        sub = tc.find(q("hp:subList"))
        if sub is None:
            sub = etree.SubElement(tc, q("hp:subList"), id="", textDirection="HORIZONTAL", lineWrap="BREAK", vertAlign="CENTER", linkListIDRef="0", linkListNextIDRef="0", textWidth="0", textHeight="0", hasTextRef="0", hasNumRef="0")
        paragraphs = [etree.SubElement(sub, q("hp:p"), paraPrIDRef="0", styleIDRef="0", pageBreak="0", columnBreak="0", merged="0")]
    first = paragraphs[0]
    set_paragraph_text(first, lines[0])
    parent = first.getparent()
    for extra in paragraphs[1:]:
        parent.remove(extra)
    index = parent.index(first)
    for offset, line in enumerate(lines[1:], 1):
        parent.insert(index + offset, clone_paragraph_shell(first, line))


# ── 명령 층이 쓰는 공용 인터페이스 (DOCX 엔진도 같은 이름을 제공한다) ─────────────────

import sys as _sys

from .hwpx_header import ALIGN_NAMES as _ALIGN_NAMES  # noqa: E402
from .images import ImageInfo  # noqa: E402


def inner_tables_of_cell(tc: etree._Element) -> list[etree._Element]:
    return [tbl for p in cell_paragraphs(tc) for run in p.findall(q("hp:run")) for tbl in run.findall(q("hp:tbl"))]


def cell_format(doc: "HwpxDocument", tc: etree._Element) -> dict:
    paragraphs = cell_paragraphs(tc)
    p = paragraphs[0] if paragraphs else None
    look = doc.header.char_look(first_char_pr(p)) if p is not None else doc.header.char_look(None)
    para = doc.header.para_look(p.get("paraPrIDRef") if p is not None else None)
    sub = tc.find(q("hp:subList"))
    return {"size": look.size, "align": para.align, "vertical_align": (sub.get("vertAlign") if sub is not None else None) or "CENTER"}


def _pt_units(value: float) -> int:
    return round(value * 100)


def _mm_units(value: float) -> int:
    return round(value * 7200 / 25.4)


def paragraph_has_picture(p: etree._Element) -> bool:
    return p.find(".//" + q("hp:pic")) is not None


def paragraph_has_field(p: etree._Element) -> bool:
    return p.find(".//" + q("hp:fieldBegin")) is not None


def paragraph_has_table(p: etree._Element) -> bool:
    return p.find(".//" + q("hp:tbl")) is not None


class _HwpxOps:
    """commands.py가 doc.ops.<이름>으로 부르는 함수 묶음."""

    paragraph_has_picture = staticmethod(paragraph_has_picture)
    paragraph_has_field = staticmethod(paragraph_has_field)
    paragraph_has_table = staticmethod(paragraph_has_table)
    table_grid = staticmethod(table_grid)
    cell_paragraphs = staticmethod(cell_paragraphs)
    paragraph_text = staticmethod(paragraph_text)
    write_cell = staticmethod(write_cell)
    replace_in_paragraph = staticmethod(replace_in_paragraph)
    inner_tables_of_cell = staticmethod(inner_tables_of_cell)
    cell_format = staticmethod(cell_format)


def _describe_paragraph(self: "HwpxDocument", p: etree._Element) -> str:
    body_para, body_char = self.header.default_looks()
    body_size = self.header.char_look(body_char).size
    return self.header.describe(p.get("paraPrIDRef"), first_char_pr(p), p.get("styleIDRef"), body_size=body_size)


def _style_usage(self: "HwpxDocument") -> dict[str, int]:
    counts: dict[str, int] = {}
    for b in self.blocks():
        if b.kind == "paragraph":
            name = self.header.style_name(b.paragraph.get("styleIDRef")) or "바탕글"
            counts[name] = counts.get(name, 0) + 1
    return counts


def _set_paragraph_runs(self: "HwpxDocument", p: etree._Element, runs) -> None:
    base = first_char_pr(p)
    pairs = []
    for r in runs:
        patch = {k: True for k in ("bold", "italic", "strike") if getattr(r, k, False)}
        pairs.append((r.text, str(self.header.ensure_char_pr(base, **patch)) if patch else base))
    set_paragraph_runs(p, pairs)


def _build_content(self: "HwpxDocument", specs, like: int | None = None) -> list[etree._Element]:
    from .markdown_lite import ParagraphSpec, TableSpec

    model = self.blocks()[like - 1].paragraph if like else self.body_model()
    para_pr, char_pr = model.get("paraPrIDRef", "0"), first_char_pr(model)
    body_size = self.header.char_look(char_pr).size
    out = []
    for spec in specs:
        if isinstance(spec, TableSpec):
            out.append(self.build_table(spec.rows, header=spec.header, like=model))
            continue
        assert isinstance(spec, ParagraphSpec)
        p = clone_paragraph_shell(model, "", char_pr)
        if spec.kind == "heading":
            p.set("paraPrIDRef", str(self.header.ensure_para_pr(para_pr, prev=1200 if spec.level <= 2 else 800, next=400, indent=0)))
            base = str(self.header.ensure_char_pr(char_pr, bold=True, size=body_size + HEADING_GROW_PT.get(spec.level, 0)))
        elif spec.kind in ("bullet", "numbered"):
            p.set("paraPrIDRef", str(self.header.ensure_para_pr(para_pr, left=1200, indent=-1200)))
            base = char_pr
        elif spec.kind == "quote":
            p.set("paraPrIDRef", str(self.header.ensure_para_pr(para_pr, left=2000)))
            base = str(self.header.ensure_char_pr(char_pr, color="#555555"))
        else:
            base = char_pr
        if spec.page_break:
            p.set("pageBreak", "1")
        pairs = []
        for r in spec.runs:
            patch = {k: True for k in ("bold", "italic", "strike") if getattr(r, k, False)}
            pairs.append((r.text, str(self.header.ensure_char_pr(base, **patch)) if patch else base))
        set_paragraph_runs(p, pairs)
        out.append(p)
    return out


HEADING_GROW_PT = {1: 6, 2: 4, 3: 2, 4: 1, 5: 0, 6: 0}


def _format_range(self: "HwpxDocument", p: etree._Element, start: int, end: int, patch: dict) -> None:
    apply_char_pr_range(p, start, end, lambda cp: self.header.ensure_char_pr(cp, **patch))


def _format_whole_paragraph(self: "HwpxDocument", p: etree._Element, patch: dict) -> bool:
    """문단의 모든 글의 글자 모양. 빈 문단은 run의 charPrIDRef만 바꾼다 (줄 높이·새로 칠 글의 모양)."""
    n = len(paragraph_text(p))
    if n:
        self.format_range(p, 0, n, patch)
        return True
    for run in p.findall(q("hp:run")):
        run.set("charPrIDRef", str(self.header.ensure_char_pr(run.get("charPrIDRef", "0"), **patch)))
    return False


def _format_paragraph(self: "HwpxDocument", p: etree._Element, patch: dict) -> None:
    kwargs = {}
    if "align" in patch:
        kwargs["align"] = ALIGN_CODES[patch["align"]]
    if "line_spacing" in patch:
        kwargs["line_spacing"] = patch["line_spacing"]
    for key, target in (("left", "left"), ("indent", "indent"), ("space_before", "prev"), ("space_after", "next")):
        if key in patch:
            kwargs[target] = _pt_units(patch[key])
    if "page_break" in patch:
        kwargs["page_break_before"] = patch["page_break"]
        p.set("pageBreak", "1" if patch["page_break"] else "0")
    p.set("paraPrIDRef", str(self.header.ensure_para_pr(p.get("paraPrIDRef", "0"), **kwargs)))


def _format_cell(self: "HwpxDocument", tc: etree._Element, fmt: dict) -> None:
    if fmt.get("vertical_align"):
        sub = tc.find(q("hp:subList"))
        if sub is not None:
            sub.set("vertAlign", fmt["vertical_align"].upper())
    if fmt.get("padding_mm"):
        margin = tc.find(q("hp:cellMargin"))
        if margin is None:
            margin = etree.SubElement(tc, q("hp:cellMargin"), left="510", right="510", top="141", bottom="141")
        for side, mm in fmt["padding_mm"].items():
            margin.set(side, str(_mm_units(mm)))
        tc.set("hasMargin", "1")
    char_patch = {k: fmt[k] for k in ("size", "bold") if k in fmt}
    para_patch = {}
    if fmt.get("align"):
        para_patch["align"] = ALIGN_CODES[fmt["align"]]
    if fmt.get("line_spacing") is not None:
        para_patch["line_spacing"] = fmt["line_spacing"]
    for p in cell_paragraphs(tc):
        if char_patch:
            for run in p.findall(q("hp:run")):
                run.set("charPrIDRef", str(self.header.ensure_char_pr(run.get("charPrIDRef", "0"), **char_patch)))
        if para_patch:
            p.set("paraPrIDRef", str(self.header.ensure_para_pr(p.get("paraPrIDRef", "0"), **para_patch)))


def _build_image(self: "HwpxDocument", data: bytes, info: ImageInfo, width_mm: float | None, align: str) -> etree._Element:
    binary_id = self.add_binary(data, info.ext, info.media_type)
    return self.build_picture_paragraph(binary_id, info.width, info.height, _mm_units(width_mm) if width_mm else None, align)


HwpxDocument.ops = _HwpxOps
HwpxDocument.describe_paragraph = _describe_paragraph
HwpxDocument.style_usage = _style_usage
HwpxDocument.set_paragraph_runs = _set_paragraph_runs
HwpxDocument.build_content = _build_content
HwpxDocument.format_range = _format_range
HwpxDocument.format_paragraph = _format_paragraph
HwpxDocument.format_whole_paragraph = _format_whole_paragraph
HwpxDocument.format_cell = _format_cell
HwpxDocument.build_image = _build_image
