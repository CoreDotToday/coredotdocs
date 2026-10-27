from __future__ import annotations

import hashlib
import secrets
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AiSession


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, name: str, document_ids: list[uuid.UUID] | None = None) -> tuple[AiSession, str]:
    token = secrets.token_urlsafe(32)
    session = AiSession(name=name[:100], token_hash=_hash(token), document_ids=None if document_ids is None else [str(d) for d in document_ids])
    db.add(session)
    db.commit()
    return session, token


def authenticate(db: Session, token: str | None) -> AiSession | None:
    if not token:
        return None
    session = db.scalar(select(AiSession).where(AiSession.token_hash == _hash(token)))
    if session is None or session.revoked_at is not None:
        return None
    return session


def allowed(session: AiSession | None, document_id: uuid.UUID) -> bool:
    """세션의 문서 범위. 세션이 없으면(사용자 콘솔) 제한 없음, document_ids가 None이면 모든 문서."""
    if session is None or session.document_ids is None:
        return True
    return str(document_id) in session.document_ids
