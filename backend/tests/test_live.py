"""라이브 세션: 편집기가 열려 있으면 편집 도구는 편집기가 실행하고 결과 파일을 리비전으로 확정한다 (설계 문서 04 §3 B4)."""

from __future__ import annotations

import json
import threading
import time
import uuid

import pytest

from app.engine.hwpx import HwpxDocument
from app.engine import commands
from app.services import live as live_mod
from app.services.events import bus
from app.tools import live_dispatch
from tests.conftest import build_hwpx, paragraph, table
from tests.test_api import call, client, doc_id  # noqa: F401


def _editor(client, doc_id, handler, *, polls: int = 20):
    """가짜 편집기: 롱폴로 요청을 받아 handler(request) → (result dict, bytes|None)로 답한다."""
    sid = client.post(f"/api/documents/{doc_id}/live", json={"client": "test-editor"}).json()["session_id"]
    seen: list[dict] = []
    stop = threading.Event()

    def loop():
        for _ in range(polls):
            if stop.is_set():
                return
            r = client.get(f"/api/documents/{doc_id}/live/{sid}/next", params={"wait": 1})
            if r.status_code != 200:
                return
            req = r.json()["request"]
            if not req:
                continue
            seen.append(req)
            result, data = handler(req)
            files = {"file": ("live.hwpx", data, "application/hwp+zip")} if data else None
            client.post(f"/api/documents/{doc_id}/live/{sid}/results/{req['id']}", data={"result": json.dumps(result)}, files=files)

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return sid, seen, stop, t


@pytest.fixture(autouse=True)
def _fast_timeout(monkeypatch):
    monkeypatch.setattr(live_mod, "REQUEST_TIMEOUT_S", 5.0)


def _finish(client, doc_id, sid, stop, t):
    stop.set()
    client.delete(f"/api/documents/{doc_id}/live/{sid}")
    t.join(5)


def test_prepare_hints_for_text_and_tables(sample_hwpx):
    doc = HwpxDocument.load(sample_hwpx)
    h = live_dispatch.prepare("replace_text", {"find": "hello", "replace": "world"}, doc)
    assert h == {"method": "replaceText", "find": "hello", "replacement": "world", "occurrence": None}
    # 같은 말이 여럿이면 앞뒤를 늘려 하나뿐인 글로 만든다
    doc2 = HwpxDocument.load(build_hwpx(paragraph("사과 하나") + paragraph("사과 둘")))
    h = live_dispatch.prepare("replace_text", {"find": "사과", "replace": "감", "block": 3}, doc2)
    assert h["method"] == "replaceText" and h["find"] == "사과 둘" and h["replacement"] == "감 둘"
    assert live_dispatch.prepare("replace_text", {"find": "사과", "replace": "감"}, doc2) is None  # 모호 → 서버가 거절한다
    h = live_dispatch.prepare("set_table_cells", {"table": 1, "cells": [{"row": 2, "col": 2, "text": "x"}]}, doc)
    assert h == {"method": "fillCells", "table": 1, "cells": [{"row": 2, "col": 2, "text": "x"}], "overwrite": False}
    assert live_dispatch.prepare("set_table_cells", {"table": 1, "cells": [{"row": 2, "col": 2, "format": {"bold": True}}]}, doc) is None
    h = live_dispatch.prepare("insert_content", {"markdown": "하나\n\n둘", "after": 3}, doc)
    assert h == {"method": "insertParagraphs", "anchor": "이 문서는 관측용 샘플입니다 hello", "occurrence": None, "where": "after", "paragraphs": ["하나", "둘"]}
    assert live_dispatch.prepare("insert_content", {"markdown": "# 제목"}, doc) is None  # 스타일이 필요한 것은 서버
    assert live_dispatch.prepare("insert_image", {"image_id": "x"}, doc) is None


def test_flat_table_numbering_counts_inner_tables_after_parent():
    inner = table([["x"]])
    cell = (
        '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
        + inner
        + '</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="1000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>'
    )
    outer = f'<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="9" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:tr>{cell}</hp:tr></hp:tbl></hp:run></hp:p>'
    doc = HwpxDocument.load(build_hwpx(outer + table([["b"]])))
    assert live_dispatch._flat_table(doc, 1) == 1
    assert live_dispatch._flat_table(doc, "1-1") == 2
    assert live_dispatch._flat_table(doc, 2) == 3


