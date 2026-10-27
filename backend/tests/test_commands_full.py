"""2차 범위: 서식·표 행·새 표·그림·누름틀·새 문서·읽기 확장."""

from __future__ import annotations

import io
import struct
import zipfile
import zlib

import pytest

from app.engine import commands
from app.engine.blank import create_blank
from app.engine.errors import CommandError
from app.engine.hwpx import HwpxDocument, first_char_pr, q
from tests.conftest import build_hwpx, paragraph, table


def load(data):
    return HwpxDocument.load(data)


def png(width: int = 16, height: int = 8) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# ── 읽기 확장 ────────────────────────────────────────────────────────────


def test_read_shows_style_summary_and_groups_empty_paragraphs():
    doc = create_blank("t")
    commands.insert_content(doc, "# 큰 제목\n\n본문\n\n**굵은 문단**")
    doc.insert_paragraphs(["", "", "", ""], after=None)
    text, _, _ = commands.read_document(doc)
    lines = text.split("\n")
    assert lines[1].startswith("[2] (16pt, 굵게) 큰 제목")
    assert lines[2] == "[3] 본문"
    assert lines[3] == "[4] (굵게) 굵은 문단"
    assert any(line.startswith("[5~8] (빈 문단 4개)") for line in lines)


def test_read_table_full_with_format_and_rows(sample_hwpx):
    text, _, _ = commands.read_document(load(sample_hwpx), table=1, include_format=True, row_from=2, row_to=2)
    assert text.startswith("표 1 (2행 × 2열)")
    assert "(2,1) [10pt, 정렬 justify, 세로 center]" in text and "가" in text and "구분" not in text


def test_read_offset_paging(sample_hwpx):
    full, _, _ = commands.read_document(load(sample_hwpx))
    first, _, next_offset = commands.read_document(load(sample_hwpx), offset=0, max_chars=300)
    assert next_offset is None and first == full
    with pytest.raises(CommandError):
        commands.read_document(load(sample_hwpx), offset=10**6)


def test_document_info_reports_page_and_styles(sample_hwpx):
    info = commands.document_info(load(sample_hwpx))
    assert "용지 A4 세로 (210×297mm)" in info and "그림 0개" in info and "바탕글" in info


# ── 서식 ────────────────────────────────────────────────────────────────


