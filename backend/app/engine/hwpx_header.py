"""header.xml 모델: 글자 모양(charPr)·문단 모양(paraPr)·글꼴·테두리 읽기와 '같은 모양 찾거나 새로 만들기'."""

from __future__ import annotations

import copy
from dataclasses import dataclass

from lxml import etree

HH = "http://www.hancom.co.kr/hwpml/2011/head"
HC = "http://www.hancom.co.kr/hwpml/2011/core"
HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"]
LANG_TAGS = {"hangul": "HANGUL", "latin": "LATIN", "hanja": "HANJA", "japanese": "JAPANESE", "other": "OTHER", "symbol": "SYMBOL", "user": "USER"}
# charPr 자식 요소의 규정 순서
CHAR_ORDER = ["fontRef", "ratio", "spacing", "relSz", "offset", "italic", "bold", "underline", "strikeout", "outline", "shadow", "emboss", "engrave", "supscript", "subscript"]
ALIGN_CODES = {"left": "LEFT", "center": "CENTER", "right": "RIGHT", "justify": "JUSTIFY", "distribute": "DISTRIBUTE"}
ALIGN_NAMES = {"LEFT": "왼쪽", "CENTER": "가운데", "RIGHT": "오른쪽", "DISTRIBUTE": "배분", "JUSTIFY": None}


def hh(tag: str) -> str:
    return "{%s}%s" % (HH, tag)


def hc(tag: str) -> str:
    return "{%s}%s" % (HC, tag)


def hp(tag: str) -> str:
    return "{%s}%s" % (HP, tag)


def hwp_unit(pt: float) -> int:
    return round(pt * 100)


@dataclass
class CharLook:
    size: float  # pt
    bold: bool
    italic: bool
    underline: bool
    strike: bool
    color: str
    font: str | None


@dataclass
class ParaLook:
    align: str  # LEFT|CENTER|RIGHT|JUSTIFY|DISTRIBUTE
    line_spacing: int  # %
    left: int  # HWPUNIT
    indent: int
    prev: int
    next: int
    page_break_before: bool