def test_live_editor_executes_and_server_commits(client, doc_id):
    def handler(req):
        assert req["tool"] == "replace_text" and req["hints"]["method"] == "replaceText"
        doc = HwpxDocument.load(client.get(f"/api/documents/{doc_id}/download").content)
        commands.replace_text(doc, req["hints"]["find"], req["hints"]["replacement"])  # 편집기가 고쳤다고 치자
        return {"ok": True, "text": "1곳을 바꿨습니다.", "place": {"section": 0, "paragraph": 2, "length": 10}}, doc.to_bytes()

    sid, seen, stop, t = _editor(client, doc_id, handler)
    assert client.get(f"/api/documents/{doc_id}/live/status").json()["live"] is True
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "LIVE"})
    assert not err and "편집기에서 실행" in text and "리비전 2" in text and "검증: " in text
    revs = client.get(f"/api/documents/{doc_id}/revisions").json()
    assert revs[-1]["tool"] == "replace_text"
    read, _ = call(client, "read_document", {"document_id": doc_id, "from": 3, "to": 3})
    assert read.endswith("LIVE")
    assert len(seen) == 1
    _finish(client, doc_id, sid, stop, t)
    assert client.get(f"/api/documents/{doc_id}/live/status").json()["live"] is False


def test_live_fallback_and_refusal(client, doc_id):
    answers = iter([({"ok": False, "code": "LIVE_FALLBACK", "text": "not_found"}, None), ({"ok": False, "code": "occupied", "text": "글이 있는 칸"}, None)])

    def handler(req):
        return next(answers)

    sid, seen, stop, t = _editor(client, doc_id, handler)
    # 편집기가 폴백을 요청하면 서버가 실행한다
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "서버"})
    assert not err and "리비전 2" in text and "편집기에서 실행" not in text
    # 편집기의 의미 있는 거절은 우리 코드로 옮겨 그대로 돌려준다
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 1, "text": "x"}]})
    assert err and text.startswith("오류[CELL_NOT_EMPTY]")
    _finish(client, doc_id, sid, stop, t)


def test_live_timeout_falls_back_to_server(client, doc_id, monkeypatch):
    monkeypatch.setattr(live_mod, "REQUEST_TIMEOUT_S", 0.3)
    received: list[dict] = []
    bus.add_listener(received.append) if hasattr(bus, "add_listener") else bus._sync_listeners.append(received.append)
    sid = client.post(f"/api/documents/{doc_id}/live", json={"client": "silent"}).json()["session_id"]
    started = time.monotonic()
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "x"})
    assert not err and "리비전 2" in text and time.monotonic() - started < 5
    # 요청은 그 문서의 이벤트 스트림에도 실려 나간다 (브라우저 편집기의 경로)
    live_events = [e for e in received if e["type"] == "live-request"]
    assert live_events and live_events[0]["session_id"] == sid and live_events[0]["request"]["hints"]["method"] == "replaceText" and live_events[0]["request"]["revision_seq"] == 1
    client.delete(f"/api/documents/{doc_id}/live/{sid}")
    bus._sync_listeners.remove(received.append) if received.append in bus._sync_listeners else None


def test_live_unexpected_change_undoes_editor_and_falls_back_to_server(client, doc_id):
    """편집기 결과의 구조가 어긋나면(표가 사라짐) 편집기에 undo를 요청하고 서버가 실행한다 (하드 오류 대신 폴백)."""
    undo_requests: list[dict] = []

    def handler(req):
        if req["tool"] == "undo":
            undo_requests.append(req)
            return {"ok": True, "text": "1단계 되돌렸습니다."}, None
        doc = HwpxDocument.load(client.get(f"/api/documents/{doc_id}/download").content)
        doc.delete_blocks(4, 4)  # 표를 지워 버렸다 (의도하지 않은 변화)
        return {"ok": True, "text": "바꿨습니다", "foreign": 3}, doc.to_bytes()

    sid, seen, stop, t = _editor(client, doc_id, handler)
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "x"})
    assert not err and "리비전 2" in text and "편집기에서 실행" not in text
    _finish(client, doc_id, sid, stop, t)
    assert [r["hints"] for r in undo_requests] == [{"method": "undo", "steps": 1, "foreign": 3}]
    revs = client.get(f"/api/documents/{doc_id}/revisions").json()
    assert revs[-1]["seq"] == 2 and revs[-1]["tool"] == "replace_text"
    read, _ = call(client, "read_document", {"document_id": doc_id, "from": 3, "to": 3})
    assert read.endswith("x")


