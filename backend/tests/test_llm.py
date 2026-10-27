"""LLM 게이트웨이 어댑터 단위 테스트 (네트워크 없음) + 채팅 API 통합(가짜 전송으로 도구 루프)."""

from __future__ import annotations

import json

import pytest

from app.api import chat as chat_api
from app.llm import gateway
from app.llm.gateway import GatewayError, ToolCall, Turn, chat, check_key, endpoint, parse_anthropic, parse_openai, parse_responses, route, to_anthropic, to_openai, to_responses, tool_specs

TOOLS = [{"name": "read_document", "description": "읽기", "inputSchema": {"type": "object", "properties": {"document_id": {"type": "string"}}, "required": ["document_id"]}}]


def test_route_by_prefix():
    assert route("claude-sonnet-5-5") == "anthropic"
    assert route("Claude-Opus-5-5") == "anthropic"
    assert route("gemini-3.8-flash") == "gemini"
    assert route("gpt-4o-mini") == "openai"
    assert route("gpt-5.5") == "openai"
    assert route("deepseek-v4-pro") == "deepseek"
    assert route("grok-4.7") == "grok"
    assert route("muse-spark-1.3") == "meta"
    assert route("qwen/qwen3.8-max") == "openrouter"
    # Chat Completions에서 함수 도구를 거부하는 OpenAI 모델은 Responses로
    for m in ("gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.3-codex", "gpt-5.5-pro", "o3-pro"):
        assert route(m) == "responses", m


def test_tool_specs_per_provider():
    a = tool_specs("anthropic", TOOLS)[0]
    assert a["input_schema"] == TOOLS[0]["inputSchema"] and "type" not in a
    o = tool_specs("openai", TOOLS)[0]
    assert o["type"] == "function" and o["function"]["parameters"] == TOOLS[0]["inputSchema"]


def test_turns_to_anthropic_merges_tool_results_and_keeps_nonempty_text():
    turns = [
        Turn("user", "읽어줘"),
        Turn("assistant", "", [ToolCall("t1", "read_document", {"document_id": "x"}), ToolCall("t2", "find_text", {"query": "a"})]),
        Turn("tool", "[1] 제목", tool_call_id="t1", name="read_document"),
        Turn("tool", "못 찾음", tool_call_id="t2", name="find_text", is_error=True),
        Turn("assistant", "읽었습니다."),
    ]
    msgs = to_anthropic(turns)
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert msgs[1]["content"][0]["type"] == "tool_use" and msgs[1]["content"][0]["input"] == {"document_id": "x"}
    results = msgs[2]["content"]
    assert len(results) == 2 and results[1]["is_error"] is True and results[0]["tool_use_id"] == "t1"
    assert msgs[3]["content"] == [{"type": "text", "text": "읽었습니다."}]


def test_turns_to_openai_reuses_raw_tool_call():
    raw = {"id": "call_1", "type": "function", "function": {"name": "read_document", "arguments": "{\"document_id\":\"x\"}"}, "extra_content": {"google": {"thought_signature": "sig"}}}
    turns = [Turn("user", "읽어줘"), Turn("assistant", "", [ToolCall("call_1", "read_document", {"document_id": "x"}, raw=raw)]), Turn("tool", "[1] 제목", tool_call_id="call_1")]
    msgs = to_openai("시스템", turns)
    assert msgs[0] == {"role": "system", "content": "시스템"}
    assert msgs[2]["tool_calls"][0] is raw  # Gemini thought_signature 보존
    assert msgs[3] == {"role": "tool", "tool_call_id": "call_1", "content": "[1] 제목"}
    plain = to_openai("s", [Turn("assistant", "답", [ToolCall("c", "find_text", {"query": "a"})])])[1]
    assert json.loads(plain["tool_calls"][0]["function"]["arguments"]) == {"query": "a"}