def test_format_text_splits_runs_and_registers_char_pr(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.format_text(doc, "hello", bold=True, color="#C00000", size=14)
    assert r.blocks == [3]
    p = doc.block(3).paragraph
    runs = p.findall(q("hp:run"))
    assert [doc.ops.paragraph_text(x) if False else "".join(t.text or "" for t in x.findall(q("hp:t"))) for x in runs] == ["이 문서는 관측용 샘플입니다 ", "hello"]
    look = doc.header.char_look(runs[1].get("charPrIDRef"))
    assert look.bold and look.color == "#C00000" and look.size == 14
    assert "(14pt, 굵게" not in doc.describe_paragraph(p)  # 첫 run은 그대로
    # 같은 서식을 다시 주면 같은 id를 재사용한다
    before = doc.header.style_count()
    doc.header.ensure_char_pr(runs[0].get("charPrIDRef"), bold=True, color="#C00000", size=14)
    assert doc.header.style_count() == before


def test_format_text_requires_a_change_and_unique_match(sample_hwpx):
    with pytest.raises(CommandError):
        commands.format_text(load(sample_hwpx), "hello")
    with pytest.raises(CommandError) as e:
        commands.format_text(load(sample_hwpx), "샘플", bold=True)
    assert "2곳" in str(e.value)


def test_format_paragraphs_writes_bounded_units(sample_hwpx):
    doc = load(sample_hwpx)
    commands.format_paragraphs(doc, 3, align="center", line_spacing=180, left=20, indent=-10, space_before=6, page_break=True)
    p = doc.block(3).paragraph
    look = doc.header.para_look(p.get("paraPrIDRef"))
    assert (look.align, look.line_spacing, look.left, look.indent, look.prev, look.page_break_before) == ("CENTER", 180, 2000, -1000, 600, True)
    assert p.get("pageBreak") == "1"
    assert "가운데" in doc.describe_paragraph(p)


def test_format_cells_and_format_table(sample_hwpx):
    doc = load(sample_hwpx)
    commands.set_table_cells(doc, 1, [{"row": 1, "col": 1, "format": {"bold": True, "align": "center", "padding_mm": {"left": 3}}}])
    cell = doc.ops.table_grid(doc.table(1)[1]).cell_at(0, 0)
    assert cell.element.get("hasMargin") == "1" and cell.element.find(q("hp:cellMargin")).get("left") == "850"
    assert doc.ops.cell_format(doc, cell.element)["align"] == "CENTER"
    commands.format_table(doc, 1, {"size": 12, "vertical_align": "top"})
    for c in doc.ops.table_grid(doc.table(1)[1]).cells:
        assert doc.ops.cell_format(doc, c.element)["size"] == 12 and doc.ops.cell_format(doc, c.element)["vertical_align"] == "TOP"


# ── 표 행·새 표 ─────────────────────────────────────────────────────────


def test_insert_and_delete_table_rows(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.insert_table_rows(doc, 1, after_row=2, rows=[["다", "라"], ["마"]])
    assert "행 2개" in r.text
    grid = doc.ops.table_grid(doc.table(1)[1])
    assert grid.rows == 4 and grid.cell_at(2, 0).text == "다" and grid.cell_at(3, 1).text == ""
    assert doc.table(1)[1].get("rowCnt") == "4"
    assert [c.row for c in grid.cells] == [0, 0, 1, 1, 2, 2, 3, 3]
    r = commands.insert_table_rows(doc, 1, after_row=0, count=1)
    assert doc.ops.table_grid(doc.table(1)[1]).cell_at(0, 0).text == ""
    r = commands.delete_table_rows(doc, 1, 1, 3)
    assert "행 3개" in r.text and doc.ops.table_grid(doc.table(1)[1]).rows == 2
    with pytest.raises(CommandError):
        commands.delete_table_rows(doc, 1, 1, 2)  # 모든 행
    with pytest.raises(CommandError):
        commands.insert_table_rows(doc, 1, rows=[["a", "b", "c"]])  # 열 초과


def test_insert_table_rows_limits(sample_hwpx):
    with pytest.raises(CommandError):
        commands.insert_table_rows(load(sample_hwpx), 1, count=1001)


def test_merged_rows_block_insertion(merged_table_hwpx):
    body = table([["a", "b"], [None, "c"]], spans={(0, 0): (2, 1)})
    doc = load(build_hwpx(body))
    with pytest.raises(CommandError) as e:
        commands.insert_table_rows(doc, 1, after_row=1, count=1)
    assert "합친 칸" in str(e.value)


def test_insert_table_builds_valid_table(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.insert_table(doc, [["구분", "**값**"], ["a", "1"], ["b"]], after=3)
    assert r.blocks == [4] and "표 1" in r.text  # 새 표가 문서 순서상 첫 표
    block, tbl, _ = doc.table(1)
    grid = doc.ops.table_grid(tbl)
    assert (grid.rows, grid.cols) == (3, 2) and grid.cell_at(0, 1).text == "값" and grid.cell_at(2, 1).text == ""
    assert tbl.get("borderFillIDRef") != "1"
    again = load(doc.to_bytes())
    assert len(again.tables()) == 2


def test_insert_content_with_markdown_table_and_pagebreak(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.insert_content(doc, "소제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- pagebreak -->\n다음 쪽", after=3)
    kinds = [doc.block(n).kind for n in r.blocks]
    assert kinds == ["paragraph", "table", "paragraph"]
    assert doc.block(r.blocks[2]).paragraph.get("pageBreak") == "1"


# ── 그림 ────────────────────────────────────────────────────────────────


def test_insert_image_adds_bindata_and_manifest(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.insert_image(doc, png(16, 8), after=3, width_mm=50)
    assert "16×8px" in r.text
    out = doc.to_bytes()
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        assert "Contents/BinData/image1.png" in zf.namelist()
        hpf = zf.read("Contents/content.hpf").decode()
        assert 'href="BinData/image1.png"' in hpf and 'media-type="image/png"' in hpf
    again = load(out)
    assert again.picture_count() == 1
    pic = again.block(r.blocks[0]).paragraph.find(".//" + q("hp:pic"))
    sz = pic.find(q("hp:sz"))
    assert int(sz.get("width")) == round(50 * 7200 / 25.4) and int(sz.get("height")) == round(50 * 7200 / 25.4) // 2


def test_insert_image_rejects_non_image(sample_hwpx):
    with pytest.raises(CommandError):
        commands.insert_image(load(sample_hwpx), b"not an image at all, really")


def test_image_width_is_clamped_to_body_width(sample_hwpx):
    doc = load(sample_hwpx)
    commands.insert_image(doc, png(4000, 10), width_mm=300)
    pic = doc.blocks()[-1].paragraph.find(".//" + q("hp:pic"))
    assert int(pic.find(q("hp:sz")).get("width")) == doc.page_info().body_width


# ── 누름틀 ──────────────────────────────────────────────────────────────


def field_paragraph(name: str, direction: str, text: str, editable: str = "1", fid: str = "7") -> str:
    begin = f'<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="{fid}" type="CLICK_HERE" name="{name}" editable="{editable}" dirty="0"><hp:parameters count="1"><hp:stringParam name="Direction">{direction}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>'
    body = f'<hp:run charPrIDRef="0"><hp:t>{text}</hp:t></hp:run>'
    end = f'<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="{fid}" fieldid="99"/></hp:ctrl></hp:run>'
    return f'<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>성명: </hp:t></hp:run>{begin}{body}{end}</hp:p>'


def test_list_and_fill_fields():
    doc = load(build_hwpx(field_paragraph("name", "이름을 쓰세요", "", fid="7") + field_paragraph("", "날짜", "2026", editable="0", fid="8")))
    listing = commands.list_fields(doc)
    assert listing.startswith("#1 [2] 이름 'name' 안내 '이름을 쓰세요' = (비었음)")
    assert "#2 [3]" in listing and "읽기 전용" in listing
    r = commands.fill_fields(doc, {"이름을 쓰세요": "홍길동"})
    assert r.blocks == [2] and doc.block(2).text() == "성명: 홍길동"
    assert doc.fields()[0].text == "홍길동"
    with pytest.raises(CommandError):
        commands.fill_fields(doc, {"#2": "x"})  # 읽기 전용
    with pytest.raises(CommandError) as e:
        commands.fill_fields(doc, {"없는 것": "x", "name": "y"})
    assert "찾지 못했습니다: 없는 것" in str(e.value) and doc.fields()[0].text == "홍길동"  # 하나도 바뀌지 않음


# ── 새 문서 ─────────────────────────────────────────────────────────────


def test_create_blank_roundtrip_and_fill():
    doc = create_blank("보고서")
    assert len(doc.blocks()) == 1 and doc.block(1).paragraph.find(".//" + q("hp:secPr")) is not None
    commands.insert_content(doc, "# 보고서\n\n- 첫째\n- 둘째\n\n| 항목 | 값 |\n|---|---|\n| a | 1 |")
    again = load(doc.to_bytes())
    text, _, _ = again.blocks() and commands.read_document(again)
    assert "[2] (16pt, 굵게) 보고서" in text and "표 1 (2행 × 2열)" in text and "• 첫째" in text
    with zipfile.ZipFile(io.BytesIO(again.to_bytes())) as zf:
        assert zf.read("Preview/PrvText.txt").decode().startswith("\n보고서") or "보고서" in zf.read("Preview/PrvText.txt").decode()


def test_set_paragraph_inline_markdown(sample_hwpx):
    doc = load(sample_hwpx)
    commands.set_paragraph(doc, 3, "앞 **굵게** 뒤")
    p = doc.block(3).paragraph
    runs = p.findall(q("hp:run"))
    assert [r.find(q("hp:t")).text for r in runs] == ["앞 ", "굵게", " 뒤"]
    assert doc.header.char_look(runs[1].get("charPrIDRef")).bold and not doc.header.char_look(runs[0].get("charPrIDRef")).bold


def test_format_paragraphs_whole_document_font_reaches_table_cells(sample_hwpx):
    """'문서 전체 글꼴을 X로': all=True + font → 문단과 표 칸 안 글의 글자 모양이 모두 바뀐다 (관측: format_text find='.'은 마침표만 바꿈)."""
    doc = load(sample_hwpx)
    r = commands.format_paragraphs(doc, None, None, True, font="A2Z", size=11)
    assert "문서 전체" in r.text and r.blocks == [1, 2, 3, 4, 5]
    for no in (2, 3):
        for run in doc.block(no).paragraph.findall(q("hp:run")):
            look = doc.header.char_look(run.get("charPrIDRef"))
            assert look.font == "A2Z" and look.size == 11
    from app.engine.search import paragraphs_of

    cells = [p for p in paragraphs_of(doc, 4)]
    assert cells and all(doc.header.char_look(run.get("charPrIDRef")).font == "A2Z" for p in cells for run in p.element.findall(q("hp:run")))
    # 빈 문단(블록 5)은 세지 않지만 run의 글자 모양은 따라온다 (그 자리에 새로 치는 글)
    assert "글 " in r.text
    assert all(doc.header.char_look(run.get("charPrIDRef")).font == "A2Z" for run in doc.block(5).paragraph.findall(q("hp:run")))


def test_format_paragraphs_needs_from_or_all(sample_hwpx):
    with pytest.raises(CommandError) as e:
        commands.format_paragraphs(load(sample_hwpx), None, align="center")
    assert "all" in str(e.value)


def test_format_text_rejects_symbol_find_for_whole_document(sample_hwpx):
    with pytest.raises(CommandError) as e:
        commands.format_text(load(sample_hwpx), " ", True, font="A2Z")
    assert e.value.code == "INVALID_ARGUMENT" and "format_paragraphs" in str(e.value)
    # 블록을 좁히면 기호도 허용 (그 블록 안의 기호만 바꾼다는 뜻이 분명하다)
    commands.format_text(load(sample_hwpx), " ", True, 3, bold=True)
