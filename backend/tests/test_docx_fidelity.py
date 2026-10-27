"""DOCX 저장 충실도(D1): 안 바뀐 본문 요소·부분은 원본 바이트 그대로, zip 항목은 순서·압축 방식·시각 보존."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path

import pytest
from lxml import etree

from app.engine import commands
from app.engine.docx import DocxDocument, w
from app.engine.docx_fidelity import scan_body
from tests.test_docx import make_docx

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def entries(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


def body_spans(xml: bytes) -> list[bytes]:
    scan = scan_body(xml, b"w:body")
    assert scan is not None
    return [xml[s.start : s.end] for s in scan.spans]


def hand_made_docx() -> bytes:
    """Word가 아닌 손으로 쓴 문서: 공백·작은따옴표 속성·속성 안 `>`·주석 — 스캐너가 넘어야 할 것들."""
    base = entries(make_docx())
    base["word/document.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        f'<w:document xmlns:w="{W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">'
        "<w:body>\n"
        "  <w:p w14:paraId='0A1B' w:rsidR=\"00AA\"><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t xml:space=\"preserve\">첫 문단 a > b </w:t></w:r></w:p>\n"
        "  <!-- 손으로 단 주석 -->\n"
        "  <w:p/>\n"
        '  <w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\n'
        "  <w:p><w:r><w:t>셋째</w:t></w:r></w:p>\n"
        '  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>\n'
        "</w:body></w:document>"
    ).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in base.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_scanner_spans_match_lxml_children():
    xml = entries(hand_made_docx())["word/document.xml"]
    spans = body_spans(xml)
    kinds = [s.kind for s in scan_body(xml, b"w:body").spans]
    assert kinds == ["element", "comment", "element", "element", "element", "element"]
    assert spans[0].strip().startswith(b"<w:p w14:paraId='0A1B'") and spans[0].strip().endswith(b"</w:p>")
    assert spans[2].strip() == b"<w:p/>"
    assert spans[3].strip().startswith(b"<w:tbl>") and spans[3].strip().endswith(b"</w:tbl>")


def test_untouched_roundtrip_is_byte_identical():
    src = make_docx()
    doc = DocxDocument.load(src)
    out = doc.to_bytes()
    assert doc.last_save == {"fallback": False, "kept": 6, "rewritten": 0, "added": 0, "parts": []}
    a, b = entries(src), entries(out)
    assert list(a) == list(b), "zip 항목 순서"
    assert a == b, "모든 항목 바이트가 같다"
    with zipfile.ZipFile(io.BytesIO(src)) as zs, zipfile.ZipFile(io.BytesIO(out)) as zo:
        for i, j in zip(zs.infolist(), zo.infolist()):
            assert (i.filename, i.compress_type, i.date_time) == (j.filename, j.compress_type, j.date_time)


def test_edit_one_paragraph_keeps_other_elements_bytes():
    src = make_docx()
    doc = DocxDocument.load(src)
    commands.replace_text(doc, "hello", "world")
    out = doc.to_bytes()
    assert doc.last_save["kept"] == 5 and doc.last_save["rewritten"] == 1 and doc.last_save["added"] == 0
    before, after = body_spans(entries(src)["word/document.xml"]), body_spans(entries(out)["word/document.xml"])
    assert len(before) == len(after) == 6
    assert [i for i in range(6) if before[i] != after[i]] == [1]
    assert b"world" in after[1] and b"xmlns:w=" not in after[1], "바뀐 문단에 루트 네임스페이스를 되풀이 선언하지 않는다"
    assert entries(src)["word/styles.xml"] == entries(out)["word/styles.xml"]
    # 다시 읽히고, 글이 맞다
    again = DocxDocument.load(out)
    assert again.block(2).text() == "이 문서는 관측용 샘플입니다 world"


def test_insert_and_delete_keep_neighbors():
    src = make_docx()
    doc = DocxDocument.load(src)
    commands.insert_content(doc, "새 문단", after=2)
    commands.delete_blocks(doc, 6, 6)  # 원래 5번(빈 문단)이 6번이 됨 → 지운다
    out = doc.to_bytes()
    assert doc.last_save["added"] == 1 and doc.last_save["rewritten"] == 0
    before, after = body_spans(entries(src)["word/document.xml"]), body_spans(entries(out)["word/document.xml"])
    # 앞: [제목, 본문, 표, 누름틀, 빈, sectPr] → 뒤: [제목, 본문, 새, 표, 누름틀, sectPr]
    assert after[0] == before[0] and after[1] == before[1] and after[3] == before[2] and after[4] == before[3] and after[5] == before[5]
    assert after[2].startswith(b"<w:p>") and "새 문단".encode() in after[2]
    assert len(after) == 6


def test_hand_made_document_with_comment_and_whitespace():
    src = hand_made_docx()
    doc = DocxDocument.load(src)
    assert doc._patcher.enabled
    commands.set_paragraph(doc, 4, "셋째 고침")
    out = doc.to_bytes()
    assert doc.last_save["rewritten"] == 1 and doc.last_save["kept"] == 5
    xml = entries(out)["word/document.xml"]
    assert "<!-- 손으로 단 주석 -->".encode() in xml
    assert b"<w:p w14:paraId='0A1B' w:rsidR=\"00AA\">" in xml, "안 바뀐 문단은 작은따옴표 속성까지 그대로"
    assert '<w:t xml:space="preserve">첫 문단 a > b </w:t>'.encode() in xml
    etree.fromstring(xml)  # 여전히 올바른 XML
    assert DocxDocument.load(out).block(4).text() == "셋째 고침"


def test_styles_rewritten_only_when_touched():
    doc = DocxDocument.load(make_docx())
    commands.insert_content(doc, "### 셋째 수준", after=1)  # Heading3 스타일을 새로 만든다
    doc.to_bytes()
    assert doc.last_save["parts"] == ["word/styles.xml"]


def test_fallback_when_body_is_self_closing_or_unscannable():
    base = entries(make_docx())
    base["word/document.xml"] = b'<?xml version="1.0"?><w:document xmlns:w="' + W.encode() + b'"><w:body/></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, d in base.items():
            zf.writestr(n, d)
    doc = DocxDocument.load(buf.getvalue())
    assert not doc._patcher.enabled
    commands.insert_content(doc, "글", after=None)
    out = doc.to_bytes()
    assert doc.last_save["fallback"] is True
    assert DocxDocument.load(out).block(1).text() == "글"


# 실제 Word 문서(저장소 밖): CDD_DOCX_SAMPLES=디렉터리 로 지정하면 돈다
_SAMPLES = [p for d in [os.environ.get("CDD_DOCX_SAMPLES")] if d for p in sorted(Path(d).glob("*.docx"))]


@pytest.mark.parametrize("path", _SAMPLES, ids=[p.name[:30] for p in _SAMPLES])
def test_real_documents_roundtrip(path: Path):
    src = path.read_bytes()
    doc = DocxDocument.load(src)
    assert doc._patcher.enabled, "Word 문서는 스캔되어야 한다"
    out = doc.to_bytes()
    assert doc.last_save["rewritten"] == 0 and doc.last_save["added"] == 0
    a, b = entries(src), entries(out)
    assert a == b and list(a) == list(b)
    # 문단 하나 고치면 나머지 본문 요소는 그대로
    first = next(blk for blk in doc.blocks() if blk.kind == "paragraph" and blk.text().strip())
    commands.set_paragraph(doc, first.no, first.text() + " (고침)")
    out2 = doc.to_bytes()
    assert doc.last_save["rewritten"] == 1
    before, after = body_spans(a["word/document.xml"]), body_spans(entries(out2)["word/document.xml"])
    assert sum(1 for x, y in zip(before, after) if x != y) == 1 and len(before) == len(after)
    import docx  # python-docx로 열린다

    docx.Document(io.BytesIO(out2))


def test_block_index_matches_editor_engine_numbering():
    """서버 블록의 index = 편집기 엔진 docxIndex: 문단·표 둘 이상인 콘텐츠 컨트롤은 부분마다 번호 하나(안쪽 컨트롤은 투명)."""
    base = entries(make_docx())
    base["word/document.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>'
        "<w:p><w:r><w:t>앞</w:t></w:r></w:p>"
        "<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>차례1</w:t></w:r></w:p>"
        "<w:sdt><w:sdtContent><w:p><w:r><w:t>안쪽</w:t></w:r></w:p></w:sdtContent></w:sdt>"
        "<w:p><w:r><w:t>차례3</w:t></w:r></w:p></w:sdtContent></w:sdt>"
        "<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:t>하나뿐</w:t></w:r></w:p></w:sdtContent></w:sdt>"
        "<w:p><w:r><w:t>뒤</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"
    ).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, d in base.items():
            zf.writestr(n, d)
    doc = DocxDocument.load(buf.getvalue())
    got = [(b.text(), b.index) for b in doc.blocks()]
    # 앞=0, 차례 컨트롤 부분 3개(차례1=1, 안쪽=2, 차례3=3), 하나뿐 컨트롤=4, 뒤=5
    assert got == [("앞", 0), ("차례1", 1), ("차례3", 3), ("하나뿐", 4), ("뒤", 5)]
