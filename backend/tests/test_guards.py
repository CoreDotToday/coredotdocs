"""6차-2 도구 품질: 오류 코드, 개체 보호, 빈 칸 규칙, 낡은 리비전, 되돌리기 규칙, 검증-후-확정, 속성 테스트, 채팅 루프 보강."""

from __future__ import annotations

import io
import struct
import zlib

import pytest
from hypothesis import given, settings as hsettings
from hypothesis import strategies as st

from app.engine import commands
from app.engine.errors import CommandError
from app.engine.hwpx import HwpxDocument, table_grid
from app.engine.invariants import Fingerprint, fingerprint, violation
from tests.conftest import build_hwpx, paragraph, table
from tests.test_api import call, client, doc_id  # noqa: F401  (모듈 픽스처를 이 모듈에서도 쓴다)


def load(data):
    return HwpxDocument.load(data)


def png_bytes(w: int = 4, h: int = 4) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# ── 오류 코드 ────────────────────────────────────────────────────────────


def test_error_codes_in_tool_text(client, doc_id):
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "없는 글", "replace": "x"})
    assert err and text.startswith("오류[TARGET_NOT_FOUND]")
    text, err = call(client, "delete_blocks", {"document_id": doc_id, "from": 99})
    assert err and text.startswith("오류[OUT_OF_RANGE]")
    text, err = call(client, "read_document", {"document_id": "11111111-2222-4333-8444-555555555555"})
    assert err and text.startswith("오류[TARGET_NOT_FOUND]")


def test_ambiguous_replace_refuses_and_lists_candidates(client):
    data = build_hwpx(paragraph("사과 하나") + paragraph("사과 둘") + paragraph("배"))
    doc_id = client.post("/api/documents", files={"file": ("모호.hwpx", data, "application/hwp+zip")}).json()["id"]
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "사과", "replace": "감"})
    assert err and text.startswith("오류[AMBIGUOUS_TARGET]") and "블록 2:" in text and "블록 3:" in text
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "사과", "replace": "감", "block": 3})
    assert not err and "1곳" in text


# ── 개체 보호 ────────────────────────────────────────────────────────────


def test_blocks_holding_objects_are_protected(client, doc_id):
    # 표 블록(4)은 include_objects 없이 지우지 않는다
    text, err = call(client, "delete_blocks", {"document_id": doc_id, "from": 4})
    assert err and text.startswith("오류[HOLDS_OBJECT]") and "블록 4(표)" in text
    # 그림을 넣은 문단은 통째로 바꾸거나 지우지 않는다
    image_id = client.post(f"/api/documents/{doc_id}/images", files={"file": ("dot.png", png_bytes(), "image/png")}).json()["image_id"]
    text, err = call(client, "insert_image", {"document_id": doc_id, "image_id": image_id, "after": 3})
    assert not err and "그림을 넣었습니다 (블록 4" in text
    text, err = call(client, "set_paragraph_text", {"document_id": doc_id, "block": 4, "text": "덮어쓰기"})
    assert err and text.startswith("오류[HOLDS_OBJECT]") and "그림" in text
    text, err = call(client, "delete_blocks", {"document_id": doc_id, "from": 4})
    assert err and text.startswith("오류[HOLDS_OBJECT]")
    text, err = call(client, "delete_blocks", {"document_id": doc_id, "from": 4, "include_objects": True})
    assert not err and "블록 1개를 지웠습니다" in text and "검증: " in text and "그림 0" in text


def test_table_cells_empty_only_and_all_or_nothing(client, doc_id):
    # (2,1)='가'에 글이 있어 거절되면 빈 칸 (2,2)도 쓰지 않는다
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 2, "text": "새"}, {"row": 2, "col": 1, "text": "덮"}]})
    assert err and text.startswith("오류[CELL_NOT_EMPTY]") and "(2,1)" in text
    text, _ = call(client, "read_document", {"document_id": doc_id, "table": 1})
    assert "새" not in text
    # 같은 글을 다시 쓰는 것은 덮어쓰기가 아니다
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 1, "text": "가"}]})
    assert not err
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 1, "text": "덮"}], "overwrite": True})
    assert not err and "칸 1개" in text


def test_cell_holding_inner_table_is_refused(merged_table_hwpx, client):
    inner = table([["x"]])
    body = (
        '<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">'
        '<hp:tbl id="9" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:tr>'
        '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
        + inner
        + '</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="1000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>'
        "</hp:tr></hp:tbl></hp:run></hp:p>"
    )
    doc = load(build_hwpx(body))
    with pytest.raises(CommandError) as e:
        commands.set_table_cells(doc, 1, [{"row": 1, "col": 1, "text": "x"}])
    assert e.value.code == "HOLDS_OBJECT" and "안쪽 표" in str(e.value)


# ── 낡은 리비전·되돌리기 규칙 ───────────────────────────────────────────


def test_expected_revision_guards_stale_edits(client, doc_id):
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "a", "expected_revision": 1})
    assert not err and "리비전 2" in text
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "a", "replace": "b", "expected_revision": 1})
    assert err and text.startswith("오류[STALE_REVISION]") and "리비전 2" in text
    text, err = call(client, "undo_last_edit", {"document_id": doc_id, "expected_revision": 1})
    assert err and text.startswith("오류[STALE_REVISION]")


