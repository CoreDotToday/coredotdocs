"""DOCX 엔진: HWPX와 같은 명령 층을 통과하는지."""

from __future__ import annotations

import io
import zipfile

import pytest

from app.engine import commands
from app.engine.docx import DocxDocument, create_blank, w
from app.engine.errors import CommandError
from app.engine.loader import detect_format, load_document
from tests.test_commands_full import png

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def make_docx() -> bytes:
    """제목(굵게 16pt) / 본문 hello / 2×2 표(머리 행) / 콘텍스트 컨트롤 문단 / 빈 문단 — 자체 생성."""
    doc = create_blank("t")
    body = doc.body
    sect = body.find(w("sectPr"))
    body.remove(body.find(w("p")))
    xml = f'''<w:body xmlns:w="{W}">
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>AI 편집 샘플</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">이 문서는 관측용 샘플입니다 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>hello</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>
<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>구분</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>내용</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>가</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>나</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t xml:space="preserve">성명: </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="이름"/><w:tag w:val="name"/><w:text/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:t>여기에 입력</w:t></w:r></w:sdtContent></w:sdt></w:p>
<w:p/></w:body>'''
    from lxml import etree

    new_body = etree.fromstring(xml)
    for child in list(new_body):
        body.insert(body.index(sect), child)
    doc._ensure_heading_style(1)
    return doc.to_bytes()


@pytest.fixture
def docx_bytes() -> bytes:
    return make_docx()


def load(data):
    return DocxDocument.load(data)


def test_detect_and_load(docx_bytes, sample_hwpx):
    assert detect_format(docx_bytes, "x.docx") == "docx" and detect_format(sample_hwpx) == "hwpx"
    assert load_document(docx_bytes).format == "docx"


def test_blocks_and_read(docx_bytes):
    doc = load(docx_bytes)
    assert [b.kind for b in doc.blocks()] == ["paragraph", "paragraph", "table", "paragraph", "paragraph"]
    text, _, _ = commands.read_document(doc)
    lines = text.split("\n")
    assert lines[0] == "[1] (heading 1, 16pt, 굵게) AI 편집 샘플"
    assert lines[1] == "[2] 이 문서는 관측용 샘플입니다 hello"
    assert lines[2] == "[3] 표 1 (2행 × 2열)" and lines[3].strip() == "(1,1) 구분 | (1,2) 내용"
    assert lines[5] == "[4] 성명: 여기에 입력" and lines[6] == "[5] (빈 문단)"


def test_find_and_replace_across_runs_keeps_italic_run(docx_bytes):
    doc = load(docx_bytes)
    assert commands.find(doc, "HELLO").startswith("[2] …")
    commands.replace_text(doc, "샘플입니다 hello", "샘플 world")
    p = doc.block(2).paragraph
    runs = p.findall(w("r"))
    assert doc.block(2).text() == "이 문서는 관측용 샘플 world"
    assert runs[1].find(w("rPr") + "/" + w("i")) is not None and runs[1].find(w("t")).text == ""


def test_table_cells_rows_and_format(docx_bytes):
    doc = load(docx_bytes)
    commands.set_table_cells(doc, 1, [{"row": 2, "col": 2, "text": "다\n라", "format": {"bold": True, "align": "center", "vertical_align": "center"}}], overwrite=True)
    grid = doc.ops.table_grid(doc.table(1)[1])
    assert grid.cell_at(1, 1).text == "다\n라"
    fmt = doc.ops.cell_format(doc, grid.cell_at(1, 1).element)
    assert fmt["align"] == "CENTER" and fmt["vertical_align"] == "CENTER"
    commands.insert_table_rows(doc, 1, after_row=2, rows=[["마", "바"]])
    assert doc.ops.table_grid(doc.table(1)[1]).rows == 3
    commands.delete_table_rows(doc, 1, 1)
    grid = doc.ops.table_grid(doc.table(1)[1])
    assert grid.rows == 2 and grid.cell_at(0, 0).text == "가"