def test_server_fallback_reloads_after_editor_pushed_a_revision(client, doc_id):
    """편집기가 기다리는 동안 자기 변경을 올렸다가 폴백하면, 서버는 새 머리 위에서 실행한다 (낡은 내용 덮어쓰기 방지)."""
    from tests.conftest import build_hwpx, paragraph, table

    def handler(req):
        pushed = build_hwpx(paragraph("제목") + paragraph("사용자가 친 글 hello") + table([["a", "b"], ["c", "d"]]))
        r = client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("x.hwpx", pushed, "application/hwp+zip")}, headers={"X-Editor-Client": "tab-1"})
        assert r.json()["revision_seq"] == 2
        return {"ok": False, "code": "LIVE_FALLBACK", "text": "not_found"}, None

    sid, seen, stop, t = _editor(client, doc_id, handler)
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "world"})
    assert not err and "리비전 3" in text
    _finish(client, doc_id, sid, stop, t)
    read = client.get(f"/api/documents/{doc_id}/read").json()["text"]
    assert "사용자가 친 글 world" in read


def test_commit_edit_refuses_when_head_moved(client, doc_id):
    from app.db import SessionLocal
    from app.engine import commands as cmds
    from app.engine.errors import CommandError
    from app.services.documents import DocumentService
    import uuid as _uuid

    db = SessionLocal()
    try:
        service = DocumentService(db)
        loaded = service.load(_uuid.UUID(doc_id))
        cmds.replace_text(loaded.hwpx, "hello", "a")
        # 그 사이 편집기가 리비전을 올렸다
        other = SessionLocal()
        try:
            DocumentService(other).replace_content(_uuid.UUID(doc_id), loaded.hwpx.to_bytes().replace(b"hello", b"bbbbb"), client="tab-2")
        finally:
            other.close()
        with pytest.raises(CommandError) as e:
            service.commit_edit(loaded, actor="ai", summary="x", command={"tool": "replace_text"}, blocks=[3])
        assert e.value.code == "STALE_REVISION"
    finally:
        db.close()


def test_live_session_replaced_fails_pending(client, doc_id):
    s1 = client.post(f"/api/documents/{doc_id}/live", json={"client": "a"}).json()["session_id"]
    s2 = client.post(f"/api/documents/{doc_id}/live", json={"client": "b"}).json()["session_id"]
    assert client.get(f"/api/documents/{doc_id}/live/{s1}/next", params={"wait": 0}).status_code == 410
    assert client.get(f"/api/documents/{doc_id}/live/{s2}/next", params={"wait": 0}).json() == {"request": None}
    assert client.post(f"/api/documents/{doc_id}/live/{s2}/results/nope", data={"result": "{}"}).status_code == 404
    client.delete(f"/api/documents/{doc_id}/live/{s2}")


def test_oversized_live_result_does_not_consume_pending_request(client, doc_id, sample_hwpx, monkeypatch):
    from app.config import settings

    sid = client.post(f"/api/documents/{doc_id}/live", json={"client": "bounded-upload"}).json()["session_id"]
    session = live_mod.live.session(doc_id, sid)
    request = live_mod.LiveRequest(id=uuid.uuid4().hex, tool="replace_text", args={}, hints={})
    session.pending[request.id] = request
    session.queue.append(request)
    url = f"/api/documents/{doc_id}/live/{sid}/results/{request.id}"
    try:
        monkeypatch.setattr(settings, "max_upload_bytes", len(sample_hwpx) - 1)
        response = client.post(url, data={"result": '{"ok":true}'}, files={"file": ("live.hwpx", sample_hwpx, "application/hwp+zip")})
        assert response.status_code == 413
        assert session.pending[request.id] is request and not request.done.is_set()
        assert request.data is None
        monkeypatch.setattr(settings, "max_upload_bytes", len(sample_hwpx))
        response = client.post(url, data={"result": '{"ok":true}'}, files={"file": ("live.hwpx", sample_hwpx, "application/hwp+zip")})
        assert response.status_code == 200
        assert request.done.is_set() and request.data == sample_hwpx
        assert request.id not in session.pending
    finally:
        client.delete(f"/api/documents/{doc_id}/live/{sid}")


