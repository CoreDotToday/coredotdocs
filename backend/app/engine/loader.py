"""파일 바이트 → 형식 판별 → 엔진 문서."""

from __future__ import annotations

import zipfile
import io

from .errors import EngineError
from .zipgate import inspect_package

FORMATS = ("hwpx", "docx")
MEDIA_TYPES = {"hwpx": "application/hwp+zip", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


def detect_format(data: bytes, filename: str = "") -> str:
    name = filename.lower()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = set(zf.namelist())
    except zipfile.BadZipFile:
        if name.endswith(".hwp"):
            raise EngineError("옛 HWP(.hwp) 파일은 이 편집기가 읽지 못합니다. 한글에서 HWPX로 저장해 올려 주세요.")
        raise EngineError("HWPX 또는 DOCX(zip) 파일이 아닙니다.")
    inspect_package(data)  # 풀기 전 안전 검사 (ZIP 폭탄·경로 탈출·암호 항목·DOCTYPE)
    if "Contents/content.hpf" in names or name.endswith(".hwpx"):
        return "hwpx"
    if "word/document.xml" in names or name.endswith(".docx"):
        return "docx"
    raise EngineError("HWPX 또는 DOCX 패키지가 아닙니다.")


def load_document(data: bytes, filename: str = ""):
    fmt = detect_format(data, filename)
    if fmt == "hwpx":
        from .hwpx import HwpxDocument

        return HwpxDocument.load(data)
    from .docx import DocxDocument

    return DocxDocument.load(data)


def create_blank(fmt: str, title: str):
    if fmt == "hwpx":
        from .blank import create_blank as hwpx_blank

        return hwpx_blank(title)
    if fmt == "docx":
        from .docx import create_blank as docx_blank

        return docx_blank(title)
    raise EngineError(f"지원하지 않는 형식: {fmt}")