class HeaderModel:
    def __init__(self, tree: etree._ElementTree):
        self.tree = tree
        self.root = tree.getroot()

    # ── 목록 접근 ────────────────────────────────────────────────────────

    def _list(self, name: str) -> etree._Element:
        node = self.root.find(".//" + hh(name))
        if node is None:
            ref = self.root.find(hh("refList"))
            if ref is None:
                ref = etree.SubElement(self.root, hh("refList"))
            node = etree.SubElement(ref, hh(name))
            node.set("itemCnt", "0")
        return node

    def _items(self, list_name: str, item_name: str) -> list[etree._Element]:
        return list(self._list(list_name).findall(hh(item_name)))

    def _by_id(self, list_name: str, item_name: str, id_: str | int | None) -> etree._Element | None:
        items = self._items(list_name, item_name)
        for item in items:
            if item.get("id") == str(id_):
                return item
        return items[0] if items else None

    def _append(self, list_name: str, item_name: str, node: etree._Element) -> int:
        container = self._list(list_name)
        items = container.findall(hh(item_name))
        next_id = max((int(i.get("id", "0")) for i in items), default=-1) + 1
        node.set("id", str(next_id))
        container.append(node)
        container.set("itemCnt", str(len(items) + 1))
        return next_id

    @staticmethod
    def _signature(node: etree._Element) -> bytes:
        clone = copy.deepcopy(node)
        clone.attrib.pop("id", None)
        return etree.tostring(clone, method="c14n")

    def _find_same(self, list_name: str, item_name: str, node: etree._Element) -> int | None:
        sig = self._signature(node)
        for item in self._items(list_name, item_name):
            if self._signature(item) == sig:
                return int(item.get("id"))
        return None

    # ── 글꼴 ─────────────────────────────────────────────────────────────

    def font_face(self, lang: str, font_id: str | int | None) -> str | None:
        for face in self._items("fontfaces", "fontface"):
            if face.get("lang") == LANG_TAGS[lang]:
                for font in face.findall(hh("font")):
                    if font.get("id") == str(font_id):
                        return font.get("face")
        return None

    def ensure_font(self, name: str) -> dict[str, int]:
        ids: dict[str, int] = {}
        container = self._list("fontfaces")
        for lang in LANGS:
            face = next((f for f in container.findall(hh("fontface")) if f.get("lang") == LANG_TAGS[lang]), None)
            if face is None:
                face = etree.SubElement(container, hh("fontface"), lang=LANG_TAGS[lang], fontCnt="0")
                container.set("itemCnt", str(len(container.findall(hh("fontface")))))
            fonts = face.findall(hh("font"))
            existing = next((f for f in fonts if f.get("face") == name), None)
            if existing is None:
                next_id = max((int(f.get("id", "0")) for f in fonts), default=-1) + 1
                existing = etree.SubElement(face, hh("font"), id=str(next_id), face=name, type="TTF", isEmbedded="0")
                etree.SubElement(existing, hh("typeInfo"), familyType="FCAT_GOTHIC", weight="6", proportion="4", contrast="0", strokeVariation="1", armStyle="1", letterform="1", midline="1", xHeight="1")
                face.set("fontCnt", str(len(fonts) + 1))
            ids[lang] = int(existing.get("id"))
        return ids

    # ── 글자 모양 ───────────────────────────────────────────────────────

    def char_look(self, char_pr_id: str | int | None) -> CharLook:
        node = self._by_id("charProperties", "charPr", char_pr_id)
        if node is None:
            return CharLook(10.0, False, False, False, False, "#000000", None)
        underline = node.find(hh("underline"))
        strike = node.find(hh("strikeout"))
        font_ref = node.find(hh("fontRef"))
        return CharLook(
            size=int(node.get("height", "1000")) / 100,
            bold=node.find(hh("bold")) is not None,
            italic=node.find(hh("italic")) is not None,
            underline=underline is not None and underline.get("type", "NONE") != "NONE",
            strike=strike is not None and strike.get("shape", "NONE") not in ("NONE", "3D"),
            color=node.get("textColor", "#000000"),
            font=self.font_face("hangul", font_ref.get("hangul") if font_ref is not None else None),
        )

    def ensure_char_pr(self, base_id: str | int | None, **patch) -> int:
        """base를 복사해 patch를 적용한 글자 모양의 id (이미 같은 것이 있으면 그 id)."""
        base = self._by_id("charProperties", "charPr", base_id)
        if base is None:
            raise ValueError("글자 모양이 하나도 없는 문서입니다.")
        node = copy.deepcopy(base)
        if patch.get("size") is not None:
            node.set("height", str(hwp_unit(patch["size"])))
        if patch.get("color") is not None:
            node.set("textColor", patch["color"])
        if patch.get("font"):
            ids = self.ensure_font(patch["font"])
            ref = node.find(hh("fontRef"))
            if ref is None:
                ref = etree.Element(hh("fontRef"))
                node.insert(0, ref)
            for lang in LANGS:
                ref.set(lang, str(ids[lang]))
        for key in ("bold", "italic"):
            if patch.get(key) is not None:
                self._set_flag(node, key, patch[key])
        if patch.get("underline") is not None:
            u = node.find(hh("underline"))
            if u is None:
                u = self._insert_ordered(node, "underline")
                u.set("shape", "SOLID")
                u.set("color", "#000000")
            u.set("type", "BOTTOM" if patch["underline"] else "NONE")
        if patch.get("strike") is not None:
            s = node.find(hh("strikeout"))
            if s is None:
                s = self._insert_ordered(node, "strikeout")
                s.set("color", "#000000")
            s.set("shape", "SOLID" if patch["strike"] else "NONE")
        same = self._find_same("charProperties", "charPr", node)
        return same if same is not None else self._append("charProperties", "charPr", node)

    def _set_flag(self, node: etree._Element, name: str, on: bool) -> None:
        existing = node.find(hh(name))
        if on and existing is None:
            self._insert_ordered(node, name)
        elif not on and existing is not None:
            node.remove(existing)

    def _insert_ordered(self, node: etree._Element, name: str) -> etree._Element:
        el = etree.Element(hh(name))
        rank = CHAR_ORDER.index(name) if name in CHAR_ORDER else len(CHAR_ORDER)
        for index, child in enumerate(node):
            local = etree.QName(child).localname
            child_rank = CHAR_ORDER.index(local) if local in CHAR_ORDER else len(CHAR_ORDER)
            if child_rank > rank:
                node.insert(index, el)
                return el
        node.append(el)
        return el

    # ── 문단 모양 ───────────────────────────────────────────────────────

    def _layout_nodes(self, para_pr: etree._Element) -> list[tuple[etree._Element | None, etree._Element | None, int]]:
        """(margin, lineSpacing, scale) 목록. hp:switch가 있으면 case(1배)와 default(2배) 둘 다."""
        switch = para_pr.find(hp("switch"))
        if switch is None:
            return [(para_pr.find(hh("margin")), para_pr.find(hh("lineSpacing")), 1)]
        out = []
        for branch in list(switch.findall(hp("case"))) + list(switch.findall(hp("default"))):
            out.append((branch.find(hh("margin")), branch.find(hh("lineSpacing")), 2 if etree.QName(branch).localname == "default" else 1))
        return out

    def para_look(self, para_pr_id: str | int | None) -> ParaLook:
        node = self._by_id("paraProperties", "paraPr", para_pr_id)
        if node is None:
            return ParaLook("JUSTIFY", 160, 0, 0, 0, 0, False)
        align = node.find(hh("align"))
        brk = node.find(hh("breakSetting"))
        margin, spacing, _ = self._layout_nodes(node)[0]

        def mv(name: str) -> int:
            if margin is None:
                return 0
            child = margin.find(hc(name))
            try:
                return int(child.get("value", "0")) if child is not None else 0
            except ValueError:
                return 0

        return ParaLook(
            align=align.get("horizontal", "JUSTIFY") if align is not None else "JUSTIFY",
            line_spacing=int(spacing.get("value", "160")) if spacing is not None and spacing.get("value", "").lstrip("-").isdigit() else 160,
            left=mv("left"),
            indent=mv("intent"),
            prev=mv("prev"),
            next=mv("next"),
            page_break_before=brk is not None and brk.get("pageBreakBefore") == "1",
        )

    def ensure_para_pr(self, base_id: str | int | None, **patch) -> int:
        base = self._by_id("paraProperties", "paraPr", base_id)
        if base is None:
            raise ValueError("문단 모양이 하나도 없는 문서입니다.")
        node = copy.deepcopy(base)
        if patch.get("align"):
            align = node.find(hh("align"))
            if align is None:
                align = etree.Element(hh("align"), vertical="BASELINE")
                node.insert(0, align)
            align.set("horizontal", patch["align"])
        if patch.get("page_break_before") is not None:
            brk = node.find(hh("breakSetting"))
            if brk is None:
                brk = etree.SubElement(node, hh("breakSetting"))
            brk.set("pageBreakBefore", "1" if patch["page_break_before"] else "0")
        for margin, spacing, scale in self._layout_nodes(node):
            for key, tag in (("indent", "intent"), ("left", "left"), ("right", "right"), ("prev", "prev"), ("next", "next")):
                if patch.get(key) is not None:
                    if margin is None:
                        continue
                    child = margin.find(hc(tag))
                    if child is None:
                        child = etree.SubElement(margin, hc(tag), unit="HWPUNIT")
                    child.set("value", str(round(patch[key] * scale)))
            if patch.get("line_spacing") is not None and spacing is not None:
                spacing.set("type", "PERCENT")
                spacing.set("value", str(round(patch["line_spacing"])))
        same = self._find_same("paraProperties", "paraPr", node)
        return same if same is not None else self._append("paraProperties", "paraPr", node)

    # ── 스타일 ─────────────────────────────────────────────────────────

    def style_name(self, style_id: str | int | None) -> str | None:
        node = self._by_id("styles", "style", style_id)
        return node.get("name") if node is not None and node.get("id") == str(style_id) else None

    def style_count(self) -> int:
        return len(self._items("styles", "style"))

    def default_looks(self) -> tuple[str, str]:
        """바탕글(스타일 0)의 (paraPrIDRef, charPrIDRef)."""
        node = self._by_id("styles", "style", 0)
        if node is None:
            return "0", "0"
        return node.get("paraPrIDRef", "0"), node.get("charPrIDRef", "0")

    # ── 테두리/배경 ─────────────────────────────────────────────────────

    def ensure_border_fill(self, *, solid: bool, fill: str | None = None) -> int:
        node = etree.Element(hh("borderFill"), threeD="0", shadow="0", centerLine="NONE", breakCellSeparateLine="0")
        etree.SubElement(node, hh("slash"), type="NONE", Crooked="0", isCounter="0")
        etree.SubElement(node, hh("backSlash"), type="NONE", Crooked="0", isCounter="0")
        kind = "SOLID" if solid else "NONE"
        width = "0.12 mm" if solid else "0.1 mm"
        for side in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            etree.SubElement(node, hh(side), type=kind, width=width, color="#000000")
        etree.SubElement(node, hh("diagonal"), type="SOLID", width="0.1 mm", color="#000000")
        if fill:
            brush = etree.SubElement(node, hc("fillBrush"))
            etree.SubElement(brush, hc("winBrush"), faceColor=fill, hatchColor="#000000", alpha="0")
        same = self._find_same("borderFills", "borderFill", node)
        if same is not None:
            return same
        container = self._list("borderFills")
        items = container.findall(hh("borderFill"))
        next_id = max((int(i.get("id", "0")) for i in items), default=0) + 1  # borderFill id는 1부터
        node.set("id", str(next_id))
        container.append(node)
        container.set("itemCnt", str(len(items) + 1))
        return next_id

    def describe(self, para_pr_id, char_pr_id, style_id, *, body_size: float | None = None, body_style: str | None = None) -> str:
        """읽기 출력의 모양 요약: '(제목 1, 16pt, 굵게, 가운데)'처럼 본문과 다른 것만."""
        parts: list[str] = []
        style = self.style_name(style_id)
        if style and style != (body_style or "바탕글"):
            parts.append(style)
        look = self.char_look(char_pr_id)
        if body_size is None or abs(look.size - body_size) > 0.01:
            parts.append(f"{look.size:g}pt")
        if look.bold:
            parts.append("굵게")
        if look.italic:
            parts.append("기울임")
        if look.underline:
            parts.append("밑줄")
        if look.strike:
            parts.append("취소선")
        if look.color.upper() not in ("#000000", "NONE"):
            parts.append(f"색 {look.color}")
        align = ALIGN_NAMES.get(self.para_look(para_pr_id).align)
        if align:
            parts.append(align)
        return f"({', '.join(parts)})" if parts else ""
