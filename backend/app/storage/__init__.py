from functools import lru_cache

from app.config import get_settings
from app.storage.base import ObjectNotFound, Storage, StorageError

__all__ = ["ObjectNotFound", "Storage", "StorageError", "build_storage", "get_storage"]


def build_storage(name: str) -> Storage:
    """Construct a storage backend by name (``local``, ``s3`` or ``auto``)."""
    settings = get_settings()
    if name == "auto":
        name = "s3" if settings.s3_bucket else "local"
    if name == "local":
        from app.storage.local import LocalStorage

        return LocalStorage(settings.photos_dir)
    if name == "s3":
        from app.storage.s3 import S3Storage, make_s3_client

        if not settings.s3_bucket:
            raise StorageError("S3_BUCKET must be set to use the s3 storage backend")
        client = make_s3_client(
            endpoint_url=settings.s3_endpoint_url,
            region=settings.s3_region,
            access_key_id=settings.s3_access_key_id,
            secret_access_key=settings.s3_secret_access_key,
            force_path_style=settings.s3_force_path_style,
        )
        return S3Storage(client, settings.s3_bucket, settings.s3_prefix)
    raise StorageError(f"unknown storage backend: {name}")


@lru_cache
def get_storage() -> Storage:
    return build_storage(get_settings().storage_backend)
