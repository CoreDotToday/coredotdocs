from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import fonts as registry

router = APIRouter(prefix="/api/fonts", tags=["fonts"])


class FontItem(BaseModel):
    family: str = Field(min_length=1, max_length=200)
    localized: str | None = Field(default=None, max_length=200)


class FontsBody(BaseModel):
    fonts: list[FontItem] = Field(max_length=5000)


@router.post("")
def set_fonts(body: FontsBody):
    n = registry.set_fonts([registry.Font(f.family, f.localized) for f in body.fonts])
    return {"count": n}


@router.get("")
def list_fonts():
    return {"fonts": [{"family": f.family, "localized": f.localized} for f in registry.fonts()]}
