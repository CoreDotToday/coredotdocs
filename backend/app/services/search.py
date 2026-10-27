"""여러 문서에 걸친 찾기: PostgreSQL block_index를 ILIKE(+pg_trgm GIN)로 좁힌 뒤 Python에서 정확한 위치·문맥을 만든다."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..engine.search import CONTEXT, find_ranges
from ..engine.textrules import slice_keeping_pairs
from ..models import BlockIndex, Document

MAX_ROWS = 2_000


@dataclass
class SearchHit:
    document_id: str
    document_title: str
    block_no: int
    where: str
    before: str
    match: str
    after: str

    def line(self) -> str:
        where = f" {self.where}" if self.where else ""
        return f"[{self.block_no}]{where} …{self.before}【{self.match}】{self.after}…"


def _like_pattern(query: str) -> str:
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def search(db: Session, query: str, document_ids: list[uuid.UUID] | None = None, limit: int = 50) -> tuple[list[SearchHit], bool]:
    """(hits, truncated). document_ids=None이면 모든 문서."""
    if not query:
        return [], False
    stmt = (
        select(BlockIndex, Document.title)
        .join(Document, Document.id == BlockIndex.document_id)
        .where(BlockIndex.text.ilike(_like_pattern(query), escape="\\"))
        .order_by(Document.updated_at.desc(), BlockIndex.block_no, BlockIndex.row_no, BlockIndex.col_no)
        .limit(MAX_ROWS + 1)
    )
    if document_ids is not None:
        stmt = stmt.where(BlockIndex.document_id.in_(document_ids))
    rows = db.execute(stmt).all()
    truncated = len(rows) > MAX_ROWS
    hits: list[SearchHit] = []
    for row, title in rows[:MAX_ROWS]:
        where = f"표 {row.table_no} ({row.row_no},{row.col_no})" if row.kind == "table" else ""
        for start, end in find_ranges(row.text, query):
            hits.append(
                SearchHit(
                    document_id=str(row.document_id),
                    document_title=title,
                    block_no=row.block_no,
                    where=where,
                    before=slice_keeping_pairs(row.text, start - CONTEXT, start),
                    match=row.text[start:end],
                    after=slice_keeping_pairs(row.text, end, end + CONTEXT),
                )
            )
            if len(hits) >= limit:
                return hits, True
    return hits, truncated
