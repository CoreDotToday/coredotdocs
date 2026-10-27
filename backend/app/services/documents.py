"""문서 수명: 업로드 → 리비전 → 블록 인덱스 → 편집(새 리비전) → 되돌리기(과거 리비전 복제)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..engine.errors import CommandError, EngineError
from ..engine.hwpx import HwpxDocument, table_grid
from ..engine.loader import create_blank, detect_format, load_document
from ..models import BlockIndex, Document, Revision
from .events import bus


class NotFound(Exception):
    pass


@dataclass
class Loaded:
    document: Document
    revision: Revision
    hwpx: object  # HwpxDocument 또는 DocxDocument (같은 인터페이스)


class DocumentService:
    def __init__(self, db: Session):
        self.db = db

    # 조회 ------------------------------------------------------------------

    def list(self) -> list[Document]:
        return list(self.db.scalars(select(Document).order_by(Document.updated_at.desc())))

    def get(self, document_id: uuid.UUID) -> Document:
        doc = self.db.get(Document, document_id)
        if doc is None:
            raise NotFound(str(document_id))
        return doc

    def head(self, document: Document) -> Revision:
        rev = self.db.get(Revision, document.head_revision_id) if document.head_revision_id else None
        if rev is None:
            raise NotFound(f"{document.id}: head revision")
        return rev

    def load(self, document_id: uuid.UUID) -> Loaded:
        doc = self.get(document_id)
        rev = self.head(doc)
        return Loaded(doc, rev, load_document(rev.content, doc.filename))

    def revisions(self, document_id: uuid.UUID) -> list[Revision]:
        self.get(document_id)
        return list(self.db.scalars(select(Revision).where(Revision.document_id == document_id).order_by(Revision.seq)))

    # 생성 ------------------------------------------------------------------

    def create(self, filename: str, data: bytes, title: str | None = None) -> Document:
        # 옛 HWP(.hwp, OLE)는 서버 쪽 rhwp 사이드카(Node)로 HWPX로 바꿔 받는다. 사이드카가 없으면 전처럼 안내한다.
        if data[:4] == b"\xd0\xcf\x11\xe0" or filename.lower().endswith(".hwp"):
            from ..engine import rhwp_node

            converted = rhwp_node.hwp_to_hwpx(data)
            if converted is not None:
                data = converted
                filename = filename[:-4] + ".hwpx" if filename.lower().endswith(".hwp") else filename
        fmt = detect_format(data, filename)
        parsed = load_document(data, filename)  # 형식 검증 (EngineError)
        doc = Document(title=title or _title_from(filename), filename=filename, format=fmt)
        self.db.add(doc)
        self.db.flush()
        self._new_revision(doc, data, actor="user", summary="업로드", command=None, hwpx=parsed)
        self.db.commit()
        return doc

    def create_blank(self, title: str, markdown: str, fmt: str = "hwpx", actor: str = "user") -> Document:
        from ..engine import commands

        parsed = create_blank(fmt, title)
        if markdown.strip():
            commands.insert_content(parsed, markdown)
        data = parsed.to_bytes()
        safe = "".join(ch for ch in title if ch not in '\\/:*?"<>|').strip()[:80] or "새 문서"
        doc = Document(title=title[:300], filename=f"{safe}.{fmt}", format=fmt)
        self.db.add(doc)
        self.db.flush()
        self._new_revision(doc, data, actor=actor, summary="새 문서", command={"tool": "create_document", "arguments": {"title": title, "format": fmt}}, hwpx=load_document(data, doc.filename))
        self.db.commit()
        return doc

    def delete(self, document_id: uuid.UUID) -> None:
        doc = self.get(document_id)
        self.db.delete(doc)
        self.db.commit()

    # 편집 ------------------------------------------------------------------

    def _assert_head(self, loaded: Loaded) -> None:
        """loaded를 읽은 뒤 다른 쪽(편집기 올리기 등)이 리비전을 만들었으면 그 위에 덮어쓰지 않는다."""
        self.db.expire(loaded.document)
        if loaded.document.head_revision_id != loaded.revision.id:
            head = self.head(loaded.document)
            raise CommandError(f"도구가 읽은 뒤 문서가 리비전 {head.seq}로 바뀌었습니다. 다시 읽고 다시 부르세요.", "STALE_REVISION")

    def commit_edit(self, loaded: Loaded, *, actor: str, summary: str, command: dict | None, blocks: list[int], place: dict | None = None) -> Revision:
        """고친 HwpxDocument를 새 리비전으로 저장하고 이벤트를 발행한다. place는 첫 변경 자리(편집기가 화면을 옮긴다)."""
        self._assert_head(loaded)
        data = loaded.hwpx.to_bytes()
        rev = self._new_revision(loaded.document, data, actor=actor, summary=summary, command=command, hwpx=load_document(data, loaded.document.filename))
        self.db.commit()
        bus.publish(loaded.document.id, "edit", revision_seq=rev.seq, actor=actor, summary=summary, blocks=blocks, tool=(command or {}).get("tool"), place=place)
        return rev

    def replace_content(self, document_id: uuid.UUID, data: bytes, *, actor: str = "user", summary: str = "편집기에서 고침", source: str = "editor", command: dict | None = None, blocks: list[int] | None = None, place: dict | None = None, client: str | None = None, base_seq: int | None = None) -> tuple[Revision, bool]:
        """화면 편집기(rhwp-studio)가 내보낸 파일 전체로 새 리비전을 만든다. 현재 내용과 같으면 리비전을 만들지 않는다.

        서버가 편집을 실행하므로
        사람이 편집기에서 고친 내용을 서버가 먼저 알아야 AI가 최신 내용 위에서 일한다. 그래서 화면이 고칠 때마다(디바운스) 올린다.
        """
        doc = self.get(document_id)
        head = self.head(doc)
        if head.content == data:
            return head, False
        if base_seq is not None and head.seq != base_seq and (head.command or {}).get("client") != client:
            # 편집기가 알던 머리 뒤에 다른 쪽(서버 도구·다른 편집기)이 리비전을 만들었다: 마지막 쓰기가 이기게 두지 않는다.
            # 자기(client)가 만든 리비전(라이브 실행 결과를 아직 이벤트로 못 봤을 때)은 그 위에 올려도 된다.
            raise CommandError(f"편집기가 리비전 {base_seq}을 보는 동안 문서가 리비전 {head.seq}로 바뀌었습니다. 다시 읽은 뒤 올리세요.", "STALE_REVISION")
        parsed = load_document(data, doc.filename)  # 형식 검증
        cmd = dict(command or {"tool": "editor"})
        cmd["source"] = source
        if client:
            cmd["client"] = client
        rev = self._new_revision(doc, data, actor=actor, summary=summary, command=cmd, hwpx=parsed)
        self.db.commit()
        bus.publish(doc.id, "edit", revision_seq=rev.seq, actor=actor, summary=summary, blocks=blocks or [], tool=cmd.get("tool") if cmd.get("tool") != "editor" else None, source=source, place=place, client=client)
        return rev, True

    def rename(self, document_id: uuid.UUID, *, title: str | None = None, filename: str | None = None) -> Document:
        doc = self.get(document_id)
        if title:
            doc.title = title[:300]
        if filename:
            name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:300]
            if not name.lower().endswith(f".{doc.format}"):
                name = f"{name}.{doc.format}"
            doc.filename = name
        self.db.commit()
        return doc

    def undo(self, document_id: uuid.UUID, steps: int = 1, actor: str = "user", force: bool = False) -> Revision:
        doc = self.get(document_id)
        head = self.head(doc)
        # 되돌리기 리비전 자체도 리비전이므로, '편집 수'가 아니라 '현재 내용의 출처'를 따라간다.
        target_seq = self._origin_seq(head) - steps
        if target_seq < 1:
            available = self._origin_seq(head) - 1
            raise CommandError(f"되돌릴 편집이 {available}개뿐입니다." if available else "되돌릴 편집이 없습니다.", "NOTHING_TO_UNDO")
        if not force:
            # 되돌릴 구간에 사람이 편집기에서 고친 리비전이 끼어 있으면 "AI 것만" 되돌릴 수 없다 (이음오피스 foreignChanges 규칙)
            foreign = [r.seq for r in self.revisions(doc.id) if target_seq < r.seq <= self._origin_seq(head) and (r.command or {}).get("tool") == "editor"]
            if foreign:
                raise CommandError(f"그 뒤에 사용자가 편집기에서 고친 리비전({', '.join(map(str, foreign[:5]))})이 있어 되돌리지 않았습니다. 그것까지 되돌리려면 force: true로 다시 부르세요.", "FOREIGN_CHANGES")
        target = self.db.scalar(select(Revision).where(Revision.document_id == doc.id, Revision.seq == target_seq))
        assert target is not None
        rev = self._new_revision(doc, target.content, actor=actor, summary=f"{steps}단계 되돌리기 (리비전 {target_seq} 내용으로)", command={"tool": "undo_last_edit", "arguments": {"steps": steps}, "restores_seq": target_seq}, hwpx=load_document(target.content, doc.filename))
        self.db.commit()
        bus.publish(doc.id, "undo", revision_seq=rev.seq, restores_seq=target_seq, steps=steps, actor=actor)
        return rev

    def _origin_seq(self, rev: Revision) -> int:
        """이 리비전의 내용이 원래 어느 편집 리비전에서 왔는지 (되돌리기 리비전은 restores_seq를 따라간다)."""
        command = rev.command or {}
        return int(command.get("restores_seq", rev.seq))

    # 내부 ------------------------------------------------------------------

    def _new_revision(self, doc: Document, data: bytes, *, actor: str, summary: str, command: dict | None, hwpx) -> Revision:
        last = self.db.scalar(select(func.max(Revision.seq)).where(Revision.document_id == doc.id)) or 0
        rev = Revision(document_id=doc.id, seq=last + 1, content=data, actor=actor, summary=summary, command=command)
        self.db.add(rev)
        self.db.flush()
        doc.head_revision_id = rev.id
        self._index(doc, rev, hwpx)
        return rev

    def _index(self, doc: Document, rev: Revision, hwpx) -> None:
        """리비전의 블록 글을 검색 인덱스에 넣는다. 이전 리비전 인덱스는 지운다 (검색은 최신 내용만 대상)."""
        self.db.execute(delete(BlockIndex).where(BlockIndex.document_id == doc.id))
        rows: list[BlockIndex] = []
        for b in hwpx.blocks():
            if b.kind == "paragraph":
                rows.append(BlockIndex(document_id=doc.id, revision_id=rev.id, block_no=b.no, kind="paragraph", text=b.text()))
            else:
                for cell in hwpx.ops.table_grid(b.table).cells:
                    rows.append(BlockIndex(document_id=doc.id, revision_id=rev.id, block_no=b.no, kind="table", table_no=b.table_no, row_no=cell.row + 1, col_no=cell.col + 1, text=cell.text))
        self.db.add_all(rows)
        self.db.flush()


def _title_from(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1]
    lower = name.lower()
    for ext in (".hwpx", ".docx"):
        if lower.endswith(ext):
            return name[: -len(ext)]
    return name
