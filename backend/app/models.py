from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

# PostgreSQL(웹 서비스)과 SQLite(데스크톱 앱) 겸용: JSON은 PG에서 jsonb, 큰 정수 키는 SQLite에서 INTEGER(자동 증가)
JsonType = JSON().with_variant(JSONB(), "postgresql")
BigId = BigInteger().with_variant(Integer(), "sqlite")


def now() -> datetime:
    return datetime.now(timezone.utc)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(300))
    filename: Mapped[str] = mapped_column(String(300))
    format: Mapped[str] = mapped_column(String(10), default="hwpx")
    head_revision_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    # 브라우저의 rhwp 렌더러가 보고한 조판 결과 (서버는 조판하지 않는다). 어느 리비전 기준인지 함께 둔다.
    layout_pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    layout_revision_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    layout_engine: Mapped[str | None] = mapped_column(String(60), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    revisions: Mapped[list["Revision"]] = relationship(back_populates="document", cascade="all, delete-orphan", order_by="Revision.seq")


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (UniqueConstraint("document_id", "seq"), CheckConstraint("actor in ('user','ai','system')"))

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes] = mapped_column(LargeBinary)
    actor: Mapped[str] = mapped_column(String(10))
    command: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    document: Mapped[Document] = relationship(back_populates="revisions")


class BlockIndex(Base):
    __tablename__ = "block_index"
    __table_args__ = (
        CheckConstraint("kind in ('paragraph','table')"),
        Index("ix_block_index_doc_rev_block", "document_id", "revision_id", "block_no"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    revision_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("revisions.id", ondelete="CASCADE"))
    block_no: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(10))
    table_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    row_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    col_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text)


class AiSession(Base):
    __tablename__ = "ai_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # 문서 ID 문자열 목록 (JSON). None이면 모든 문서.
    document_ids: Mapped[list[str] | None] = mapped_column(JsonType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ToolCall(Base):
    __tablename__ = "tool_calls"

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    tool: Mapped[str] = mapped_column(String(60))
    arguments: Mapped[dict] = mapped_column(JsonType)
    ok: Mapped[bool] = mapped_column(Boolean)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Asset(Base):
    """그림 등 업로드한 첨부. insert_image가 image_id로 참조한다."""

    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    filename: Mapped[str] = mapped_column(String(300))
    media_type: Mapped[str] = mapped_column(String(100))
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ChatMessage(Base):
    """앱 내 채팅 기록. 문서마다 남고, 실패한 실행의 답은 남기지 않는다 (이음오피스 project-store 규칙)."""

    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_messages_doc_seq", "document_id", "seq"),)

    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(10))  # user | assistant
    text: Mapped[str] = mapped_column(Text)
    tools: Mapped[list | None] = mapped_column(JsonType, nullable=True)  # [{name, ok, summary}]
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
