"""쪽 설정(용지 크기·방향·여백) — HWPX(`hp:secPr/hp:pagePr`)와 DOCX(`w:sectPr/w:pgSz·w:pgMar`) 공통 모델.

단위: 화면·도구는 mm. HWPX는 HWPUNIT(1/7200인치), DOCX는 트윕(1/1440인치).
용지 방향: DOCX는 `w:pgSz`의 w·h가 실제 놓인 크기이고 가로면 `w:orient="landscape"`.
HWPX는 한글이 width·height를 늘 세로 값으로 쓰고 가로는 `landscape="NARROWLY"`로 표시한다(세로는 "WIDELY").
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .errors import CommandError

MM_PER_INCH = 25.4
PAPERS: dict[str, tuple[float, float]] = {  # 세로 기준 (너비, 높이) mm
    "A3": (297, 420),
    "A4": (210, 297),
    "A5": (148, 210),
    "B4": (257, 364),
    "B5": (182, 257),
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
}
MIN_BODY_MM = 20.0
EDGES = ("top", "bottom", "left", "right", "header", "footer", "gutter")


@dataclass(frozen=True)
class PageSetup:
    """한 구역의 쪽 설정 (mm). width·height는 놓인 그대로(가로면 width > height)."""

    width: float
    height: float
    landscape: bool
    top: float
    bottom: float
    left: float
    right: float
    header: float
    footer: float
    gutter: float = 0.0

    @property
    def paper(self) -> str | None:
        short, long_ = sorted((self.width, self.height))
        for name, (w, h) in PAPERS.items():
            if abs(short - w) < 1.0 and abs(long_ - h) < 1.0:
                return name
        return None

    def line(self) -> str:
        paper = self.paper or f"{self.width:g}×{self.height:g}mm"
        return (
            f"용지 {paper} {'가로' if self.landscape else '세로'} ({_mm(self.width)}×{_mm(self.height)}mm), "
            f"여백 위 {_mm(self.top)} 아래 {_mm(self.bottom)} 왼쪽 {_mm(self.left)} 오른쪽 {_mm(self.right)}mm, "
            f"머리말 {_mm(self.header)} 꼬리말 {_mm(self.footer)}mm" + (f", 제본 {_mm(self.gutter)}mm" if self.gutter else "")
        )


def _mm(v: float) -> str:
    return f"{round(v, 1):g}"


def apply_patch(cur: PageSetup, patch: dict) -> PageSetup:
    """도구 인자(paper·width_mm·height_mm·orientation·margins_mm·header_mm·footer_mm·gutter_mm)를 적용한 새 설정. 본문이 너무 좁아지면 거절."""
    width, height, landscape = cur.width, cur.height, cur.landscape
    if patch.get("paper"):
        w, h = PAPERS[patch["paper"]]
        width, height = (h, w) if landscape else (w, h)
    if patch.get("width_mm") is not None:
        width = float(patch["width_mm"])
    if patch.get("height_mm") is not None:
        height = float(patch["height_mm"])
    orientation = patch.get("orientation")
    if orientation is not None:
        want = orientation == "landscape"
        if want != (width > height) and width != height:
            width, height = height, width
        landscape = want
    elif patch.get("width_mm") is not None or patch.get("height_mm") is not None:
        landscape = width > height
    edges = {k: getattr(cur, k) for k in EDGES}
    for k, v in (patch.get("margins_mm") or {}).items():
        edges[k] = float(v)
    for k in ("header", "footer", "gutter"):
        if patch.get(f"{k}_mm") is not None:
            edges[k] = float(patch[f"{k}_mm"])
    out = replace(cur, width=width, height=height, landscape=landscape, **edges)
    body_w = out.width - out.left - out.right - out.gutter
    body_h = out.height - out.top - out.bottom
    if body_w < MIN_BODY_MM or body_h < MIN_BODY_MM:
        raise CommandError(f"여백이 너무 커서 본문이 {body_w:.0f}×{body_h:.0f}mm만 남습니다. 본문이 {MIN_BODY_MM:.0f}mm 이상 남도록 여백을 줄이세요.", "OUT_OF_RANGE")
    return out


def to_unit(mm: float, per_inch: int) -> int:
    return int(round(mm / MM_PER_INCH * per_inch))


def from_unit(v: int, per_inch: int) -> float:
    return round(v / per_inch * MM_PER_INCH, 1)  # 0.1mm: 트윕·HWPUNIT 왕복의 끝수(14.99)를 감춘다
