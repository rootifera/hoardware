import pytest
from botocore.exceptions import ClientError

from app.storage.base import ObjectNotFound, StorageError
from app.storage.local import LocalStorage
from app.storage.s3 import S3Storage


def test_local_roundtrip_and_cleanup(tmp_path):
    storage = LocalStorage(tmp_path)
    storage.put("items/1/a.jpg", b"hello", "image/jpeg")
    assert storage.exists("items/1/a.jpg")
    chunks, size = storage.open("items/1/a.jpg")
    assert b"".join(chunks) == b"hello" and size == 5
    storage.delete("items/1/a.jpg")
    assert not storage.exists("items/1/a.jpg")
    assert not (tmp_path / "items").exists()  # empty dirs tidied, root kept
    assert tmp_path.exists()
    storage.delete("items/1/a.jpg")  # idempotent


def test_local_missing_object(tmp_path):
    with pytest.raises(ObjectNotFound):
        LocalStorage(tmp_path).open("nope.jpg")


@pytest.mark.parametrize("key", ["../escape", "a/../../escape", "/etc/passwd", "", "..", "a\x00b"])
def test_local_rejects_path_traversal(tmp_path, key):
    storage = LocalStorage(tmp_path)
    with pytest.raises(StorageError):
        storage.put(key, b"x", "image/jpeg")
    with pytest.raises(StorageError):
        storage.delete(key)


class FakeS3Client:
    """Just enough of the boto3 client surface for S3Storage."""

    def __init__(self):
        self.objects = {}
        self.bucket_ok = True

    def _missing(self, op):
        return ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, op)

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[(Bucket, Key)] = (Body, ContentType)

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise self._missing("GetObject")
        body = self.objects[(Bucket, Key)][0]

        class Stream:
            def iter_chunks(self, size):
                yield body

            def close(self):
                pass

        return {"Body": Stream(), "ContentLength": len(body)}

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "nf"}}, "HeadObject")

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)

    def head_bucket(self, Bucket):
        if not self.bucket_ok:
            raise ClientError({"Error": {"Code": "403", "Message": "denied"}}, "HeadBucket")


def test_s3_roundtrip_with_prefix():
    client = FakeS3Client()
    storage = S3Storage(client, "bucket", "photos/")
    storage.put("items/1/a.jpg", b"data", "image/jpeg")
    assert ("bucket", "photos/items/1/a.jpg") in client.objects
    assert storage.exists("items/1/a.jpg")
    chunks, size = storage.open("items/1/a.jpg")
    assert b"".join(chunks) == b"data" and size == 4
    storage.delete("items/1/a.jpg")
    storage.delete("items/1/a.jpg")
    assert not storage.exists("items/1/a.jpg")
    with pytest.raises(ObjectNotFound):
        storage.open("items/1/a.jpg")
    storage.check()
    client.bucket_ok = False
    with pytest.raises(StorageError):
        storage.check()


def test_s3_rejects_bad_keys():
    storage = S3Storage(FakeS3Client(), "bucket", "photos/")
    for key in ("../x", "a/../b", "/abs", ""):
        with pytest.raises(StorageError):
            storage.put(key, b"x", "image/jpeg")
