"""앱 내 LLM 채팅. 사용자가 넣은 core.today 키(X-CDT-Key)로 호출하고 서버는 키를 저장하지 않는다."""

from __future__ import annotations

import asyncio
import re
import threading
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import delete
from sqlalchemy.orm import Session
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..db import SessionLocal, get_db
from ..models import ChatMessage
from ..llm.agent import load_history, run_chat
from ..llm.gateway import GatewayError, check_key, fetch_pricing
from ..services.documents import NotFound
from ..services.events import bus

router = APIRouter(prefix="/api/ai", tags=["chat"])

# 추천 모델: 게이트웨이에서 도구 호출 왕복(도구 부르기 → 결과 받고 답하기)을 확인한 것 (2026-10-24, 운영 게이트웨이).
# 묶음 순서가 화면의 순서다. 그 밖의 대화 모델은 게이트웨이 단가표에서 채운다(_gateway_models, 확인 안 됨 표시).
MODELS: list[dict[str, Any]] = [
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "provider": "anthropic", "group": "Claude"},
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5", "provider": "anthropic", "group": "Claude"},
    {"id": "claude-fable-5-1", "label": "Claude Fable 5.1", "provider": "anthropic", "group": "Claude", "note": "최상위"},
    {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5", "provider": "anthropic", "group": "Claude", "note": "저렴"},
    {"id": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "provider": "openai", "group": "GPT"},
    {"id": "gpt-6-astra", "label": "GPT-6 Astra", "provider": "openai", "group": "GPT", "note": "최상위"},
    {"id": "gpt-6-sol", "label": "GPT-6 Sol", "provider": "openai", "group": "GPT"},
    {"id": "gpt-6-luna", "label": "GPT-6 Luna", "provider": "openai", "group": "GPT", "note": "저렴"},
    {"id": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "provider": "openai", "group": "GPT"},
    {"id": "gpt-5.5", "label": "GPT-5.5", "provider": "openai", "group": "GPT"},
    {"id": "gpt-5.4-mini", "label": "GPT-5.4 mini", "provider": "openai", "group": "GPT", "note": "저렴"},
    {"id": "gemini-4-argon", "label": "Gemini 4 Argon", "provider": "gemini", "group": "Gemini"},
    {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash", "provider": "gemini", "group": "Gemini"},
    {"id": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro (미리 보기)", "provider": "gemini", "group": "Gemini"},
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash Lite", "provider": "gemini", "group": "Gemini", "note": "저렴"},
    {"id": "grok-4.7", "label": "Grok 4.7", "provider": "grok", "group": "Grok"},
    {"id": "grok-4.3", "label": "Grok 4.3", "provider": "grok", "group": "Grok"},
    {"id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "provider": "deepseek", "group": "DeepSeek"},
    {"id": "deepseek-flash", "label": "DeepSeek Flash", "provider": "deepseek", "group": "DeepSeek", "note": "저렴"},
    {"id": "muse-spark-1.3", "label": "Meta Muse Spark 1.3", "provider": "meta", "group": "Meta"},
    {"id": "qwen/qwen3.8-max", "label": "Qwen 3.8 Max", "provider": "openrouter", "group": "OpenRouter"},
    {"id": "moonshotai/kimi-k3", "label": "Kimi K3", "provider": "openrouter", "group": "OpenRouter"},
    {"id": "z-ai/glm-5.3", "label": "GLM 5.3", "provider": "openrouter", "group": "OpenRouter"},
    {"id": "minimax/minimax-m3", "label": "MiniMax M3", "provider": "openrouter", "group": "OpenRouter"},
    {"id": "upstage/solar-pro4", "label": "Upstage Solar Pro 4", "provider": "openrouter", "group": "OpenRouter", "note": "저렴"},
    {"id": "openai/gpt-oss-120b", "label": "gpt-oss 120B", "provider": "openrouter", "group": "OpenRouter", "note": "저렴"},
]
DEFAULT_MODEL = "claude-sonnet-5-5"


def _key(header: str | None) -> str:
    key = (header or "").strip() or (settings.cdt_api_key or "")
    if not key:
        raise HTTPException(401, "core.today API 키(X-CDT-Key)가 필요합니다. 화면에서 키를 넣으세요.")
    return key


GROUPS = {"anthropic": "Claude", "openai": "GPT", "google": "Gemini", "grok": "Grok", "deepseek": "DeepSeek", "meta": "Meta", "openrouter": "OpenRouter"}
_SKIP = re.compile(r"(image|multi-agent|-\d{4}-\d{2}-\d{2}$|-\d{8}$)")  # 그림 모델·다중 에이전트(Responses 전용·고비용)·날짜 고정판
_PRICING_TTL = 600.0
_pricing: tuple[float, list[dict[str, Any]]] | None = None
_pricing_lock = threading.Lock()


def _pricing_rows(key: str) -> list[dict[str, Any]] | None:
    """단가표 (모든 키가 같은 표를 받으므로 앱 전체에서 10분 캐시). 실패하면 None."""
    global _pricing
    with _pricing_lock:
        if _pricing and time.monotonic() - _pricing[0] < _PRICING_TTL:
            return _pricing[1]
    try:
        rows = fetch_pricing(key)
    except GatewayError:
        return None
    with _pricing_lock:
        _pricing = (time.monotonic(), rows)
    return rows


def model_catalog(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """추천 목록 + 단가표의 그 밖의 대화 모델. 단가(1K 토큰당 크레딧)를 붙이고, 게이트웨이가 은퇴시킨 추천 모델은 뺀다."""
    if rows is None:
        return [{**m, "verified": True} for m in MODELS]
    by_id = {r["id"]: r for r in rows}

    def price(r: dict[str, Any] | None) -> dict[str, float]:
        if not r:
            return {}
        try:
            return {"input_per_1k": round(float(r.get("input_per_token") or 0) * 1000, 3), "output_per_1k": round(float(r.get("output_per_token") or 0) * 1000, 3)}
        except (TypeError, ValueError):
            return {}

    out = [{**m, "verified": True, **price(by_id.get(m["id"]))} for m in MODELS if not (by_id.get(m["id"]) or {}).get("retired")]
    known = {m["id"] for m in MODELS}
    extra = [
        r for r in rows
        if r.get("category") == "chat" and not r.get("retired") and r["id"] not in known and r.get("provider") in GROUPS and not _SKIP.search(r["id"])
    ]
    for r in sorted(extra, key=lambda r: (list(GROUPS).index(r["provider"]), r["id"])):
        out.append({"id": r["id"], "label": r["id"], "provider": r["provider"], "group": GROUPS[r["provider"]], "verified": False, **price(r)})
    return out


@router.get("/models")
def models(x_cdt_key: str | None = Header(default=None)):
    key = (x_cdt_key or "").strip() or (settings.cdt_api_key or "")
    rows = _pricing_rows(key) if key else None
    return {"models": model_catalog(rows), "default": DEFAULT_MODEL, "docs": "https://console.core.today/docs/llm", "pricing": rows is not None}


@router.get("/key")
def key_check(x_cdt_key: str | None = Header(default=None)):
    key = _key(x_cdt_key)
    try:
        ok = check_key(key)
    except GatewayError as e:
        raise HTTPException(e.status if e.status in {403, 429} else 502, e.message) from e
    if not ok:
        raise HTTPException(401, "core.today API 키가 올바르지 않습니다.")
    return {"ok": True, "key_hint": f"{key[:6]}…{key[-4:]}"}


class HistoryItem(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=30_000)


class ChatBody(BaseModel):
    document_id: uuid.UUID
    model: str = Field(DEFAULT_MODEL, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:/-]+$")
    message: str = Field(min_length=1, max_length=20_000)
    history: list[HistoryItem] | None = Field(default=None, max_length=60, description="없으면 서버에 저장된 문서별 대화 기록을 쓴다")
    selection: str | None = Field(default=None, max_length=6_000, description="사용자가 편집기에서 선택한 글 (있으면 요청이 그 부분에 대한 것이 된다)")


@router.get("/chat/{document_id}/history")
def chat_history(document_id: uuid.UUID, db: Session = Depends(get_db)):
    rows = load_history(db, document_id, limit=200)
    return {"messages": [{"seq": m.seq, "role": m.role, "text": m.text, "tools": m.tools, "model": m.model, "created_at": m.created_at.isoformat()} for m in rows]}


@router.delete("/chat/{document_id}/history")
def clear_chat_history(document_id: uuid.UUID, db: Session = Depends(get_db)):
    db.execute(delete(ChatMessage).where(ChatMessage.document_id == document_id))
    db.commit()
    return {"ok": True}


@router.post("/chat")
async def chat_stream(body: ChatBody, x_cdt_key: str | None = Header(default=None)):
    api_key = _key(x_cdt_key)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
    stop = threading.Event()  # 화면의 "중단"(연결 끊김)이 루프를 멈춘다

    def emit(kind: str, payload: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))

    def work() -> None:
        db = SessionLocal()
        try:
            run_chat(db, document_id=body.document_id, model=body.model, api_key=api_key, history=None if body.history is None else [h.model_dump() for h in body.history], message=body.message, emit=emit, stop=stop, selection=body.selection)
        except NotFound:
            emit("error", {"status": 404, "message": "문서를 찾지 못했습니다."})
        except GatewayError as e:
            emit("error", {"status": e.status, "message": e.message})
        except Exception as e:  # noqa: BLE001  화면에 원인을 보여 준다
            emit("error", {"message": f"채팅 처리 중 오류: {e}"})
        finally:
            db.close()
            loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, work)

    async def stream():
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if item is None:
                    yield bus.format_sse({"type": "end"})
                    return
                kind, payload = item
                yield bus.format_sse({"type": kind, **payload})
        finally:
            stop.set()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
