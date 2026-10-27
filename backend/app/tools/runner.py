"""도구 호출 실행: 스키마 검증 → 권한 → 엔진 명령 → 리비전 → 결과 글(상한 적용) → 호출 기록."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from .. import fonts
from ..config import settings
from ..engine import commands
from ..engine.errors import CommandError, EngineError
from ..engine.invariants import fingerprint, violation
from ..engine.loader import load_document
from ..services.live import live
from . import live_dispatch
from ..models import AiSession, Asset, ToolCall
from ..services.ai_sessions import allowed
from ..services.documents import DocumentService, NotFound
from ..services.events import bus
from ..services.search import search
from . import registry

NARROW_HINTS = {
    "read_document": "같은 범위에서 응답의 from(또는 offset)으로 이어 읽거나 to·table로 범위를 좁히세요",
    "find_text": "document_id로 문서 하나만 찾거나 query를 더 길게 주세요",
    "list_fields": "from·to로 필드 번호 범위를 좁히세요",
}
READ_TOOLS = {"read_document", "document_info", "find_text", "list_fields", "read_selection", "list_notes", "list_fonts"}


@dataclass
class ToolResponse:
    text: str
    is_error: bool = False

    def as_mcp(self) -> dict[str, Any]:
        out: dict[str, Any] = {"content": [{"type": "text", "text": self.text}]}
        if self.is_error:
            out["isError"] = True
        return out


def cap_output(text: str, tool: str, limit: int | None = None) -> str:
    limit = limit or settings.output_limit
    if len(text) <= limit:
        return text
    cut = text.rfind("\n", 0, limit)
    end = cut if cut > limit // 2 else limit
    hint = NARROW_HINTS.get(tool, "범위(from·to·document_id)를 좁혀 다시 부르세요")
    return f"{text[:end]}\n… 결과가 길어 앞부분만 보입니다 (전체 {len(text):,}자). {hint}."


def json_safe(value: Any) -> Any:
    if isinstance(value, str):
        return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(value, dict):
        return {json_safe(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    return value


def layout_line(document, revision_seq: int) -> str:
    """브라우저 렌더러(rhwp)가 보고한 쪽 수. 서버는 조판하지 않으므로 어느 리비전 기준인지 밝힌다."""
    if document.layout_pages is None:
        return "화면 쪽 수: 아직 없음 (화면에서 '조판 미리보기'를 열면 계산됩니다)"
    engine = document.layout_engine or "브라우저 렌더러"
    if document.layout_revision_seq == revision_seq:
        return f"화면 쪽 수: {document.layout_pages}쪽 ({engine}, 현재 리비전 기준)"
    return f"화면 쪽 수: {document.layout_pages}쪽 ({engine}, 리비전 {document.layout_revision_seq} 기준 — 그 뒤 편집이 있어 화면을 열면 다시 계산됩니다)"


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def run_tool(db: Session, name: str, arguments: Any, session: AiSession | None, actor: str) -> ToolResponse:
    started = time.monotonic()
    if name not in registry.tool_names():
        return ToolResponse(f"오류[INVALID_ARGUMENT] 알 수 없는 도구: {name}", True)
    error = registry.validate(name, arguments if arguments is not None else {})
    if error:
        return ToolResponse(f"오류[INVALID_ARGUMENT] 도구 인자를 확인하세요. {error}", True)
    args = dict(arguments or {})
    document_id = _uuid(args.get("document_id"))
    if document_id is not None and name not in READ_TOOLS and allowed(session, document_id):
        # 화면이 "AI가 … 중" 알림을 띄울 수 있게 편집 도구는 시작도 알린다 (권한 밖 문서의 구독자에게는 알리지 않는다)
        bus.publish(document_id, "activity", tool=name, actor=actor, phase="start")
    try:
        response, document_id = _dispatch(db, name, args, document_id, session, actor)
    except NotFound:
        response = ToolResponse(f"오류[TARGET_NOT_FOUND] 문서를 찾지 못했습니다: {args.get('document_id')}. list_documents로 확인하세요.", True)
    except CommandError as e:
        response = ToolResponse(f"오류[{e.code}] {e}", True)
    except (EngineError, ValueError) as e:
        response = ToolResponse(f"오류[INVALID_ARGUMENT] {e}", True)
    response.text = cap_output(response.text, name)
    db.add(ToolCall(session_id=session.id if session else None, document_id=document_id, tool=name, arguments=json_safe(args), ok=not response.is_error, result=None if response.is_error else response.text[:4000], error=response.text[:4000] if response.is_error else None, duration_ms=int((time.monotonic() - started) * 1000)))
    db.commit()
    if document_id is not None:
        bus.publish(document_id, "activity", tool=name, actor=actor, ok=not response.is_error, phase="end")
    return response


def _dispatch(db: Session, name: str, args: dict, document_id: uuid.UUID | None, session: AiSession | None, actor: str) -> tuple[ToolResponse, uuid.UUID | None]:
    service = DocumentService(db)
    scope = None if session is None or session.document_ids is None else [uuid.UUID(d) for d in session.document_ids]
    font_note: str | None = None
    if isinstance(args.get("font"), str):
        # 한국어 이름("에이투지체")을 설치 글꼴의 가족명("A2Z")으로: 화면·Word는 가족명으로 찾는다
        args["font"], font_note = fonts.normalize(args["font"])

    if name == "list_fonts":
        if not fonts.known():
            return ToolResponse("설치된 글꼴 목록을 받지 못했습니다 (데스크톱 앱이 아니거나 아직 읽는 중). 글꼴 이름을 그대로 쓰되 사용자에게 설치 여부를 확인하세요."), None
        rows, total = fonts.search(args.get("query"), limit=200)
        if not rows:
            return ToolResponse(f"'{args.get('query')}'에 맞는 설치 글꼴이 없습니다 (설치 글꼴 {len(fonts.fonts())}개)."), None
        lines = [f"- {f.family}" + (f"  ({f.localized})" if f.localized else "") for f in rows]
        head = f"설치된 글꼴 {total}개" + (f" 중 {len(rows)}개 (query로 좁히세요)" if total > len(rows) else "") + " — font 인자에는 가족명(앞의 영문 이름)을 쓴다:"
        return ToolResponse(head + "\n" + "\n".join(lines)), None
    if name == "list_documents":
        docs = [d for d in service.list() if allowed(session, d.id)]
        if not docs:
            return ToolResponse("다룰 수 있는 문서가 없습니다. 웹 화면에서 올리거나 create_document로 만드세요."), None
        lines = [f"- {d.id}  '{d.title}'  [{d.format}]  (리비전 {service.head(d).seq}, {d.updated_at:%Y-%m-%d %H:%M})" for d in docs]
        return ToolResponse("\n".join(lines)), None

    if name == "create_document":
        fmt = args.get("format", "hwpx")
        doc = service.create_blank(args["title"], args.get("markdown", ""), fmt, actor=actor)
        if session is not None and session.document_ids is not None:
            session.document_ids = list(session.document_ids) + [str(doc.id)]
            db.commit()
        bus.publish(doc.id, "edit", revision_seq=1, actor=actor, summary="새 문서", blocks=[], tool=name)
        return ToolResponse(f"새 문서를 만들었습니다: {doc.id} ('{doc.title}', {fmt}). read_document로 확인하세요."), doc.id

    if name == "find_text" and document_id is None:
        hits, truncated = search(db, args["query"], scope, limit=50)
        if not hits:
            return ToolResponse(f"'{args['query'][:40]}'을(를) 어느 문서에서도 찾지 못했습니다."), None
        lines, current = [], None
        for h in hits:
            if h.document_id != current:
                current = h.document_id
                lines.append(f"■ {h.document_title} ({h.document_id})")
            lines.append(h.line())
        if truncated:
            lines.append("… 결과가 더 있습니다. document_id로 문서를 고르거나 query를 더 길게 주세요.")
        return ToolResponse("\n".join(lines)), None

    assert document_id is not None
    if not allowed(session, document_id):
        return ToolResponse("오류[FORBIDDEN] 이 세션이 다룰 수 없는 문서입니다. list_documents로 확인하세요.", True), document_id

    if name == "undo_last_edit":
        _assert_expected_revision(service, document_id, args.get("expected_revision"))
        rev = service.undo(document_id, int(args.get("steps", 1)), actor=actor, force=bool(args.get("force", False)))
        return ToolResponse(f"{args.get('steps', 1)}단계 되돌렸습니다 (리비전 {rev.seq})."), document_id

    loaded = service.load(document_id)
    doc = loaded.hwpx
    if name not in READ_TOOLS and args.get("expected_revision") is not None and int(args["expected_revision"]) != loaded.revision.seq:
        raise CommandError(f"문서가 리비전 {args['expected_revision']} 뒤에 바뀌어 지금은 리비전 {loaded.revision.seq}입니다. 블록 번호가 달라졌을 수 있으니 read_document로 다시 읽고 다시 부르세요.", "STALE_REVISION")
    before = fingerprint(doc) if name not in READ_TOOLS else None
    if name == "read_document":
        text, next_from, next_offset = commands.read_document(doc, args.get("from", 1), args.get("to"), args.get("max_chars", commands.READ_LIMIT), offset=args.get("offset"), table=args.get("table"), include_format=args.get("include_format", False), row_from=args.get("row_from"), row_to=args.get("row_to"))
        return ToolResponse(text), document_id
    if name == "document_info":
        return ToolResponse(f"제목: {loaded.document.title}\n형식: {loaded.document.format}\n리비전: {loaded.revision.seq}\n" + commands.document_info(doc) + "\n" + layout_line(loaded.document, loaded.revision.seq)), document_id
    if name == "find_text":
        return ToolResponse(commands.find(doc, args["query"])), document_id
    if name == "list_fields":
        return ToolResponse(commands.list_fields(doc, args.get("from"), args.get("to"))), document_id

    # 라이브 세션: 편집기가 열려 있으면 편집기 플러그인이 실행하고 결과 파일을 돌려준다 (설계 문서 04 §3 B4)
    if name in live_dispatch.LIVE_ONLY_TOOLS and live.get(document_id) is None:
        raise CommandError("이 도구는 편집기(coredotdocs 화면)가 그 문서를 열고 있을 때만 됩니다. 사용자에게 문서를 열어 달라고 하거나 블록 번호로 고치세요.", "UNSUPPORTED")
    hints = live_dispatch.prepare(name, args, doc) if name in live_dispatch.LIVE_TOOLS and live.get(document_id) is not None else None
    if hints is not None:
        if name in ("read_selection", "list_notes"):
            req = live.request(document_id, name, args, hints)
            res = req.result if req is not None else None
            if not res:
                raise CommandError("편집기가 제때 답하지 않았습니다.", "UNSUPPORTED")
            if not res.get("ok"):
                code = str(res.get("code") or "")
                if code in ("LIVE_FALLBACK", "LIVE_GONE", "LIVE_TIMEOUT", ""):
                    raise CommandError(str(res.get("text") or "편집기가 답하지 않았습니다."), "UNSUPPORTED")
                return ToolResponse(str(res.get("text") or "선택한 부분이 없습니다.")), document_id
            return ToolResponse(str(res.get("text") or "")), document_id
        done = _run_live(db, service, loaded, name, args, hints, actor)
        if done is not None:
            return done, document_id
        if name in live_dispatch.LIVE_ONLY_TOOLS:
            raise CommandError("편집기가 제때 답하지 않았거나 이 요청을 실행하지 못했습니다. 다시 시도하세요.", "UNSUPPORTED")
        # 편집기가 못 해서 서버가 한다: 기다리는 동안 편집기가 올린 리비전이 있을 수 있으니 다시 읽는다 (낡은 내용 덮어쓰기 방지)
        db.expire_all()  # 같은 세션의 identity map에 남은 옛 머리를 버린다
        seen_seq, seen_blocks = loaded.revision.seq, len(doc.blocks())
        loaded = service.load(document_id)
        doc = loaded.hwpx
        # 편집기가 실행 전에 사용자 타이핑을 올렸고 블록 수가 달라졌으면, AI가 읽은 블록 번호는 이제 다른 블록을 가리킬 수 있다
        if loaded.revision.seq != seen_seq and len(doc.blocks()) != seen_blocks and _uses_block_numbers(name, args):
            raise CommandError(f"편집기에서 방금 올린 변경으로 블록 수가 달라졌습니다(리비전 {loaded.revision.seq}). 블록 번호가 바뀌었을 수 있으니 read_document로 다시 읽고 다시 부르세요.", "STALE_REVISION")
        before = fingerprint(doc)
    elif name in live_dispatch.LIVE_ONLY_TOOLS:
        raise CommandError("이 요청에 필요한 값이 빠졌습니다 (예: format_selection은 바꿀 모양을 하나 이상).", "INVALID_ARGUMENT")

    if name == "replace_text":
        result = commands.replace_text(doc, args["find"], args["replace"], args.get("all", False), args.get("block"), args.get("match_case", False))
    elif name == "set_paragraph_text":
        result = commands.set_paragraph(doc, args["block"], args["text"])
    elif name == "insert_content":
        result = commands.insert_content(doc, args["markdown"], args.get("after"), args.get("before"), args.get("like"))
    elif name == "delete_blocks":
        result = commands.delete_blocks(doc, args["from"], args.get("to"), include_objects=bool(args.get("include_objects", False)))
    elif name == "set_table_cells":
        result = commands.set_table_cells(doc, args["table"], args["cells"], overwrite=bool(args.get("overwrite", False)))
    elif name == "format_table":
        result = commands.format_table(doc, args["table"], args["format"])
    elif name == "set_page_setup":
        result = commands.set_page_setup(doc, {k: v for k, v in args.items() if k not in ("document_id", "section", "expected_revision")}, args.get("section"))
    elif name == "insert_table_rows":
        result = commands.insert_table_rows(doc, args["table"], args.get("after_row"), args.get("rows"), args.get("count"))
    elif name == "delete_table_rows":
        result = commands.delete_table_rows(doc, args["table"], args["from"], args.get("to"))
    elif name == "insert_table":
        result = commands.insert_table(doc, args["rows"], args.get("after"), args.get("header", True))
    elif name == "insert_image":
        asset = db.get(Asset, _uuid(args["image_id"]))
        if asset is None:
            raise CommandError(f"그림을 찾지 못했습니다: {args['image_id']}. 화면에서 그림을 먼저 올리세요.", "TARGET_NOT_FOUND")
        result = commands.insert_image(doc, asset.data, args.get("after"), args.get("width_mm"), args.get("align", "center"))
    elif name == "fill_fields":
        result = commands.fill_fields(doc, args["values"])
    elif name == "format_text":
        result = commands.format_text(doc, args["find"], args.get("all", False), args.get("block"), **{k: args.get(k) for k in ("bold", "italic", "underline", "strike", "color", "size", "font")})
    elif name == "format_paragraphs":
        result = commands.format_paragraphs(doc, args.get("from"), args.get("to"), bool(args.get("all", False)), **{k: args.get(k) for k in ("align", "line_spacing", "left", "indent", "space_before", "space_after", "page_break", *commands.CHAR_LOOK_KEYS)})
    else:  # pragma: no cover
        return ToolResponse(f"알 수 없는 도구: {name}", True), document_id

    # 검증-후-확정: 의도하지 않은 구조 변화(표·그림·누름틀·블록 수)가 있으면 리비전으로 확정하지 않는다
    after = fingerprint(doc)
    assert before is not None
    problem = violation(name, before, after)
    if problem:
        db.rollback()
        raise CommandError(problem, "UNEXPECTED_CHANGE")
    place = doc.place(result.blocks[0]) if result.blocks else None
    rev = service.commit_edit(loaded, actor=actor, summary=result.text.split("\n")[0], command={"tool": name, "arguments": json_safe(args)}, blocks=result.blocks, place=place)
    verify = f"검증: {after.line()}" + ("" if after == before else f" (전: {before.line()})")
    note = f"\n주의: {font_note}" if font_note else ""
    return ToolResponse(f"{result.text}{note}\n→ 리비전 {rev.seq}로 저장되었습니다. 화면에 바로 반영되며, undo_last_edit로 되돌릴 수 있습니다.\n{verify}"), document_id


PLUGIN_CODES = {"not_found": "TARGET_NOT_FOUND", "ambiguous": "AMBIGUOUS_TARGET", "no_such_occurrence": "OUT_OF_RANGE", "no_such_table": "OUT_OF_RANGE", "no_such_cell": "OUT_OF_RANGE", "no_such_line": "OUT_OF_RANGE", "no_such_field": "TARGET_NOT_FOUND", "occupied": "CELL_NOT_EMPTY", "holds_object": "HOLDS_OBJECT", "has_objects": "HOLDS_OBJECT", "has_fields": "HOLDS_OBJECT", "unsupported_place": "UNSUPPORTED", "in_table": "UNSUPPORTED", "nested": "UNSUPPORTED", "would_empty": "OUT_OF_RANGE", "no_such_style": "INVALID_ARGUMENT", "changed": "STALE_REVISION", "NONE": "TARGET_NOT_FOUND", "crosses_merged": "UNSUPPORTED", "named_cells": "UNSUPPORTED", "not_merged": "INVALID_ARGUMENT", "count": "INVALID_ARGUMENT", "none": "TARGET_NOT_FOUND", "unsupported": "UNSUPPORTED", "too_long": "UNSUPPORTED"}


def _run_live(db: Session, service: DocumentService, loaded, name: str, args: dict, hints: dict, actor: str) -> ToolResponse | None:
    """편집기에 실행을 맡긴다. None이면 서버가 실행한다(세션 없음·시간 초과·편집기가 폴백 요청·구조 검증 실패)."""
    document_id = loaded.document.id
    req = live.request(document_id, name, args, hints, revision_seq=loaded.revision.seq)
    if req is None or not req.result:
        return None
    res = req.result
    if not res.get("ok"):
        code = str(res.get("code") or "")
        if code in ("LIVE_FALLBACK", "LIVE_GONE", "LIVE_TIMEOUT", ""):
            return None
        raise CommandError(str(res.get("text") or "편집기가 거절했습니다."), PLUGIN_CODES.get(code, code if code.isupper() else "INVALID_ARGUMENT"))
    if not req.data:
        return None
    # 비교 기준은 '결과가 온 시점의 머리': 편집기가 실행 직전에 자기 변경을 올렸으면 그것이 머리다 (사용자 타이핑을 AI 변화로 오인하지 않는다)
    before = fingerprint(service.load(document_id).hwpx)
    parsed = load_document(req.data, loaded.document.filename)
    after = fingerprint(parsed)
    problem = violation(name, before, after)
    if problem:
        # 편집기의 변경을 되돌리고 서버가 실행한다 (엔진 재직렬화로 개수가 다르게 읽힐 수 있어 하드 오류 대신 폴백)
        live.request(document_id, "undo", {}, {"method": "undo", "steps": 1, "foreign": res.get("foreign")}, timeout=10)
        return None
    text = str(res.get("text") or f"{name}을(를) 편집기에서 실행했습니다.")
    place = res.get("place") if isinstance(res.get("place"), dict) else None
    blocks = [int(b) for b in res.get("blocks", []) if isinstance(b, int)] if isinstance(res.get("blocks"), list) else []
    rev, _changed = service.replace_content(document_id, req.data, actor=actor, summary=text.split("\n")[0][:200], source="editor-live", command={"tool": name, "arguments": json_safe(args), "live": True}, blocks=blocks, place=place, client=req.client or None)
    verify = f"검증: {after.line()}" + ("" if after == before else f" (전: {before.line()})")
    return ToolResponse(f"{text}\n→ 리비전 {rev.seq}로 저장되었습니다 (편집기에서 실행, 실행 취소 1단계). undo_last_edit로 되돌릴 수 있습니다.\n{verify}")


BLOCK_ARGS = ("block", "after", "before", "like", "from", "to")


def _uses_block_numbers(name: str, args: dict) -> bool:
    """블록·표 번호로 자리를 가리키는 호출인지 (글로 찾는 replace_text/format_text는 block이 없으면 아니다)."""
    if name in ("set_table_cells", "format_table", "insert_table_rows", "delete_table_rows"):
        return True
    return any(args.get(k) is not None for k in BLOCK_ARGS)


def _assert_expected_revision(service: DocumentService, document_id: uuid.UUID, expected) -> None:
    if expected is None:
        return
    head = service.head(service.get(document_id))
    if int(expected) != head.seq:
        raise CommandError(f"문서가 리비전 {expected} 뒤에 바뀌어 지금은 리비전 {head.seq}입니다. 다시 읽고 다시 부르세요.", "STALE_REVISION")
