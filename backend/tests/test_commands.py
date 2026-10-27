import pytest

from app.engine import commands
from app.engine.errors import CommandError
from app.engine.hwpx import HwpxDocument, table_grid
from app.engine.search import find_text


def load(data):
    return HwpxDocument.load(data)


def test_read_document_format(sample_hwpx):
    text, next_from, _ = commands.read_document(load(sample_hwpx))
    lines = text.split("\n")
    assert lines[0] == "[1] (빈 문단)"
    assert lines[1] == "[2] AI 편집 샘플"
    assert lines[3] == "[4] 표 1 (2행 × 2열)"
    assert lines[4].strip() == "(1,1) 구분 | (1,2) 내용"
    assert next_from is None


def test_read_document_paging_stops_on_block_boundary(sample_hwpx):
    text, next_from, _ = commands.read_document(load(sample_hwpx), max_chars=40)
    assert next_from is not None
    assert f"from: {next_from}" in text


def test_find_text_literal_case_insensitive_with_context(sample_hwpx):
    hits = find_text(load(sample_hwpx), "HELLO")
    assert len(hits) == 1
    assert hits[0].block_no == 3 and hits[0].match == "hello"
    assert hits[0].line().startswith("[3] …")


def test_find_text_inside_table_cells_reports_where(sample_hwpx):
    hits = find_text(load(sample_hwpx), "내용")
    assert hits[0].where == "표 1 (1,2)"


def test_find_text_regex_metacharacters_are_literal(sample_hwpx):
    assert find_text(load(sample_hwpx), "a.*b") == []
    assert commands.find(load(sample_hwpx), "(관측)") .startswith("'(관측)'을(를) 찾지 못했습니다")


def test_find_text_very_long_query_does_not_raise(sample_hwpx):
    result = commands.find(load(sample_hwpx), "a" * 200_000)
    assert "찾지 못했습니다" in result


def test_find_empty_query_rejected(sample_hwpx):
    with pytest.raises(CommandError):
        commands.find(load(sample_hwpx), "")


def test_replace_single_match(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.replace_text(doc, "hello", "world")
    assert r.edited and r.blocks == [3]
    assert doc.block(3).text() == "이 문서는 관측용 샘플입니다 world"


def test_replace_requires_all_when_multiple(sample_hwpx):
    doc = load(sample_hwpx)
    with pytest.raises(CommandError) as e:
        commands.replace_text(doc, "샘플", "x")
    assert "2곳에 있습니다" in str(e.value)
    r = commands.replace_text(doc, "샘플", "x", all_=True)
    assert "2곳" in r.text
    assert doc.block(2).text() == "AI 편집 x"


def test_replace_not_found_gives_loose_hint(sample_hwpx):
    with pytest.raises(CommandError) as e:
        commands.replace_text(load(sample_hwpx), "관측용샘플", "x")
    assert "띄어쓰기만 다른 글" in str(e.value) and "'관측용 샘플'" in str(e.value)


def test_replace_across_runs_keeps_run_structure(multi_run_hwpx):
    doc = load(multi_run_hwpx)
    assert doc.block(2).text() == "앞 굵은 글 뒤"
    commands.replace_text(doc, "굵은 글 뒤", "X")
    assert doc.block(2).text() == "앞 X"
    runs = doc.block(2).paragraph.findall("{http://www.hancom.co.kr/hwpml/2011/paragraph}run")
    assert [r.get("charPrIDRef") for r in runs] == ["0", "2", "0"]


def test_replace_rejects_xml_unsafe_text(sample_hwpx):
    with pytest.raises(ValueError):
        commands.replace_text(load(sample_hwpx), "hello", "\ud800")
    with pytest.raises(ValueError):
        commands.set_paragraph(load(sample_hwpx), 3, "a\x00b")


def test_set_paragraph_text_and_table_guard(sample_hwpx):
    doc = load(sample_hwpx)
    commands.set_paragraph(doc, 3, "새 글")
    assert doc.block(3).text() == "새 글"
    with pytest.raises(CommandError):
        commands.set_paragraph(doc, 4, "x")
    with pytest.raises(CommandError):
        commands.set_paragraph(doc, 99, "x")


def test_insert_content_markdown(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.insert_content(doc, "# 제목\n\n- 항목 하나\n- 항목 둘\n\n본문 글", after=3, like=3)
    assert r.blocks == [4, 5, 6, 7]
    assert [doc.block(n).text() for n in r.blocks] == ["제목", "• 항목 하나", "• 항목 둘", "본문 글"]
    assert doc.block(8).kind == "table"


def test_insert_content_rejects_both_anchors_and_empty(sample_hwpx):
    with pytest.raises(CommandError):
        commands.insert_content(load(sample_hwpx), "x", after=1, before=1)
    with pytest.raises(CommandError):
        commands.insert_content(load(sample_hwpx), "   \n  ")


def test_delete_blocks_range_validation(sample_hwpx):
    with pytest.raises(CommandError):
        commands.delete_blocks(load(sample_hwpx), 5, 1)
    with pytest.raises(CommandError):
        commands.delete_blocks(load(sample_hwpx), 1, 10**6)
    doc = load(sample_hwpx)
    r = commands.delete_blocks(doc, 2, 3)
    assert "2개" in r.text
    assert doc.block(2).kind == "table"


def test_set_table_cells(sample_hwpx):
    doc = load(sample_hwpx)
    r = commands.set_table_cells(doc, 1, [{"row": 2, "col": 1, "text": "첫 줄\n둘째 줄"}, {"row": 2, "col": 2, "text": ""}], overwrite=True)
    assert "2개" in r.text
    grid = table_grid(doc.table(1)[1])
    assert grid.cell_at(1, 0).text == "첫 줄\n둘째 줄"
    assert grid.cell_at(1, 1).text == ""


def test_set_table_cells_errors(sample_hwpx, merged_table_hwpx):
    with pytest.raises(CommandError) as e:
        commands.set_table_cells(load(sample_hwpx), 1, [{"row": 10**15, "col": 1, "text": "x"}])
    assert "2행 × 2열" in str(e.value)
    with pytest.raises(CommandError):
        commands.set_table_cells(load(sample_hwpx), 2, [{"row": 1, "col": 1, "text": "x"}])
    with pytest.raises(CommandError) as e:
        commands.set_table_cells(load(merged_table_hwpx), 1, [{"row": 1, "col": 1, "text": "a"}, {"row": 1, "col": 2, "text": "b"}])
    assert "같은 칸" in str(e.value)


def test_document_info(sample_hwpx):
    info = commands.document_info(load(sample_hwpx))
    assert "블록 5개 · 표 1개" in info
