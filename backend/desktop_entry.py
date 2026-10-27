"""데스크톱 앱(PyInstaller)용 진입점.

  editor-server                 HTTP API 서버 (EDITOR_PORT, EDITOR_DATABASE_URL 등 환경 변수)
  editor-server --mcp           외부 AI 앱용 stdio MCP 브리지 (EDITOR_API_URL, EDITOR_AI_TOKEN)
"""

from __future__ import annotations

import os
import sys


def main() -> None:
    if "--mcp" in sys.argv[1:]:
        from app.mcp_stdio import main as mcp_main

        mcp_main()
        return
    import uvicorn

    from app.main import app

    port = int(os.environ.get("EDITOR_PORT", "8000"))
    uvicorn.run(app, host=os.environ.get("EDITOR_HOST", "127.0.0.1"), port=port, log_level=os.environ.get("EDITOR_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
