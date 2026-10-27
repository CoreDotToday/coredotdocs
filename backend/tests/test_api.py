"""통합 테스트: FastAPI + PostgreSQL(컨테이너). EDITOR_DATABASE_URL이 가리키는 DB를 쓴다."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

pytestmark = pytest.mark.db


@pytest.fixture(scope="module")
def client():
    from app.db import engine
    from app.main import app

    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception as e:  # pragma: no cover
        pytest.skip(f"PostgreSQL에 연결할 수 없습니다: {e}")
    with TestClient(app, base_url="http://127.0.0.1") as c:
        from app.db import Base

        with engine.begin() as conn:  # 방언 중립 비우기 (PostgreSQL·SQLite)
            for table in reversed(Base.metadata.sorted_tables):
                conn.execute(table.delete())
        yield c


@pytest.fixture
def doc_id(client, sample_hwpx):
    r = client.post("/api/documents", files={"file": ("sample.hwpx", sample_hwpx, "application/hwp+zip")})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def call(client, name, arguments, token=None):
    headers = {"X-AI-Token": token} if token else {}
    r = client.post(f"/api/tools/{name}", json={"arguments": arguments}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    return body["content"][0]["text"], body.get("isError", False)


def test_upload_rejects_non_hwpx(client):
    r = client.post("/api/documents", files={"file": ("x.hwpx", b"not zip", "application/octet-stream")})
    assert r.status_code == 422


def test_upload_list_get_blocks_download(client, doc_id, sample_hwpx):
    assert any(d["id"] == doc_id for d in client.get("/api/documents").json())
    detail = client.get(f"/api/documents/{doc_id}").json()
    assert detail["block_count"] == 5 and detail["revision_seq"] == 1
    blocks = client.get(f"/api/documents/{doc_id}/blocks").json()["blocks"]
    assert blocks[3]["kind"] == "table" and blocks[3]["cells"][0]["text"] == "구분"
    r = client.get(f"/api/documents/{doc_id}/download")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/hwp+zip")
    assert r.content[:2] == b"PK"


def test_tools_list_matches_registry(client):
    tools = client.get("/api/tools").json()["tools"]
    assert [t["name"] for t in tools][:2] == ["list_documents", "read_document"]
    assert all(t["inputSchema"]["additionalProperties"] is False for t in tools)


def test_read_and_find_via_tools(client, doc_id):
    text, err = call(client, "read_document", {"document_id": doc_id})
    assert not err and text.startswith("[1] (빈 문단)\n[2] AI 편집 샘플")
    text, err = call(client, "find_text", {"document_id": doc_id, "query": "HELLO"})
    assert not err and text.startswith("[3] …")
    text, err = call(client, "find_text", {"query": "내용"})  # 모든 문서에서 (DB 인덱스 경로)
    assert not err and "표 1 (1,2)" in text


def test_search_api_uses_index_with_context(client, doc_id):
    hits = client.get("/api/search", params={"q": "샘플", "document_id": doc_id}).json()["hits"]
    assert [h["block_no"] for h in hits] == [2, 3]
    assert hits[1]["match"] == "샘플" and hits[1]["before"].endswith("관측용 ")
    # LIKE 메타문자는 글자 그대로
    assert client.get("/api/search", params={"q": "%"}).json()["hits"] == []


def test_edit_creates_revision_and_undo_restores(client, doc_id):
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "world"})
    assert not err and "1곳을 바꿨습니다" in text and "리비전 2" in text
    text, _ = call(client, "read_document", {"document_id": doc_id, "from": 3, "to": 3})
    assert text == "[3] 이 문서는 관측용 샘플입니다 world"
    # 글이 있는 칸은 overwrite 없이는 거절(전부-아니면-무), overwrite면 고친다
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 1, "text": "다"}]})
    assert err and "오류[CELL_NOT_EMPTY]" in text
    text, err = call(client, "set_table_cells", {"document_id": doc_id, "table": 1, "cells": [{"row": 2, "col": 1, "text": "다"}], "overwrite": True})
    assert not err and "리비전 3" in text and "검증: 문단" in text
    # 인덱스가 최신 내용을 따라간다
    assert client.get("/api/search", params={"q": "world", "document_id": doc_id}).json()["hits"][0]["block_no"] == 3
    assert client.get("/api/search", params={"q": "hello", "document_id": doc_id}).json()["hits"] == []
    text, err = call(client, "undo_last_edit", {"document_id": doc_id, "steps": 2})
    assert not err and "리비전 4" in text
    text, _ = call(client, "read_document", {"document_id": doc_id, "from": 3, "to": 3})
    assert text.endswith("hello")
    revs = client.get(f"/api/documents/{doc_id}/revisions").json()
    assert [r["seq"] for r in revs] == [1, 2, 3, 4] and revs[3]["tool"] == "undo_last_edit"
    # 더 되돌릴 편집이 없다
    text, err = call(client, "undo_last_edit", {"document_id": doc_id, "steps": 1})
    assert err and "되돌릴 편집이 없습니다" in text


def test_schema_violations_are_mcp_errors_not_http_errors(client, doc_id):
    text, err = call(client, "undo_last_edit", {"document_id": doc_id, "steps": 51})
    assert err and "steps" in text
    text, err = call(client, "read_document", {"document_id": doc_id, "from": 0})
    assert err and "from" in text
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "x", "bogus": 1})
    assert err and "Additional properties" in text
    text, err = call(client, "nope", {})
    assert err and "알 수 없는 도구" in text
    # JSON 문법상 유효한 짝 없는 서로게이트("\ud800")는 전송 계층(httpx)이 못 보내므로 원시 바이트로 보낸다
    raw = ('{"arguments": {"document_id": "%s", "find": "hello", "replace": "\\ud800"}}' % doc_id).encode()
    r = client.post("/api/tools/replace_text", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 200
    body = r.json()
    assert body.get("isError") and "U+D800" in body["content"][0]["text"]


def test_command_errors_are_returned_to_ai(client, doc_id):
    text, err = call(client, "delete_blocks", {"document_id": doc_id, "from": 5, "to": 1})
    assert err and "범위" in text
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "없는 글", "replace": "x"})
    assert err and "찾지 못했습니다" in text
    text, err = call(client, "read_document", {"document_id": "11111111-2222-4333-8444-555555555555"})
    assert err and "문서를 찾지 못했습니다" in text


def test_ai_session_scope_and_auth(client, doc_id, sample_hwpx):
    other = client.post("/api/documents", files={"file": ("other.hwpx", sample_hwpx, "application/hwp+zip")}).json()["id"]
    token = client.post("/api/ai/sessions", json={"name": "test", "document_ids": [doc_id]}).json()["token"]
    text, err = call(client, "list_documents", {}, token=token)
    assert doc_id in text and other not in text
    text, err = call(client, "read_document", {"document_id": other}, token=token)
    assert err and "다룰 수 없는 문서" in text
    r = client.post("/api/tools/list_documents", json={"arguments": {}}, headers={"X-AI-Token": "wrong"})
    assert r.status_code == 401
    # AI 편집은 actor=ai로 기록된다
    call(client, "set_paragraph_text", {"document_id": doc_id, "block": 3, "text": "AI가 고친 글"}, token=token)
    revs = client.get(f"/api/documents/{doc_id}/revisions").json()
    assert revs[-1]["actor"] == "ai" and revs[-1]["tool"] == "set_paragraph_text"


def test_events_publish_on_edit(client, doc_id):
    from app.services.events import bus

    received = []
    bus.add_sync_listener(received.append)
    try:
        call(client, "insert_content", {"document_id": doc_id, "markdown": "# 새 제목", "after": 0})
    finally:
        bus._sync_listeners.remove(received.append)
    kinds = [(e["type"], e.get("phase")) for e in received if e["document_id"] == doc_id]
    assert kinds == [("activity", "start"), ("edit", None), ("activity", "end")]
    assert received[1]["tool"] == "insert_content" and received[1]["blocks"] == [2]


def test_sse_endpoint_sends_ready(client, doc_id):
    with client.stream("GET", f"/api/documents/{doc_id}/events") as r:
        assert r.status_code == 200
        first = next(r.iter_lines())
        assert first == "event: ready"


def test_output_cap_cuts_on_line_boundary():
    from app.tools.runner import cap_output

    text = "\n".join(f"[{i}] " + "가" * 50 for i in range(1000))
    out = cap_output(text, "read_document", limit=1000)
    assert len(out) < 1200 and "앞부분만" in out and out.split("\n")[-2].startswith("[")


def test_docx_upload_and_tools(client):
    from tests.test_docx import make_docx

    r = client.post("/api/documents", files={"file": ("sample.docx", make_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 201 and r.json()["format"] == "docx"
    did = r.json()["id"]
    text, err = call(client, "read_document", {"document_id": did, "from": 2, "to": 2})
    assert not err and text == "[2] 이 문서는 관측용 샘플입니다 hello"
    text, err = call(client, "format_text", {"document_id": did, "find": "hello", "bold": True})
    assert not err
    r = client.get(f"/api/documents/{did}/download")
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")


def test_create_document_tool_and_endpoint(client):
    text, err = call(client, "create_document", {"title": "AI 보고서", "markdown": "# 머리\n\n본문", "format": "hwpx"})
    assert not err and "새 문서를 만들었습니다" in text
    did = text.split(": ")[1].split(" ")[0]
    text, _ = call(client, "read_document", {"document_id": did})
    assert "(16pt, 굵게) 머리" in text and "[3] 본문" in text
    r = client.post("/api/documents/new", json={"title": "웹에서 만든 문서", "markdown": "안녕", "format": "docx"})
    assert r.status_code == 201 and r.json()["format"] == "docx"


def test_image_upload_and_insert(client, doc_id):
    from tests.test_commands_full import png

    r = client.post(f"/api/documents/{doc_id}/images", files={"file": ("a.png", png(10, 10), "image/png")})
    assert r.status_code == 201, r.text
    image_id = r.json()["image_id"]
    assert client.get(f"/api/documents/{doc_id}/images").json()[0]["image_id"] == image_id
    text, err = call(client, "insert_image", {"document_id": doc_id, "image_id": image_id, "after": 3, "width_mm": 30})
    assert not err and "10×10px" in text
    assert client.get(f"/api/documents/{doc_id}").json()["block_count"] == 6
    r = client.post(f"/api/documents/{doc_id}/images", files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 422
    text, err = call(client, "insert_image", {"document_id": doc_id, "image_id": "11111111-2222-4333-8444-555555555555"})
    assert err and "그림을 찾지 못했습니다" in text


def test_format_and_fields_through_api(client, doc_id):
    text, err = call(client, "format_paragraphs", {"document_id": doc_id, "from": 2, "align": "center", "line_spacing": 160})
    assert not err
    text, err = call(client, "format_paragraphs", {"document_id": doc_id, "from": 2, "left": 1e308})
    assert err and "left" in text
    text, err = call(client, "list_fields", {"document_id": doc_id})
    assert not err and "누름틀(필드)이 없습니다" in text
    text, err = call(client, "insert_table_rows", {"document_id": doc_id, "table": 1, "rows": [["x", "y"]]})
    assert not err and "행 1개" in text
    text, err = call(client, "read_document", {"document_id": doc_id, "table": 1, "row_from": 3})
    assert not err and "(3,1)" in text and "구분" not in text


def test_push_revision_and_rename(client, doc_id, sample_hwpx):
    """화면 편집기가 내보낸 파일을 리비전으로 올리기: 같은 내용이면 리비전 없음, 다르면 새 리비전 + edit 이벤트(source=editor)."""
    from app.services.events import bus

    seen = []
    bus.add_sync_listener(seen.append)
    r = client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("sample.hwpx", sample_hwpx, "application/hwp+zip")})
    assert r.status_code == 201 and r.json() == {"revision_seq": 1, "changed": False}
    text, err = call(client, "replace_text", {"document_id": doc_id, "find": "hello", "replace": "world"})
    assert not err
    edited = client.get(f"/api/documents/{doc_id}/download").content
    r = client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("sample.hwpx", sample_hwpx, "application/hwp+zip")}, data={"summary": "편집기 시험"})
    assert r.status_code == 201 and r.json() == {"revision_seq": 3, "changed": True}
    assert client.get(f"/api/documents/{doc_id}/download").content == sample_hwpx
    assert any(e["type"] == "edit" and e.get("source") == "editor" and e["revision_seq"] == 3 for e in seen)
    assert client.get(f"/api/documents/{doc_id}/revisions").json()[-1]["summary"] == "편집기 시험"
    # 편집 도구는 시작·끝 활동 이벤트를 낸다 (화면의 "AI가 … 중" 알림)
    phases = [e.get("phase") for e in seen if e["type"] == "activity" and e["tool"] == "replace_text"]
    assert phases == ["start", "end"]
    assert edited != sample_hwpx
    r = client.post(f"/api/documents/{doc_id}/revisions", files={"file": ("x.hwpx", b"not zip", "application/hwp+zip")})
    assert r.status_code == 422
    r = client.patch(f"/api/documents/{doc_id}", json={"title": "새 이름", "filename": "/Users/me/새 이름"})
    assert r.status_code == 200 and r.json()["filename"] == "새 이름.hwpx" and r.json()["title"] == "새 이름"
    assert client.get(f"/api/documents/{doc_id}").json()["title"] == "새 이름"