def test_parse_responses():
    a = parse_anthropic({"content": [{"type": "text", "text": "먼저 "}, {"type": "tool_use", "id": "t", "name": "read_document", "input": {"document_id": "x"}}], "usage": {"input_tokens": 3, "output_tokens": 4}, "stop_reason": "tool_use"})
    assert a.text == "먼저 " and a.tool_calls[0].name == "read_document" and a.usage == {"input_tokens": 3, "output_tokens": 4} and a.stop == "tool_use"
    o = parse_openai({"choices": [{"message": {"content": None, "tool_calls": [{"id": "c", "type": "function", "function": {"name": "find_text", "arguments": "{bad"}}]}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 1, "completion_tokens": 2}})
    assert o.text == "" and o.tool_calls[0].arguments["_invalid_json"] == "{bad" and o.usage["output_tokens"] == 2
    with pytest.raises(GatewayError):
        parse_openai({"choices": []})


def test_chat_builds_provider_requests_and_maps_errors():
    seen = []

    def transport(method, url, headers, body):
        seen.append((method, url, headers, body))
        if "anthropic" in url:
            return 200, {"content": [{"type": "text", "text": "안녕"}], "usage": {}}
        return 401, {"error": {"message": "bad"}}

    r = chat(model="claude-sonnet-5-5", system="S", turns=[Turn("user", "hi")], tools=TOOLS, api_key="cdt_x", transport=transport, max_tokens=99)
    assert r.text == "안녕"
    m, url, headers, body = seen[0]
    assert url.endswith("/llm/anthropic/v1/messages") and headers["Authorization"] == "Bearer cdt_x" and headers["anthropic-version"]
    assert body["system"] == "S" and body["max_tokens"] == 99 and body["tools"][0]["input_schema"]
    with pytest.raises(GatewayError) as e:
        chat(model="gpt-4o-mini", system="S", turns=[Turn("user", "hi")], tools=TOOLS, api_key="cdt_x", transport=transport)
    assert e.value.status == 401 and "키" in e.value.message
    _, url, _, body = seen[1]
    assert url.endswith("/llm/openai/v1/chat/completions") and "max_completion_tokens" in body and "max_tokens" not in body
    chat_gemini = lambda: chat(model="gemini-3.8-flash", system="S", turns=[Turn("user", "hi")], tools=[], api_key="k", transport=transport)  # noqa: E731
    with pytest.raises(GatewayError):
        chat_gemini()
    _, url, _, body = seen[2]
    assert "/llm/gemini/v1beta/openai/chat/completions" in url and "max_tokens" in body and "tools" not in body


def test_compat_endpoints():
    assert endpoint("grok", "https://g").endswith("/llm/grok/v1/chat/completions")
    assert endpoint("openrouter", "https://g").endswith("/llm/openrouter/v1/chat/completions")
    assert endpoint("gemini", "https://g").endswith("/llm/gemini/v1beta/openai/chat/completions")
    assert endpoint("responses", "https://g").endswith("/llm/openai/v1/responses")


def test_responses_round_trip_replays_output_items():
    out = [
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "xx"},
        {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read_document", "arguments": '{"document_id": "d"}'},
    ]
    r = parse_responses({"status": "completed", "output": out, "usage": {"input_tokens": 5, "output_tokens": 2}})
    assert r.tool_calls[0].id == "call_1" and r.tool_calls[0].arguments == {"document_id": "d"} and r.items == out
    items = to_responses([Turn("user", "hi"), Turn("assistant", "", r.tool_calls, items=r.items), Turn("tool", "실패", tool_call_id="call_1", is_error=True)])
    assert items[0] == {"role": "user", "content": "hi"}
    assert items[1:3] == out  # 추론 항목까지 그대로 돌려준다
    assert items[3] == {"type": "function_call_output", "call_id": "call_1", "output": "오류: 실패"}
    # 이전 실행(기록)에서 온 assistant 턴은 원본이 없으므로 메시지·호출로 만든다
    items = to_responses([Turn("assistant", "답", [ToolCall("c2", "read_document", {})])])
    assert items == [{"role": "assistant", "content": "답"}, {"type": "function_call", "call_id": "c2", "name": "read_document", "arguments": "{}"}]
    text = parse_responses({"output": [{"type": "message", "content": [{"type": "output_text", "text": "끝"}]}], "status": "completed"})
    assert text.text == "끝" and not text.tool_calls


def test_responses_request_and_fallback_from_chat_completions():
    seen = []

    def transport(method, url, headers, body):
        seen.append((url, body))
        if url.endswith("/chat/completions") and body.get("tools"):
            return 400, {"error": {"message": "Function tools with reasoning_effort are not supported for gpt-5.5-next in /v1/chat/completions. To use function tools, use /v1/responses."}}
        if url.endswith("/chat/completions"):
            return 200, {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}
        return 200, {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]}

    r = chat(model="gpt-6.1-sol", system="S", turns=[Turn("user", "hi")], tools=TOOLS, api_key="k", transport=transport, max_tokens=50)
    url, body = seen[-1]
    assert url.endswith("/llm/openai/v1/responses") and r.text == "ok"
    assert body["instructions"] == "S" and body["store"] is False and body["max_output_tokens"] == 50
    assert body["tools"][0] == {"type": "function", "name": "read_document", "description": "읽기", "parameters": TOOLS[0]["inputSchema"]}
    seen.clear()
    r = chat(model="gpt-5.5-next", system="S", turns=[Turn("user", "hi")], tools=TOOLS, api_key="k", transport=transport)  # 규칙이 모르는 새 모델
    assert [u.rsplit("/", 1)[-1] for u, _ in seen] == ["completions", "responses"] and r.text == "ok"
    seen.clear()
    chat(model="grok-4.7", system="S", turns=[Turn("user", "hi")], tools=[], api_key="k", transport=transport, max_tokens=7)
    assert seen[0][0].endswith("/llm/grok/v1/chat/completions") and seen[0][1]["max_tokens"] == 7