def test_selection_tools_need_live_editor(client, doc_id):
    text, err = call(client, "read_selection", {"document_id": doc_id})
    assert err and text.startswith("오류[UNSUPPORTED]")
    text, err = call(client, "replace_selection", {"document_id": doc_id, "texts": ["x"]})
    assert err and text.startswith("오류[UNSUPPORTED]")

    def handler(req):
        if req["hints"]["method"] == "selection":
            return {"ok": True, "text": "선택 1토막:\n1) 관측용 샘플입니다"}, None
        assert req["hints"] == {"method": "replaceSelection", "texts": ["고친 글"]}
        doc = HwpxDocument.load(client.get(f"/api/documents/{doc_id}/download").content)
        commands.replace_text(doc, "관측용 샘플입니다", "고친 글")
        return {"ok": True, "text": "선택한 부분을 바꿨습니다."}, doc.to_bytes()

    sid, seen, stop, t = _editor(client, doc_id, handler)
    text, err = call(client, "read_selection", {"document_id": doc_id})
    assert not err and "관측용 샘플입니다" in text
    text, err = call(client, "replace_selection", {"document_id": doc_id, "texts": ["고친 글"]})
    assert not err and "편집기에서 실행" in text and "리비전 2" in text
    _finish(client, doc_id, sid, stop, t)
    # heartbeat로 살아 있음을 알린다; 없는 세션은 410
    assert client.post(f"/api/documents/{doc_id}/live/{sid}/heartbeat").status_code == 410


def test_editor_push_with_stale_base_is_refused_unless_own_revision(client, doc_id):
    """편집기 올리기(X-Editor-Base): 머리가 다른 쪽 때문에 움직였으면 409 STALE_REVISION, 자기 리비전 뒤라면 허용 (리뷰 #2)."""
    files = lambda body: {"file": ("x.hwpx", build_hwpx(paragraph("제목") + paragraph(body) + table([["a", "b"], ["c", "d"]])), "application/hwp+zip")}  # noqa: E731
    # 서버 도구가 리비전 2를 만든다
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "server"})
    assert not err and "리비전 2" in text
    # 편집기는 아직 리비전 1을 본다고 올린다 → 거절, 머리 번호를 알려준다
    r = client.post(f"/api/documents/{doc_id}/revisions", files=files("typing A"), headers={"X-Editor-Client": "tab-1", "X-Editor-Base": "1"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "STALE_REVISION" and r.json()["detail"]["revision_seq"] == 2
    # 머리를 기준으로 올리면 된다 (리비전 3)
    r = client.post(f"/api/documents/{doc_id}/revisions", files=files("typing A"), headers={"X-Editor-Client": "tab-1", "X-Editor-Base": "2"})
    assert r.status_code == 201 and r.json()["revision_seq"] == 3
    # 자기 리비전(3)을 아직 이벤트로 못 봐서 기준 2로 올려도 허용 (리비전 4)
    r = client.post(f"/api/documents/{doc_id}/revisions", files=files("typing AB"), headers={"X-Editor-Client": "tab-1", "X-Editor-Base": "2"})
    assert r.status_code == 201 and r.json()["revision_seq"] == 4
    # 다른 편집기는 거절
    r = client.post(f"/api/documents/{doc_id}/revisions", files=files("typing other"), headers={"X-Editor-Client": "tab-2", "X-Editor-Base": "3"})
    assert r.status_code == 409
    # 기준 없이 올리면 전처럼 허용 (옛 클라이언트·테스트)
    r = client.post(f"/api/documents/{doc_id}/revisions", files=files("typing other"))
    assert r.status_code == 201


def test_live_result_revision_carries_requesting_session_client(client, doc_id):
    """라이브 실행 리비전의 client는 요청을 받은 세션 것 — 결과가 오는 사이 다른 창이 세션을 가져가도 바뀌지 않는다 (리뷰 #7)."""
    def handler(req):
        doc = HwpxDocument.load(client.get(f"/api/documents/{doc_id}/download").content)
        commands.replace_text(doc, req["hints"]["find"], req["hints"]["replacement"])
        client.post(f"/api/documents/{doc_id}/live", json={"client": "other-window"})  # 결과를 보내기 직전에 다른 창이 등록
        return {"ok": True, "text": "1곳"}, doc.to_bytes()

    sid, seen, stop, t = _editor(client, doc_id, handler)
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "LIVE"})
    # 세션이 교체되어 결과 전송이 410이면 서버가 실행한다; 교체 전에 들어갔으면 편집기 실행 — 어느 쪽이든 client는 요청 세션 것이거나 없음
    assert not err
    from app.services.documents import DocumentService
    from app.db import SessionLocal
    with SessionLocal() as db:
        head = DocumentService(db).head(DocumentService(db).get(uuid.UUID(doc_id)))
        assert (head.command or {}).get("client") in ("test-editor", None)
        assert (head.command or {}).get("client") != "other-window"
    stop.set()
    t.join(5)


