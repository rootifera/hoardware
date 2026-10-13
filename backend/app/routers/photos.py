import logging
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.enums import PhotoRole
from app.models import Item, Photo
from app.routers.items import photo_out
from app.schemas import PhotoOut, PhotoUpdate
from app.services.photos import InvalidImage, new_keys, process_image, process_pending_deletions, queue_deletions
from app.storage import ObjectNotFound, StorageError, get_storage

log = logging.getLogger(__name__)

router = APIRouter(tags=["photos"])
SessionDep = Annotated[Session, Depends(get_session)]

MAX_FILES_PER_REQUEST = 20
MAX_REQUEST_FILES_FACTOR = 5  # a request may carry at most this many max-size files in total


def _read_limited(upload: UploadFile, limit: int) -> bytes:
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"{upload.filename or 'file'} exceeds the {limit // (1024 * 1024)} MB upload limit")
    return data


@router.post("/items/{item_id}/photos", response_model=list[PhotoOut], status_code=201)
def upload_photos(
    item_id: int,
    session: SessionDep,
    files: Annotated[list[UploadFile], File()],
    role: Annotated[PhotoRole, Form()] = PhotoRole.OTHER,
    caption: Annotated[str | None, Form(max_length=1000)] = None,
):
    if len(files) > MAX_FILES_PER_REQUEST:
        raise HTTPException(422, f"at most {MAX_FILES_PER_REQUEST} files per request")
    if session.get(Item, item_id) is None:
        raise HTTPException(404, "item not found")
    settings = get_settings()
    storage = get_storage()

    # Validate everything before storing anything.
    prepared = []
    total = 0
    for upload in files:
        data = _read_limited(upload, settings.max_upload_bytes)
        total += len(data)
        if total > settings.max_upload_bytes * MAX_REQUEST_FILES_FACTOR:
            raise HTTPException(413, "too much data in one request; upload fewer photos at a time")
        if not data:
            raise HTTPException(422, f"{upload.filename or 'file'} is empty")
        try:
            prepared.append((upload, data, process_image(data)))
        except InvalidImage as exc:
            raise HTTPException(415, f"{upload.filename or 'file'}: {exc}") from None

    next_order = session.scalar(select(func.coalesce(func.max(Photo.sort_order), -1) + 1).where(Photo.item_id == item_id))
    written: list[str] = []
    photos: list[Photo] = []
    try:
        for offset, (upload, data, processed) in enumerate(prepared):
            key, thumb_key = new_keys(item_id, processed.extension)
            storage.put(key, data, processed.content_type)
            written.append(key)
            storage.put(thumb_key, processed.thumbnail, "image/webp")
            written.append(thumb_key)
            photos.append(
                Photo(
                    item_id=item_id,
                    storage_key=key,
                    thumb_key=thumb_key,
                    content_type=processed.content_type,
                    size_bytes=len(data),
                    original_filename=(upload.filename or "")[:255] or None,
                    role=role.value,
                    caption=caption.strip() or None if caption else None,
                    sort_order=(next_order or 0) + offset,
                )
            )
        session.add_all(photos)
        session.commit()
    except StorageError as exc:
        session.rollback()
        _cleanup(session, written)
        log.error("photo upload failed: %s", exc)
        raise HTTPException(503, "photo storage is unavailable") from None
    except Exception:
        session.rollback()
        _cleanup(session, written)
        raise
    return [photo_out(p) for p in photos]


def _cleanup(session: Session, keys: list[str]) -> None:
    if not keys:
        return
    queue_deletions(session, keys)
    session.commit()
    try:
        process_pending_deletions(session, get_storage())
    except StorageError:
        pass


@router.patch("/items/{item_id}/photos/{photo_id}", response_model=PhotoOut)
def update_photo(item_id: int, photo_id: int, body: PhotoUpdate, session: SessionDep):
    photo = session.scalar(select(Photo).where(Photo.id == photo_id, Photo.item_id == item_id))
    if photo is None:
        raise HTTPException(404, "photo not found")
    for name, value in body.model_dump(exclude_unset=True).items():
        if name != "caption" and value is None:
            raise HTTPException(422, f"{name} cannot be null")
        setattr(photo, name, value.value if hasattr(value, "value") else value)
    session.commit()
    return photo_out(photo)


@router.delete("/items/{item_id}/photos/{photo_id}", status_code=204)
def delete_photo(item_id: int, photo_id: int, session: SessionDep):
    photo = session.scalar(select(Photo).where(Photo.id == photo_id, Photo.item_id == item_id))
    if photo is None:
        raise HTTPException(404, "photo not found")
    queue_deletions(session, [photo.storage_key, photo.thumb_key])
    session.delete(photo)
    session.commit()
    try:
        process_pending_deletions(session, get_storage())
    except StorageError:
        pass
    return Response(status_code=204)


def _stream(request: Request, photo: Photo, key: str, content_type: str) -> Response:
    etag = f'"{key}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    try:
        chunks, size = get_storage().open(key)
    except ObjectNotFound:
        raise HTTPException(404, "photo file is missing from storage") from None
    except StorageError as exc:
        log.error("photo read failed: %s", exc)
        raise HTTPException(503, "photo storage is unavailable") from None
    headers["Content-Length"] = str(size)
    return StreamingResponse(chunks, media_type=content_type, headers=headers)


@router.get("/photos/{photo_id}/file")
def get_photo_file(photo_id: int, request: Request, session: SessionDep):
    photo = session.get(Photo, photo_id)
    if photo is None:
        raise HTTPException(404, "photo not found")
    return _stream(request, photo, photo.storage_key, photo.content_type)


@router.get("/photos/{photo_id}/thumbnail")
def get_photo_thumbnail(photo_id: int, request: Request, session: SessionDep):
    photo = session.get(Photo, photo_id)
    if photo is None:
        raise HTTPException(404, "photo not found")
    return _stream(request, photo, photo.thumb_key, "image/webp")
