from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..engine import commands
from ..engine.errors import CommandError, EngineError
from ..engine.images import image_info
from ..engine.loader import MEDIA_TYPES
from ..models import Asset
from ..services.documents import DocumentService, NotFound
from ..services.events import bus
from ..uploads import read_upload

router = APIRouter(prefix="/api/documents", tags=["documents"])
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _service(db: Session = Depends(get_db)) -> DocumentService:
    return DocumentService(db)


def _doc_or_404(service: DocumentService, document_id: uuid.UUID):
    try:
        return service.load(document_id)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")


@router.post("", status_code=201)
async def upload(file: UploadFile = File(...), service: DocumentService = Depends(_service)):
    data = await read_upload(file, settings.max_upload_bytes, "파일이 너무 큽니다.")
    try:
        doc = service.create(file.filename or "문서.hwpx", data)
    except EngineError as e:
        raise HTTPException(422, str(e))
    loaded = service.load(doc.id)
    return {"id": str(doc.id), "title": doc.title, "format": doc.format, "block_count": len(loaded.hwpx.blocks()), "revision_seq": loaded.revision.seq}


@router.get("")
def list_documents(service: DocumentService = Depends(_service)):
    out = []
    for d in service.list():
        rev = service.head(d)
        out.append({"id": str(d.id), "title": d.title, "filename": d.filename, "format": d.format, "revision_seq": rev.seq, "updated_at": d.updated_at.isoformat()})
    return out


