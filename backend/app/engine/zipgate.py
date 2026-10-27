"""올라온 ZIP 패키지(HWPX·DOCX)를 풀기 전에 거는 안전 검사.

선언된 크기를 믿지 않고 실제로 풀리는 양을 재서 끊는다(조작된 central directory 방어). 항목 수·항목별 크기·총량·
압축비 상한, 경로 탈출(`..`·절대 경로·NUL), 암호 항목, stored/deflate 외 압축 방식, zip64를 거절한다.
XML 쪽은 DOCTYPE/ENTITY 선언(주석 밖, 항목 전체)을 거절해 엔티티 확장(billion laughs)·외부 엔티티를 막는다.
zip64·여러 디스크 아카이브는 Python zipfile이 읽는 범위 안에서 같은 규칙으로 검사한다(별도 거절은 없다).
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass

from .errors import EngineError

_CHUNK = 1 << 16


@dataclass(frozen=True)
class ZipLimits:
    max_entries: int = 10_000
    max_entry_bytes: int = 128 * 1024 * 1024
    max_total_bytes: int = 256 * 1024 * 1024
    max_xml_scan_bytes: int = 32 * 1024 * 1024  # DOCTYPE 검사를 위해 메모리에 두는 XML 상한; 넘는 XML 항목은 거절
    max_ratio: int = 200  # 압축비 상한 (1MiB 넘는 항목에만 적용)
    ratio_floor: int = 1024 * 1024


DEFAULT_LIMITS = ZipLimits()
_ALLOWED_METHODS = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
_XML_SUFFIXES = (".xml", ".hpf", ".rels", ".opf")


class PackageRejected(EngineError):
    """검사에 걸린 패키지. code는 프로그램이 분기하는 값, 메시지는 사람이 읽는 말."""

    def __init__(self, code: str, message: str, *, entry: str | None = None):
        super().__init__(message)
        self.code = code
        self.entry = entry


def _unsafe_name(name: str) -> bool:
    if not name or "\x00" in name:
        return True
    if name.startswith(("/", "\\")) or (len(name) > 1 and name[1] == ":"):
        return True
    parts = name.replace("\\", "/").split("/")
    depth = 0
    for p in parts:
        if p == "..":
            depth -= 1
            if depth < 0:
                return True
        elif p and p != ".":
            depth += 1
    return False


_COMMENT = re.compile(rb"<!--.*?-->", re.S)
_DECL = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.I)


def _has_doctype(xml: bytes) -> bool:
    """주석을 뺀 전체에서 DOCTYPE/ENTITY 선언을 찾는다 (프롤로그의 긴 주석 뒤에 숨겨도 잡는다)."""
    return _DECL.search(_COMMENT.sub(b"", xml)) is not None


def inspect_package(data: bytes, limits: ZipLimits = DEFAULT_LIMITS) -> None:
    """통과하면 None, 아니면 PackageRejected. zip이 아니면 EngineError가 아니라 BadZipFile을 그대로 둔다(형식 판별은 호출자 몫)."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return  # 형식 판별 단계가 처리한다
    with zf:
        infos = zf.infolist()
        if len(infos) > limits.max_entries:
            raise PackageRejected("too_many_entries", f"패키지 항목이 너무 많습니다 ({len(infos)} > {limits.max_entries}).")
        total = 0
        for info in infos:
            name = info.filename
            if _unsafe_name(name):
                raise PackageRejected("unsafe_entry_path", f"허용되지 않는 항목 경로입니다: {name!r}", entry=name)
            if info.flag_bits & 0x1:
                raise PackageRejected("encrypted_entry", f"암호가 걸린 항목은 열 수 없습니다: {name}", entry=name)
            if info.compress_type not in _ALLOWED_METHODS:
                raise PackageRejected("unsupported_compression", f"지원하지 않는 압축 방식입니다 ({info.compress_type}): {name}", entry=name)
            if info.file_size > limits.max_entry_bytes:
                raise PackageRejected("entry_too_large", f"항목이 너무 큽니다 ({info.file_size} B): {name}", entry=name)
            if info.file_size > limits.ratio_floor and info.compress_size > 0 and info.file_size // info.compress_size > limits.max_ratio:
                raise PackageRejected("suspicious_ratio", f"압축비가 비정상적으로 높습니다 ({info.file_size // info.compress_size}:1): {name}", entry=name)
            total += info.file_size
            if total > limits.max_total_bytes:
                raise PackageRejected("package_too_large", f"패키지를 풀면 너무 큽니다 (> {limits.max_total_bytes} B).")
            if info.is_dir():
                continue
            # 실제로 풀어 보며 선언 크기+1에서 끊는다: 선언을 믿지 않는다
            seen = 0
            is_xml = name.lower().endswith(_XML_SUFFIXES)
            if is_xml and info.file_size > limits.max_xml_scan_bytes:
                raise PackageRejected("entry_too_large", f"XML 항목이 너무 큽니다 ({info.file_size} B): {name}", entry=name)
            parts: list[bytes] = []
            cap = info.file_size + 1
            try:
                with zf.open(info) as fh:
                    while seen < cap:
                        chunk = fh.read(min(_CHUNK, cap - seen))
                        if not chunk:
                            break
                        if is_xml:
                            parts.append(chunk)
                        seen += len(chunk)
            except (zipfile.BadZipFile, EOFError, OSError) as e:
                raise PackageRejected("corrupt_entry", f"항목을 풀지 못했습니다: {name} ({e})", entry=name) from e
            if seen != info.file_size:
                raise PackageRejected("size_mismatch", f"선언된 크기와 실제 크기가 다릅니다: {name}", entry=name)
            if is_xml and _has_doctype(b"".join(parts)):
                raise PackageRejected("xml_doctype", f"DOCTYPE/ENTITY 선언이 든 XML은 받지 않습니다: {name}", entry=name)
