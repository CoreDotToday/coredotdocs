"""AI 앱(Claude Desktop 등)용 stdio MCP 서버. 도구 목록·호출을 HTTP API로 전달한다.

실행: EDITOR_API_URL=http://127.0.0.1:8000 EDITOR_AI_TOKEN=<토큰> python -m app.mcp_stdio
표준 출력에는 JSON-RPC 한 줄씩만 쓴다. 기록은 표준 오류로.

- 요청은 도착 순서대로 처리하되, `notifications/cancelled`가 먼저 오면 해당 요청은 실행하지 않고 답하지 않는다.
- `_meta.progressToken`이 있으면 호출 시작 시 진행 알림 하나를 보낸다 (HTTP 호출은 짧아 중간 진행은 없다).
"""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any, Callable

import httpx

from . import __version__

PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
SERVER_INFO = {"name": "coredotdocs", "title": "coredotdocs — HWPX AI 편집기", "version": __version__}
INSTRUCTIONS = (
    "HWPX·DOCX 문서를 블록(문단·표) 번호로 읽고 고치는 도구입니다. 먼저 list_documents로 document_id를 얻고, "
    "고치기 전에 read_document로 읽으세요. 편집은 바로 새 리비전으로 저장되고 undo_last_edit로 되돌릴 수 있습니다. "
    "글을 넣거나 지우면 뒤 블록 번호가 바뀌므로 다시 읽으세요. 편집 도구에는 document_info(또는 직전 편집 응답)의 리비전을 expected_revision으로 넘기세요. "
    "실패하면 응답이 '오류[CODE] …'로 시작합니다: AMBIGUOUS_TARGET(후보 목록, block이나 all로 좁히기), HOLDS_OBJECT(개체 든 블록·칸, "
    "사용자가 시켰을 때만 include_objects), CELL_NOT_EMPTY(글 있는 칸, 사용자가 시켰을 때만 overwrite), STALE_REVISION(다시 읽기), "
    "FOREIGN_CHANGES(사용자 편집이 끼어 되돌리기 거절, 묻고 force), UNEXPECTED_CHANGE(구조가 바뀌어 적용 안 함). "
    "도구가 해냈다고 알린 편집만 했다고 말하세요."
)


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


class StdioBridge:
    def __init__(self, client: httpx.Client, write: Callable[[dict], None] | None = None):
        self.client = client
        self.write = write or (lambda m: None)
        self.initialized = False
        self.cancelled: set[Any] = set()
        self.in_flight: set[Any] = set()
        self._lock = threading.Lock()

    def handle(self, message: Any) -> dict | None:
        """요청이면 응답 dict(취소됐으면 None), 알림이면 None."""
        if not _is_object(message) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": message.get("id") if _is_object(message) else None, "error": {"code": -32600, "message": "Invalid Request"}}
        msg_id = message.get("id")
        method = message["method"]
        params = message.get("params")
        is_request = "id" in message
        if params is not None and not _is_object(params):
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32602, "message": "Invalid params"}} if is_request else None
        params = params or {}
        if method == "notifications/cancelled":
            with self._lock:
                self.cancelled.add(params.get("requestId"))
            return None
        if method.startswith("notifications/") or not is_request:
            return None
        with self._lock:
            if msg_id in self.cancelled:
                self.cancelled.discard(msg_id)
                return None
            self.in_flight.add(msg_id)
        try:
            response = self._run(msg_id, method, params)
        finally:
            with self._lock:
                self.in_flight.discard(msg_id)
                was_cancelled = msg_id in self.cancelled
                self.cancelled.discard(msg_id)
        return None if was_cancelled else response

    def _run(self, msg_id: Any, method: str, params: dict) -> dict:
        try:
            if method == "initialize":
                self.initialized = True
                version = params.get("protocolVersion")
                return self._ok(msg_id, {"protocolVersion": version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0], "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS})
            if method == "ping":
                return self._ok(msg_id, {})
            if not self.initialized:
                return self._err(msg_id, -32602, "initialize 먼저 보내세요.")
            if method == "tools/list":
                r = self.client.get("/api/tools")
                r.raise_for_status()
                return self._ok(msg_id, r.json())
            if method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments")
                meta = params.get("_meta") if _is_object(params.get("_meta")) else {}
                if not isinstance(name, str) or not name or (arguments is not None and not _is_object(arguments)):
                    return self._err(msg_id, -32602, "Invalid tools/call params")
                token = meta.get("progressToken")
                if token is not None:
                    self.write({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": token, "progress": 1, "message": f"{name} 실행 중"}})
                r = self.client.post(f"/api/tools/{name}", json={"arguments": arguments or {}})
                if r.status_code == 401:
                    return self._ok(msg_id, {"content": [{"type": "text", "text": "편집기 API 토큰이 올바르지 않습니다 (EDITOR_AI_TOKEN)."}], "isError": True})
                r.raise_for_status()
                return self._ok(msg_id, r.json())
            return self._err(msg_id, -32601, f"Method not found: {method}")
        except httpx.HTTPError as e:
            return self._err(msg_id, -32603, f"편집기 API에 닿지 못했습니다: {e}")

    @staticmethod
    def _ok(msg_id: Any, result: Any) -> dict:
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    @staticmethod
    def _err(msg_id: Any, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def resolve_api_base(env: dict[str, str] | None = None) -> str:
    """API 주소: EDITOR_API_URL > EDITOR_STATE_FILE(데스크톱 앱이 실행 때 쓴 {"api_url": …}) > 기본값.

    데스크톱 앱은 포트가 실행마다 달라질 수 있어 AI 앱 설정에 주소를 굳히지 않고 상태 파일 경로만 적는다.
    """
    env = os.environ if env is None else env
    if env.get("EDITOR_API_URL"):
        return env["EDITOR_API_URL"]
    state = env.get("EDITOR_STATE_FILE")
    if state:
        try:
            with open(state, encoding="utf-8") as f:
                url = json.load(f).get("api_url")
            if isinstance(url, str) and url.startswith("http"):
                return url
        except (OSError, ValueError):
            pass
    return "http://127.0.0.1:8000"


def main() -> None:
    # MCP stdio is UTF-8 even when Windows redirects pipes using a CP949 locale.
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    base = resolve_api_base()
    token = os.environ.get("EDITOR_AI_TOKEN", "")
    client = httpx.Client(base_url=base, headers={"X-AI-Token": token} if token else {}, timeout=120)
    out_lock = threading.Lock()

    def write(message: dict) -> None:
        with out_lock:
            sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    bridge = StdioBridge(client, write)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        # 취소 알림은 즉시 반영하고, 요청은 순서대로 실행한다
        response = bridge.handle(message)
        if response is not None:
            write(response)


if __name__ == "__main__":
    main()
