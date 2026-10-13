"""Database backups: pg_dump (custom format) to a local directory and/or S3."""

import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.engine import make_url

from app.config import Settings, get_settings
from app.storage.base import StorageError
from app.storage.s3 import make_s3_client

log = logging.getLogger(__name__)

NAME_RE = re.compile(r"^hoardware-\d{8}T\d{6}Z\.dump$")


@dataclass
class BackupInfo:
    name: str
    where: str  # "local" or "s3"
    size: int
    modified: datetime


def _pg_env(settings: Settings) -> tuple[list[str], dict[str, str]]:
    url = make_url(settings.database_url)
    args = ["-h", url.host or "localhost", "-p", str(url.port or 5432), "-U", url.username or "postgres"]
    env = dict(os.environ)
    if url.password:
        env["PGPASSWORD"] = url.password
    return args + ["-d", url.database or "postgres"], env


def _s3(settings: Settings):
    if not settings.backup_s3_bucket:
        return None
    client = make_s3_client(
        endpoint_url=settings.backup_s3_endpoint_url or settings.s3_endpoint_url,
        region=settings.backup_s3_region or settings.s3_region,
        access_key_id=settings.backup_s3_access_key_id or settings.s3_access_key_id,
        secret_access_key=settings.backup_s3_secret_access_key or settings.s3_secret_access_key,
        force_path_style=settings.s3_force_path_style,
    )
    return client, settings.backup_s3_bucket, settings.backup_s3_prefix


def create_backup() -> list[BackupInfo]:
    """Dump the database and store it on every configured destination."""
    settings = get_settings()
    name = f"hoardware-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    settings.backup_local_dir.mkdir(parents=True, exist_ok=True)
    target = settings.backup_local_dir / name
    partial = target.with_suffix(".dump.partial")
    pg_args, env = _pg_env(settings)

    result = subprocess.run(
        ["pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--file", str(partial), *pg_args],
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump failed: {result.stderr.strip()}")
    partial.replace(target)
    created = [BackupInfo(name, "local", target.stat().st_size, datetime.now(timezone.utc))]

    s3 = _s3(settings)
    if s3:
        client, bucket, prefix = s3
        try:
            client.upload_file(str(target), bucket, f"{prefix}{name}")
        except Exception as exc:
            raise StorageError(f"local backup {name} written, but S3 upload failed: {exc}") from exc
        created.append(BackupInfo(name, "s3", target.stat().st_size, datetime.now(timezone.utc)))

    apply_retention(settings)
    return created


def list_backups() -> list[BackupInfo]:
    settings = get_settings()
    found: list[BackupInfo] = []
    if settings.backup_local_dir.is_dir():
        for path in settings.backup_local_dir.iterdir():
            if NAME_RE.match(path.name):
                stat = path.stat()
                found.append(BackupInfo(path.name, "local", stat.st_size, datetime.fromtimestamp(stat.st_mtime, timezone.utc)))
    s3 = _s3(settings)
    if s3:
        client, bucket, prefix = s3
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                name = obj["Key"][len(prefix):]
                if NAME_RE.match(name):
                    found.append(BackupInfo(name, "s3", obj["Size"], obj["LastModified"]))
    return sorted(found, key=lambda b: (b.name, b.where), reverse=True)


def apply_retention(settings: Settings) -> None:
    keep = settings.backup_retention_count
    if keep <= 0:
        return
    backups = list_backups()
    for where in ("local", "s3"):
        names = sorted((b.name for b in backups if b.where == where), reverse=True)
        for name in names[keep:]:
            log.info("retention: removing %s backup %s", where, name)
            if where == "local":
                (settings.backup_local_dir / name).unlink(missing_ok=True)
            else:
                client, bucket, prefix = _s3(settings)
                client.delete_object(Bucket=bucket, Key=f"{prefix}{name}")


def restore_backup(name: str, source: str | None = None) -> None:
    """Restore ``name`` into the configured database, replacing its contents.

    The application containers should be stopped first (see the README)."""
    if not NAME_RE.match(name):
        raise ValueError(f"not a Hoardware backup name: {name}")
    settings = get_settings()
    local = settings.backup_local_dir / name
    use = source or ("local" if local.is_file() else "s3")

    with tempfile.TemporaryDirectory() as tmp:
        if use == "local":
            if not local.is_file():
                raise FileNotFoundError(f"{local} does not exist")
            dump = local
        else:
            s3 = _s3(settings)
            if not s3:
                raise RuntimeError("BACKUP_S3_BUCKET is not configured")
            client, bucket, prefix = s3
            dump = Path(tmp) / name
            client.download_file(bucket, f"{prefix}{name}", str(dump))

        pg_args, env = _pg_env(settings)
        result = subprocess.run(
            ["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error", *pg_args, str(dump)],
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"pg_restore failed: {result.stderr.strip()}")
