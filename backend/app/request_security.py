"""Reject untrusted browser origins and Host headers before an API handler runs."""
from __future__ import annotations

from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import Settings


def _authority(value: str) -> tuple[str, int | None] | None:
    if not value or any(c.isspace() or c in "/\\@?#%" for c in value):
        return None
    try:
        parsed = urlsplit("//" + value)
        if not parsed.hostname or parsed.username is not None:
            return None
        return parsed.hostname.lower(), parsed.port
    except ValueError:
        return None


class LocalRequestMiddleware:
    def __init__(self, app: ASGIApp, config: Settings):
        self.app = app
        self.config = config

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        hosts = headers.getlist("host")
        authority = _authority(hosts[0]) if len(hosts) == 1 else None
        if authority is None or authority[0] not in {host.lower() for host in self.config.allowed_hosts}:
            await JSONResponse({"detail": "허용되지 않은 Host입니다."}, status_code=400)(scope, receive, send)
            return

        origins = headers.getlist("origin")
        allowed = True
        if origins:
            allowed = len(origins) == 1 and self._allowed_origin(origins[0], scope["scheme"], authority)
        elif headers.get("sec-fetch-site") == "cross-site":
            # CLI/MCP clients omit Origin; a browser's cross-site no-CORS request must not use that exception.
            allowed = False
        if not allowed:
            await JSONResponse({"detail": "허용되지 않은 Origin입니다."}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)

    def _allowed_origin(self, origin: str, scheme: str, authority: tuple[str, int | None]) -> bool:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            return False
        if parsed.scheme not in {"http", "https"} or parsed.path or parsed.query or parsed.fragment:
            return False
        origin_authority = _authority(parsed.netloc)
        if origin_authority is None:
            return False
        if origin in self.config.cors_origins:
            return True
        # The API's own documentation/client may send a same-origin request.
        default_port = 443 if scheme == "https" else 80
        return parsed.scheme == scheme and origin_authority[0] == authority[0] and (origin_authority[1] or default_port) == (authority[1] or default_port)
