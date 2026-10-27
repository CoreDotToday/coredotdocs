"""실제 core.today 게이트웨이로 한 바퀴 (CDT_API_KEY가 있을 때만; 크레딧을 조금 쓴다)."""

from __future__ import annotations

import json
import os

import pytest

KEY = os.environ.get("CDT_API_KEY")
pytestmark = [pytest.mark.db, pytest.mark.skipif(not KEY, reason="CDT_API_KEY 없음")]


def _events(text):
    return [json.loads(l[6:]) for chunk in text.split("\n\n") for l in chunk.splitlines() if l.startswith("data: ")]


def test_key_check_live(client_with_doc):
    client, _ = client_with_doc
    assert client.get("/api/ai/key", headers={"X-CDT-Key": KEY}).json()["ok"] is True
    assert client.get("/api/ai/key", headers={"X-CDT-Key": "cdt_invalid"}).status_code == 401


@pytest.mark.parametrize("model", ["claude-haiku-4-5", "gpt-4o-mini", "gemini-3.8-flash"])
def test_chat_live_reads_document(client_with_doc, model):
    client, doc_id = client_with_doc
    r = client.post("/api/ai/chat", json={"document_id": doc_id, "model": model, "message": "read_document 도구로 이 문서의 블록 1~3을 읽고, 1번 블록의 글을 그대로 한 줄로 알려줘. 편집은 하지 마."}, headers={"X-CDT-Key": KEY})
    events = _events(r.text)
    kinds = [e["type"] for e in events]
    assert "error" not in kinds, events
    assert "tool_call" in kinds and kinds[-2:] == ["done", "end"], kinds
    assert any(e["type"] == "tool_result" and e["ok"] for e in events)
    assert events[-2]["usage"]["input_tokens"] > 0


@pytest.fixture(params=["hwpx", "docx"])
def live_edit_document(client_with_doc, request):
    """실제 AI 편집에 쓰는 문서를 API로 만들고 테스트 결과와 무관하게 정리한다."""
    client, seed_id = client_with_doc
    document_id = None
    try:
        response = client.post("/api/documents/new", json={
            "title": f"Release AI edit smoke {request.param}",
            "format": request.param,
            "markdown": "릴리스 AI 편집 검증\n\nRELEASE_AI_BEFORE\n\nRELEASE_AI_UNCHANGED",
        })
        assert response.status_code == 201, response.text
        document_id = response.json()["id"]
        baseline = client.get(f"/api/documents/{document_id}/read")
        assert baseline.status_code == 200, baseline.text
        assert baseline.json()["text"].count("RELEASE_AI_BEFORE") == 1
        yield client, document_id, baseline.json()
    finally:
        for created_id in [document_id, seed_id]:
            if created_id is not None:
                response = client.delete(f"/api/documents/{created_id}")
                assert response.status_code == 204, response.text


def test_chat_live_edits_reads_back_and_undoes(live_edit_document):
    client, document_id, baseline = live_edit_document
    response = client.post("/api/ai/chat", json={
        "document_id": document_id,
        "model": "gpt-4o-mini",
        "message": (
            "먼저 read_document 도구로 이 문서를 읽으세요. 그다음 replace_text 도구를 한 번 호출해서 "
            "정확한 문자열 RELEASE_AI_BEFORE를 RELEASE_AI_AFTER로 바꾸세요. "
            "읽은 리비전을 expected_revision으로 전달하세요. 그 밖의 글, 서식, 문단은 바꾸지 말고 "
            "RELEASE_AI_UNCHANGED는 그대로 두세요. 편집 뒤 read_document로 결과를 확인하세요."
        ),
    }, headers={"X-CDT-Key": KEY})
    assert response.status_code == 200, response.text
    events = _events(response.text)
    kinds = [event["type"] for event in events]
    assert "error" not in kinds, events
    assert kinds[-2:] == ["done", "end"], kinds
    successful_results = [event for event in events if event["type"] == "tool_result" and event["ok"]]
    assert any(event["name"] == "read_document" for event in successful_results), events
    assert len([event for event in successful_results if event["name"] == "replace_text"]) == 1, events
    assert events[-2]["usage"]["input_tokens"] > 0

    after_response = client.get(f"/api/documents/{document_id}/read")
    assert after_response.status_code == 200, after_response.text
    after = after_response.json()
    assert after["text"] == baseline["text"].replace("RELEASE_AI_BEFORE", "RELEASE_AI_AFTER")
    assert after["revision_seq"] == baseline["revision_seq"] + 1
    revisions = client.get(f"/api/documents/{document_id}/revisions").json()
    assert revisions[-1]["actor"] == "ai" and revisions[-1]["tool"] == "replace_text"

    undo = client.post(f"/api/documents/{document_id}/undo", json={"steps": 1})
    assert undo.status_code == 200, undo.text
    restored_response = client.get(f"/api/documents/{document_id}/read")
    assert restored_response.status_code == 200, restored_response.text
    restored = restored_response.json()
    assert restored["text"] == baseline["text"]
    assert restored["revision_seq"] == after["revision_seq"] + 1