def test_vertical_merge_grid():
    doc = create_blank("t")
    from lxml import etree

    tbl = etree.fromstring(f'<w:tbl xmlns:w="{W}"><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    doc.body.insert(0, tbl)
    grid = doc.ops.table_grid(tbl)
    assert grid.cell_at(1, 0).text == "a" and grid.cell_at(0, 0).row_span == 2 and grid.cell_at(1, 1).text == "c"
    with pytest.raises(CommandError):
        commands.insert_table_rows(doc, 1, after_row=1, count=1)


def test_insert_content_headings_table_and_format(docx_bytes):
    doc = load(docx_bytes)
    r = commands.insert_content(doc, "## 소제목\n\n- 항목\n\n| a | b |\n|---|---|\n| 1 | 2 |", after=2)
    assert [doc.block(n).kind for n in r.blocks] == ["paragraph", "paragraph", "table"]
    assert "(heading 2, 14pt, 굵게)" in doc.describe_paragraph(doc.block(r.blocks[0]).paragraph)
    commands.format_text(doc, "hello", bold=True, color="#C00000", size=14, underline=True)
    rpr = [x for x in doc.block(2).paragraph.findall(w("r")) if x.find(w("t")).text == "hello"][0].find(w("rPr"))
    assert rpr.find(w("b")) is not None and rpr.find(w("color")).get(w("val")) == "C00000" and rpr.find(w("sz")).get(w("val")) == "28"
    commands.format_paragraphs(doc, 2, align="center", line_spacing=150, left=10, indent=-5, space_after=6)
    ppr = doc.block(2).paragraph.find(w("pPr"))
    assert ppr.find(w("jc")).get(w("val")) == "center"
    assert ppr.find(w("spacing")).get(w("line")) == "360" and ppr.find(w("spacing")).get(w("after")) == "120"
    assert ppr.find(w("ind")).get(w("left")) == "200" and ppr.find(w("ind")).get(w("hanging")) == "100"


def test_fields_list_and_fill(docx_bytes):
    doc = load(docx_bytes)
    listing = commands.list_fields(doc)
    assert listing.startswith("#1 [4] 이름 '이름' 안내 'name' = (비었음)")
    commands.fill_fields(doc, {"이름": "홍길동"})
    assert doc.block(4).text() == "성명: 홍길동"
    again = load(doc.to_bytes())
    assert again.fields()[0].text == "홍길동"


def test_insert_image_adds_media_rel_and_content_type(docx_bytes):
    doc = load(docx_bytes)
    r = commands.insert_image(doc, png(20, 10), after=2, width_mm=40)
    out = doc.to_bytes()
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        names = zf.namelist()
        assert "word/media/image1.png" in names
        assert b'Extension="png"' in zf.read("[Content_Types].xml")
        assert b"media/image1.png" in zf.read("word/_rels/document.xml.rels")
    again = load(out)
    assert again.picture_count() == 1
    ext = again.block(r.blocks[0]).paragraph.find(".//{%s}extent" % "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing")
    assert int(ext.get("cx")) == round(40 / 25.4 * 914400) and int(ext.get("cy")) == round(40 / 25.4 * 914400) // 2


def test_delete_blocks_keeps_sectpr_last(docx_bytes):
    doc = load(docx_bytes)
    with pytest.raises(CommandError) as e:
        commands.delete_blocks(doc, 1, 5)  # 표가 든 범위는 include_objects 없이 지우지 않는다
    assert e.value.code == "HOLDS_OBJECT"
    commands.delete_blocks(doc, 1, 5, include_objects=True)
    assert etree_local(doc.body[-1]) == "sectPr" and len(doc.blocks()) == 1


def etree_local(el):
    from lxml import etree

    return etree.QName(el).localname


def test_create_blank_docx_roundtrip():
    doc = create_blank("보고서")
    commands.insert_content(doc, "# 보고서\n\n본문 **강조**\n\n| a |\n|---|\n| 1 |")
    again = load_document(doc.to_bytes(), "x.docx")
    text, _, _ = commands.read_document(again)
    assert "[2] (heading 1, 16pt, 굵게) 보고서" in text and "표 1 (2행 × 1열)" in text
    info = commands.document_info(again)
    assert "용지 A4 세로 (210×297mm)" in info and "표 1개" in info


def test_format_paragraphs_whole_document_font_docx(docx_bytes):
    doc = load(docx_bytes)
    r = commands.format_paragraphs(doc, None, None, True, font="A2Z", color="#112233")
    assert "문서 전체" in r.text
    fonts = {rf.get(w("eastAsia")) for rf in doc.block(2).paragraph.iter(w("rFonts"))}
    assert fonts == {"A2Z"}
    # 표 칸 안 run도
    tbl = next(b for b in doc.blocks() if b.kind == "table").table
    cell_fonts = {rf.get(w("ascii")) for rf in tbl.iter(w("rFonts"))}
    assert cell_fonts == {"A2Z"}
    # 문단 끝 표시(w:pPr/w:rPr)도 바뀐다: 빈 문단의 줄 높이와 그 자리에 새로 치는 글의 모양이 따라온다 (관측: 실제 문서에서 423곳이 남았었음)
    empty = [b for b in doc.blocks() if b.kind == "paragraph" and not b.text()]
    assert empty and all(b.paragraph.find(w("pPr") + "/" + w("rPr") + "/" + w("rFonts")).get(w("eastAsia")) == "A2Z" for b in empty)
    assert all(rf.get(w("eastAsia")) == "A2Z" for b in doc.blocks() if b.kind == "paragraph" for rf in b.paragraph.iter(w("rFonts")))
    # 범위 지정도 그대로 동작하고, 문단 모양과 글자 모양을 함께 준다
    r2 = commands.format_paragraphs(doc, 2, 2, align="center", size=12)
    assert "문단 1개의 모양과 글 1곳의 글자 모양" in r2.text