@router.get("/{document_id}")
def get_document(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    loaded = _doc_or_404(service, document_id)
    d = loaded.document
    layout = {"pages": d.layout_pages, "revision_seq": d.layout_revision_seq, "engine": d.layout_engine} if d.layout_pages is not None else None
    return {"id": str(d.id), "title": d.title, "filename": d.filename, "format": d.format, "revision_seq": loaded.revision.seq, "block_count": len(loaded.hwpx.blocks()), "updated_at": d.updated_at.isoformat(), "layout": layout}


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    try:
        service.delete(document_id)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")
    return Response(status_code=204)


@router.get("/{document_id}/read")
def read(document_id: uuid.UUID, start: int = 1, to: int | None = None, max_chars: int = commands.READ_LIMIT, service: DocumentService = Depends(_service)):
    loaded = _doc_or_404(service, document_id)
    if not (1 <= start <= 100_000) or not (256 <= max_chars <= commands.READ_LIMIT):
        raise HTTPException(422, "from은 1 이상, max_chars는 256~18000이어야 합니다.")
    try:
        text, next_from, _ = commands.read_document(loaded.hwpx, start, to, max_chars)
    except CommandError as e:
        raise HTTPException(422, str(e))
    return {"text": text, "next_from": next_from, "revision_seq": loaded.revision.seq}


@router.get("/{document_id}/blocks")
def blocks(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    loaded = _doc_or_404(service, document_id)
    out = []
    for b in loaded.hwpx.blocks():
        where = {k: v for k, v in (("index", b.index), ("sub", b.sub)) if v is not None}  # DOCX: 편집기 엔진의 docxIndex 대응
        if b.kind == "paragraph":
            out.append({"no": b.no, "kind": "paragraph", "text": b.text(), **where})
        else:
            grid = loaded.hwpx.ops.table_grid(b.table)
            out.append({"no": b.no, "kind": "table", "table_no": b.table_no, "rows": grid.rows, "cols": grid.cols, "cells": [{"row": c.row + 1, "col": c.col + 1, "row_span": c.row_span, "col_span": c.col_span, "text": c.text} for c in grid.cells], **where})
    return {"revision_seq": loaded.revision.seq, "blocks": out}


@router.get("/{document_id}/page-setup")
def page_setup(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    """구역마다 쪽 설정(mm). 고치기는 도구 set_page_setup (쪽 설정 대화상자·AI 공통)."""
    loaded = _doc_or_404(service, document_id)
    sections = [{"section": i, "paper": s.paper, "width_mm": s.width, "height_mm": s.height, "orientation": "landscape" if s.landscape else "portrait", "margins_mm": {k: getattr(s, k) for k in ("top", "bottom", "left", "right")}, "header_mm": s.header, "footer_mm": s.footer, "gutter_mm": s.gutter} for i, s in enumerate(loaded.hwpx.page_setups(), 1)]
    return {"revision_seq": loaded.revision.seq, "sections": sections}


@router.get("/{document_id}/download")
def download(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    loaded = _doc_or_404(service, document_id)
    fmt = loaded.document.format
    filename = loaded.document.filename if loaded.document.filename.lower().endswith(f".{fmt}") else f"{loaded.document.filename}.{fmt}"
    return Response(loaded.revision.content, media_type=MEDIA_TYPES.get(fmt, "application/octet-stream"), headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(filename)}"})


def _quote(name: str) -> str:
    from urllib.parse import quote

    return quote(name)


@router.get("/{document_id}/revisions")
def revisions(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    try:
        revs = service.revisions(document_id)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")
    return [{"seq": r.seq, "actor": r.actor, "summary": r.summary, "tool": (r.command or {}).get("tool"), "created_at": r.created_at.isoformat()} for r in revs]


@router.post("/{document_id}/revisions", status_code=201)
async def push_revision(document_id: uuid.UUID, file: UploadFile = File(...), summary: str = Form("편집기에서 고침"), service: DocumentService = Depends(_service), x_editor_client: str | None = Header(default=None), x_editor_base: int | None = Header(default=None, ge=0)):
    """화면 편집기가 내보낸 현재 문서 전체를 새 리비전으로 올린다 (행위자 user). 내용이 같으면 리비전을 만들지 않는다.
    X-Editor-Client는 어느 편집기가 올렸는지(그 편집기는 이벤트를 다시 읽지 않는다). X-Editor-Base는 편집기가 알던 머리 리비전:
    그 뒤에 다른 쪽이 리비전을 만들었으면 409 STALE_REVISION(편집기는 다시 읽는다) — 마지막 쓰기가 이기지 않는다."""
    _doc_or_404(service, document_id)
    data = await read_upload(file, settings.max_upload_bytes, "파일이 너무 큽니다.")
    try:
        rev, changed = service.replace_content(document_id, data, actor="user", summary=summary[:200] or "편집기에서 고침", client=(x_editor_client or "")[:60] or None, base_seq=x_editor_base)
    except EngineError as e:
        raise HTTPException(422, str(e))
    except CommandError as e:
        head = service.head(service.get(document_id))
        raise HTTPException(409, {"message": str(e), "code": e.code, "revision_seq": head.seq})
    return {"revision_seq": rev.seq, "changed": changed}


class RenameBody(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    filename: str | None = Field(None, min_length=1, max_length=300)


@router.patch("/{document_id}")
def rename_document(document_id: uuid.UUID, body: RenameBody, service: DocumentService = Depends(_service)):
    try:
        d = service.rename(document_id, title=body.title, filename=body.filename)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")
    return {"id": str(d.id), "title": d.title, "filename": d.filename, "format": d.format}


class LayoutBody(BaseModel):
    pages: int = Field(ge=1, le=10_000)
    revision_seq: int = Field(ge=1)
    engine: str = Field("rhwp", max_length=60)


@router.post("/{document_id}/layout")
def report_layout(document_id: uuid.UUID, body: LayoutBody, service: DocumentService = Depends(_service)):
    """브라우저 렌더러가 계산한 쪽 수를 기록한다 (document_info의 '화면 쪽 수'). 현재 리비전과 다르면 무시하고 알려 준다."""
    loaded = _doc_or_404(service, document_id)
    if body.revision_seq != loaded.revision.seq:
        return {"accepted": False, "current_revision_seq": loaded.revision.seq}
    d = loaded.document
    d.layout_pages, d.layout_revision_seq, d.layout_engine = body.pages, body.revision_seq, body.engine
    service.db.commit()
    return {"accepted": True, "pages": body.pages, "revision_seq": body.revision_seq}


class UndoBody(BaseModel):
    steps: int = Field(1, ge=1, le=50)
    force: bool = False


@router.post("/{document_id}/undo")
def undo(document_id: uuid.UUID, body: UndoBody, service: DocumentService = Depends(_service)):
    try:
        rev = service.undo(document_id, body.steps, actor="user", force=body.force)
    except NotFound:
        raise HTTPException(404, "문서를 찾지 못했습니다.")
    except CommandError as e:
        raise HTTPException(409, {"message": str(e), "code": e.code})
    return {"revision_seq": rev.seq, "summary": rev.summary}


@router.get("/{document_id}/events")
async def events(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    _doc_or_404(service, document_id)
    queue = bus.subscribe(document_id)

    async def stream():
        try:
            yield bus.format_sse({"type": "ready", "document_id": str(document_id)})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield bus.format_sse(event)
        finally:
            bus.unsubscribe(document_id, queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class CreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    markdown: str = Field("", max_length=200_000)
    format: str = Field("hwpx", pattern="^(hwpx|docx)$")


@router.post("/new", status_code=201)
def create_new(body: CreateBody, service: DocumentService = Depends(_service)):
    try:
        doc = service.create_blank(body.title, body.markdown, body.format, actor="user")
    except (EngineError, CommandError) as e:
        raise HTTPException(422, str(e))
    return {"id": str(doc.id), "title": doc.title, "format": doc.format}


@router.post("/{document_id}/images", status_code=201)
async def upload_image(document_id: uuid.UUID, file: UploadFile = File(...), service: DocumentService = Depends(_service)):
    _doc_or_404(service, document_id)
    data = await read_upload(file, MAX_IMAGE_BYTES, "그림은 10MB까지 올릴 수 있습니다.")
    info = image_info(data)
    if info is None:
        raise HTTPException(422, "PNG·JPEG·GIF·BMP 그림만 올릴 수 있습니다.")
    asset = Asset(document_id=document_id, filename=file.filename or f"image.{info.ext}", media_type=info.media_type, width=info.width, height=info.height, data=data)
    service.db.add(asset)
    service.db.commit()
    return {"image_id": str(asset.id), "width": info.width, "height": info.height, "media_type": info.media_type}


@router.get("/{document_id}/images")
def list_images(document_id: uuid.UUID, service: DocumentService = Depends(_service)):
    _doc_or_404(service, document_id)
    from sqlalchemy import select

    rows = service.db.scalars(select(Asset).where(Asset.document_id == document_id).order_by(Asset.created_at.desc())).all()
    return [{"image_id": str(a.id), "filename": a.filename, "width": a.width, "height": a.height, "media_type": a.media_type} for a in rows]
