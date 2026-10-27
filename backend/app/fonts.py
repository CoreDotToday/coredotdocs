"""설치된 글꼴 목록(데스크톱 앱이 메인 프로세스에서 읽어 POST /api/fonts로 올린다).

도구 인자의 글꼴 이름을 설치된 가족명(영문)으로 맞춘다: 사용자는 "에이투지체"라 부르지만 글꼴 파일의 가족명은 "A2Z"이고,
화면(Chromium)·Word는 영문 가족명으로 찾는다. 목록을 못 받았으면(웹판) 이름을 그대로 둔다.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class Font:
    family: str
    localized: str | None = None


_lock = threading.Lock()
_fonts: list[Font] = []
_index: dict[str, str] = {}


def _key(name: str) -> str:
    return "".join(name.lower().split())


def set_fonts(fonts: list[Font]) -> int:
    global _fonts, _index
    seen: dict[str, Font] = {}
    for f in fonts:
        fam = f.family.strip()
        if fam and fam not in seen:
            seen[fam] = Font(fam, (f.localized or "").strip() or None)
    index: dict[str, str] = {}
    for f in seen.values():
        index.setdefault(_key(f.family), f.family)
        if f.localized:
            index.setdefault(_key(f.localized), f.family)
    with _lock:
        _fonts = sorted(seen.values(), key=lambda f: (f.localized or f.family).casefold())
        _index = index
    return len(_fonts)


def fonts() -> list[Font]:
    with _lock:
        return list(_fonts)


def known() -> bool:
    with _lock:
        return bool(_fonts)


def normalize(name: str) -> tuple[str, str | None]:
    """(쓸 이름, 안내). 설치 목록에 있으면 가족명으로; 없으면 그대로 두고 안내를 돌려준다. 목록이 없으면 안내 없음."""
    with _lock:
        index, have = _index, bool(_fonts)
    name = name.strip()
    if not have:
        return name, None
    hit = index.get(_key(name))
    if hit is None:
        return name, f"'{name}'은(는) 설치된 글꼴 목록에 없습니다. list_fonts로 확인하세요. (이름을 그대로 적었으니 그 글꼴이 없는 컴퓨터에서는 다른 글꼴로 보입니다)"
    return hit, None


def search(query: str | None, limit: int = 200) -> tuple[list[Font], int]:
    q = _key(query) if query else ""
    rows = [f for f in fonts() if not q or q in _key(f.family) or (f.localized and q in _key(f.localized))]
    return rows[:limit], len(rows)