def test_undo_refuses_when_user_edited_in_editor(client, doc_id, sample_hwpx):
    call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "AI"})  # 리비전 2 (ai 아님, user지만 도구)
    # 편집기가 다른 내용을 올림 → 리비전 3 (tool=editor)
    edited = build_hwpx(paragraph("사용자가 고침"))
    r = client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("x.hwpx", edited, "application/hwp+zip")})
    assert r.status_code == 201 and r.json()["revision_seq"] == 3
    # 리비전 2(도구)만 되돌리려 하면 사용자 리비전 3이 끼어 있어 거절
    r = client.post(f"/api/documents/{doc_id}/undo", json={"steps": 2})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "FOREIGN_CHANGES"
    text, err = call(client, "undo_last_edit", {"document_id": doc_id, "steps": 2})
    assert err and text.startswith("오류[FOREIGN_CHANGES]")
    # 한 단계(리비전 3 자체)는 사용자 리비전을 '건너뛰는' 것이 아니므로 허용되지 않는다 — 구간에 3이 들어 있다
    r = client.post(f"/api/documents/{doc_id}/undo", json={"steps": 1})
    assert r.status_code == 409
    r = client.post(f"/api/documents/{doc_id}/undo", json={"steps": 2, "force": True})
    assert r.status_code == 200 and r.json()["revision_seq"] == 4
    text, _ = call(client, "read_document", {"document_id": doc_id, "from": 3, "to": 3})
    assert text.endswith("hello")


# ── 검증-후-확정 ────────────────────────────────────────────────────────


def test_violation_rules():
    before = Fingerprint(blocks=5, paragraphs=4, tables=1, pictures=0, fields=((1, "a"),))
    assert violation("replace_text", before, before) is None
    assert "표 수" in violation("replace_text", before, Fingerprint(5, 4, 0, 0, ((1, "a"),)))
    assert violation("insert_table", before, Fingerprint(6, 4, 2, 0, ((1, "a"),))) is None
    assert "누름틀 #1" in violation("set_paragraph_text", before, Fingerprint(5, 4, 1, 0, ((1, "b"),)))
    assert violation("fill_fields", before, Fingerprint(5, 4, 1, 0, ((1, "b"),))) is None
    assert "블록 수" in violation("format_text", before, Fingerprint(4, 3, 1, 0, ((1, "a"),)))
    assert violation("delete_blocks", before, Fingerprint(3, 3, 0, 0, ())) is None


def test_fingerprint_counts_inner_tables_and_edit_results_carry_verification(sample_hwpx, client, doc_id):
    fp = fingerprint(load(sample_hwpx))
    assert (fp.blocks, fp.paragraphs, fp.tables, fp.pictures, fp.field_count) == (5, 4, 1, 0, 0)
    text, err = call(client, "insert_table", {"document_id": doc_id, "rows": [["a", "b"]], "after": 3})
    assert not err and "검증: 문단 4, 표 2" in text and "(전: 문단 4, 표 1" in text


def test_unexpected_change_is_not_committed(client, doc_id, monkeypatch):
    """도구가 의도하지 않은 구조 변화를 만들면 리비전을 만들지 않는다 (가짜 명령으로 표를 지우게 한다)."""
    from app.engine import commands as cmds

    def rogue(doc, find_, replace, all_=False, block=None, match_case=False):
        doc.delete_blocks(4, 4)  # 표를 지워 버린다
        return cmds.CommandResult("바꿨다고 주장", True, [3])

    monkeypatch.setattr(cmds, "replace_text", rogue)
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "x"})
    assert err and text.startswith("오류[UNEXPECTED_CHANGE]") and "표 수 1→0" in text
    assert client.get(f"/api/documents/{doc_id}/revisions").json()[-1]["seq"] == 1


# ── 속성 테스트 (한글의 달인 Hypothesis 방식) ─────────────────────────────

korean = st.text(alphabet=st.characters(whitelist_categories=("Lu", "Ll", "Lo", "Nd"), min_codepoint=0x20, max_codepoint=0xD7A3), min_size=1, max_size=12).filter(lambda s: s.strip() == s and s)


