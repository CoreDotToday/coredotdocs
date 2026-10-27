"""문서별 이벤트 버스. 편집·되돌리기·AI 활동을 SSE 구독자에게 전달한다.

API 핸들러는 동기(스레드풀)에서 발행하고 SSE 생성기는 이벤트 루프에서 받으므로,
루프를 알고 있으면 call_soon_threadsafe로 넘기고, 루프가 없을 때(단위 테스트)는 동기 리스너에게만 전달한다.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self._queues: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._sync_listeners: list[Callable[[dict[str, Any]], None]] = []

    def subscribe(self, document_id: uuid.UUID | str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._queues[str(document_id)].add(queue)
        return queue

    def unsubscribe(self, document_id: uuid.UUID | str, queue: asyncio.Queue) -> None:
        self._queues[str(document_id)].discard(queue)

    def add_sync_listener(self, listener: Callable[[dict[str, Any]], None]) -> None:
        self._sync_listeners.append(listener)

    def publish(self, document_id: uuid.UUID | str, kind: str, **payload: Any) -> dict[str, Any]:
        event = {"type": kind, "document_id": str(document_id), "at": datetime.now(timezone.utc).isoformat(), **payload}
        for listener in self._sync_listeners:
            listener(event)
        queues = list(self._queues.get(str(document_id), ()))
        if self.loop is not None and queues:
            for queue in queues:
                self.loop.call_soon_threadsafe(self._put, queue, event)
        return event

    @staticmethod
    def _put(queue: asyncio.Queue, event: dict[str, Any]) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # 느린 구독자는 이벤트를 놓친다; 화면은 다음 이벤트에서 다시 읽는다

    @staticmethod
    def format_sse(event: dict[str, Any]) -> str:
        return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


bus = EventBus()
