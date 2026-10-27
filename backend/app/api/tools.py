from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..services.ai_sessions import authenticate, create_session
from ..services.search import search
from ..tools import registry
from ..tools.runner import run_tool

router = APIRouter(prefix="/api", tags=["tools"])


@router.get("/tools")
def list_tools():
    return {"tools": registry.TOOLS}


class ToolCallBody(BaseModel):
    arguments: dict[str, Any] | None = None


@router.post("/tools/{name}")
def call_tool(name: str, body: ToolCallBody, db: Session = Depends(get_db), x_ai_token: str | None = Header(default=None)):
    session = authenticate(db, x_ai_token)
    if x_ai_token and session is None:
        raise HTTPException(401, "AI 세션 토큰이 올바르지 않습니다.")
    if session is None and not settings.allow_anonymous_tools:
        raise HTTPException(401, "AI 세션 토큰(X-AI-Token)이 필요합니다.")
    actor = "ai" if session else "user"
    return run_tool(db, name, body.arguments or {}, session, actor).as_mcp()


@router.get("/search")
def search_api(q: str = Query(min_length=1, max_length=500), document_id: uuid.UUID | None = None, limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    hits, truncated = search(db, q, [document_id] if document_id else None, limit=limit)
    return {"hits": [h.__dict__ for h in hits], "truncated": truncated}


class SessionBody(BaseModel):
    name: str = "AI"
    document_ids: list[uuid.UUID] | None = None


@router.post("/ai/sessions", status_code=201)
def new_session(body: SessionBody, db: Session = Depends(get_db)):
    session, token = create_session(db, body.name, body.document_ids)
    return {"id": str(session.id), "name": session.name, "token": token, "note": "토큰은 지금 한 번만 보입니다."}
