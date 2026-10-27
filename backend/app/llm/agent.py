"""앱 내 채팅 에이전트 루프: 사용자 메시지 → LLM → (도구 호출 → 실행 → 결과 전달)* → 최종 답.

도구 실행은 MCP 경로와 같은 run_tool을 거치므로 리비전·활동 이벤트·호출 기록이 동일하게 남는다.
채팅은 문서 하나에 묶이고(document_id 강제), 호출 횟수 상한(chat_max_rounds)을 둔다.

6차-2에서 더한 규칙(설계 문서 04 §2 A10, 이음오피스 agent-core에서 배움):
- 문맥: 매 요청마다 문서 정보(블록·표·누름틀·스타일)와 본문 앞부분(CONTEXT_CHARS)을 시스템 지시문에 붙인다.
- 비밀 가리기: 사용자 메시지의 API 키·비밀번호 모양을 모델에 보내기 전에 가린다.
- 폭주 차단: 같은 도구 호출 묶음이 3번 이어지거나(MAX_IDENTICAL_TURNS), 모든 호출이 실패한 턴이 연속 MAX_ALL_ERROR_TURNS이면 멈춘다.
- 답 검증(verify): 편집했다고 말했는데 성공한 편집 도구가 없으면 교정 턴을 한 번만 준다.
- 기록: 성공한 실행만 문서별 대화 기록(ChatMessage)에 남긴다. 실패한 실행의 답은 남기지 않는다.
"""

from __future__ import annotations

import re
import threading
import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..engine import commands
from ..models import AiSession, ChatMessage
from ..services.documents import DocumentService
from ..tools import registry
from ..tools.runner import READ_TOOLS, run_tool
from .gateway import Reply, Transport, Turn, chat

Emit = Callable[[str, dict[str, Any]], None]

RESULT_PREVIEW = 1_500
CONTEXT_CHARS = 6_000
MAX_IDENTICAL_TURNS = 3
MAX_ALL_ERROR_TURNS = 6
MAX_STORED_TEXT = 32_000
HISTORY_TURNS = 40

EDIT_TOOLS = set(registry.EDIT_TOOLS) - {"undo_last_edit"}
CLAIM_WORDS = ("바꿨", "바꾸었", "넣었", "고쳤", "지웠", "채웠", "추가했", "삭제했", "수정했", "적용했", "변경했", "만들었", "작성했")

RULES = [
    "당신은 HWPX·DOCX 문서를 사람과 함께 고치는 편집 도우미입니다.",
    "먼저 read_document(또는 find_text)로 관련 블록을 읽고 블록 번호·글을 정확히 확인한 뒤 편집 도구를 부르세요. 편집 도구에는 읽었을 때의 리비전을 expected_revision으로 넘기세요.",
    "사용자가 요청하지 않은 편집은 하지 마세요. 시키지 않은 서식은 바꾸지 마세요. 될 수 있으면 적게 바꾸세요.",
    "바꿀 말이 문서에 여러 곳이면 도구가 거절하고 후보를 돌려줍니다. 그때는 block이나 all로 좁혀 다시 부르거나 사용자에게 물으세요.",
    "표·그림·누름틀이 든 블록·칸은 도구가 보호합니다(HOLDS_OBJECT, CELL_NOT_EMPTY). 사용자가 분명히 시켰을 때만 include_objects·overwrite를 쓰세요.",
    "메시지에 '선택한 부분'이 있으면 그 부분만 다룹니다: read_selection으로 읽고 replace_selection(토막마다 새 글 하나)·format_selection으로 고칩니다.",
    "할 일을 글로 적지 말고 도구를 부르세요. 도구가 해냈다고 알린 편집만 했다고 말하세요. 도구가 오류를 주면 원인을 설명하고 다른 방법을 제안하세요.",
    "'여백'은 뜻이 여럿입니다: 용지 가장자리와 본문 사이(쪽 여백·용지 여백)는 set_page_setup, 문단 위아래 간격·들여쓰기는 format_paragraphs, 표 칸 안 여백은 format_table의 padding_mm. 어느 쪽인지 분명하지 않으면 사용자에게 물으세요.",
    "글꼴을 바꿀 때는 먼저 list_fonts로 설치된 글꼴을 확인하고 font에는 가족명(영문)을 쓰세요. 문서 전체나 여러 블록의 글꼴·크기는 format_paragraphs(all: true 또는 from~to)로 바꾸고, format_text는 특정 글에만 씁니다. find에 마침표·공백 같은 기호를 넣어 전체를 바꾸려 하지 마세요.",
    "공문서 문체를 지킵니다: 항목 기호는 □, ㅇ, -, 1., 가. 순서를 쓰고 마크다운 기호(#, *, **)는 본문에 넣지 마세요.",
    "답은 한국어로 간결하게, 무엇을 어떻게 바꿨는지 블록 번호를 들어 설명하세요.",
]

