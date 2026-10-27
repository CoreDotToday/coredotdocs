"""자체 DOCX(WordprocessingML) 엔진. HWPX 엔진과 같은 메서드 이름을 제공해 commands.py가 형식을 가리지 않게 한다.

DOCX는 zip 패키지다. `word/document.xml`의 `w:body` 아래에 문단(`w:p`)과 표(`w:tbl`)가 형제로 온다 (HWPX와 달리 표가
문단 안에 들어가지 않는다). 글은 `w:r > w:t`, 서식은 `w:rPr`(글자)·`w:pPr`(문단)에 직접 적는다. 그림은 `w:drawing`과
`word/_rels/document.xml.rels`의 관계 + `word/media/` 파일로 이뤄진다. 콘텐츠 컨트롤(`w:sdt`)을 누름틀로 다룬다.

단위: Word는 트윕(1/20pt)과 하프포인트(글자 크기), EMU(그림)를 쓴다. 공용 PageInfo는 HWPUNIT(1/100pt)이라 트윕×5로 맞춘다.
"""

from __future__ import annotations

import copy
import io
import re
import zipfile
from dataclasses import dataclass, field

from lxml import etree

from .docx_fidelity import BodyPatcher, digest
from .errors import CommandError, EngineError
from .hwpx import Block, Cell, Field, PageInfo, TableGrid
from .images import ImageInfo
from .pagesetup import EDGES, PageSetup, apply_patch, from_unit, to_unit

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NSMAP = {"w": W, "r": R, "wp": WP, "a": A, "pic": PIC}
MIMETYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_INSERTED_ROWS = 1000
MAX_INSERTED_CELLS = 10_000
HEADING_GROW_PT = {1: 6, 2: 4, 3: 2, 4: 1, 5: 0, 6: 0}
JC = {"left": "left", "center": "center", "right": "right", "justify": "both", "distribute": "distribute"}
JC_NAMES = {"center": "가운데", "right": "오른쪽", "left": "왼쪽", "distribute": "배분", "both": None, "start": "왼쪽", "end": "오른쪽"}
# rPr 자식의 규정 순서(일부)
RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"]
PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"]


def w(tag: str) -> str:
    return "{%s}%s" % (W, tag)


def _val(el: etree._Element | None, default: str | None = None) -> str | None:
    return el.get(w("val"), default) if el is not None else default


def _on(el: etree._Element | None) -> bool:
    """w:b 같은 토글: 요소가 있고 val이 0/false가 아니면 켜짐."""
    return el is not None and _val(el, "true") not in ("0", "false")


def _ordered_child(parent: etree._Element, name: str, order: list[str]) -> etree._Element:
    existing = parent.find(w(name))
    if existing is not None:
        return existing
    el = etree.Element(w(name))
    rank = order.index(name) if name in order else len(order)
    for index, child in enumerate(parent):
        local = etree.QName(child).localname
        if (order.index(local) if local in order else len(order)) > rank:
            parent.insert(index, el)
            return el
    parent.append(el)
    return el


# ── 글 읽기 ──────────────────────────────────────────────────────────────


def _runs(p: etree._Element) -> list[etree._Element]:
    """문단 바로 아래(및 hyperlink/sdt 안)의 w:r. 표 칸 안 문단은 포함하지 않는다."""
    out = []
    for child in p:
        local = etree.QName(child).localname
        if local == "r":
            out.append(child)
        elif local in ("hyperlink", "ins", "smartTag"):
            out.extend(c for c in child if etree.QName(c).localname == "r")
        elif local == "sdt":
            content = child.find(w("sdtContent"))
            if content is not None:
                out.extend(c for c in content if etree.QName(c).localname == "r")
    return out


def _run_text(r: etree._Element) -> str:
    parts = []
    for child in r:
        local = etree.QName(child).localname
        if local == "t":
            parts.append(child.text or "")
        elif local == "tab":
            parts.append("\t")
        elif local in ("br", "cr"):
            parts.append("\n")
    return "".join(parts)


def paragraph_text(p: etree._Element) -> str:
    return "".join(_run_text(r) for r in _runs(p))


def cell_paragraphs(tc: etree._Element) -> list[etree._Element]:
    return list(tc.findall(w("p")))


def cell_text(tc: etree._Element) -> str:
    return "\n".join(paragraph_text(p) for p in cell_paragraphs(tc))


def table_grid(tbl: etree._Element) -> TableGrid:
    trs = tbl.findall(w("tr"))
    cells: list[Cell] = []
    open_merges: dict[int, Cell] = {}  # col → 위에서 이어지는 합친 칸
    for r, tr in enumerate(trs):
        col = 0
        for tc in tr.findall(w("tc")):
            pr = tc.find(w("tcPr"))
            span = int(_val(pr.find(w("gridSpan")), "1") if pr is not None else "1")
            vmerge = pr.find(w("vMerge")) if pr is not None else None
            if vmerge is not None and _val(vmerge, "continue") == "continue":
                above = open_merges.get(col)
                if above is not None:
                    above.row_span += 1
                col += span
                continue
            cell = Cell(row=r, col=col, row_span=1, col_span=span, text=cell_text(tc), element=tc)
            cells.append(cell)
            if vmerge is not None:
                open_merges[col] = cell
            else:
                open_merges.pop(col, None)
            col += span
    cols = max((c.col + c.col_span for c in cells), default=0)
    return TableGrid(rows=len(trs), cols=cols, cells=cells)


def inner_tables_of_cell(tc: etree._Element) -> list[etree._Element]:
    return list(tc.findall(w("tbl")))


def _sdt_parts(sdt: etree._Element) -> list[etree._Element]:
    """콘텐츠 컨트롤 안의 문단·표를 문서 순서로 (안쪽 sdt·sdtContent는 투명)."""
    out: list[etree._Element] = []

    def walk(el: etree._Element) -> None:
        for c in el:
            if not isinstance(c.tag, str):
                continue
            local = etree.QName(c).localname
            if local in ("p", "tbl"):
                out.append(c)
            elif local in ("sdt", "sdtContent"):
                walk(c)

    content = sdt.find(w("sdtContent"))
    if content is not None:
        walk(content)
    return out


