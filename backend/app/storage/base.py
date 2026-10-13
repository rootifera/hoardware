from abc import ABC, abstractmethod
from collections.abc import Iterator


class StorageError(Exception):
    pass


class ObjectNotFound(StorageError):
    pass


class Storage(ABC):
    """Key/value object store for photos. Keys are backend-independent
    relative paths such as ``items/42/<uuid>.jpg``."""

    name: str

    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str) -> None: ...

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
