"""Downloads: manuals, drivers, tools and other files attached to an item."""

import logging
import mimetypes
import re
import uuid
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.enums import FileKind
from app.models import Item, ItemFile
from app.schemas import FileOut, FileUpdate
from app.services.photos import process_pending_deletions, queue_deletions
from app.storage import ObjectNotFound, StorageError, get_storage

log = logging.getLogger(__name__)

router = APIRouter(tags=["files"])
SessionDep = Annotated[Session, Depends(get_session)]

MAX_FILES_PER_REQUEST = 10


def file_url(file_id: int) -> str:
    return f"/api/v1/files/{file_id}/download"


def file_out(f: ItemFile) -> FileOut:
    return FileOut(
        id=f.id,
        item_id=f.item_id,
        filename=f.filename,
        kind=f.kind,
        description=f.description,
        content_type=f.content_type,
        size_bytes=f.size_bytes,
        created_at=f.created_at,
        url=file_url(f.id),
    )


def file_key(item_id: int, token: str, filename: str) -> str:
    return f"items/{item_id}/files/{token[:8]}/{filename}"


def clean_filename(name: str | None) -> str:
    """The base name only, without control characters or path parts."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip().strip(".")
    return base[:255] or "file"


def _size(upload: UploadFile) -> int:
    upload.file.seek(0, 2)
    size = upload.file.tell()
    upload.file.seek(0)
    return size


@router.post("/items/{item_id}/files", response_model=list[FileOut], status_code=201)
def upload_files(
    item_id: int,
    session: SessionDep,
    files: Annotated[list[UploadFile], File()],
    kind: Annotated[FileKind, Form()] = FileKind.OTHER,
    description: Annotated[str | None, Form(max_length=1000)] = None,
):
    if len(files) > MAX_FILES_PER_REQUEST:
        raise HTTPException(422, f"at most {MAX_FILES_PER_REQUEST} files per request")
    if session.get(Item, item_id) is None:
        raise HTTPException(404, "item not found")
    limit = get_settings().max_file_bytes
    sizes = []
    for upload in files:
        size = _size(upload)
        name = clean_filename(upload.filename)
        if size == 0:
            raise HTTPException(422, f"{name} is empty")
        if size > limit:
            raise HTTPException(413, f"{name} exceeds the {limit // (1024 * 1024)} MB limit for files")
        sizes.append(size)

    storage = get_storage()
    written: list[str] = []
    rows: list[ItemFile] = []
    try:
        for upload, size in zip(files, sizes, strict=True):
            name = clean_filename(upload.filename)
            # The real file name is part of the key, so the bucket is readable when browsed directly.
            key = file_key(item_id, uuid.uuid4().hex, name)
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            storage.put_file(key, upload.file, content_type)
            written.append(key)
            rows.append(
                ItemFile(
                    item_id=item_id,
                    storage_key=key,
                    filename=name,
                    content_type=content_type,
                    size_bytes=size,
                    kind=kind.value,
                    description=description.strip() or None if description else None,
                )
            )
        session.add_all(rows)
        session.commit()
    except StorageError as exc:
        session.rollback()
        _cleanup(session, written)
        log.error("file upload failed: %s", exc)
        raise HTTPException(503, "file storage is unavailable") from None
    except Exception:
        session.rollback()
        _cleanup(session, written)
        raise
    return [file_out(r) for r in rows]


def _cleanup(session: Session, keys: list[str]) -> None:
    if not keys:
        return
    queue_deletions(session, keys)
    session.commit()
    try:
        process_pending_deletions(session, get_storage())
    except StorageError:
        pass


@router.patch("/items/{item_id}/files/{file_id}", response_model=FileOut)
def update_file(item_id: int, file_id: int, body: FileUpdate, session: SessionDep):
    row = session.scalar(select(ItemFile).where(ItemFile.id == file_id, ItemFile.item_id == item_id))
    if row is None:
        raise HTTPException(404, "file not found")
    for name, value in body.model_dump(exclude_unset=True).items():
        if name != "description" and value is None:
            raise HTTPException(422, f"{name} cannot be null")
        if name == "filename":
            value = clean_filename(value)
        setattr(row, name, value.value if hasattr(value, "value") else value)
    session.commit()
    return file_out(row)


@router.delete("/items/{item_id}/files/{file_id}", status_code=204)
def delete_file(item_id: int, file_id: int, session: SessionDep):
    row = session.scalar(select(ItemFile).where(ItemFile.id == file_id, ItemFile.item_id == item_id))
    if row is None:
        raise HTTPException(404, "file not found")
    queue_deletions(session, [row.storage_key])
    session.delete(row)
    session.commit()
    try:
        process_pending_deletions(session, get_storage())
    except StorageError:
        pass
    return Response(status_code=204)


def _disposition(filename: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"


@router.get("/files/{file_id}/download")
def download_file(file_id: int, session: SessionDep):
    row = session.get(ItemFile, file_id)
    if row is None:
        raise HTTPException(404, "file not found")
    try:
        chunks, size = get_storage().open(row.storage_key)
    except ObjectNotFound:
        raise HTTPException(404, "the file is missing from storage") from None
    except StorageError as exc:
        log.error("file read failed: %s", exc)
        raise HTTPException(503, "file storage is unavailable") from None
    # Always an attachment, never rendered by the browser: an uploaded .html must not run on this origin.
    headers = {
        "Content-Disposition": _disposition(row.filename),
        "Content-Length": str(size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
    }
    return StreamingResponse(chunks, media_type=row.content_type, headers=headers)
