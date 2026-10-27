#!/usr/bin/env bash
# 백엔드를 PyInstaller로 한 폴더(onedir)에 묶는다 → dist/editor-server/ (Electron 앱의 resources/backend로 들어간다)
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON_VERSION=$(cat ../desktop/scripts/python-version.txt)
uv sync --quiet --frozen --managed-python --python "$PYTHON_VERSION"
rm -rf build/editor-server dist/editor-server
uv run --frozen pyinstaller --noconfirm --clean --onedir --name editor-server \
  --paths . \
  --hidden-import app.main --hidden-import app.mcp_stdio \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto --hidden-import uvicorn.loops.asyncio \
  --hidden-import uvicorn.protocols.http.auto --hidden-import uvicorn.protocols.http.h11_impl --hidden-import uvicorn.protocols.http.httptools_impl \
  --hidden-import uvicorn.protocols.websockets.auto --hidden-import uvicorn.lifespan.on --hidden-import uvicorn.lifespan.off \
  --collect-all jsonschema --collect-all jsonschema_specifications --collect-submodules sqlalchemy.dialects.sqlite \
  --exclude-module psycopg --exclude-module psycopg_binary --exclude-module psycopg_c \
  --exclude-module psycopg2 --exclude-module psycopg2cffi --exclude-module asyncpg --exclude-module pg8000 \
  --add-data 'app/engine/rhwp_convert.mjs:app/engine' \
  desktop_entry.py
uv run --frozen python ../desktop/scripts/collect-python-licenses.py --write
echo "→ dist/editor-server/editor-server"
