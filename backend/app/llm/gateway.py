"""core.today LLM 게이트웨이 호출. 모델 이름의 접두어로 요청 형식을 고른다.

- claude-*  → Anthropic Messages            POST {base}/llm/anthropic/v1/messages
- gemini-*  → Gemini의 OpenAI 호환 엔드포인트  POST {base}/llm/gemini/v1beta/openai/chat/completions
- gpt-6*·gpt-5.6+·*-codex·*-pro → OpenAI Responses  POST {base}/llm/openai/v1/responses
  (이 모델들은 Chat Completions에서 함수 도구를 거부한다 — 게이트웨이 400 "use /v1/responses", 2026-10-24 확인)
- grok-* / deepseek-* / muse-* / "공급자/모델" → OpenAI 호환 Chat Completions
  POST {base}/llm/{grok|deepseek|meta|openrouter}/v1/chat/completions
- 그 외     → OpenAI Chat Completions         POST {base}/llm/openai/v1/chat/completions

모든 형식이 같은 Bearer 키를 쓴다. 대화는 공급자 중립 형식(Turn)으로 들고 있다가 요청 직전에
공급자 형식으로 바꾸고, 응답은 다시 중립 형식(Reply)으로 돌린다. Gemini는 tool_call에 붙는
thought_signature를 다음 요청에 그대로 돌려줘야 하므로 OpenAI 계열 tool_call 원본을 raw로 보관한다.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from ..config import settings

Provider = Literal["anthropic", "openai", "responses", "gemini", "grok", "deepseek", "meta", "openrouter"]
# OpenAI 호환 Chat Completions를 쓰는 공급자 (게이트웨이 경로 접두어만 다르다)
COMPAT: dict[str, str] = {"openai": "openai/v1", "gemini": "gemini/v1beta/openai", "grok": "grok/v1", "deepseek": "deepseek/v1", "meta": "meta/v1", "openrouter": "openrouter/v1"}
_RESPONSES_ONLY = re.compile(r"^(gpt-(?:[6-9]|5\.(?:[6-9]|\d{2}))|.*-codex(?:-|$)|(?:gpt-|o\d).*-pro(?:-\d{4}-\d{2}-\d{2})?$)")
# (method, url, headers, json_body|None) → (status, json_body)
Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None], tuple[int, dict[str, Any]]]

TIMEOUT = 180.0


class GatewayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    raw: dict[str, Any] | None = None  # OpenAI 계열 원본 (Gemini thought_signature 보존용)


@dataclass
class Turn:
    role: Literal["user", "assistant", "tool"]
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None
    is_error: bool = False
    items: list[dict[str, Any]] | None = None  # Responses 출력 원본(추론 항목 포함) — 다음 요청에 그대로 돌려준다


@dataclass
class Reply:
    text: str
    tool_calls: list[ToolCall]
    usage: dict[str, int]
    stop: str
    items: list[dict[str, Any]] | None = None


def route(model: str) -> Provider:
    m = model.strip().lower()
    if m.startswith("claude"):
        return "anthropic"
    if m.startswith("gemini"):
        return "gemini"
    if m.startswith("grok"):
        return "grok"
    if m.startswith("deepseek"):
        return "deepseek"
    if m.startswith("muse-"):
        return "meta"
    if "/" in m:
        return "openrouter"
    if _RESPONSES_ONLY.match(m):
        return "responses"
    return "openai"


def endpoint(provider: Provider, base: str | None = None) -> str:
    base = (base or settings.cdt_api_base).rstrip("/")
    if provider == "anthropic":
        return f"{base}/llm/anthropic/v1/messages"
    if provider == "responses":
        return f"{base}/llm/openai/v1/responses"
    return f"{base}/llm/{COMPAT[provider]}/chat/completions"


def http_transport(method: str, url: str, headers: dict[str, str], body: dict[str, Any] | None) -> tuple[int, dict[str, Any]]:
    try:
        res = httpx.request(method, url, headers=headers, json=body, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        raise GatewayError(502, f"LLM 게이트웨이에 연결하지 못했습니다: {e}") from e
    try:
        data = res.json()
    except ValueError:
        data = {"error": {"message": res.text[:300]}}
    return res.status_code, data if isinstance(data, dict) else {"data": data}


# --- 도구 정의 변환 ----------------------------------------------------------------

def tool_specs(provider: Provider, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if provider == "anthropic":
        return [{"name": t["name"], "description": t["description"], "input_schema": t["inputSchema"]} for t in tools]
    if provider == "responses":
        return [{"type": "function", "name": t["name"], "description": t["description"], "parameters": t["inputSchema"]} for t in tools]
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]}} for t in tools]


# --- 대화 변환 ---------------------------------------------------------------------

def to_anthropic(turns: list[Turn]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for t in turns:
        if t.role == "user":
            messages.append({"role": "user", "content": t.content})
        elif t.role == "assistant":
            content: list[dict[str, Any]] = []
            if t.content.strip():
                content.append({"type": "text", "text": t.content})
            for c in t.tool_calls:
                content.append({"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments})
            messages.append({"role": "assistant", "content": content or [{"type": "text", "text": "(빈 응답)"}]})
        else:
            block: dict[str, Any] = {"type": "tool_result", "tool_use_id": t.tool_call_id, "content": t.content or "(결과 없음)"}
            if t.is_error:
                block["is_error"] = True
            last = messages[-1] if messages else None
            if last and last["role"] == "user" and isinstance(last["content"], list) and last["content"] and last["content"][0].get("type") == "tool_result":
                last["content"].append(block)  # 같은 턴의 도구 결과는 한 메시지로
            else:
                messages.append({"role": "user", "content": [block]})
    return messages


def to_openai(system: str, turns: list[Turn]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for t in turns:
        if t.role == "user":
            messages.append({"role": "user", "content": t.content})
        elif t.role == "assistant":
            msg: dict[str, Any] = {"role": "assistant", "content": t.content or None}
            if t.tool_calls:
                msg["tool_calls"] = [c.raw or {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.arguments, ensure_ascii=False)}} for c in t.tool_calls]
            messages.append(msg)
        else:
            messages.append({"role": "tool", "tool_call_id": t.tool_call_id, "content": t.content or "(결과 없음)"})
    return messages


def to_responses(turns: list[Turn]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for t in turns:
        if t.role == "user":
            items.append({"role": "user", "content": t.content})
        elif t.role == "assistant":
            if t.items is not None:  # 같은 실행 안의 Responses 출력: 추론 항목까지 그대로
                items.extend(t.items)
                continue
            if t.content.strip():
                items.append({"role": "assistant", "content": t.content})
            for c in t.tool_calls:
                items.append({"type": "function_call", "call_id": c.id, "name": c.name, "arguments": json.dumps(c.arguments, ensure_ascii=False)})
        else:
            out = t.content or "(결과 없음)"
            items.append({"type": "function_call_output", "call_id": t.tool_call_id, "output": f"오류: {out}" if t.is_error else out})
    return items


# --- 응답 해석 ---------------------------------------------------------------------

def parse_anthropic(data: dict[str, Any]) -> Reply:
    text, calls = [], []
    for block in data.get("content") or []:
        if block.get("type") == "text":
            text.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            calls.append(ToolCall(id=str(block.get("id")), name=str(block.get("name")), arguments=dict(block.get("input") or {})))
    u = data.get("usage") or {}
    return Reply("".join(text), calls, {"input_tokens": int(u.get("input_tokens", 0)), "output_tokens": int(u.get("output_tokens", 0))}, str(data.get("stop_reason") or ""))


def parse_openai(data: dict[str, Any]) -> Reply:
    choices = data.get("choices") or []
    if not choices:
        raise GatewayError(502, "LLM 응답에 choices가 없습니다.")
    msg = choices[0].get("message") or {}
    calls = []
    for raw in msg.get("tool_calls") or []:
        fn = raw.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            args = {"_invalid_json": fn.get("arguments")}
        calls.append(ToolCall(id=str(raw.get("id")), name=str(fn.get("name")), arguments=args if isinstance(args, dict) else {}, raw=raw))
    u = data.get("usage") or {}
    content = msg.get("content")
    if isinstance(content, list):  # 일부 공급자는 content를 파트 배열로 준다
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return Reply(content or "", calls, {"input_tokens": int(u.get("prompt_tokens", 0)), "output_tokens": int(u.get("completion_tokens", 0))}, str(choices[0].get("finish_reason") or ""))


def parse_responses(data: dict[str, Any]) -> Reply:
    output = [o for o in data.get("output") or [] if isinstance(o, dict)]
    text, calls = [], []
    for o in output:
        if o.get("type") == "message":
            text.extend(c.get("text", "") for c in o.get("content") or [] if isinstance(c, dict) and c.get("type") == "output_text")
        elif o.get("type") == "function_call":
            try:
                args = json.loads(o.get("arguments") or "{}")
            except ValueError:
                args = {"_invalid_json": o.get("arguments")}
            calls.append(ToolCall(id=str(o.get("call_id")), name=str(o.get("name")), arguments=args if isinstance(args, dict) else {}))
    u = data.get("usage") or {}
    stop = str((data.get("incomplete_details") or {}).get("reason") or data.get("status") or "")
    return Reply("".join(text), calls, {"input_tokens": int(u.get("input_tokens", 0)), "output_tokens": int(u.get("output_tokens", 0))}, stop, items=output)


# --- 호출 -------------------------------------------------------------------------

def _error_message(status: int, data: dict[str, Any], model: str) -> str:
    err = data.get("error")
    detail = (err.get("message") if isinstance(err, dict) else err) or data.get("message") or json.dumps(data, ensure_ascii=False)[:300]
    if status == 401:
        return "core.today API 키가 올바르지 않습니다. 키를 확인하세요."
    if status == 402:
        return f"core.today 크레딧이 부족합니다. ({detail})"
    if status == 404 or (isinstance(err, dict) and err.get("code") == "model_not_found"):
        return f"모델을 찾지 못했습니다: {model}. ({detail})"
    if status == 429:
        return f"요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요. ({detail})"
    return f"LLM 게이트웨이 오류 {status}: {detail}"


def chat(*, model: str, system: str, turns: list[Turn], tools: list[dict[str, Any]], api_key: str, transport: Transport | None = None, max_tokens: int | None = None) -> Reply:
    provider = route(model)
    transport = transport or http_transport
    max_tokens = max_tokens or settings.chat_max_tokens
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        return _call(provider, model, system, turns, tools, headers, transport, max_tokens)
    except GatewayError as e:
        # 새 OpenAI 모델이 Chat Completions에서 도구를 거부하면 Responses로 한 번 더 (접두어 규칙이 못 따라간 모델)
        if provider == "openai" and e.status == 400 and "/v1/responses" in e.message:
            return _call("responses", model, system, turns, tools, headers, transport, max_tokens)
        raise


def _call(provider: Provider, model: str, system: str, turns: list[Turn], tools: list[dict[str, Any]], headers: dict[str, str], transport: Transport, max_tokens: int) -> Reply:
    if provider == "responses":
        # store=false: 대화를 OpenAI 쪽에 남기지 않는다. 추론 항목은 암호문으로 받아 다음 요청에 돌려준다.
        body: dict[str, Any] = {"model": model, "instructions": system, "input": to_responses(turns), "max_output_tokens": max_tokens, "store": False, "include": ["reasoning.encrypted_content"]}
        if tools:
            body["tools"] = tool_specs(provider, tools)
    elif provider == "anthropic":
        headers = {**headers, "anthropic-version": "2023-06-01"}
        body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": to_anthropic(turns)}
        if tools:
            body["tools"] = tool_specs(provider, tools)
    else:
        body = {"model": model, "messages": to_openai(system, turns)}
        # OpenAI 추론 모델(gpt-5·o 계열)은 max_tokens를 거부하므로 max_completion_tokens를 쓴다. 다른 호환 경로는 max_tokens.
        body["max_completion_tokens" if provider == "openai" else "max_tokens"] = max_tokens
        if tools:
            body["tools"] = tool_specs(provider, tools)
    status, data = transport("POST", endpoint(provider), headers, body)
    if status >= 400:
        raise GatewayError(status, _error_message(status, data, model))
    if provider == "anthropic":
        return parse_anthropic(data)
    return parse_responses(data) if provider == "responses" else parse_openai(data)


def check_key(api_key: str, transport: Transport | None = None) -> bool:
    """인증이 필요한 무료 단가표 조회로 키를 확인한다. 401만 잘못된 키로 판단한다.

    공급자별 /openai/v1/models는 유효한 키에도 공급자 오류를 낼 수 있다.
    단가표 캐시는 쓰지 않고 매번 전달받은 키를 게이트웨이에서 확인한다.
    """
    transport = transport or http_transport
    base = settings.cdt_api_base.rstrip("/")
    status, data = transport("GET", f"{base}/llm/v1/pricing", {"Authorization": f"Bearer {api_key}"}, None)
    if status == 401:
        return False
    if status >= 400:
        raise GatewayError(status, _error_message(status, data, ""))
    if status != 200 or not isinstance(data.get("models"), list):
        raise GatewayError(502, "core.today API 키 확인 응답 형식이 올바르지 않습니다. 잠시 뒤 다시 시도하세요.")
    return True


def fetch_pricing(api_key: str, transport: Transport | None = None) -> list[dict[str, Any]]:
    """게이트웨이가 받는 모델과 단가(GET /llm/v1/pricing, 키 필요). 실패하면 GatewayError."""
    transport = transport or http_transport
    base = settings.cdt_api_base.rstrip("/")
    status, data = transport("GET", f"{base}/llm/v1/pricing", {"Authorization": f"Bearer {api_key}"}, None)
    if status >= 400:
        raise GatewayError(status, _error_message(status, data, ""))
    models = data.get("models")
    return [m for m in models if isinstance(m, dict) and isinstance(m.get("id"), str)] if isinstance(models, list) else []
