"""MCP 브리지가 API 주소를 찾는 순서: EDITOR_API_URL > 상태 파일 > 기본값."""

import json

from app.mcp_stdio import resolve_api_base


def test_resolve_api_base(tmp_path):
    state = tmp_path / "server.json"
    state.write_text(json.dumps({"api_url": "http://127.0.0.1:47371"}), encoding="utf-8")
    assert resolve_api_base({}) == "http://127.0.0.1:8000"
    assert resolve_api_base({"EDITOR_STATE_FILE": str(state)}) == "http://127.0.0.1:47371"
    assert resolve_api_base({"EDITOR_STATE_FILE": str(state), "EDITOR_API_URL": "http://x:1"}) == "http://x:1"
    state.write_text("garbage", encoding="utf-8")
    assert resolve_api_base({"EDITOR_STATE_FILE": str(state)}) == "http://127.0.0.1:8000"
    assert resolve_api_base({"EDITOR_STATE_FILE": str(tmp_path / "none.json")}) == "http://127.0.0.1:8000"
