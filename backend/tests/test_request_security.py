from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.uploads import read_upload
from app.config import Settings
from app.request_security import LocalRequestMiddleware


@pytest.fixture
def guarded_client():
    app = FastAPI()
    config = Settings(_env_file=None, allowed_hosts=["127.0.0.1", "localhost", "::1"], cors_origins=["http://127.0.0.1:4137", "http://localhost:3000"])
    app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_methods=["*"])
    app.add_middleware(LocalRequestMiddleware, config=config)
    calls = []

    @app.api_route("/probe", methods=["GET", "POST", "DELETE"])
    def probe():
        calls.append(True)
        return {"ok": True}

    with TestClient(app, base_url="http://127.0.0.1:8123") as client:
        yield client, config, calls


@pytest.mark.parametrize("host", ["attacker.example", "localhost.attacker.example", "127.0.0.1.attacker.example", "localhost@attacker.example", "127.0.0.1:bad", "localhost/path", "", "testserver"])
def test_untrusted_host_rejected_before_handler(guarded_client, host):
    client, _, calls = guarded_client
    assert client.post("/probe", headers={"Host": host}).status_code == 400
    assert calls == []


@pytest.mark.parametrize("origin", ["https://attacker.example", "http://localhost:9999", "null", "http://localhost:3000/", "http://user@localhost:3000", "http://localhost:3000?x=y", "http://localhost:3000#x"])
def test_untrusted_origin_rejected_before_handler(guarded_client, origin):
    client, _, calls = guarded_client
    assert client.post("/probe", headers={"Origin": origin}, data={"form": "simple cross-site post"}).status_code == 403
    assert calls == []


def test_cli_mcp_and_configured_desktop_origins_work(guarded_client):
    client, config, calls = guarded_client
    assert client.get("/probe").status_code == 200
    assert client.post("/probe", headers={"Origin": "http://127.0.0.1:4137"}).status_code == 200
    assert client.post("/probe", headers={"Origin": "http://localhost:3000", "Sec-Fetch-Site": "cross-site"}).status_code == 200
    assert client.post("/probe", headers={"Origin": "http://127.0.0.1:8123"}).status_code == 200
    assert client.get("/probe", headers={"Host": "[::1]:8123"}).status_code == 200
    config.allowed_hosts.append("backend")
    assert client.get("/probe", headers={"Host": "backend:8000"}).status_code == 200
    assert len(calls) == 6


def test_cross_site_without_origin_and_duplicate_headers_are_rejected(guarded_client):
    client, _, calls = guarded_client
    assert client.get("/probe", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/probe", headers=[("Host", "localhost"), ("Host", "attacker.example")]).status_code == 400
    assert client.post("/probe", headers=[("Origin", "http://localhost:3000"), ("Origin", "https://attacker.example")]).status_code == 403
    assert calls == []


def test_cors_preflight_accepts_only_configured_origin(guarded_client):
    client, _, calls = guarded_client
    headers = {"Origin": "http://127.0.0.1:4137", "Access-Control-Request-Method": "POST"}
    response = client.options("/probe", headers=headers)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == headers["Origin"]
    headers["Origin"] = "https://attacker.example"
    assert client.options("/probe", headers=headers).status_code == 403
    assert calls == []


@pytest.mark.parametrize("size,content,allowed", [(None, b"abcd", True), (4, b"abcd", True), (None, b"abcde-more-unread", False), (5, b"abcde", False)])
def test_upload_reads_at_most_limit_plus_one(size, content, allowed):
    requests = []

    async def read(count):
        requests.append(count)
        assert count == 5
        return content[:count]

    file = SimpleNamespace(size=size, read=read)
    if allowed:
        assert asyncio.run(read_upload(file, 4, "too big")) == content
    else:
        with pytest.raises(HTTPException) as caught:
            asyncio.run(read_upload(file, 4, "too big"))
        assert caught.value.status_code == 413
    assert requests == ([] if size is not None and size > 4 else [5])


def test_oversized_document_revision_and_image_do_not_change_state(client_with_doc, sample_hwpx, monkeypatch):
    from app.api import documents
    from app.config import settings

    client, document_id = client_with_doc
    count_before = len(client.get("/api/documents").json())
    revision_before = client.get(f"/api/documents/{document_id}").json()["revision_seq"]
    monkeypatch.setattr(settings, "max_upload_bytes", len(sample_hwpx) - 1)
    upload = {"file": ("oversized.hwpx", sample_hwpx, "application/hwp+zip")}
    assert client.post("/api/documents", files=upload).status_code == 413
    assert client.post(f"/api/documents/{document_id}/revisions", files=upload).status_code == 413
    monkeypatch.setattr(documents, "MAX_IMAGE_BYTES", 2)
    assert client.post(f"/api/documents/{document_id}/images", files={"file": ("oversized.png", b"abc", "image/png")}).status_code == 413
    assert len(client.get("/api/documents").json()) == count_before
    assert client.get(f"/api/documents/{document_id}").json()["revision_seq"] == revision_before
    assert client.get(f"/api/documents/{document_id}/images").json() == []
