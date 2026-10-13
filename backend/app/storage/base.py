from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import BinaryIO


class StorageError(Exception):
    pass


class ObjectNotFound(StorageError):
    pass


class Storage(ABC):
    """Key/value object store for photos. Keys are backend-independent
    relative paths such as ``items/42/photos/<uuid>.jpg`` or ``items/42/files/<id>/<name>``."""

    name: str

    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    @abstractmethod
    def put_file(self, key: str, fileobj: BinaryIO, content_type: str) -> None:
        """Store a (seekable, rewound) file object without loading it into memory."""

    @abstractmethod
    def open(self, key: str) -> tuple[Iterator[bytes], int]:
        """Return (chunk iterator, size). Raises ObjectNotFound."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """Delete an object. Deleting a missing object is not an error."""

    @abstractmethod
    def check(self) -> None:
        """Raise StorageError if the backend is not usable."""