@pytest.mark.parametrize("models", [[], [{"id": "gpt-test", "provider": "openai"}]])
def test_check_key_uses_authenticated_free_pricing(monkeypatch, models):
    monkeypatch.setattr(gateway.settings, "cdt_api_base", "https://gateway.example/")
    seen = []

    def transport(method, url, headers, body):
        seen.append((method, url, headers, body))
        return 200, {"models": models, "total": len(models), "updated_at": "2026-10-27"}

    assert check_key("cdt_test", transport) is True
    assert seen == [("GET", "https://gateway.example/llm/v1/pricing", {"Authorization": "Bearer cdt_test"}, None)]


def test_check_key_rejects_invalid_key():
    assert check_key("cdt_invalid", lambda m, u, h, b: (401, {"error": {"code": "invalid_api_key", "type": "authentication_error"}})) is False


@pytest.mark.parametrize("status", [403, 429, 500, 504])
def test_check_key_surfaces_permission_rate_limit_and_gateway_failures(status):
    with pytest.raises(GatewayError) as error:
        check_key("cdt_test", lambda m, u, h, b: (status, {"error": {"message": "upstream failure"}}))
    assert error.value.status == status


@pytest.mark.parametrize("status,data", [
    (200, {}),
    (200, {"data": []}),
    (200, {"models": None}),
    (200, {"models": {}}),
    (200, {"error": {"message": "unexpected response"}}),
    (204, {"models": []}),
    (302, {"models": []}),
])
def test_check_key_does_not_accept_malformed_or_redirect_responses(status, data):
    with pytest.raises(GatewayError) as error:
        check_key("cdt_test", lambda m, u, h, b: (status, data))
    assert error.value.status == 502


@pytest.mark.parametrize("upstream_status,data,expected_status", [
    (200, {"models": []}, 200),
    (401, {"error": {"code": "invalid_api_key"}}, 401),
    (403, {"error": {"message": "permission denied"}}, 403),
    (429, {"error": {"message": "rate limit"}}, 429),
    (504, {"error": {"message": "gateway timeout"}}, 502),
    (200, {}, 502),
])
def test_key_api_preserves_validation_result_without_model_cache(monkeypatch, upstream_status, data, expected_status):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(chat_api.router)
    monkeypatch.setattr(chat_api, "_pricing", (float("inf"), [{"id": "cached-model"}]))
    seen = []

    def transport(method, url, headers, body):
        seen.append((method, url, headers, body))
        return upstream_status, data

    monkeypatch.setattr(gateway, "http_transport", transport)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        response = client.get("/api/ai/key", headers={"X-CDT-Key": "cdt_mock_key_1234"})
    assert response.status_code == expected_status
    assert len(seen) == 1 and seen[0][0] == "GET" and seen[0][1].endswith("/llm/v1/pricing")
    assert seen[0][2] == {"Authorization": "Bearer cdt_mock_key_1234"} and seen[0][3] is None
    if expected_status == 200:
        assert response.json() == {"ok": True, "key_hint": "cdt_mo…1234"}
    else:
        assert "detail" in response.json() and "ok" not in response.json()


