"""Bound memory used when materializing a spooled multipart upload."""
from fastapi import HTTPException, UploadFile


async def read_upload(file: UploadFile, limit: int, detail: str) -> bytes:
    # Starlette has already spooled multipart files; never copy an unbounded file into memory.
    if file.size is not None and file.size > limit:
        raise HTTPException(413, detail)
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, detail)
    return data
