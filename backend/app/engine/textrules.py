"""문서에 들어갈 글의 공통 규칙: XML 1.0에 적을 수 있는 문자만 받는다."""

from __future__ import annotations

import re
from typing import Any

# XML 1.0 Char 집합 밖의 문자: C0 제어 문자(탭·줄바꿈·CR 제외), 서로게이트, U+FFFE/U+FFFF
_FORBIDDEN = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff￾￿]")

# UTF-16 기준으로 짝 없는 서로게이트를 찾는다 (JSON에서 "\ud800" 같은 값이 그대로 들어올 수 있다)


def first_forbidden_char(text: str) -> str | None:
    m = _FORBIDDEN.search(text)
    return m.group(0) if m else None


def assert_xml_safe(value: Any, where: str = "입력") -> None:
    """문자열이면 검사하고, dict/list면 안쪽까지 모두 검사한다."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            bad = first_forbidden_char(item)
            if bad is not None:
                raise ValueError(f"{where}에 XML로 저장할 수 없는 문자(U+{ord(bad):04X})가 있습니다. 해당 문자를 바꿔 다시 시도하세요.")
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, (list, tuple)):
            stack.extend(item)


def slice_keeping_pairs(text: str, start: int, end: int) -> str:
    """앞뒤 문맥을 자를 때 서로게이트 쌍을 끊지 않는다 (Python str은 코드 포인트 단위라 보통 안전하지만,
    짝 없는 서로게이트가 섞인 문자열도 그대로 다룬다)."""
    start = max(0, min(start, len(text)))
    end = max(start, min(end, len(text)))
    return text[start:end]
