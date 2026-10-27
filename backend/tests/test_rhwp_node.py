"""서버 쪽 rhwp 사이드카: Node가 있으면 옛 HWP를 HWPX로 바꿔 받는다 (설계 문서 04 §8.2-5). Node나 엔진 폴더가 없으면 건너뛴다."""

from __future__ import annotations

import pytest

from app.engine import commands, rhwp_node
from app.engine.hwpx import HwpxDocument
from app.engine.loader import create_blank
from tests.test_api import client, doc_id  # noqa: F401


@pytest.fixture
def engine_hwpx() -> bytes:
    """rhwp가 읽는 완전한 HWPX (테스트용 최소 패키지는 rhwp가 거부한다 — 머리 정보가 모자라서)."""
    doc = create_blank("hwpx", "사이드카")
    commands.insert_content(doc, "관측용 샘플입니다 hello\n\n| a | b |\n|---|---|\n| 1 | 2 |")
    return doc.to_bytes()

pytestmark = pytest.mark.skipif(not rhwp_node.available(), reason="node 또는 rhwp 엔진 폴더(frontend/public/rhwp-core) 없음")


def test_roundtrip_hwpx_hwp_hwpx(engine_hwpx):
    hwp = rhwp_node.convert(engine_hwpx, "hwp")
    assert hwp and hwp[:4] == b"\xd0\xcf\x11\xe0"
    back = rhwp_node.hwp_to_hwpx(hwp)
    assert back and back[:2] == b"PK"
    doc = HwpxDocument.load(back)
    assert "관측용 샘플입니다 hello" in doc.plain_text()


def test_upload_hwp_is_converted(client, engine_hwpx):
    hwp = rhwp_node.convert(engine_hwpx, "hwp")
    r = client.post("/api/documents", files={"file": ("옛문서.hwp", hwp, "application/x-hwp")})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["format"] == "hwpx"
    doc = client.get(f"/api/documents/{body['id']}").json()
    assert doc["filename"].endswith(".hwpx")
    read = client.get(f"/api/documents/{body['id']}/read").json()
    assert "hello" in read["text"]
