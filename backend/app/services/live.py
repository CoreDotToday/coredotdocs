"""라이브 세션 — "진실은 서버, 실행은 편집기" (설계 문서 04 §3 B4, §9.1-1).

문서를 연 편집기가 세션을 등록하면 편집 도구 호출은 편집기 안의 플러그인이 실행한다(변경 하나 = 편집기 실행 취소 한 단계,
커서 이동·바뀐 곳 표시). 편집기는 실행 결과와 내보낸 HWPX 전체를 돌려주고 서버는 그것을 리비전으로 확정한다.
편집기가 없거나 제때 답하지 않으면 서버(lxml)가 실행한다.

전달: 요청은 그 문서의 이벤트 스트림(SSE, `live-request`)에 실어 보낸다 — 편집기가 이미 열어 둔 연결이라 연결을 더 쓰지 않는다
(브라우저는 출처당 연결 6개가 상한이라 탭마다 롱폴을 열면 모든 요청이 줄을 선다). 롱폴 `next`는 브라우저가 아닌 편집기·테스트용으로 남긴다.
살아 있음: 편집기가 15초마다 heartbeat를 보낸다(또는 롱폴). STALE_S 동안 없으면 죽은 세션이다.
문서당 세션 하나(새 등록이 이전 것을 밀어낸다 — 보이는 탭이 세션을 갖는다). 메모리 안에서만 산다(프로세스 하나).
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .events import bus

REQUEST_TIMEOUT_S = 20.0  # 편집기 응답 대기 상한; 넘으면 서버가 실행한다
POLL_WAIT_S = 25.0  # 롱폴 최대 대기
STALE_S = 40.0  # 이 시간 동안 heartbeat·롱폴이 없으면 세션이 죽은 것으로 본다


@dataclass
class LiveRequest:
    id: str
    tool: str
    args: dict[str, Any]
    hints: dict[str, Any]
    client: str = ""  # 요청을 받은 세션의 편집기 표식 (결과 리비전에 찍는다 — 그 사이 세션이 바뀌어도 실행한 편집기 것)
    created_at: float = field(default_factory=time.monotonic)
    done: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    data: bytes | None = None


@dataclass
class LiveSession:
    id: str
    document_id: str
    client: str = ""
    created_at: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)
    queue: deque[LiveRequest] = field(default_factory=deque)  # 롱폴용
    pending: dict[str, LiveRequest] = field(default_factory=dict)
    wake: threading.Condition = field(default_factory=lambda: threading.Condition(threading.Lock()))

    @property
    def alive(self) -> bool:
        return time.monotonic() - self.last_seen < STALE_S

    def touch(self) -> None:
        self.last_seen = time.monotonic()


class LiveRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, LiveSession] = {}  # document_id → session

    def register(self, document_id: uuid.UUID | str, client: str = "") -> LiveSession:
        with self._lock:
            old = self._sessions.get(str(document_id))
            if old is not None:
                self._fail_all(old, "편집기 세션이 교체되었습니다.")
            session = LiveSession(id=uuid.uuid4().hex, document_id=str(document_id), client=client[:60])
            self._sessions[str(document_id)] = session
            return session

    def close(self, document_id: uuid.UUID | str, session_id: str) -> bool:
        with self._lock:
            s = self._sessions.get(str(document_id))
            if s is None or s.id != session_id:
                return False
            self._fail_all(s, "편집기 세션이 닫혔습니다.")
            del self._sessions[str(document_id)]
            return True

    def get(self, document_id: uuid.UUID | str) -> LiveSession | None:
        with self._lock:
            s = self._sessions.get(str(document_id))
            return s if s is not None and s.alive else None

    def session(self, document_id: uuid.UUID | str, session_id: str) -> LiveSession | None:
        with self._lock:
            s = self._sessions.get(str(document_id))
            return s if s is not None and s.id == session_id else None

    @staticmethod
    def _fail_all(s: LiveSession, message: str) -> None:
        with s.wake:
            for r in list(s.queue) + list(s.pending.values()):
                if not r.done.is_set():
                    r.result = {"ok": False, "code": "LIVE_GONE", "text": message}
                    r.done.set()
            s.queue.clear()
            s.pending.clear()
            s.wake.notify_all()

    # 도구 실행 쪽 ---------------------------------------------------------------

    def request(self, document_id: uuid.UUID | str, tool: str, args: dict[str, Any], hints: dict[str, Any], timeout: float | None = None, revision_seq: int | None = None) -> LiveRequest | None:
        """편집기에 실행을 부탁하고 결과를 기다린다. 세션이 없거나 제때 답이 없으면 None (호출자가 서버 실행으로 폴백)."""
        timeout = REQUEST_TIMEOUT_S if timeout is None else timeout
        s = self.get(document_id)
        if s is None:
            return None
        req = LiveRequest(id=uuid.uuid4().hex, tool=tool, args=args, hints=hints, client=s.client)
        with s.wake:
            s.queue.append(req)
            s.pending[req.id] = req
            s.wake.notify_all()
        # 편집기가 열어 둔 이벤트 스트림으로 보낸다 (브라우저 편집기의 경로)
        bus.publish(document_id, "live-request", session_id=s.id, request={"id": req.id, "tool": tool, "args": args, "hints": hints, "revision_seq": revision_seq})
        if not req.done.wait(timeout):
            with s.wake:
                if req.done.is_set():  # 기다림이 끝나는 순간 결과가 들어왔다: 그 결과를 쓴다 (편집기는 200을 받았으니 서버가 또 실행하면 두 번이다)
                    return req
                s.pending.pop(req.id, None)
                try:
                    s.queue.remove(req)
                except ValueError:
                    pass
                req.result = {"ok": False, "code": "LIVE_TIMEOUT", "text": "편집기가 제때 답하지 않았습니다."}
                req.done.set()
            return None
        return req

    # 편집기 쪽 -------------------------------------------------------------------

    def heartbeat(self, s: LiveSession) -> None:
        s.touch()

    def next_request(self, s: LiveSession, wait: float = POLL_WAIT_S) -> LiveRequest | None:
        """롱폴(브라우저가 아닌 편집기·테스트용): 요청이 올 때까지 최대 wait초 기다린다."""
        s.touch()
        deadline = time.monotonic() + wait
        with s.wake:
            while not s.queue:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    s.touch()
                    return None
                s.wake.wait(remaining)
            req = s.queue.popleft()
        s.touch()
        return req

    def complete(self, s: LiveSession, request_id: str, result: dict[str, Any], data: bytes | None) -> bool:
        with s.wake:
            req = s.pending.pop(request_id, None)
            if req is None or req.done.is_set():
                return False
            try:
                s.queue.remove(req)
            except ValueError:
                pass
            req.result = result
            req.data = data
            req.done.set()
        s.touch()
        return True


live = LiveRegistry()