# ── 글 쓰기 ──────────────────────────────────────────────────────────────


def _make_run(text: str, rpr: etree._Element | None = None) -> etree._Element:
    r = etree.Element(w("r"))
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    parts = text.split("\n")
    for i, part in enumerate(parts):
        if i:
            etree.SubElement(r, w("br"))
        t = etree.SubElement(r, w("t"))
        t.text = part
        if part != part.strip() or not part:
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return r


def _first_rpr(p: etree._Element) -> etree._Element | None:
    for r in _runs(p):
        if r.find(w("t")) is not None:
            return r.find(w("rPr"))
    ppr = p.find(w("pPr"))
    return ppr.find(w("rPr")) if ppr is not None else None


def _clear_text_runs(p: etree._Element) -> None:
    for r in _runs(p):
        parent = r.getparent()
        if any(etree.QName(c).localname in ("t", "tab", "br", "cr") for c in r):
            parent.remove(r)


def set_paragraph_text(p: etree._Element, text: str) -> None:
    rpr = _first_rpr(p)
    _clear_text_runs(p)
    p.append(_make_run(text, rpr))


def set_paragraph_runs(p: etree._Element, runs: list[tuple[str, etree._Element | None]]) -> None:
    _clear_text_runs(p)
    for text, rpr in runs:
        p.append(_make_run(text, rpr))


def replace_in_paragraph(p: etree._Element, start: int, end: int, replacement: str) -> None:
    offset = 0
    first = True
    for r in _runs(p):
        text = _run_text(r)
        r_start, r_end = offset, offset + len(text)
        offset = r_end
        if r_end <= start or r_start >= end:
            continue
        a = max(start, r_start) - r_start
        b = min(end, r_end) - r_start
        new_text = text[:a] + (replacement if first else "") + text[b:]
        first = False
        rpr = r.find(w("rPr"))
        for child in list(r):
            if etree.QName(child).localname != "rPr":
                r.remove(child)
        fresh = _make_run(new_text, None)
        for child in list(fresh):
            r.append(child)
        if rpr is not None and r.find(w("rPr")) is None:
            r.insert(0, rpr)


def _apply_look(rpr: etree._Element, patch: dict) -> None:
    """글자 모양 patch(bold/italic/strike/underline/color/size/font)를 w:rPr에 적는다."""
    for key, tag in (("bold", "b"), ("italic", "i"), ("strike", "strike")):
        if key in patch:
            el = rpr.find(w(tag))
            if patch[key] and el is None:
                _ordered_child(rpr, tag, RPR_ORDER)
            elif not patch[key] and el is not None:
                rpr.remove(el)
    if "underline" in patch:
        _ordered_child(rpr, "u", RPR_ORDER).set(w("val"), "single" if patch["underline"] else "none")
    if "color" in patch:
        _ordered_child(rpr, "color", RPR_ORDER).set(w("val"), patch["color"].lstrip("#").upper())
    if "size" in patch:
        _ordered_child(rpr, "sz", RPR_ORDER).set(w("val"), str(int(round(patch["size"] * 2))))
        _ordered_child(rpr, "szCs", RPR_ORDER).set(w("val"), str(int(round(patch["size"] * 2))))
    if "font" in patch:
        fonts = _ordered_child(rpr, "rFonts", RPR_ORDER)
        for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
            fonts.set(w(attr), patch["font"])


def apply_rpr_range(p: etree._Element, start: int, end: int, patch) -> None:
    """[start, end) 글자들의 run을 쪼개 patch(rPr) 적용."""
    offset = 0
    for r in list(_runs(p)):
        text = _run_text(r)
        r_start, r_end = offset, offset + len(text)
        offset = r_end
        if r_end <= start or r_start >= end or not text:
            continue
        a = max(start, r_start) - r_start
        b = min(end, r_end) - r_start
        rpr = r.find(w("rPr"))
        parent = r.getparent()
        index = parent.index(r)
        parent.remove(r)
        pieces = []
        if text[:a]:
            pieces.append(_make_run(text[:a], rpr))
        styled = _make_run(text[a:b], rpr)
        if styled.find(w("rPr")) is None:
            styled.insert(0, etree.Element(w("rPr")))
        patch(styled.find(w("rPr")))
        pieces.append(styled)
        if text[b:]:
            pieces.append(_make_run(text[b:], rpr))
        for offset_i, piece in enumerate(pieces):
            parent.insert(index + offset_i, piece)


def clone_paragraph_shell(like: etree._Element, text: str = "", rpr: etree._Element | None = None) -> etree._Element:
    p = etree.Element(w("p"))
    ppr = like.find(w("pPr"))
    if ppr is not None:
        new_ppr = copy.deepcopy(ppr)
        for drop in ("sectPr", "pPrChange"):
            el = new_ppr.find(w(drop))
            if el is not None:
                new_ppr.remove(el)
        p.append(new_ppr)
    p.append(_make_run(text, rpr if rpr is not None else _first_rpr(like)))
    return p


def _write_cell(tc: etree._Element, text: str) -> None:
    paragraphs = cell_paragraphs(tc)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not paragraphs:
        paragraphs = [etree.SubElement(tc, w("p"))]
    first = paragraphs[0]
    set_paragraph_text(first, lines[0])
    for extra in paragraphs[1:]:
        tc.remove(extra)
    index = tc.index(first)
    for offset, line in enumerate(lines[1:], 1):
        tc.insert(index + offset, clone_paragraph_shell(first, line))


# ── 문서 ─────────────────────────────────────────────────────────────────