_KEY_PATTERNS = [
    re.compile(r"\b(?:cdt|sk-ant|sk|ghp|gho|xoxb|xoxp)[_-][A-Za-z0-9_\-]{12,}"),
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s/@]+:[^\s/@]+@"),
]
_LABELED = re.compile(r"(?i)(?<![A-Za-z가-힣])(password|passwd|pwd|secret|token|api[_-]?key|비밀번호|암호|토큰)(\s*[:=은는]\s*)\S{6,}")


def sanitize_message(text: str) -> str:
    """실수로 붙여 넣은 키·비밀번호를 모델에 보내기 전에 가린다 (이음오피스 sanitizeAgentPayload)."""
    out = text
    for pat in _KEY_PATTERNS:
        out = pat.sub("[가려짐]", out)
    return _LABELED.sub(lambda m: f"{m.group(1)}{m.group(2)}[가려짐]", out)


def document_context(doc, title: str, fmt: str, revision_seq: int) -> str:
    info = commands.document_info(doc)
    text, next_from, _ = commands.read_document(doc, 1, None, CONTEXT_CHARS)
    more = f"\n… (더 있음: read_document from={next_from}로 이어 읽으세요)" if next_from else ""
    return f"## 열린 문서\n제목: {title} ({fmt}), 리비전 {revision_seq}\n{info}\n\n## 본문 (블록 번호와 함께, 앞 {CONTEXT_CHARS:,}자까지)\n{text}{more}"


def system_prompt(title: str, fmt: str, document_id: uuid.UUID, context: str = "") -> str:
    head = "\n".join(RULES)
    return f"{head}\n지금 열린 문서: '{title}' ({fmt}, id {document_id}). 모든 도구의 document_id는 이 문서로 고정됩니다.\n\n{context}".rstrip()


def _scoped_arguments(name: str, arguments: dict[str, Any], document_id: uuid.UUID) -> dict[str, Any]:
    schema = next((t["inputSchema"] for t in registry.TOOLS if t["name"] == name), None)
    args = dict(arguments)
    if schema and "document_id" in (schema.get("properties") or {}):
        args["document_id"] = str(document_id)
    return args


def _signature(reply: Reply) -> tuple:
    return tuple((c.name, tuple(sorted((k, str(v)) for k, v in c.arguments.items()))) for c in reply.tool_calls)


def _claims_edit(text: str) -> bool:
    return any(w in text for w in CLAIM_WORDS)


def load_history(db: Session, document_id: uuid.UUID, limit: int = HISTORY_TURNS) -> list[ChatMessage]:
    rows = list(db.scalars(select(ChatMessage).where(ChatMessage.document_id == document_id).order_by(ChatMessage.seq.desc()).limit(limit)))
    rows.reverse()
    return rows


def _append(db: Session, document_id: uuid.UUID, role: str, text: str, tools: list[dict] | None = None, model: str | None = None) -> None:
    last = db.scalar(select(func.max(ChatMessage.seq)).where(ChatMessage.document_id == document_id)) or 0
    db.add(ChatMessage(document_id=document_id, seq=last + 1, role=role, text=text[:MAX_STORED_TEXT], tools=tools, model=model))
    db.commit()


CHAT_TOOLS = [t for t in registry.TOOLS if t["name"] not in ("create_document", "list_documents")]  # 채팅은 문서 하나에 묶인다


