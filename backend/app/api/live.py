"""라이브 세션 API — 편집기가 문서의 편집 도구를 대신 실행한다 (services/live.py)."""

from __future__ import annotations

import json
import uuid
from typing import Any

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..services.documents import DocumentService, NotFound
from ..services.live import POLL_WAIT_S, live
from ..uploads import read_upload

router = APIRouter(prefix="/api/documents/{document_id}/live", tags=["live"])
_POLL_LIMITER = anyio.CapacityLimiter(200)  # 롱폴은 기본 스레드풀(40)을 잡아먹지 않게 따로 센다
MAX_RESULT_JSON = 64 * 1024


def _check_doc(document_id: uuid.UUID, db: Session) -> None:
    try:
        DocumentService(db).get(document_id)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")


class RegisterBody(BaseModel):
    client: str = Field("", max_length=60)


@router.post("", status_code=201)
def register(document_id: uuid.UUID, body: RegisterBody, db: Session = Depends(get_db)):
    _check_doc(document_id, db)
    s = live.register(document_id, body.client)
    return {"session_id": s.id, "poll_wait_s": POLL_WAIT_S}


@router.delete("/{session_id}")
def close(document_id: uuid.UUID, session_id: str):
    return {"ok": live.close(document_id, session_id)}


@router.post("/{session_id}/heartbeat")
def heartbeat(document_id: uuid.UUID, session_id: str):
    """편집기가 15초마다 보낸다 (브라우저 편집기는 요청을 SSE로 받으므로 이것만으로 살아 있음을 알린다)."""
    s = live.session(document_id, session_id)
    if s is None:
        raise HTTPException(410, "세션이 없습니다. 다시 등록하세요.")
    live.heartbeat(s)
    return {"ok": True}


@router.get("/{session_id}/next")
async def next_request(document_id: uuid.UUID, session_id: str, wait: float = Query(POLL_WAIT_S, ge=0, le=POLL_WAIT_S)):
    """브라우저가 아닌 편집기·테스트용 롱폴. 요청이 없으면 {request: null}."""
    s = live.session(document_id, session_id)
    if s is None:
        raise HTTPException(410, "세션이 없습니다. 다시 등록하세요.")
    req = await anyio.to_thread.run_sync(live.next_request, s, wait, limiter=_POLL_LIMITER)
    if req is None:
        return {"request": None}
    return {"request": {"id": req.id, "tool": req.tool, "args": req.args, "hints": req.hints}}


@router.post("/{session_id}/results/{request_id}")
async def post_result(document_id: uuid.UUID, session_id: str, request_id: str, result: str = Form(...), file: UploadFile | None = File(None)):
    """편집기의 실행 결과. result는 JSON {ok, text, code?, place?, count?}, file은 성공했을 때 내보낸 HWPX 전체."""
    s = live.session(document_id, session_id)
    if s is None:
        raise HTTPException(410, "세션이 없습니다.")
    if len(result) > MAX_RESULT_JSON:
        raise HTTPException(413, "result가 너무 큽니다.")
    try:
        payload: dict[str, Any] = json.loads(result)
        if not isinstance(payload, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(422, "result는 JSON 객체여야 합니다.")
    place = payload.get("place")
    if place is not None and not (isinstance(place, dict) and all(isinstance(place.get(k), int) and place.get(k) >= 0 for k in ("section", "paragraph", "length"))):
        payload["place"] = None
    data = await read_upload(file, settings.max_upload_bytes, "파일이 너무 큽니다.") if file is not None else None
    if not live.complete(s, request_id, payload, data):
        raise HTTPException(404, "기다리는 요청이 아닙니다 (이미 끝났거나 시간이 지났습니다).")
    return {"ok": True}


@router.get("/status")
def status(document_id: uuid.UUID):
    s = live.get(document_id)
    return {"live": s is not None, "session_id": s.id if s else None, "client": s.client if s else None}