class _DocxOps:
    paragraph_has_picture = staticmethod(lambda p: p.find(".//" + w("drawing")) is not None)
    paragraph_has_field = staticmethod(lambda p: p.find(".//" + w("fldChar")) is not None or p.find(".//" + w("sdt")) is not None)
    paragraph_has_table = staticmethod(lambda p: p.find(".//" + w("tbl")) is not None)
    table_grid = staticmethod(table_grid)
    cell_paragraphs = staticmethod(cell_paragraphs)
    paragraph_text = staticmethod(paragraph_text)
    write_cell = staticmethod(_write_cell)
    replace_in_paragraph = staticmethod(replace_in_paragraph)
    inner_tables_of_cell = staticmethod(inner_tables_of_cell)

    @staticmethod
    def cell_format(doc: "DocxDocument", tc: etree._Element) -> dict:
        paragraphs = cell_paragraphs(tc)
        p = paragraphs[0] if paragraphs else None
        size = doc._run_size(_first_rpr(p)) if p is not None else doc.default_size
        jc = _val(p.find(w("pPr") + "/" + w("jc"))) if p is not None else None
        pr = tc.find(w("tcPr"))
        valign = _val(pr.find(w("vAlign")), "top") if pr is not None else "top"
        return {"size": size, "align": {"both": "JUSTIFY"}.get(jc or "", (jc or "left").upper()), "vertical_align": (valign or "top").upper()}


