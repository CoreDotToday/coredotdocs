"""AI 도구의 동작 규약: 블록 번호, 찾기·바꾸기 안내, 입력 경계, 스키마 거절.

AI가 도구 결과만 보고 다음 행동을 정할 수 있도록 결과 문구와 거절 규칙을 고정한다.
"""

from __future__ import annotations

import pytest

from app.engine import commands
from app.engine.errors import CommandError
from app.engine.hwpx import HwpxDocument
from app.tools import registry

DOC = "11111111-2222-4333-8444-555555555555"


def load(data):
    return HwpxDocument.load(data)


# ── 읽기·찾기·바꾸기 ───────────────────────────────────────────────────────


def test_block_numbering_starts_at_one_and_table_is_its_own_block(sample_hwpx):
    """블록 번호는 1부터, 표는 별도 블록 `[n] 표 N (R행 × C열)` + `(r,c) 글 | …`."""
    text, _, _ = commands.read_document(load(sample_hwpx))
    assert "[4] 표 1 (2행 × 2열)" in text and "(1,1) 구분 | (1,2) 내용" in text


def test_replace_requires_unique_match_or_all(sample_hwpx):
    """여러 곳이면 거절하고 자리마다 문맥을 보여 준 뒤 all: true 또는 block을 안내한다."""
    with pytest.raises(CommandError) as e:
        commands.replace_text(load(sample_hwpx), "샘플", "x")
    msg = str(e.value)
    assert "2곳" in msg and "all: true" in msg and "1) 블록 2" in msg


def test_replace_not_found_gives_spacing_hint(sample_hwpx):
    """못 찾으면 띄어쓰기만 다른 글을 찾아 '그대로 주세요'라고 안내한다."""
    with pytest.raises(CommandError) as e:
        commands.replace_text(load(sample_hwpx), "관측용샘플입니다", "x")
    assert "띄어쓰기만 다른 글" in str(e.value)


def test_find_is_literal_and_case_insensitive_with_context(sample_hwpx):
    """찾기는 글자 그대로(정규식 아님), 대소문자 무시, 앞뒤 문맥과 【】 표시."""
    out = commands.find(load(sample_hwpx), "HELLO")
    assert out.startswith("[3] …") and "【hello】" in out


def test_empty_find_and_query_rejected(sample_hwpx):
    with pytest.raises(CommandError):
        commands.find(load(sample_hwpx), "")
    with pytest.raises(CommandError):
        commands.replace_text(load(sample_hwpx), "", "x")


def test_long_query_is_safe(sample_hwpx):
    """스키마가 500자에서 거절하고, 엔진은 문자열 검색이라 어떤 길이도 예외 없이 '찾지 못했습니다'."""
    assert registry.validate("find_text", {"query": "a" * 200_000}) is not None
    assert "찾지 못했습니다" in commands.find(load(sample_hwpx), "a" * 200_000)


# ── 편집 입력 경계 ─────────────────────────────────────────────────────────


def test_xml_unsafe_text_rejected(sample_hwpx):
    """U+D800 등 XML 1.0이 허용하지 않는 문자는 거절한다."""
    with pytest.raises(ValueError) as e:
        commands.replace_text(load(sample_hwpx), "hello", "\ud800")
    assert "U+D800" in str(e.value)


def test_delete_range_validation(sample_hwpx):
    with pytest.raises(CommandError) as e:
        commands.delete_blocks(load(sample_hwpx), 5, 1)
    assert "(1~5)" in str(e.value)


def test_table_cell_out_of_range_message_includes_size(sample_hwpx):
    with pytest.raises(CommandError) as e:
        commands.set_table_cells(load(sample_hwpx), 1, [{"row": 10**15, "col": 1, "text": "x"}])
    assert "2행 × 2열" in str(e.value)


def test_insert_content_rejects_both_anchors(sample_hwpx):
    """after와 before를 함께 주면 거절한다."""
    with pytest.raises(CommandError):
        commands.insert_content(load(sample_hwpx), "x", after=1, before=1)


def test_insert_at_front_keeps_section_paragraph_first(sample_hwpx):
    """after:0은 구역 설정 문단 뒤(블록 2)에 넣는다."""
    doc = load(sample_hwpx)
    r = commands.insert_content(doc, "맨 앞", after=0)
    assert r.blocks == [2]


# ── 스키마 ─────────────────────────────────────────────────────────────────


def test_prototype_keys_do_not_pollute(sample_hwpx):
    import json

    err = registry.validate("read_document", json.loads('{"document_id": "%s", "__proto__": {"x": 1}}' % DOC))
    assert err is not None
    assert not hasattr(object(), "x")


def test_schema_bound_rejections(sample_hwpx):
    assert "maximum" in registry.validate("undo_last_edit", {"document_id": DOC, "steps": 51})
    assert "minimum" in registry.validate("read_document", {"document_id": DOC, "from": 0})


def test_unknown_argument_keys_rejected(sample_hwpx):
    assert "Additional properties" in registry.validate("replace_text", {"document_id": DOC, "find": "a", "replace": "b", "expectedLoadId": 9})


def test_every_number_has_an_upper_bound():
    for tool in registry.TOOLS:
        stack = [tool["inputSchema"]]
        while stack:
            node = stack.pop()
            if node.get("type") in ("integer", "number"):
                assert "maximum" in node, (tool["name"], node)
            stack.extend(node.get("properties", {}).values())
            if "items" in node:
                stack.append(node["items"])


def test_undo_is_revision_based_with_50_step_limit(sample_hwpx):
    assert registry.validate("undo_last_edit", {"document_id": DOC, "steps": 50}) is None
    assert registry.validate("undo_last_edit", {"document_id": DOC, "steps": 51}) is not None


def test_access_model_is_per_document_not_folder():
    """도구는 파일 경로가 아니라 문서 ID로만 문서를 가리킨다."""
    names = {p for t in registry.TOOLS for p in t["inputSchema"]["properties"]}
    assert "path" not in names and "document_id" in names
