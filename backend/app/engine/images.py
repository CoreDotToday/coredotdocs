"""그림 바이트의 형식과 픽셀 크기 읽기 (PNG·JPEG·GIF·BMP). 외부 라이브러리 없이 헤더만 본다."""

from __future__ import annotations

import struct
from dataclasses import dataclass


@dataclass
class ImageInfo:
    width: int
    height: int
    ext: str  # png | jpg | gif | bmp
    media_type: str


def image_info(data: bytes) -> ImageInfo | None:
    if len(data) < 24:
        return None
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return ImageInfo(w, h, "png", "image/png")
    if data[:6] in (b"GIF87a", b"GIF89a"):
        w, h = struct.unpack("<HH", data[6:10])
        return ImageInfo(w, h, "gif", "image/gif")
    if data[:2] == b"BM" and len(data) >= 26:
        w, h = struct.unpack("<ii", data[18:26])
        return ImageInfo(abs(w), abs(h), "bmp", "image/bmp")
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = struct.unpack(">H", data[i + 2 : i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return ImageInfo(w, h, "jpg", "image/jpeg")
            i += 2 + length
    return None
