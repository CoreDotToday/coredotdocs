"""DOCX 저장 충실도 — "안 바뀐 본문 요소는 원본 바이트 그대로" (설계 문서 04 §12.2 D1).

lxml로 나무 전체를 다시 직렬화하면 손대지 않은 문단까지 바이트가 바뀐다(속성 따옴표·네임스페이스 선언·빈 요소 표기·
`xml:space`가 없는 공백 처리 등). Word·한컴은 대개 그대로 열지만 변경 추적·주석·비교 도구에는 "문서 전체가 바뀐" 것으로 보인다.

규칙(동작 기준; 코드는 우리 것):
1. 읽을 때 `word/document.xml` 원본 바이트에서 `w:body`의 **맨 위 자식**(문단·표·sdt·sectPr·주석 등)마다 바이트 범위를 재고,
   lxml 자식마다 직렬화 지문(해시)을 남긴다.
2. 저장할 때 본문 자식을 차례로 보며 — 읽을 때 있었고 지문이 그대로면 **원본 바이트 범위를 그대로 잇고**, 바뀌었거나 새로
   넣은 것만 lxml로 직렬화한다(루트가 이미 선언한 네임스페이스는 되풀이 선언하지 않는다). 지운 것은 빠진다.
3. 바뀐 문단도 나무 편집이라 손대지 않은 자식(pPr·rsid·책갈피·주석 범위)은 그대로다 — 상위 편집기 엔진이 `rawPPr`를 따로 보존하는
   것과 같은 효과.
4. 다른 부분(`styles.xml`·`.rels`·`[Content_Types].xml`)도 지문이 같으면 원본 바이트, zip 항목은 원래 순서·압축 방식·시각을 지킨다.
   (압축 바이트를 그대로 잇는 무재압축 복사는 하지 않는다 — 내용은 같고 압축 결과만 다를 수 있다.)

원본 바이트 범위와 lxml 자식이 하나라도 어긋나면(주석·PI가 섞인 드문 문서) 이 파일의 보조는 꺼지고 예전처럼 전체를 다시 직렬화한다.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from lxml import etree

# 시작·끝 태그(속성 안의 따옴표 속 `>`를 넘긴다), 주석, CDATA, 처리 명령
_TOKEN = re.compile(rb"<(?:(?P<comment>!--.*?--)|(?P<cdata>!\[CDATA\[.*?\]\])|(?P<pi>\?.*?\?)|(?P<close>/)?(?P<name>[A-Za-z_][\w.\-:]*)(?P<attrs>(?:[^>\"']|\"[^\"]*\"|'[^']*')*))>", re.S)


@dataclass(frozen=True)
class Span:
    start: int  # 앞 요소 끝(사이 공백 포함)부터
    end: int
    kind: str  # 'element' | 'comment' | 'pi' | 'cdata'
    name: str  # element의 로컬 이름


@dataclass
class BodyScan:
    prefix: bytes  # `<w:body ...>`까지
    spans: list[Span]
    suffix: bytes  # `</w:body>`부터 끝까지


def scan_body(xml: bytes, body_tag: bytes) -> BodyScan | None:
    """`word/document.xml` 원본 바이트에서 body의 맨 위 자식 범위를 잰다. 못 재면 None."""
    body_open = re.compile(rb"<" + re.escape(body_tag) + rb"(?:\s(?:[^>\"']|\"[^\"]*\"|'[^']*')*)?>")
    m = body_open.search(xml)
    if m is None or m.group(0).endswith(b"/>"):
        return None
    pos = m.end()
    prefix = xml[:pos]
    spans: list[Span] = []
    depth = 0
    item_start = pos
    item_name = ""
    last_end = pos
    for t in _TOKEN.finditer(xml, pos):
        if t.group("comment") is not None or t.group("cdata") is not None or t.group("pi") is not None:
            if depth == 0:
                kind = "comment" if t.group("comment") is not None else ("cdata" if t.group("cdata") is not None else "pi")
                spans.append(Span(last_end, t.end(), kind, ""))
                last_end = t.end()
            continue
        name = t.group("name")
        if t.group("close"):
            if depth == 0:
                if name != body_tag:
                    return None
                return BodyScan(prefix, spans, xml[last_end:])
            depth -= 1
            if depth == 0:
                spans.append(Span(last_end, t.end(), "element", item_name))
                last_end = t.end()
            continue
        self_closing = t.group("attrs").rstrip().endswith(b"/")
        if depth == 0:
            item_start = t.start()
            item_name = name.split(b":")[-1].decode()
            if self_closing:
                spans.append(Span(last_end, t.end(), "element", item_name))
                last_end = t.end()
                continue
        if not self_closing:
            depth += 1
    return None


def digest(el: etree._Element) -> bytes:
    return hashlib.blake2b(etree.tostring(el, with_tail=False, encoding="utf-8"), digest_size=16).digest()


def _kind_of(child: etree._Element) -> tuple[str, str]:
    if isinstance(child, etree._Comment):
        return "comment", ""
    if isinstance(child, etree._ProcessingInstruction):
        return "pi", ""
    if not isinstance(child.tag, str):
        return "other", ""
    return "element", etree.QName(child).localname


class BodyPatcher:
    """읽을 때 한 번 만들고, 저장할 때 `render`로 document.xml 바이트를 짓는다."""

    def __init__(self, xml: bytes, body: etree._Element):
        self.xml = xml
        self.body = body
        self.last: dict[str, int | bool] = {}
        root = body.getroottree().getroot()
        self.root_ns = [(p, u) for p, u in root.nsmap.items()]
        tag = (body.prefix + ":" if body.prefix else "") + "body"
        self.scan = scan_body(xml, tag.encode())
        self.original: dict[int, tuple[int, bytes]] = {}  # id(자식) → (범위 번호, 지문)
        self._keep = list(body)  # 프록시를 살려 두어 id가 안정되게
        if self.scan is None or len(self.scan.spans) != len(self._keep):
            self.scan = None
            return
        for i, (span, child) in enumerate(zip(self.scan.spans, self._keep)):
            kind, name = _kind_of(child)
            if kind != span.kind or (kind == "element" and name != span.name):
                self.scan = None
                self.original = {}
                return
            self.original[id(child)] = (i, digest(child))
        self.last: dict[str, int | bool] = {}

    @property
    def enabled(self) -> bool:
        return self.scan is not None

    def serialize_child(self, child: etree._Element) -> bytes:
        """바뀐·새 자식 하나를 직렬화한다. 루트에 이미 있는 네임스페이스 선언은 뺀다."""
        data = etree.tostring(child, with_tail=False, encoding="utf-8")  # 꼬리 공백은 원본 범위가 품는다; UTF-8 그대로(문자 참조 없이)
        if not isinstance(child.tag, str):
            return data
        gt = data.find(b">")
        head, tail = data[: gt + 1], data[gt + 1 :]
        for prefix, uri in self.root_ns:
            decl = (b' xmlns:%s="%s"' % (prefix.encode(), uri.encode())) if prefix else (b' xmlns="%s"' % uri.encode())
            head = head.replace(decl, b"", 1)
        return head + tail

    def render(self) -> bytes | None:
        """현재 나무로 document.xml 바이트. 보조가 꺼져 있으면 None (호출자가 전체 직렬화)."""
        if self.scan is None:
            return None
        out = [self.scan.prefix]
        kept = rewritten = added = 0
        for child in self.body:
            orig = self.original.get(id(child))
            if orig is not None and digest(child) == orig[1]:
                span = self.scan.spans[orig[0]]
                out.append(self.xml[span.start : span.end])
                kept += 1
            else:
                out.append(self.serialize_child(child))
                if orig is None:
                    added += 1
                else:
                    rewritten += 1
        out.append(self.scan.suffix)
        self.last = {"kept": kept, "rewritten": rewritten, "added": added}
        return b"".join(out)