# --- 채팅 API: 가짜 게이트웨이로 도구 루프 끝까지 ------------------------------------------

pytestmark_db = pytest.mark.db


def sse_events(text: str) -> list[dict]:
    out = []
    for chunk in text.split("\n\n"):
        for line in chunk.splitlines():
            if line.startswith("data: "):
                out.append(json.loads(line[6:]))
    return out


@pytest.mark.db
def test_chat_api_runs_tool_loop(monkeypatch, client_with_doc):
    client, doc_id = client_with_doc
    calls = {"n": 0}

    def fake_transport(method, url, headers, body):
        calls["n"] += 1
        assert headers["Authorization"] == "Bearer cdt_test"
        if calls["n"] == 1:
            # 모델이 틀린 document_id를 주더라도 서버가 현재 문서로 고정한다
            assert body["messages"][-1]["content"] == "2번 블록을 '고친 글'로 바꿔줘"
            return 200, {"content": [{"type": "tool_use", "id": "t1", "name": "set_paragraph_text", "input": {"document_id": "1", "block": 2, "text": "고친 글"}}], "usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "tool_use"}
        results = body["messages"][-1]["content"]
        assert results[0]["type"] == "tool_result" and "리비전 2" in results[0]["content"]
        return 200, {"content": [{"type": "text", "text": "2번 블록을 고쳤습니다."}], "usage": {"input_tokens": 20, "output_tokens": 6}, "stop_reason": "end_turn"}

    monkeypatch.setattr(gateway, "http_transport", fake_transport)
    r = client.post("/api/ai/chat", json={"document_id": doc_id, "model": "claude-sonnet-5-5", "message": "2번 블록을 '고친 글'로 바꿔줘"}, headers={"X-CDT-Key": "cdt_test"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = sse_events(r.text)
    kinds = [e["type"] for e in events]
    assert kinds == ["tool_call", "tool_result", "text", "done", "end"], kinds
    assert events[0]["arguments"]["document_id"] == doc_id and events[1]["ok"] is True
    assert events[3]["usage"] == {"input_tokens": 30, "output_tokens": 11}
    blocks = client.get(f"/api/documents/{doc_id}/blocks").json()
    assert blocks["revision_seq"] == 2 and blocks["blocks"][1]["text"] == "고친 글"
    revs = client.get(f"/api/documents/{doc_id}/revisions").json()
    assert revs[-1]["actor"] == "ai" and revs[-1]["tool"] == "set_paragraph_text"


@pytest.mark.db
def test_chat_api_requires_key_and_reports_gateway_error(monkeypatch, client_with_doc):
    client, doc_id = client_with_doc
    monkeypatch.setattr("app.api.chat.settings.cdt_api_key", None)
    r = client.post("/api/ai/chat", json={"document_id": doc_id, "message": "안녕"})
    assert r.status_code == 401
    monkeypatch.setattr(gateway, "http_transport", lambda m, u, h, b: (402, {"error": {"message": "no credits"}}))
    r = client.post("/api/ai/chat", json={"document_id": doc_id, "message": "안녕"}, headers={"X-CDT-Key": "cdt_x"})
    events = sse_events(r.text)
    assert events[0]["type"] == "error" and events[0]["status"] == 402 and "크레딧" in events[0]["message"]
    r = client.post("/api/ai/chat", json={"document_id": doc_id, "message": "안녕", "model": "bad model!"}, headers={"X-CDT-Key": "cdt_x"})
    assert r.status_code == 422


@pytest.mark.db
def test_key_check_and_models(monkeypatch, client_with_doc):
    client, _ = client_with_doc
    r = client.get("/api/ai/models").json()
    assert r["default"] == "claude-sonnet-5-5" and r["pricing"] is False
    assert {"gpt-6.1-sol", "grok-4.7", "qwen/qwen3.8-max"} <= {m["id"] for m in r["models"]} and all(m["verified"] for m in r["models"])
    rows = [
        {"id": "gpt-6.1-sol", "provider": "openai", "category": "chat", "input_per_token": 0.003716, "output_per_token": 0.01858},
        {"id": "gpt-4o", "provider": "openai", "category": "chat", "input_per_token": 0.0046, "output_per_token": 0.0185},
        {"id": "gpt-4o-2024-08-06", "provider": "openai", "category": "chat"},  # 날짜 고정판은 뺀다
        {"id": "gemini-3-pro-image", "provider": "google", "category": "chat"},  # 그림 모델은 뺀다
        {"id": "claude-3-opus", "provider": "anthropic", "category": "chat", "retired": True},
        {"id": "grok-4.7", "provider": "grok", "category": "chat", "retired": True},  # 은퇴한 추천 모델은 숨긴다
        {"id": "text-embedding-3-small", "provider": "openai", "category": "embedding"},
    ]
    monkeypatch.setattr(gateway, "http_transport", lambda m, u, h, b: (200, {"models": rows}) if u.endswith("/llm/v1/pricing") else (401, {}))
    monkeypatch.setattr(chat_api, "_pricing", None)
    r = client.get("/api/ai/models", headers={"X-CDT-Key": "cdt_x"}).json()
    by_id = {m["id"]: m for m in r["models"]}
    assert r["pricing"] is True and by_id["gpt-6.1-sol"]["output_per_1k"] == 18.58 and by_id["gpt-6.1-sol"]["verified"] is True
    assert by_id["gpt-4o"]["verified"] is False and by_id["gpt-4o"]["group"] == "GPT"
    assert not {"gpt-4o-2024-08-06", "gemini-3-pro-image", "claude-3-opus", "grok-4.7", "text-embedding-3-small"} & set(by_id)
    monkeypatch.setattr(chat_api, "_pricing", None)
    monkeypatch.setattr(gateway, "http_transport", lambda m, u, h, b: (200, {"models": []}) if h["Authorization"] == "Bearer cdt_good" else (401, {}))
    assert client.get("/api/ai/key", headers={"X-CDT-Key": "cdt_good"}).json()["ok"] is True
    assert client.get("/api/ai/key", headers={"X-CDT-Key": "cdt_bad"}).status_code == 401


@pytest.mark.db
def test_layout_report_shows_in_document_info(client_with_doc):
    client, doc_id = client_with_doc
    info = client.post("/api/tools/document_info", json={"arguments": {"document_id": doc_id}}).json()["content"][0]["text"]
    assert "화면 쪽 수: 아직 없음" in info
    assert client.post(f"/api/documents/{doc_id}/layout", json={"pages": 3, "revision_seq": 99}).json()["accepted"] is False
    assert client.post(f"/api/documents/{doc_id}/layout", json={"pages": 3, "revision_seq": 1, "engine": "rhwp 0.8.7"}).json()["accepted"] is True
    assert client.get(f"/api/documents/{doc_id}").json()["layout"] == {"pages": 3, "revision_seq": 1, "engine": "rhwp 0.8.7"}
    info = client.post("/api/tools/document_info", json={"arguments": {"document_id": doc_id}}).json()["content"][0]["text"]
    assert "화면 쪽 수: 3쪽 (rhwp 0.8.7, 현재 리비전 기준)" in info
    client.post("/api/tools/set_paragraph_text", json={"arguments": {"document_id": doc_id, "block": 2, "text": "바뀜"}})
    info = client.post("/api/tools/document_info", json={"arguments": {"document_id": doc_id}}).json()["content"][0]["text"]
    assert "리비전 1 기준" in info
