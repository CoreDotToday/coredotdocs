from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api import live, chat, documents, fonts, tools
from .config import settings
from .db import init_db
from .request_security import LocalRequestMiddleware
from .services.events import bus


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    bus.loop = asyncio.get_running_loop()
    yield


app = FastAPI(title="코어닷독스", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(LocalRequestMiddleware, config=settings)
app.include_router(documents.router)
app.include_router(tools.router)
app.include_router(chat.router)
app.include_router(live.router)
app.include_router(fonts.router)


@app.get("/api/health")
def health():
    return {"ok": True}
