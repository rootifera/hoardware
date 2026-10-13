"""Importer abstraction for reference hardware datasets.

An adapter turns a locally supplied dataset (files the user has downloaded)
into a stream of ReferenceRecord / ParseIssue objects. The runner in
app.reference.runner stores them idempotently. Nothing here touches the
network and the core app never depends on any dataset being loaded.
"""

import hashlib
import json
import re
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal


@dataclass
class ReferenceRecord:
    upstream_id: str  # stable within the source, see the adapter for how it is built
    kind: str  # "cpu", "gpu_chipset", ...
    model: str
    manufacturer: str | None = None
    family: str | None = None
    part_number: str | None = None
    revision: str | None = None
    aliases: list[str] = field(default_factory=list)
    # Raw values as published. None = the source says "not applicable";
    # a missing key = unknown.
    specs: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)

    def content_hash(self) -> str:
        """Hash of everything that is stored, for added/changed/unchanged reporting.
        Provenance (file/line) is deliberately excluded: moving a row within the
        source is not a change to the model."""
        payload = {
            "kind": self.kind,
            "model": self.model,
            "manufacturer": self.manufacturer,
            "family": self.family,
            "part_number": self.part_number,
            "revision": self.revision,
            "aliases": self.aliases,
            "specs": self.specs,
        }
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha1(raw.encode()).hexdigest()


@dataclass
class ParseIssue:
    level: Literal["error", "skipped"]
    message: str
    where: str = ""  # "file:line"


@dataclass
class SourceInfo:
    key: str
    name: str
    url: str | None = None
    licence: str | None = None
    attribution: str | None = None


class ReferenceAdapter(ABC):
    source: SourceInfo

    @abstractmethod
    def source_version(self, path: Path) -> str:
        """Identifies the dataset snapshot (e.g. a content hash)."""

    @abstractmethod
    def read(self, path: Path) -> Iterator[ReferenceRecord | ParseIssue]:
        """Yield records and issues. ``upstream_id`` must be unique in one run."""


# --- normalisation helpers shared by importers and the matcher -------------

_NON_ALNUM = re.compile(r"[^a-z0-9]")
_SPLIT = re.compile(r"[\s/,;()]+")
_HAS_DIGIT = re.compile(r"\d")


def match_key(value: str | None) -> str:
    """Lowercase alphanumerics only: 'A80501-60' -> 'a8050160'."""
    return _NON_ALNUM.sub("", (value or "").lower())


def token_keys_of(value: str | None) -> set[str]:
    """Keys for the individual words of a part number, so a collector can match
    on just the S-Spec or ordering code printed on the chip ('Q0939', 'SL27S')."""
    keys = set()
    for token in _SPLIT.split(value or ""):
        key = match_key(token)
        if len(key) >= 4 and _HAS_DIGIT.search(key):
            keys.add(key)
    return keys


def build_keys(part_number: str | None, aliases: list[str]) -> tuple[list[str], list[str]]:
    """(exact_keys, token_keys) for a record."""
    exact: set[str] = set()
    tokens: set[str] = set()
    for value in [part_number, *aliases]:
        key = match_key(value)
        if len(key) >= 3:
            exact.add(key)
        tokens |= token_keys_of(value)
    return sorted(exact), sorted(tokens - exact)


def build_search_text(record: ReferenceRecord) -> str:
    parts = [record.manufacturer, record.family, record.model, record.part_number, record.revision, *record.aliases]
    return " ".join(p for p in parts if p).lower()


def build_sort_name(record: ReferenceRecord) -> str:
    return " ".join(p for p in [record.manufacturer, record.family, record.model] if p).lower()
