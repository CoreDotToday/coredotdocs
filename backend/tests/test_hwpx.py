import zipfile
import io

import pytest

from app.engine.errors import EngineError
from app.engine.hwpx import HwpxDocument, table_grid


def test_blocks_are_numbered_from_one_and_tables_are_separate(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    kinds = [(b.no, b.kind) for b in doc.blocks()]
    assert kinds == [(1, "paragraph"), (2, "paragraph"), (3, "paragraph"), (4, "table"), (5, "paragraph")]
    assert doc.block(2).text() == "AI 편집 샘플"
    assert doc.block(4).table_no == 1


def test_table_grid_reads_cells(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    grid = table_grid(doc.table(1)[1])
    assert (grid.rows, grid.cols) == (2, 2)
    assert [(c.row, c.col, c.text) for c in grid.cells] == [(0, 0, "구분"), (0, 1, "내용"), (1, 0, "가"), (1, 1, "나")]


def test_merged_cell_resolves_by_any_covered_coordinate(merged_table_hwpx):
    doc = HwpxDocument.load(merged_table_hwpx)
    grid = table_grid(doc.table(1)[1])
    assert grid.cell_at(0, 1).text == "머리"
    assert grid.cell_at(0, 1) is grid.cell_at(0, 0)
    assert grid.cell_at(0, 2).text == "셋"


def test_roundtrip_preserves_other_entries_and_mimetype_first(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    out = doc.to_bytes()
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        infos = zf.infolist()
        assert infos[0].filename == "mimetype"
        assert infos[0].compress_type == zipfile.ZIP_STORED
        assert zf.read("mimetype") == b"application/hwp+zip"
        assert set(zf.namelist()) >= set(zipfile.ZipFile(io.BytesIO(sample_hwpx)).namelist())  # 미리보기 글(Preview/PrvText.txt)은 새로 더해질 수 있다
    again = HwpxDocument.load(out)
    assert [b.text() for b in again.blocks()] == [b.text() for b in doc.blocks()]


def test_namespace_prefixes_survive_rewrite(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    doc.block(3).paragraph  # 접근만
    out = doc.to_bytes()
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        xml = zf.read("Contents/section0.xml").decode()
    assert "<hp:p " in xml and "<hs:sec" in xml and "hp:secPr" in xml


def test_rejects_non_zip_and_wrong_mimetype():
    with pytest.raises(EngineError):
        HwpxDocument.load(b"not a zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/zip")
        zf.writestr("Contents/content.hpf", "<x/>")
    with pytest.raises(EngineError):
        HwpxDocument.load(buf.getvalue())


def test_insert_and_delete_keep_section_settings(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    numbers = doc.insert_paragraphs(["새 문단"], after=0)
    assert numbers == [2]  # 구역 설정 문단(1) 뒤에 들어간다
    assert doc.block(2).text() == "새 문단"
    doc.delete_blocks(1, 2)
    first = doc.block(1)
    assert first.paragraph.find(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}secPr") is not None
    assert first.text() == ""
    assert doc.block(2).text() == "AI 편집 샘플"


def test_delete_table_block_removes_only_that_table(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    doc.delete_blocks(4, 4)
    assert [b.kind for b in doc.blocks()] == ["paragraph"] * 4
