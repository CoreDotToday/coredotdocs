import io
import json
from pathlib import Path
import tomllib

import httpx

from app.mcp_stdio import StdioBridge
from app import mcp_stdio


def make_bridge(calls):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.headers.get("x-ai-token"), request.content))
        if request.url.path == "/api/tools":
            return httpx.Response(200, json={"tools": [{"name": "read_document", "inputSchema": {"type": "object"}}]})
        if request.url.path.startswith("/api/tools/"):
            if request.headers.get("x-ai-token") == "bad":
                return httpx.Response(401, json={"detail": "nope"})
            return httpx.Response(200, json={"content": [{"type": "text", "text": "ok"}]})
        return httpx.Response(404)

    client = httpx.Client(base_url="http://editor", transport=httpx.MockTransport(handler), headers={"X-AI-Token": "good"})
    return StdioBridge(client)


def test_initialize_then_list_and_call():
    calls = []
    bridge = make_bridge(calls)
    r = bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    assert r["result"]["protocolVersion"] == "2025-06-18" and r["result"]["serverInfo"]["name"] == "coredotdocs"
    metadata = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert r["result"]["serverInfo"]["version"] == metadata["project"]["version"]
    r = bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert r["result"]["tools"][0]["name"] == "read_document"
    r = bridge.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_document", "arguments": {"document_id": "x"}}})
    assert r["result"]["content"][0]["text"] == "ok"
    assert calls[-1][1] == "/api/tools/read_document" and json.loads(calls[-1][3]) == {"arguments": {"document_id": "x"}}


def test_stdio_main_uses_utf8_with_cp949_windows_pipes(monkeypatch):
    query = "한글 — 문서 📄"
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "find_text", "arguments": {"query": query}}},
    ]
    incoming = io.BytesIO(("\n".join(json.dumps(message, ensure_ascii=False) for message in messages) + "\n").encode("utf-8"))
    outgoing = io.BytesIO()
    stdin = io.TextIOWrapper(incoming, encoding="cp949")
    stdout = io.TextIOWrapper(outgoing, encoding="cp949")
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"content": [{"type": "text", "text": query}]})

    with httpx.Client(base_url="http://editor", transport=httpx.MockTransport(handler)) as client:
        with monkeypatch.context() as patch:
            patch.setenv("EDITOR_API_URL", "http://editor")
            patch.setattr(mcp_stdio.httpx, "Client", lambda **kwargs: client)
            patch.setattr(mcp_stdio.sys, "stdin", stdin)
            patch.setattr(mcp_stdio.sys, "stdout", stdout)
            mcp_stdio.main()
    assert stdin.encoding == stdout.encoding == "utf-8"
    assert calls == [{"arguments": {"query": query}}]
    encoded = outgoing.getvalue()
    assert b"\r\n" not in encoded
    responses = [json.loads(line) for line in encoded.decode("utf-8").splitlines()]
    assert responses[0]["result"]["serverInfo"]["title"] == mcp_stdio.SERVER_INFO["title"]
    assert responses[1]["result"]["content"][0]["text"] == query


def test_protocol_shape_errors():
    bridge = make_bridge([])
    assert bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["error"]["code"] == -32602  # initialize 전
    bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "", "arguments": {}}})["error"]["code"] == -32602
    assert bridge.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "x", "arguments": []}})["error"]["code"] == -32602
    assert bridge.handle({"jsonrpc": "2.0", "id": 4, "method": "nope"})["error"]["code"] == -32601
    assert bridge.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}) is None
    assert bridge.handle([1, 2])["error"]["code"] == -32600
    assert bridge.handle({"jsonrpc": "2.0", "id": 5, "method": "ping"})["result"] == {}


def test_bad_token_becomes_tool_error_not_crash():
    bridge = make_bridge([])
    bridge.client.headers["X-AI-Token"] = "bad"
    bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    r = bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "read_document", "arguments": {}}})
    assert r["result"]["isError"] is True


def test_cancelled_request_gets_no_response_and_progress_is_sent():
    sent = []
    calls = []
    bridge = make_bridge(calls)
    bridge.write = sent.append
    bridge.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert bridge.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7}}) is None
    assert bridge.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "read_document", "arguments": {}}}) is None
    assert not any(c[1] == "/api/tools/read_document" for c in calls)  # 취소된 요청은 실행하지 않는다
    r = bridge.handle({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "read_document", "arguments": {}, "_meta": {"progressToken": "p1"}}})
    assert r["result"]["content"][0]["text"] == "ok"
    assert sent and sent[0]["method"] == "notifications/progress" and sent[0]["params"]["progressToken"] == "p1"