def run_chat(db: Session, *, document_id: uuid.UUID, model: str, api_key: str, history: list[dict[str, str]] | None, message: str, emit: Emit, transport: Transport | None = None, max_rounds: int | None = None, persist: bool = True, stop: threading.Event | None = None, selection: str | None = None) -> str:
    service = DocumentService(db)
    loaded = service.load(document_id)
    document = loaded.document
    message = sanitize_message(message)
    if selection and selection.strip():
        message = f"{message}\n\n## 선택한 부분 (사용자가 편집기에서 고른 글 — 이 요청은 이 부분에 대한 것이다; replace_selection·format_selection으로 고친다)\n{selection.strip()[:6000]}"
    if history is None:
        history = [{"role": m.role, "content": m.text} for m in load_history(db, document_id)]
    turns = [Turn(role=h["role"], content=h["content"]) for h in history if h.get("role") in ("user", "assistant") and h.get("content")]  # type: ignore[arg-type]
    turns.append(Turn("user", message))
    # DB에 저장하지 않는 임시 세션: 범위를 이 문서로 제한하고 행위자는 'ai'
    session = AiSession(name="앱 내 채팅", token_hash="", document_ids=[str(document_id)])
    system = system_prompt(document.title, document.format, document_id, document_context(loaded.hwpx, document.title, document.format, loaded.revision.seq))
    max_rounds = max_rounds or settings.chat_max_rounds
    usage = {"input_tokens": 0, "output_tokens": 0}
    final = ""
    tool_log: list[dict] = []
    edited_ok = False
    identical = 0
    all_error_turns = 0
    last_sig: tuple | None = None
    corrected = False
    for _ in range(max_rounds):
        if stop is not None and stop.is_set():
            emit("error", {"message": "중단했습니다."})
            return final
        reply: Reply = chat(model=model, system=system, turns=turns, tools=CHAT_TOOLS, api_key=api_key, transport=transport)
        usage["input_tokens"] += reply.usage.get("input_tokens", 0)
        usage["output_tokens"] += reply.usage.get("output_tokens", 0)
        if reply.text.strip():
            emit("text", {"text": reply.text})
            final = reply.text
        turns.append(Turn("assistant", reply.text, reply.tool_calls, items=reply.items))
        if not reply.tool_calls:
            # 답 검증: 편집했다고 말했는데 성공한 편집 도구가 없으면 교정 턴 한 번
            if _claims_edit(reply.text) and not edited_ok and not corrected:
                corrected = True
                turns.append(Turn("user", "[앱 확인] 이번 실행에서 성공한 편집 도구 호출이 없습니다. 실제로 고쳤다면 도구를 불러 고치고, 아니면 고치지 않았다고 바로잡아 답하세요."))
                emit("notice", {"message": "답이 편집을 주장했지만 실행된 편집이 없어 다시 확인합니다."})
                continue
            emit("done", {"usage": usage, "model": model})
            if persist:
                _append(db, document_id, "user", message)
                _append(db, document_id, "assistant", final, tools=tool_log or None, model=model)
            return final
        sig = _signature(reply)
        identical = identical + 1 if sig == last_sig else 1
        last_sig = sig
        if identical >= MAX_IDENTICAL_TURNS:
            emit("error", {"message": "같은 도구 호출이 반복되어 멈췄습니다. 요청을 바꿔 다시 시도하세요."})
            return final
        errors = 0
        for call in reply.tool_calls:
            if stop is not None and stop.is_set():
                emit("error", {"message": "중단했습니다. 이미 실행된 편집은 리비전으로 남아 있습니다."})
                return final
            args = _scoped_arguments(call.name, call.arguments, document_id)
            emit("tool_call", {"id": call.id, "name": call.name, "arguments": args})
            result = run_tool(db, call.name, args, session, "ai")
            emit("tool_result", {"id": call.id, "name": call.name, "ok": not result.is_error, "text": result.text[:RESULT_PREVIEW]})
            turns.append(Turn("tool", result.text, tool_call_id=call.id, name=call.name, is_error=result.is_error))
            tool_log.append({"name": call.name, "ok": not result.is_error, "summary": result.text.split("\n")[0][:200]})
            if result.is_error:
                errors += 1
            elif call.name in EDIT_TOOLS:
                edited_ok = True
        all_error_turns = all_error_turns + 1 if errors == len(reply.tool_calls) else 0
        if all_error_turns >= MAX_ALL_ERROR_TURNS:
            emit("error", {"message": f"도구 호출이 {MAX_ALL_ERROR_TURNS}턴 연속 실패해 멈췄습니다. 문서 상태를 확인하고 요청을 바꿔 보세요."})
            return final
    emit("error", {"message": f"도구 호출이 {max_rounds}회를 넘어 멈췄습니다. 요청을 나눠서 다시 시도하세요."})
    return final