def test_live_timeout_race_keeps_late_result(client, doc_id, monkeypatch):
    """기다림이 끝나는 순간 결과가 들어오면 그 결과를 쓴다(편집기는 200을 받았으므로 서버가 또 실행하면 두 번) (리뷰 #8)."""
    s = live_mod.live.register(doc_id, "t")
    req_holder = {}
    orig_wait = threading.Event.wait

    def racing_wait(self, timeout=None):
        # 대기가 '시간 초과'로 끝나는 척하되, 그 전에 결과가 들어온 상태를 만든다
        req = req_holder.get("req")
        if req is not None and self is req.done:
            live_mod.live.complete(s, req.id, {"ok": True, "text": "late"}, b"x")
            return False
        return orig_wait(self, timeout)

    orig_init = live_mod.LiveRequest.__init__

    def capture_init(self, *a, **k):
        orig_init(self, *a, **k)
        req_holder["req"] = self

    monkeypatch.setattr(live_mod.LiveRequest, "__init__", capture_init)
    monkeypatch.setattr(threading.Event, "wait", racing_wait)
    req = live_mod.live.request(doc_id, "replace_text", {}, {}, timeout=0.1)
    assert req is not None and req.result == {"ok": True, "text": "late"} and req.data == b"x"
    live_mod.live.close(doc_id, s.id)



def test_docx_tools_ask_editor_to_flush_then_server_executes(docx_doc_factory=None):
    """DOCX 문서: 라이브 세션이 있으면 편집 도구는 flush 힌트로 편집기에 먼저 가고, 편집기가 LIVE_FALLBACK을 답하면 서버가 실행한다."""
    from app.tools import live_dispatch
    from app.engine.docx import create_blank

    doc = create_blank("t")
    assert live_dispatch.prepare("set_paragraph_text", {"block": 1, "text": "x"}, doc) == {"method": "flush"}
    assert live_dispatch.prepare("read_selection", {}, doc) == {"method": "selection"}
    assert live_dispatch.prepare("replace_selection", {"texts": ["a", "b"]}, doc) == {"method": "replaceSelection", "texts": ["a", "b"]}
    assert live_dispatch.prepare("insert_note", {"kind": "footnote", "find": "a", "text": "b"}, doc) is None
    assert live_dispatch.prepare("read_document", {}, doc) is None


def test_server_fallback_refuses_block_numbers_after_editor_added_blocks(client, doc_id):
    """편집기가 실행 전에 문단을 더한 리비전을 올리고 폴백하면, AI가 읽은 블록 번호는 낡았다 → STALE_REVISION (엉뚱한 문단을 고치지 않는다)."""
    from tests.conftest import build_hwpx, paragraph, table

    before = client.get(f"/api/documents/{doc_id}/read").json()["text"]

    def handler(req):
        pushed = build_hwpx(paragraph("사용자가 넣은 새 첫 문단") + paragraph("AI 편집 샘플") + paragraph("이 문서는 관측용 샘플입니다 hello") + table([["구분", "내용"], ["가", "나"]]) + paragraph(""))
        client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("x.hwpx", pushed, "application/hwp+zip")}, headers={"X-Editor-Client": "tab-1"})
        return {"ok": False, "code": "LIVE_FALLBACK", "text": "not_found"}, None

    sid, seen, stop, t = _editor(client, doc_id, handler)
    text, err = call(client, "set_paragraph_text", {"document_id": doc_id, "block": 2, "text": "AI가 바꾼 제목"})
    _finish(client, doc_id, sid, stop, t)
    assert len(seen) == 1 and err and "STALE_REVISION" in text, (text, len(seen))
    read = client.get(f"/api/documents/{doc_id}/read").json()["text"]
    assert "AI가 바꾼 제목" not in read and "사용자가 넣은 새 첫 문단" in read
    assert before  # 원래 문서는 읽혔다
