from collections.abc import Iterator
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.storage.base import ObjectNotFound, Storage, StorageError

CHUNK = 64 * 1024


def make_s3_client(
    *,
    endpoint_url: str | None,
    region: str,
    access_key_id: str | None,
    secret_access_key: str | None,
    force_path_style: bool = True,
):
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url or None,
        region_name=region,
        aws_access_key_id=access_key_id or None,
        aws_secret_access_key=secret_access_key or None,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if force_path_style else "virtual"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def _is_missing(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}


class S3Storage(Storage):
    name = "s3"

    def __init__(self, client, bucket: str, prefix: str = ""):
        self.client = client
        self.bucket = bucket
        self.prefix = prefix

    def _key(self, key: str) -> str:
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise StorageError(f"invalid storage key: {key!r}")
        return f"{self.prefix}{key}"

    def put(self, key: str, data: bytes, content_type: str) -> None:
        try:
            self.client.put_object(
                Bucket=self.bucket, Key=self._key(key), Body=data, ContentType=content_type
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(str(exc)) from exc

    def put_file(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        try:
            self.client.upload_fileobj(
                fileobj, self.bucket, self._key(key), ExtraArgs={"ContentType": content_type}
            )
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(str(exc)) from exc

    def open(self, key: str) -> tuple[Iterator[bytes], int]:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
        except ClientError as exc:
            if _is_missing(exc):
                raise ObjectNotFound(key) from exc
            raise StorageError(str(exc)) from exc
        except BotoCoreError as exc:
            raise StorageError(str(exc)) from exc

        body = response["Body"]

        def chunks() -> Iterator[bytes]:
            try:
                yield from body.iter_chunks(CHUNK)
            finally:
                body.close()

        return chunks(), response["ContentLength"]

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except ClientError as exc:
            if _is_missing(exc):
                return False
            raise StorageError(str(exc)) from exc
        except BotoCoreError as exc:
            raise StorageError(str(exc)) from exc

    def delete(self, key: str) -> None:
        # S3 delete is already idempotent.
        try:
            self.client.delete_object(Bucket=self.bucket, Key=self._key(key))
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(str(exc)) from exc

    def check(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except (BotoCoreError, ClientError) as exc:
            raise StorageError(str(exc)) from exc