class DocxDocument:
    format = "docx"
    ops = _DocxOps
    section_paths = ["word/document.xml"]

    def __init__(self, entries: dict[str, bytes], order: list[str]):
        self._entries = entries
        self._order = order
        parser = etree.XMLParser(remove_blank_text=False, huge_tree=False, resolve_entities=False, no_network=True)
        try:
            self._doc = etree.ElementTree(etree.fromstring(entries["word/document.xml"], parser))
            self._styles = etree.ElementTree(etree.fromstring(entries["word/styles.xml"], parser)) if "word/styles.xml" in entries else None
            self._rels = etree.ElementTree(etree.fromstring(entries.get("word/_rels/document.xml.rels", b'<Relationships xmlns="%s"/>' % REL.encode()), parser))
            self._types = etree.ElementTree(etree.fromstring(entries["[Content_Types].xml"], parser))
        except (etree.XMLSyntaxError, KeyError) as e:
            raise EngineError("DOCX 본문을 읽지 못했습니다.") from e
        self.body = self._doc.getroot().find(w("body"))
        if self.body is None:
            raise EngineError("w:body가 없는 DOCX입니다.")
        self.default_size = self._default_size()
        # 저장 충실도(docx_fidelity): 안 바뀐 본문 요소·부분은 원본 바이트 그대로 내보낸다
        self._patcher = BodyPatcher(entries["word/document.xml"], self.body)
        self._part_digests = {name: digest(tree.getroot()) for name, tree in (("word/_rels/document.xml.rels", self._rels), ("[Content_Types].xml", self._types), ("word/styles.xml", self._styles)) if tree is not None and name in entries}
        self._zip_meta: dict[str, tuple[int, tuple]] = {}
        self.last_save: dict = {}

    @classmethod
    def load(cls, data: bytes) -> "DocxDocument":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise EngineError("DOCX(zip) 파일이 아닙니다.") from e
        with zf:
            names = zf.namelist()
            entries = {n: zf.read(n) for n in names}
            meta = {i.filename: (i.compress_type, i.date_time) for i in zf.infolist()}
        if "word/document.xml" not in entries or "[Content_Types].xml" not in entries:
            raise EngineError("DOCX 패키지가 아닙니다 (word/document.xml 없음).")
        doc = cls(entries, names)
        doc._zip_meta = meta
        return doc

    def to_bytes(self) -> bytes:
        """패키지로 되돌린다. 안 바뀐 본문 요소·부분은 원본 바이트 그대로(docx_fidelity), zip 항목은 원래 순서·압축 방식·시각을 지킨다."""
        body_xml = self._patcher.render()
        if body_xml is None:
            body_xml = etree.tostring(self._doc, xml_declaration=True, encoding="UTF-8", standalone=True)
            self.last_save = {"fallback": True}
        else:
            self.last_save = {"fallback": False, **self._patcher.last}
        self._entries["word/document.xml"] = body_xml
        parts_rewritten = []
        for name, tree in (("word/_rels/document.xml.rels", self._rels), ("[Content_Types].xml", self._types), ("word/styles.xml", self._styles)):
            if tree is None:
                continue
            if self._part_digests.get(name) == digest(tree.getroot()):
                continue  # 손대지 않은 부분: 읽은 바이트 그대로
            self._entries[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
            parts_rewritten.append(name)
        self.last_save["parts"] = parts_rewritten
        for name in ("word/_rels/document.xml.rels",):
            if name not in self._order:
                self._order.append(name)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            ordered = list(self._order) + [n for n in self._entries if n not in self._order]  # 원래 항목 순서 그대로 (Word는 Content_Types를 맨 앞에 두지 않기도 한다)
            for name in ordered:
                compress_type, date_time = self._zip_meta.get(name, (zipfile.ZIP_DEFLATED, (1980, 1, 1, 0, 0, 0)))
                info = zipfile.ZipInfo(name, date_time=date_time)
                info.compress_type = compress_type if compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) else zipfile.ZIP_DEFLATED
                zf.writestr(info, self._entries[name])
        return buf.getvalue()

    def plain_text(self) -> str:
        return "\n".join(b.text() if b.kind == "paragraph" else "\n".join(c.text for c in table_grid(b.table).cells) for b in self.blocks())

    # 스타일 ---------------------------------------------------------------

    def _style(self, style_id: str | None) -> etree._Element | None:
        if self._styles is None or not style_id:
            return None
        for st in self._styles.getroot().findall(w("style")):
            if st.get(w("styleId")) == style_id:
                return st
        return None

    def style_name(self, style_id: str | None) -> str | None:
        st = self._style(style_id)
        return _val(st.find(w("name"))) if st is not None else None

    def _default_size(self) -> float:
        if self._styles is not None:
            sz = self._styles.getroot().find(w("docDefaults") + "/" + w("rPrDefault") + "/" + w("rPr") + "/" + w("sz"))
            if sz is not None and _val(sz, "").isdigit():
                return int(_val(sz)) / 2
        return 10.0

    def _run_size(self, rpr: etree._Element | None) -> float:
        sz = rpr.find(w("sz")) if rpr is not None else None
        return int(_val(sz)) / 2 if sz is not None and _val(sz, "").isdigit() else self.default_size

    # 블록 ------------------------------------------------------------------

    def blocks(self) -> list[Block]:
        out: list[Block] = []
        table_no = 0
        index = -1  # body 맨 위 요소 번호 (편집기 엔진의 docxIndex와 같은 셈법: 요소만 센다)
        for child in self.body:
            if not isinstance(child.tag, str):
                continue  # 주석·처리 명령은 블록이 아니다
            index += 1
            local = etree.QName(child).localname
            if local == "p":
                out.append(Block(no=len(out) + 1, kind="paragraph", paragraph=child, reader=paragraph_text, index=index))
            elif local == "tbl":
                table_no += 1
                out.append(Block(no=len(out) + 1, kind="table", paragraph=child, table=child, table_no=table_no, reader=paragraph_text, index=index))
            elif local == "sdt":
                # 편집기 엔진과 같은 셈법: 콘텐츠 컨트롤 안의 문단·표(안쪽 컨트롤은 투명하게 내려감)가 둘 이상이면 부분마다 번호 하나씩,
                # 아니면 컨트롤 전체가 번호 하나. 블록으로 내놓는 것은 예전처럼 sdtContent 바로 아래 문단뿐이다.
                parts = _sdt_parts(child)
                base = index
                if len(parts) >= 2:
                    index += len(parts) - 1
                position = {id(el): k for k, el in enumerate(parts)}
                content = child.find(w("sdtContent"))
                for inner in content if content is not None else []:
                    if isinstance(inner.tag, str) and etree.QName(inner).localname == "p":
                        at = base + position.get(id(inner), 0) if len(parts) >= 2 else base
                        out.append(Block(no=len(out) + 1, kind="paragraph", paragraph=inner, reader=paragraph_text, index=at, sub=0))
        return out

    def place(self, no: int) -> dict | None:
        return None  # DOCX 편집기는 블록 편집기라 자리 이동이 없다

    def block(self, no: int) -> Block:
        blocks = self.blocks()
        if not 1 <= no <= len(blocks):
            raise IndexError(no)
        return blocks[no - 1]

    def tables(self) -> list[Block]:
        return [b for b in self.blocks() if b.kind == "table"]

    def table(self, ref) -> tuple[Block, etree._Element, str]:
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
            inner = [t for tr in tbl.findall(w("tr")) for tc in tr.findall(w("tc")) for t in tc.findall(w("tbl"))]
            if not 1 <= k <= len(inner):
                raise IndexError(f"{label}-{k}")
            tbl = inner[k - 1]
            label = f"{label}-{k}"
        return blocks[0], tbl, label

    def page_info(self) -> PageInfo:
        sect = self.body.find(w("sectPr"))
        sz = sect.find(w("pgSz")) if sect is not None else None
        mar = sect.find(w("pgMar")) if sect is not None else None
        tw = lambda el, k, d: int(el.get(w(k), d)) * 5 if el is not None and el.get(w(k)) is not None else d * 5  # noqa: E731  트윕 → HWPUNIT
        return PageInfo(tw(sz, "w", 11906), tw(sz, "h", 16838), tw(mar, "left", 1701), tw(mar, "right", 1701), tw(mar, "top", 1134), tw(mar, "bottom", 850), tw(mar, "gutter", 0))

    # 쪽 설정 (pagesetup.py) — 문단 안 w:sectPr(구역 끝)들과 본문 끝 w:sectPr를 차례로 -------------

    def _sect_prs(self) -> list[etree._Element]:
        out = [p.find(w("pPr") + "/" + w("sectPr")) for p in self.body.findall(w("p"))]
        out = [s for s in out if s is not None]
        last = self.body.find(w("sectPr"))
        if last is None:
            last = etree.SubElement(self.body, w("sectPr"))
        return out + [last]

    def page_setups(self) -> list[PageSetup]:
        out = []
        for sect in self._sect_prs():
            sz, mar = sect.find(w("pgSz")), sect.find(w("pgMar"))
            g = lambda el, k, d: from_unit(int(el.get(w(k)) or d), 1440) if el is not None else from_unit(d, 1440)  # noqa: E731
            width, height = g(sz, "w", 11906), g(sz, "h", 16838)
            landscape = (sz is not None and sz.get(w("orient")) == "landscape") or width > height
            out.append(PageSetup(width, height, landscape, g(mar, "top", 1134), g(mar, "bottom", 850), g(mar, "left", 1701), g(mar, "right", 1701), g(mar, "header", 567), g(mar, "footer", 567), g(mar, "gutter", 0)))
        return out

    def set_page_setup(self, section: int | None, patch: dict) -> list[int]:
        sects = self._sect_prs()
        targets = range(1, len(sects) + 1) if section is None else [section]
        current = self.page_setups()
        order = ["headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType", "cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange"]
        for no in targets:
            if not 1 <= no <= len(sects):
                raise CommandError(f"구역 {no}이(가) 없습니다 (구역 {len(sects)}개).", "OUT_OF_RANGE")
            new = apply_patch(current[no - 1], patch)
            sect = sects[no - 1]
            sz = _ordered_child(sect, "pgSz", order)
            sz.set(w("w"), str(to_unit(new.width, 1440)))
            sz.set(w("h"), str(to_unit(new.height, 1440)))
            if new.landscape:
                sz.set(w("orient"), "landscape")
            elif w("orient") in sz.attrib:
                del sz.attrib[w("orient")]
            mar = _ordered_child(sect, "pgMar", order)
            for k in EDGES:
                mar.set(w(k), str(to_unit(getattr(new, k), 1440)))
        return list(targets)

    def body_model(self) -> etree._Element:
        blocks = self.blocks()
        for b in reversed(blocks):
            if b.kind == "paragraph" and b.text().strip() and not _on(_first_rpr(b.paragraph).find(w("b")) if _first_rpr(b.paragraph) is not None else None) and not (b.paragraph.find(w("pPr") + "/" + w("pStyle")) is not None and "eading" in (_val(b.paragraph.find(w("pPr") + "/" + w("pStyle"))) or "")):
                return b.paragraph
        return blocks[-1].paragraph if blocks else etree.Element(w("p"))

    def describe_paragraph(self, p: etree._Element) -> str:
        parts = []
        ppr = p.find(w("pPr"))
        style_id = _val(ppr.find(w("pStyle"))) if ppr is not None else None
        name = self.style_name(style_id)
        if name and name.lower() not in ("normal", "바탕글", "표준"):
            parts.append(name)
        rpr = _first_rpr(p)
        st_rpr = self._style(style_id).find(w("rPr")) if self._style(style_id) is not None else None
        size = self._run_size(rpr if rpr is not None and rpr.find(w("sz")) is not None else st_rpr)
        if abs(size - self.default_size) > 0.01:
            parts.append(f"{size:g}pt")
        look = lambda tag: (_on(rpr.find(w(tag))) if rpr is not None else False) or (_on(st_rpr.find(w(tag))) if st_rpr is not None else False)  # noqa: E731
        if look("b"):
            parts.append("굵게")
        if look("i"):
            parts.append("기울임")
        u = rpr.find(w("u")) if rpr is not None else None
        if u is not None and _val(u, "single") != "none":
            parts.append("밑줄")
        if look("strike"):
            parts.append("취소선")
        color = _val(rpr.find(w("color"))) if rpr is not None else None
        if color and color.lower() not in ("auto", "000000"):
            parts.append(f"색 #{color.upper()}")
        jc = _val(ppr.find(w("jc"))) if ppr is not None else None
        name_jc = JC_NAMES.get(jc or "both")
        if name_jc:
            parts.append(name_jc)
        return f"({', '.join(parts)})" if parts else ""

    def style_usage(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for b in self.blocks():
            if b.kind == "paragraph":
                ppr = b.paragraph.find(w("pPr"))
                name = self.style_name(_val(ppr.find(w("pStyle"))) if ppr is not None else None) or "Normal"
                counts[name] = counts.get(name, 0) + 1
        return counts

    def picture_count(self) -> int:
        return len(self.body.findall(".//" + w("drawing")))

    # 편집: 문단 -------------------------------------------------------------

    def _anchor_index(self, after: int | None, before: int | None) -> int:
        blocks = self.blocks()
        body = self.body
        sect = body.find(w("sectPr"))
        tail = body.index(sect) if sect is not None else len(body)
        if before is not None:
            return body.index(blocks[before - 1].paragraph)
        if after is not None and after > 0:
            return body.index(blocks[after - 1].paragraph) + 1
        if after == 0:
            return 0
        return tail

    def insert_elements(self, elements: list[etree._Element], after: int | None = None, before: int | None = None) -> list[int]:
        index = self._anchor_index(after, before)
        for offset, el in enumerate(elements):
            self.body.insert(index + offset, el)
        ids = {id(el) for el in elements}
        return [b.no for b in self.blocks() if id(b.paragraph) in ids]

    def insert_paragraphs(self, texts: list[str], after: int | None = None, before: int | None = None, like: int | None = None) -> list[int]:
        model = self.blocks()[like - 1].paragraph if like else self.body_model()
        return self.insert_elements([clone_paragraph_shell(model, t) for t in texts], after, before)

    def delete_blocks(self, start: int, end: int) -> int:
        blocks = self.blocks()
        removed = 0
        for b in blocks[start - 1 : end]:
            el = b.paragraph
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
                removed += 1
        sect = self.body.find(w("sectPr"))
        if self.body.find(w("p")) is None and self.body.find(w("tbl")) is None:
            self.body.insert(self.body.index(sect) if sect is not None else 0, etree.Element(w("p")))
        return removed

    def set_paragraph_runs(self, p: etree._Element, runs) -> None:
        base = _first_rpr(p)
        pairs = []
        for r in runs:
            rpr = copy.deepcopy(base) if base is not None else etree.Element(w("rPr"))
            if getattr(r, "bold", False):
                _ordered_child(rpr, "b", RPR_ORDER)
            if getattr(r, "italic", False):
                _ordered_child(rpr, "i", RPR_ORDER)
            if getattr(r, "strike", False):
                _ordered_child(rpr, "strike", RPR_ORDER)
            pairs.append((r.text, rpr if len(rpr) else None))
        set_paragraph_runs(p, pairs)

    def build_content(self, specs, like: int | None = None) -> list[etree._Element]:
        from .markdown_lite import ParagraphSpec, TableSpec

        model = self.blocks()[like - 1].paragraph if like else self.body_model()
        base_rpr = _first_rpr(model)
        base_size = self._run_size(base_rpr)
        out = []
        for spec in specs:
            if isinstance(spec, TableSpec):
                out.append(self.build_table(spec.rows, header=spec.header, like=model))
                continue
            assert isinstance(spec, ParagraphSpec)
            p = clone_paragraph_shell(model, "", base_rpr)
            p.remove(p.find(w("r")))
            ppr = _ordered_child(p, "pPr", ["pPr"])
            if ppr.getparent() is None or p.index(ppr) != 0:
                p.remove(ppr)
                p.insert(0, ppr)
            run_rpr = copy.deepcopy(base_rpr) if base_rpr is not None else etree.Element(w("rPr"))
            if spec.kind == "heading":
                style = self._ensure_heading_style(spec.level)
                _ordered_child(ppr, "pStyle", PPR_ORDER).set(w("val"), style)
                _ordered_child(run_rpr, "b", RPR_ORDER)
                _ordered_child(run_rpr, "sz", RPR_ORDER).set(w("val"), str(int((base_size + HEADING_GROW_PT.get(spec.level, 0)) * 2)))
            elif spec.kind in ("bullet", "numbered"):
                ind = _ordered_child(ppr, "ind", PPR_ORDER)
                ind.set(w("left"), "480")
                ind.set(w("hanging"), "240")
            elif spec.kind == "quote":
                _ordered_child(ppr, "ind", PPR_ORDER).set(w("left"), "720")
                _ordered_child(run_rpr, "color", RPR_ORDER).set(w("val"), "555555")
            if spec.page_break:
                _ordered_child(ppr, "pageBreakBefore", PPR_ORDER)
            if len(ppr) == 0:
                p.remove(ppr)
            for r in spec.runs:
                rpr = copy.deepcopy(run_rpr)
                for flag, tag in (("bold", "b"), ("italic", "i"), ("strike", "strike")):
                    if getattr(r, flag, False):
                        _ordered_child(rpr, tag, RPR_ORDER)
                p.append(_make_run(r.text, rpr if len(rpr) else None))
            out.append(p)
        return out

    def _ensure_heading_style(self, level: int) -> str:
        style_id = f"Heading{min(level, 6)}"
        if self._styles is None:
            return style_id
        if self._style(style_id) is None:
            root = self._styles.getroot()
            st = etree.SubElement(root, w("style"), {w("type"): "paragraph", w("styleId"): style_id})
            etree.SubElement(st, w("name")).set(w("val"), f"heading {min(level, 6)}")
            etree.SubElement(st, w("basedOn")).set(w("val"), "Normal")
            etree.SubElement(st, w("qFormat"))
            ppr = etree.SubElement(st, w("pPr"))
            etree.SubElement(ppr, w("keepNext"))
            sp = etree.SubElement(ppr, w("spacing"))
            sp.set(w("before"), "240")
            sp.set(w("after"), "80")
            etree.SubElement(ppr, w("outlineLvl")).set(w("val"), str(min(level, 6) - 1))
        return style_id

    def format_range(self, p: etree._Element, start: int, end: int, patch: dict) -> None:
        apply_rpr_range(p, start, end, lambda rpr: _apply_look(rpr, patch))

    def format_whole_paragraph(self, p: etree._Element, patch: dict) -> bool:
        """문단의 모든 글과 문단 끝 표시(w:pPr/w:rPr)의 글자 모양. 빈 문단은 끝 표시만 바뀐다 (줄 높이·새로 칠 글의 모양)."""
        n = len(paragraph_text(p))
        if n:
            self.format_range(p, 0, n, patch)
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        _apply_look(_ordered_child(ppr, "rPr", PPR_ORDER), patch)
        return n > 0

    def format_paragraph(self, p: etree._Element, patch: dict) -> None:
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        if "align" in patch:
            _ordered_child(ppr, "jc", PPR_ORDER).set(w("val"), JC[patch["align"]])
        spacing_keys = {"line_spacing": ("line", lambda v: str(int(round(v * 240 / 100)))), "space_before": ("before", lambda v: str(int(round(v * 20)))), "space_after": ("after", lambda v: str(int(round(v * 20))))}
        for key, (attr, conv) in spacing_keys.items():
            if key in patch:
                sp = _ordered_child(ppr, "spacing", PPR_ORDER)
                sp.set(w(attr), conv(patch[key]))
                if key == "line_spacing":
                    sp.set(w("lineRule"), "auto")
        if "left" in patch or "indent" in patch:
            ind = _ordered_child(ppr, "ind", PPR_ORDER)
            if "left" in patch:
                ind.set(w("left"), str(int(round(patch["left"] * 20))))
            if "indent" in patch:
                v = int(round(patch["indent"] * 20))
                for drop in ("firstLine", "hanging"):
                    ind.attrib.pop(w(drop), None)
                ind.set(w("firstLine" if v >= 0 else "hanging"), str(abs(v)))
        if "page_break" in patch:
            el = ppr.find(w("pageBreakBefore"))
            if patch["page_break"] and el is None:
                _ordered_child(ppr, "pageBreakBefore", PPR_ORDER)
            elif not patch["page_break"] and el is not None:
                ppr.remove(el)

    def format_cell(self, tc: etree._Element, fmt: dict) -> None:
        pr = tc.find(w("tcPr"))
        if pr is None:
            pr = etree.Element(w("tcPr"))
            tc.insert(0, pr)
        if fmt.get("vertical_align"):
            _ordered_child(pr, "vAlign", ["tcW", "gridSpan", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark"]).set(w("val"), fmt["vertical_align"])
        if fmt.get("padding_mm"):
            mar = _ordered_child(pr, "tcMar", ["tcW", "gridSpan", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark"])
            for side, mm in fmt["padding_mm"].items():
                side_el = mar.find(w(side))
                if side_el is None:
                    side_el = etree.SubElement(mar, w(side))
                side_el.set(w("w"), str(int(round(mm / 25.4 * 1440))))
                side_el.set(w("type"), "dxa")
        for p in cell_paragraphs(tc):
            if "align" in fmt or "line_spacing" in fmt:
                self.format_paragraph(p, {k: fmt[k] for k in ("align", "line_spacing") if k in fmt})
            if "size" in fmt or "bold" in fmt:
                runs = _runs(p)
                if not runs:
                    runs = [_make_run("", _first_rpr(p))]
                    p.append(runs[0])
                for r in runs:
                    rpr = r.find(w("rPr"))
                    if rpr is None:
                        rpr = etree.Element(w("rPr"))
                        r.insert(0, rpr)
                    if "size" in fmt:
                        _ordered_child(rpr, "sz", RPR_ORDER).set(w("val"), str(int(round(fmt["size"] * 2))))
                    if "bold" in fmt:
                        el = rpr.find(w("b"))
                        if fmt["bold"] and el is None:
                            _ordered_child(rpr, "b", RPR_ORDER)
                        elif not fmt["bold"] and el is not None:
                            rpr.remove(el)

    # 편집: 표 ---------------------------------------------------------------

    def insert_table_rows(self, tbl: etree._Element, after_row: int | None, rows: list[list[str]], count: int | None) -> int:
        grid = table_grid(tbl)
        trs = tbl.findall(w("tr"))
        total = len(trs)
        after = total if after_row is None else after_row
        if not 0 <= after <= total:
            raise ValueError(f"after_row는 0~{total} 사이여야 합니다.")
        new_count = max(len(rows), count or 0, 0 if rows else 1)
        if new_count > MAX_INSERTED_ROWS:
            raise ValueError(f"한 번에 {MAX_INSERTED_ROWS}행까지 넣을 수 있습니다.")
        if any(c.row_span > 1 and c.row < after < c.row + c.row_span for c in grid.cells):
            raise ValueError(f"{after}행 아래는 세로로 합친 칸 속이라 행을 넣을 수 없습니다.")

        def complete(i: int) -> bool:
            cells = grid.row_cells(i)
            return bool(cells) and all(c.row_span == 1 for c in cells) and sum(c.col_span for c in cells) == grid.cols

        near = max(0, after - 1)
        model_index = next((i for i in sorted(range(total), key=lambda i: (abs(i - near), -i)) if complete(i)), None)
        if model_index is None:
            raise ValueError("본뜰 수 있는 행(합친 칸 없이 모든 열을 덮는 행)이 없습니다.")
        model_cells = grid.row_cells(model_index)
        if new_count * len(model_cells) > MAX_INSERTED_CELLS:
            raise ValueError(f"한 번에 새 칸 {MAX_INSERTED_CELLS}개까지 넣을 수 있습니다.")
        for i, row in enumerate(rows):
            if len(row) > grid.cols:
                raise ValueError(f"새 {i + 1}행에 {len(row)}열을 주었지만 표는 {grid.cols}열입니다.")
        new_trs = []
        for i in range(new_count):
            tr = copy.deepcopy(trs[model_index])
            trpr = tr.find(w("trPr"))
            if trpr is not None and trpr.find(w("tblHeader")) is not None:
                trpr.remove(trpr.find(w("tblHeader")))
            values = rows[i] if i < len(rows) else []
            for at, tc in enumerate(tr.findall(w("tc"))):
                pr = tc.find(w("tcPr"))
                if pr is not None and pr.find(w("vMerge")) is not None:
                    pr.remove(pr.find(w("vMerge")))
                col = model_cells[at].col if at < len(model_cells) else at
                _write_cell(tc, values[col] if col < len(values) else "")
            new_trs.append(tr)
        insert_at = tbl.index(trs[0]) if after == 0 else tbl.index(trs[after - 1]) + 1
        for offset, tr in enumerate(new_trs):
            tbl.insert(insert_at + offset, tr)
        return new_count

    def delete_table_rows(self, tbl: etree._Element, start: int, end: int) -> int:
        trs = tbl.findall(w("tr"))
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
        return end - start + 1

    def build_table(self, rows: list[list[str]], header: bool = True, like: etree._Element | None = None) -> etree._Element:
        model = like if like is not None else self.body_model()
        cols = max(len(r) for r in rows)
        rows = [r + [""] * (cols - len(r)) for r in rows]
        width_tw = self.page_info().body_width // 5
        col_w = width_tw // cols
        tbl = etree.Element(w("tbl"))
        pr = etree.SubElement(tbl, w("tblPr"))
        etree.SubElement(pr, w("tblW"), {w("w"): str(width_tw), w("type"): "dxa"})
        borders = etree.SubElement(pr, w("tblBorders"))
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            etree.SubElement(borders, w(side), {w("val"): "single", w("sz"): "4", w("space"): "0", w("color"): "auto"})
        etree.SubElement(pr, w("tblLayout"), {w("type"): "fixed"})
        grid = etree.SubElement(tbl, w("tblGrid"))
        for _ in range(cols):
            etree.SubElement(grid, w("gridCol"), {w("w"): str(col_w)})
        base_rpr = _first_rpr(model)
        for r, row in enumerate(rows):
            tr = etree.SubElement(tbl, w("tr"))
            is_header = header and r == 0
            if is_header:
                etree.SubElement(etree.SubElement(tr, w("trPr")), w("tblHeader"))
            for text in row:
                tc = etree.SubElement(tr, w("tc"))
                tcpr = etree.SubElement(tc, w("tcPr"))
                etree.SubElement(tcpr, w("tcW"), {w("w"): str(col_w), w("type"): "dxa"})
                if is_header:
                    etree.SubElement(tcpr, w("shd"), {w("val"): "clear", w("color"): "auto", w("fill"): "EDEDED"})
                p = etree.SubElement(tc, w("p"))
                if is_header:
                    ppr = etree.SubElement(p, w("pPr"))
                    etree.SubElement(ppr, w("jc")).set(w("val"), "center")
                rpr = copy.deepcopy(base_rpr) if base_rpr is not None else etree.Element(w("rPr"))
                if is_header:
                    _ordered_child(rpr, "b", RPR_ORDER)
                p.append(_make_run(text, rpr if len(rpr) else None))
        return tbl

    # 편집: 그림 -------------------------------------------------------------

    def _add_relationship(self, kind: str, target: str) -> str:
        root = self._rels.getroot()
        ids = {rel.get("Id") for rel in root}
        n = len(ids) + 1
        while f"rId{n}" in ids:
            n += 1
        etree.SubElement(root, "{%s}Relationship" % REL, Id=f"rId{n}", Type=kind, Target=target)
        return f"rId{n}"

    def _ensure_content_type(self, ext: str, media_type: str) -> None:
        root = self._types.getroot()
        for d in root.findall("{%s}Default" % CT):
            if d.get("Extension", "").lower() == ext:
                return
        etree.SubElement(root, "{%s}Default" % CT, Extension=ext, ContentType=media_type)

    def build_image(self, data: bytes, info: ImageInfo, width_mm: float | None, align: str) -> etree._Element:
        n = 1
        while f"word/media/image{n}.{info.ext}" in self._entries:
            n += 1
        path = f"word/media/image{n}.{info.ext}"
        self._entries[path] = data
        self._order.append(path)
        self._ensure_content_type(info.ext, info.media_type)
        rid = self._add_relationship("http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", f"media/image{n}.{info.ext}")
        emu_per_px = 9525
        max_cx = self.page_info().body_width // 5 * 635  # 트윕 → EMU
        cx = min(int(round(width_mm / 25.4 * 914400)) if width_mm else info.width * emu_per_px, max_cx)
        cy = max(1, int(round(cx * info.height / max(1, info.width))))
        model = self.body_model()
        p = clone_paragraph_shell(model, "", None)
        p.remove(p.find(w("r")))
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        _ordered_child(ppr, "jc", PPR_ORDER).set(w("val"), JC.get(align, "center"))
        r = etree.SubElement(p, w("r"))
        drawing = etree.SubElement(r, w("drawing"))
        inline = etree.SubElement(drawing, "{%s}inline" % WP, distT="0", distB="0", distL="0", distR="0")
        etree.SubElement(inline, "{%s}extent" % WP, cx=str(cx), cy=str(cy))
        etree.SubElement(inline, "{%s}effectExtent" % WP, l="0", t="0", r="0", b="0")
        etree.SubElement(inline, "{%s}docPr" % WP, id=str(n), name=f"그림 {n}")
        etree.SubElement(etree.SubElement(inline, "{%s}cNvGraphicFramePr" % WP), "{%s}graphicFrameLocks" % A, noChangeAspect="1")
        graphic = etree.SubElement(inline, "{%s}graphic" % A)
        gdata = etree.SubElement(graphic, "{%s}graphicData" % A, uri=PIC)
        pic = etree.SubElement(gdata, "{%s}pic" % PIC)
        nv = etree.SubElement(pic, "{%s}nvPicPr" % PIC)
        etree.SubElement(nv, "{%s}cNvPr" % PIC, id="0", name=f"image{n}.{info.ext}")
        etree.SubElement(nv, "{%s}cNvPicPr" % PIC)
        blipfill = etree.SubElement(pic, "{%s}blipFill" % PIC)
        etree.SubElement(blipfill, "{%s}blip" % A, {"{%s}embed" % R: rid})
        etree.SubElement(etree.SubElement(blipfill, "{%s}stretch" % A), "{%s}fillRect" % A)
        sppr = etree.SubElement(pic, "{%s}spPr" % PIC)
        xfrm = etree.SubElement(sppr, "{%s}xfrm" % A)
        etree.SubElement(xfrm, "{%s}off" % A, x="0", y="0")
        etree.SubElement(xfrm, "{%s}ext" % A, cx=str(cx), cy=str(cy))
        etree.SubElement(etree.SubElement(sppr, "{%s}prstGeom" % A, prst="rect"), "{%s}avLst" % A)
        return p

    # 누름틀(콘텐츠 컨트롤) --------------------------------------------------

    def fields(self) -> list[Field]:
        out: list[Field] = []
        for b in self.blocks():
            targets = [(b.paragraph, "")] if b.kind == "paragraph" else [(p, f"표 {b.table_no} ({c.row + 1},{c.col + 1})") for c in table_grid(b.table).cells for p in cell_paragraphs(c.element)]
            for p, where in targets:
                candidates = list(p.findall(w("sdt")))
                parent = p.getparent()
                if parent is not None and etree.QName(parent).localname == "sdtContent":
                    candidates.append(parent.getparent())
                for sdt in candidates:
                    pr = sdt.find(w("sdtPr"))
                    content = sdt.find(w("sdtContent"))
                    name = _val(pr.find(w("alias")), "") if pr is not None else ""
                    tag = _val(pr.find(w("tag")), "") if pr is not None else ""
                    placeholder = pr.find(w("showingPlcHdr")) is not None if pr is not None else False
                    text = "".join(_run_text(r) for r in content.iter(w("r"))) if content is not None else ""
                    locked = pr is not None and pr.find(w("lock")) is not None and _val(pr.find(w("lock")), "") in ("contentLocked", "sdtContentLocked")
                    kind = next((etree.QName(c).localname for c in (pr if pr is not None else []) if etree.QName(c).localname in ("text", "richText", "date", "dropDownList", "comboBox", "checkbox", "picture")), "text")
                    out.append(Field(len(out) + 1, b.no, where, name or tag, tag if name else "", "" if placeholder else text, kind, locked or kind in ("picture", "checkbox"), p, sdt, content))
        return out

    def fill_field(self, f: Field, value: str) -> None:
        sdt, content = f.begin_run, f.end_run
        if content is None:
            content = etree.SubElement(sdt, w("sdtContent"))
        pr = sdt.find(w("sdtPr"))
        if pr is not None and pr.find(w("showingPlcHdr")) is not None:
            pr.remove(pr.find(w("showingPlcHdr")))
        first_rpr = next((r.find(w("rPr")) for r in content.iter(w("r"))), None)
        if content.find(w("p")) is not None:
            p = content.find(w("p"))
            _clear_text_runs(p)
            for extra in content.findall(w("p"))[1:]:
                content.remove(extra)
            p.append(_make_run(value, first_rpr))
        else:
            for child in list(content):
                content.remove(child)
            content.append(_make_run(value, first_rpr))


# ── 새 문서 ─────────────────────────────────────────────────────────────

_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def create_blank(title: str = "새 문서") -> DocxDocument:
    content_types = f'{_DECL}<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
    rels = f'{_DECL}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
    doc_rels = f'{_DECL}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    styles = (
        f'{_DECL}<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="맑은 고딕" w:hAnsi="맑은 고딕" w:eastAsia="맑은 고딕" w:cs="맑은 고딕"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>'
    )
    document = f'{_DECL}<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1701" w:bottom="850" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>'
    core = f'{_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{title.replace("&", "&amp;").replace("<", "&lt;")}</dc:title><dc:creator>hwpx-ai-editor</dc:creator></cp:coreProperties>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document)
        zf.writestr("word/styles.xml", styles)
        zf.writestr("word/_rels/document.xml.rels", doc_rels)
        zf.writestr("docProps/core.xml", core)
    return DocxDocument.load(buf.getvalue())
