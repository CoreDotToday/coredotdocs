"""작은 마크다운 → 문단/표 명세.

지원: 제목(#~######), 목록(-, *, +, 1.), 인용(>), 표(| a | b | + 구분선), 쪽 나누기(<!-- pagebreak -->),
인라인 **굵게**·*기울임*·~~취소선~~. 그 외 문법은 글 그대로 둔다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
_QUOTE = re.compile(r"^>\s?(.*)$")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$")
_PAGEBREAK = re.compile(r"^\s*<!--\s*pagebreak\s*-->\s*$", re.I)
_INLINE = re.compile(r"(\*\*.+?\*\*|~~.+?~~|(?<!\*)\*(?!\*).+?(?<!\*)\*(?!\*))")


@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    strike: bool = False


@dataclass
class ParagraphSpec:
    runs: list[Run]
    kind: str = "body"  # body | heading | bullet | numbered | quote
    level: int = 0
    page_break: bool = False

    @property
    def text(self) -> str:
        return "".join(r.text for r in self.runs)


@dataclass
class TableSpec:
    rows: list[list[str]]
    header: bool = True
    align: list[str] = field(default_factory=list)


Spec = ParagraphSpec | TableSpec


def inline_runs(text: str) -> list[Run]:
    """**굵게**, *기울임*, ~~취소선~~을 run으로 나눈다 (한 단계만, 중첩은 글 그대로)."""
    runs: list[Run] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append(Run(text[pos : m.start()]))
        token = m.group(0)
        if token.startswith("**"):
            runs.append(Run(token[2:-2], bold=True))
        elif token.startswith("~~"):
            runs.append(Run(token[2:-2], strike=True))
        else:
            runs.append(Run(token[1:-1], italic=True))
        pos = m.end()
    if pos < len(text):
        runs.append(Run(text[pos:]))
    return [r for r in runs if r.text]


def plain(text: str) -> str:
    return "".join(r.text for r in inline_runs(text))


def _split_row(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", body)]


def parse(markdown: str) -> list[Spec]:
    specs: list[Spec] = []
    buffer: list[str] = []
    pending_break = False
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    def flush() -> None:
        nonlocal pending_break
        if buffer:
            specs.append(ParagraphSpec(inline_runs(" ".join(s.strip() for s in buffer)), page_break=pending_break))
            pending_break = False
            buffer.clear()

    def add(spec: Spec) -> None:
        nonlocal pending_break
        if isinstance(spec, ParagraphSpec):
            spec.page_break = spec.page_break or pending_break
            pending_break = False
        specs.append(spec)

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            flush()
            i += 1
            continue
        if _PAGEBREAK.match(line):
            flush()
            pending_break = True
            i += 1
            continue
        if _TABLE_ROW.match(line) and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush()
            header = _split_row(line)
            aligns = []
            for cell in _split_row(lines[i + 1]):
                aligns.append("center" if cell.startswith(":") and cell.endswith(":") else "right" if cell.endswith(":") else "left")
            rows = [header]
            i += 2
            while i < len(lines) and _TABLE_ROW.match(lines[i]):
                rows.append(_split_row(lines[i]))
                i += 1
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            add(TableSpec(rows=[[plain(c) for c in r] for r in rows], header=True, align=aligns))
            continue
        if m := _HEADING.match(line):
            flush()
            add(ParagraphSpec(inline_runs(m.group(2).strip()), "heading", len(m.group(1))))
        elif m := _BULLET.match(line):
            flush()
            add(ParagraphSpec([Run("• ")] + inline_runs(m.group(1).strip()), "bullet"))
        elif m := _NUMBERED.match(line):
            flush()
            add(ParagraphSpec([Run(f"{m.group(1)}. ")] + inline_runs(m.group(2).strip()), "numbered"))
        elif m := _QUOTE.match(line):
            flush()
            add(ParagraphSpec(inline_runs(m.group(1).strip()), "quote"))
        else:
            buffer.append(line)
        i += 1
    flush()
    return [s for s in specs if isinstance(s, TableSpec) or s.text]
