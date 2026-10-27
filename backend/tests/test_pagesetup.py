"""쪽 설정(용지·방향·여백): 두 형식의 읽기·쓰기, 도구·API, DOCX 바이트 보존."""

from __future__ import annotations

import io
import zipfile

import pytest
from lxml import etree

from app.engine import blank, commands
from app.engine.docx import DocxDocument, w
from app.engine.errors import CommandError
from app.engine.hwpx import q
from app.engine.loader import load_document
from tests.test_docx import make_docx

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def test_hwpx_margins_and_landscape_are_written_like_hancom():
    doc = blank.create_blank("t")
    before = doc.page_setups()[0]
    assert (before.paper, before.landscape, before.left) == ("A4", False, 30.0)
    r = commands.set_page_setup(doc, {"orientation": "landscape", "margins_mm": {"top": 15, "left": 20}, "header_mm": 12})
    assert "A4 가로 (297×210mm)" in r.text and "위 15" in r.text and "왼쪽 20" in r.text and "머리말 12" in r.text
    again = load_document(doc.to_bytes(), "t.hwpx")
    page = again._roots()[0].find(".//" + q("hp:pagePr"))
    # 한글: 너비·높이는 세로 값, 가로는 landscape="NARROWLY"
    assert int(page.get("width")) < int(page.get("height")) and page.get("landscape") == "NARROWLY"
    s = again.page_setups()[0]
    assert (s.width, s.height, s.landscape, s.top, s.left, s.right, s.header) == (297.0, 210.0, True, 15.0, 20.0, 30.0, 12.0)
    commands.set_page_setup(again, {"orientation": "portrait"})
    assert again.page_setups()[0].landscape is False and again._roots()[0].find(".//" + q("hp:pagePr")).get("landscape") == "WIDELY"


def test_docx_page_setup_keeps_other_bytes_and_all_sections():
    src = make_docx()
    doc = DocxDocument.load(src)
    # 구역 두 개: 첫 문단 끝에 구역 나눔(문단 안 sectPr)
    first = doc.body.find(w("p"))
    ppr = first.find(w("pPr"))
    ppr.append(etree.fromstring(f'<w:sectPr xmlns:w="{W}"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1701" w:bottom="850" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>'))
    doc = DocxDocument.load(doc.to_bytes())
    assert len(doc.page_setups()) == 2
    commands.set_page_setup(doc, {"paper": "Letter", "margins_mm": {"left": 15, "right": 15}})
    out = doc.to_bytes()
    again = DocxDocument.load(out)
    for s in again.page_setups():
        assert (s.paper, s.left, s.right) == ("Letter", 15.0, 15.0)
    # 한 구역만
    commands.set_page_setup(again, {"orientation": "landscape"}, section=2)
    a, b = again.page_setups()
    assert (a.landscape, b.landscape) == (False, True) and b.width > b.height
    sect = again._sect_prs()[1]
    assert sect.find(w("pgSz")).get(w("orient")) == "landscape"
    # 쪽 설정만 바꾸면 다른 부분·다른 본문 요소는 그대로다
    with zipfile.ZipFile(io.BytesIO(out)) as z1, zipfile.ZipFile(io.BytesIO(DocxDocument.load(out).to_bytes())) as z2:
        assert z1.read("word/styles.xml") == z2.read("word/styles.xml")


def test_page_setup_guards():
    doc = DocxDocument.load(make_docx())
    with pytest.raises(CommandError) as e:
        commands.set_page_setup(doc, {"margins_mm": {"left": 120, "right": 100}})
    assert e.value.code == "OUT_OF_RANGE"
    with pytest.raises(CommandError):
        commands.set_page_setup(doc, {})
    with pytest.raises(CommandError) as e:
        commands.set_page_setup(doc, {"paper": "A4"}, section=9)
    assert e.value.code == "OUT_OF_RANGE"
    assert "쪽 설정: 용지 A4 세로" in commands.document_info(doc)


@pytest.mark.db
def test_page_setup_tool_and_endpoint(client_with_doc):
    client, doc_id = client_with_doc
    r = client.get(f"/api/documents/{doc_id}/page-setup").json()
    seq = r["revision_seq"]
    assert r["sections"][0]["paper"] == "A4" and r["sections"][0]["orientation"] == "portrait"
    res = client.post("/api/tools/set_page_setup", json={"arguments": {"document_id": doc_id, "margins_mm": {"top": 12.5, "bottom": 12.5}, "orientation": "landscape"}}).json()
    assert not res.get("isError"), res
    assert "리비전" in res["content"][0]["text"]
    r = client.get(f"/api/documents/{doc_id}/page-setup").json()
    s = r["sections"][0]
    assert r["revision_seq"] == seq + 1 and s["orientation"] == "landscape" and s["margins_mm"]["top"] == 12.5 and s["width_mm"] > s["height_mm"]
    bad = client.post("/api/tools/set_page_setup", json={"arguments": {"document_id": doc_id, "paper": "A0"}}).json()
    assert bad["isError"]