@hsettings(max_examples=40, deadline=None)
@given(find=korean, replace=korean)
def test_replace_text_is_local_and_idempotent(find, replace):
    """다른 블록·표 모양·개체 수는 그대로이고, 같은 치환을 한 번 더 하면 (대상이 사라졌으므로) 거절되거나 결과가 같다."""
    body = paragraph(f"앞 {find} 뒤") + paragraph("다른 문단") + table([["구분", "내용"], ["가", "나"]])
    doc = load(build_hwpx(body))
    before = fingerprint(doc)
    other_before = doc.block(3).text()
    shape_before = (table_grid(doc.table(1)[1]).rows, table_grid(doc.table(1)[1]).cols)
    try:
        commands.replace_text(doc, find, replace, block=2)
    except CommandError as e:
        assert e.code in {"AMBIGUOUS_TARGET", "TARGET_NOT_FOUND"}
        return
    once = doc.block(2).text()
    contained = find.lower() in replace.lower()  # 찾기는 대소문자를 무시한다(기본): Ġ→ġ도 치환 뒤에 다시 찾힌다
    assert once == f"앞 {replace} 뒤" or contained  # find가 replace에 포함되면 치환 뒤에도 남는다
    assert doc.block(3).text() == other_before
    assert (table_grid(doc.table(1)[1]).rows, table_grid(doc.table(1)[1]).cols) == shape_before
    after = fingerprint(doc)
    assert (after.tables, after.pictures, after.field_count, after.blocks) == (before.tables, before.pictures, before.field_count, before.blocks)
    if not contained:
        with pytest.raises(CommandError):
            commands.replace_text(doc, find, replace, block=2)  # 멱등: 더 바꿀 것이 없다
        assert doc.block(2).text() == once


@hsettings(max_examples=30, deadline=None)
@given(text=korean)
def test_identity_roundtrip_keeps_structure(text):
    """문단을 자기 글로 다시 쓰면 글·표 모양·개체 수가 그대로다 (항등 왕복)."""
    doc = load(build_hwpx(paragraph(text) + table([["a"]])))
    before = fingerprint(doc)
    commands.set_paragraph(doc, 2, text)
    assert doc.block(2).text() == text
    reloaded = load(doc.to_bytes())
    assert fingerprint(reloaded) == before and reloaded.block(2).text() == text


# ── 채팅 루프 보강 ────────────────────────────────────────────────────────


def _anthropic_text(text: str) -> tuple[int, dict]:
    return 200, {"content": [{"type": "text", "text": text}], "usage": {"input_tokens": 1, "output_tokens": 1}, "stop_reason": "end_turn"}


def _anthropic_tool(tid: str, name: str, args: dict) -> tuple[int, dict]:
    return 200, {"content": [{"type": "tool_use", "id": tid, "name": name, "input": args}], "usage": {"input_tokens": 1, "output_tokens": 1}, "stop_reason": "tool_use"}


def _run(client, doc_id, transport, message="고쳐 줘"):
    import uuid

    from app.db import SessionLocal
    from app.llm.agent import run_chat

    events: list[tuple[str, dict]] = []
    db = SessionLocal()
    try:
        final = run_chat(db, document_id=uuid.UUID(doc_id), model="claude-sonnet-5-5", api_key="cdt_test", history=None, message=message, emit=lambda k, p: events.append((k, p)), transport=transport)
    finally:
        db.close()
    return final, events


def test_chat_context_and_secret_masking(client, doc_id):
    seen: list[dict] = []

    def transport(method, url, headers, body):
        seen.append(body)
        return _anthropic_text("문서를 읽었습니다.")

    final, events = _run(client, doc_id, transport, message="키는 cdt_abcdefghijklmnopqrstuv 입니다")
    body = seen[0]
    assert "## 열린 문서" in body["system"] and "[3] 이 문서는 관측용 샘플입니다 hello" in body["system"] and "expected_revision" in body["system"]
    assert "cdt_abcdefghijklmnopqrstuv" not in body["messages"][-1]["content"] and "[가려짐]" in body["messages"][-1]["content"]
    # 기록: 성공한 실행은 문서별로 남고 API로 읽힌다
    hist = client.get(f"/api/ai/chat/{doc_id}/history").json()["messages"]
    assert [m["role"] for m in hist] == ["user", "assistant"] and "[가려짐]" in hist[0]["text"]
    # 다음 실행은 저장된 기록을 모델 문맥으로 되살린다
    _run(client, doc_id, transport, message="두 번째")
    assert [m["role"] for m in seen[1]["messages"]] == ["user", "assistant", "user"]
    assert client.delete(f"/api/ai/chat/{doc_id}/history").json()["ok"] and client.get(f"/api/ai/chat/{doc_id}/history").json()["messages"] == []


def test_chat_stops_on_identical_tool_calls(client, doc_id):
    def transport(method, url, headers, body):
        return _anthropic_tool("t", "find_text", {"query": "hello"})

    final, events = _run(client, doc_id, transport)
    kinds = [k for k, _ in events]
    assert kinds.count("tool_call") == 2 and kinds[-1] == "error" and "반복" in events[-1][1]["message"]
    assert client.get(f"/api/ai/chat/{doc_id}/history").json()["messages"] == []  # 실패한 실행은 남기지 않는다


def test_chat_verifies_edit_claims(client, doc_id):
    calls = {"n": 0}

    def transport(method, url, headers, body):
        calls["n"] += 1
        if calls["n"] == 1:
            return _anthropic_text("3번 블록을 고쳤습니다.")  # 거짓 주장
        assert "[앱 확인]" in body["messages"][-1]["content"]
        return _anthropic_text("아직 고치지 않았습니다. 어느 블록을 고칠지 알려 주세요.")

    final, events = _run(client, doc_id, transport)
    assert calls["n"] == 2 and "notice" in [k for k, _ in events] and final.startswith("아직")
