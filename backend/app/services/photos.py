"""Photo validation, thumbnailing and storage bookkeeping."""

import io
import logging
import uuid
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import PendingDeletion
from app.storage import Storage, StorageError

log = logging.getLogger(__name__)

# Detected image format -> (content type, extension). The client-supplied
# content type and filename are never trusted.
ALLOWED_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
}


class InvalidImage(ValueError):
    pass


@dataclass
class ProcessedImage:
    content_type: str
    extension: str
    thumbnail: bytes


def process_image(data: bytes) -> ProcessedImage:
    settings = get_settings()
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format
            probe.verify()
        if fmt not in ALLOWED_FORMATS:
            raise InvalidImage("unsupported image type (allowed: JPEG, PNG, GIF, WebP)")
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image)
            image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
            size = settings.thumbnail_size
            image.thumbnail((size, size))
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=80)
    except InvalidImage:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError) as exc:
        raise InvalidImage("file is not a valid image") from exc
    content_type, extension = ALLOWED_FORMATS[fmt]
    return ProcessedImage(content_type, extension, buffer.getvalue())


def new_keys(item_id: int, extension: str) -> tuple[str, str]:
    token = uuid.uuid4().hex
    return f"items/{item_id}/{token}.{extension}", f"items/{item_id}/{token}_thumb.webp"


def queue_deletions(session: Session, keys: list[str]) -> None:
    """Record keys for deletion in the caller's transaction."""
    session.add_all(PendingDeletion(storage_key=key) for key in keys)


def process_pending_deletions(session: Session, storage: Storage, limit: int = 500) -> tuple[int, int]:
    """Try to delete queued objects. Returns (deleted, failed)."""
    deleted = failed = 0
    rows = session.scalars(select(PendingDeletion).order_by(PendingDeletion.id).limit(limit)).all()
    for row in rows:
        try:
            storage.delete(row.storage_key)
        except StorageError as exc:
            row.attempts += 1
            row.last_error = str(exc)[:500]
            failed += 1
            log.warning("could not delete %s: %s", row.storage_key, exc)
        else:
            session.delete(row)
            deleted += 1
    session.commit()
    return deleted, failed
