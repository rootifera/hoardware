from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # IANA timezone used for "today" (verified/tested dates). Set TZ in .env.
    tz: str = "UTC"

    # Single-user login. Empty AUTH_PASSWORD (and AUTH_PASSWORD_HASH) = no login required.
    # AUTH_PASSWORD_HASH (from `python -m app.cli hash-password`) is preferred over a plain password.
    auth_username: str = "admin"
    auth_password: str | None = None
    auth_password_hash: str | None = None
    auth_session_days: int = 30
    # auto: Secure cookie when the request came in over https (X-Forwarded-Proto), else not.
    auth_cookie_secure: Literal["auto", "always", "never"] = "auto"

    database_url: str = "postgresql+psycopg://hoardware:hoardware@db:5432/hoardware"

    # Photos
    # "auto" uses S3 when a bucket is configured, otherwise the local volume.
    storage_backend: Literal["auto", "local", "s3"] = "auto"
    photos_dir: Path = Path("/data/photos")
    max_upload_bytes: int = 20 * 1024 * 1024
    max_file_bytes: int = 1024 * 1024 * 1024  # manuals, drivers, tools
    max_image_pixels: int = 100_000_000
    thumbnail_size: int = 480

    # S3-compatible object storage (photos; also the default for backups)
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str | None = None
    s3_prefix: str = ""  # empty = the bucket root: items/<id>/...
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_force_path_style: bool = True

    # Database backups. Local backups are always written; S3 is added when
    # BACKUP_S3_BUCKET is set. Unset BACKUP_S3_* connection values fall back
    # to the S3_* ones.
    backup_local_dir: Path = Path("/backups")
    backup_retention_count: int = 14
    backup_interval_hours: float = 24
    backup_s3_bucket: str | None = None
    backup_s3_prefix: str = "backups/"
    backup_s3_endpoint_url: str | None = None
    backup_s3_region: str | None = None
    backup_s3_access_key_id: str | None = None
    backup_s3_secret_access_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
