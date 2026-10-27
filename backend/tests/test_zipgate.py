"""ZIP/XML 게이트: 올라온 패키지를 풀기 전에 거는 검사 (설계 문서 04 §2 A7)."""

from __future__ import annotations

import io
import zipfile

import pytest

from app.engine.errors import EngineError
from app.engine.loader import load_document
from app.engine.zipgate import PackageRejected, ZipLimits, inspect_package


def _zip(entries: dict[str, bytes], *, flag_bits: int = 0, method: int = zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = method
            info.flag_bits |= flag_bits
            zf.writestr(info, data)
    return buf.getvalue()


def test_sample_passes(sample_hwpx):
    inspect_package(sample_hwpx)
    load_document(sample_hwpx)


def test_path_traversal_rejected():
    with pytest.raises(PackageRejected) as e:
        inspect_package(_zip({"Contents/../../etc/passwd": b"x"}))
    assert e.value.code == "unsafe_entry_path"
    with pytest.raises(PackageRejected):
        inspect_package(_zip({"/abs.xml": b"x"}))
    # NUL은 zipfile이 쓰기 단계에서 잘라 내므로 검사 함수로 직접 본다
    from app.engine.zipgate import _unsafe_name

    assert _unsafe_name("a\x00b") and _unsafe_name("..") and not _unsafe_name("Contents/section0.xml")


def _set_encrypted_flag(data: bytes) -> bytes:
    """zipfile은 쓰기 때 flag_bits를 초기화하므로, 로컬 헤더(PK\x03\x04, +6)와 central directory(PK\x01\x02, +8)의 플래그를 직접 켠다."""
    b = bytearray(data)
    for sig, off in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        i = b.find(sig)
        while i >= 0:
            b[i + off] |= 0x1
            i = b.find(sig, i + 4)
    return bytes(b)


def test_encrypted_entry_rejected():
    with pytest.raises(PackageRejected) as e:
        inspect_package(_set_encrypted_flag(_zip({"Contents/section0.xml": b"<a/>"})))
    assert e.value.code == "encrypted_entry"


def test_bomb_limits_use_real_decompressed_size():
    import os

    big = os.urandom(3 * 1024 * 1024)  # 압축되지 않는 3MiB (압축비 ≈ 1)
    data = _zip({"Contents/big.bin": big})
    inspect_package(data)  # 기본 한도 안
    with pytest.raises(PackageRejected) as e:
        inspect_package(data, ZipLimits(max_total_bytes=1024 * 1024))
    assert e.value.code == "package_too_large"
    with pytest.raises(PackageRejected) as e:
        inspect_package(data, ZipLimits(max_entry_bytes=1024 * 1024))
    assert e.value.code == "entry_too_large"


def test_zip_bomb_ratio_rejected_by_default():
    zeros = b"\0" * (3 * 1024 * 1024)  # deflate로 약 1000:1
    with pytest.raises(PackageRejected) as e:
        inspect_package(_zip({"Contents/big.bin": zeros}))
    assert e.value.code == "suspicious_ratio"
    inspect_package(_zip({"Contents/big.bin": zeros}), ZipLimits(max_ratio=2000))  # 한도를 올리면 통과(실제 해제량도 선언과 같다)


def test_forged_central_directory_size_is_caught():
    """central directory의 file_size를 줄여 적어도 실제로 풀리는 양으로 잡는다."""
    big = b"A" * 200_000
    data = bytearray(_zip({"Contents/x.bin": big}, method=zipfile.ZIP_STORED))
    # local header와 central directory 양쪽의 uncompressed size(4바이트)를 100으로 바꾼다
    needle = (200_000).to_bytes(4, "little")
    count = 0
    start = 0
    while True:
        i = data.find(needle, start)
        if i < 0:
            break
        data[i : i + 4] = (100).to_bytes(4, "little")
        count += 1
        start = i + 4
    assert count >= 2
    with pytest.raises(PackageRejected) as e:
        inspect_package(bytes(data))
    assert e.value.code in {"size_mismatch", "corrupt_entry"}


def test_doctype_xml_rejected(sample_hwpx):
    with zipfile.ZipFile(io.BytesIO(sample_hwpx)) as zf:
        entries = {n: zf.read(n) for n in zf.namelist()}
    entries["Contents/section0.xml"] = b'<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa">]>' + entries["Contents/section0.xml"].split(b"?>", 1)[1]
    data = _zip(entries)
    with pytest.raises(PackageRejected) as e:
        inspect_package(data)
    assert e.value.code == "xml_doctype"
    with pytest.raises(EngineError):
        load_document(data)


def test_too_many_entries():
    data = _zip({f"e{i}": b"" for i in range(50)})
    with pytest.raises(PackageRejected) as e:
        inspect_package(data, ZipLimits(max_entries=10))
    assert e.value.code == "too_many_entries"


def test_doctype_after_long_comment_is_caught(sample_hwpx):
    """프롤로그의 긴 주석 뒤에 숨긴 DOCTYPE도 잡는다 (리뷰 #3)."""
    with zipfile.ZipFile(io.BytesIO(sample_hwpx)) as zf:
        entries = {n: zf.read(n) for n in zf.namelist()}
    body = entries["Contents/section0.xml"].split(b"?>", 1)[1]
    entries["Contents/section0.xml"] = b'<?xml version="1.0"?><!--' + b" " * 6000 + b'--><!DOCTYPE lol [<!ENTITY a "aaaa">]>' + body
    with pytest.raises(PackageRejected) as e:
        inspect_package(_zip(entries))
    assert e.value.code == "xml_doctype"
    # 주석 안의 글은 선언이 아니다
    entries["Contents/section0.xml"] = b'<?xml version="1.0"?><!-- <!DOCTYPE x> -->' + body
    inspect_package(_zip(entries))
