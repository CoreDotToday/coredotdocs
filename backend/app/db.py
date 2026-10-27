from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    """PostgreSQL(웹 서비스) 또는 SQLite(데스크톱 앱, 파일 하나)."""
    if url.startswith("sqlite"):
        eng = create_engine(url, future=True, connect_args={"check_same_thread": False})

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # 외래 키 cascade와 동시 읽기·쓰기
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

        return eng
    return create_engine(url, pool_pre_ping=True, future=True)


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    """테이블과 검색 인덱스를 만든다. (운영에서는 Alembic으로 옮긴다; 1차는 create_all + DDL)"""
    from . import models  # noqa: F401  모델 등록

    Base.metadata.create_all(engine)
    if engine.dialect.name != "postgresql":
        return  # SQLite: ILIKE는 lower(text) LIKE로 동작하고 trigram 인덱스는 없다 (문서 수가 적은 데스크톱 용도)
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_block_index_text_trgm ON block_index USING gin (text gin_trgm_ops)"))
        # 이미 만들어진 DB에 뒤에 추가한 열 (create_all은 기존 표를 고치지 않는다)
        conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS layout_pages integer, ADD COLUMN IF NOT EXISTS layout_revision_seq integer, ADD COLUMN IF NOT EXISTS layout_engine varchar(60)"))
        # ai_sessions.document_ids: uuid[] → jsonb (SQLite 겸용으로 바꾼 뒤)
        kind = conn.execute(text("SELECT data_type FROM information_schema.columns WHERE table_name='ai_sessions' AND column_name='document_ids'")).scalar()
        if kind == "ARRAY":
            conn.execute(text("ALTER TABLE ai_sessions ALTER COLUMN document_ids TYPE jsonb USING to_jsonb(document_ids)"))


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
