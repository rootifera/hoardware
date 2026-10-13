"""CPU-DB adapter (https://github.com/zymos/cpu-db).

Written against the real data, see docs/reference-data-findings.md:

* read the per-vendor files ``cpu-db.<Vendor>.csv``; the combined
  ``cpu-db.csv`` is a lossy generated artifact and is ignored;
* the header has 51 columns named "Empty", so rows are parsed positionally
  (never with DictReader) using the first index of each name;
* a blank Manufacturer cell takes the vendor from the file name;
* rows can be shorter than the header (trailing empties trimmed): padded;
* "NA" / "N/A" cells mean "not applicable" and become null, blanks are unknown
  and omitted, "none" is a real value (e.g. no L2 cache) and kept;
* there is no stable ID and (manufacturer, family, part #) is not unique, so
  exact duplicates are collapsed and different rows with the same key become
  numbered variants.
"""

import csv
import hashlib
import re
from collections.abc import Iterator
from pathlib import Path

from app.reference.base import ParseIssue, ReferenceAdapter, ReferenceRecord, SourceInfo

PLACEHOLDERS_NA = {"na", "n/a"}
REQUIRED = ("Manufacturer", "Family", "Part #")
ALIAS_COLUMNS = [f"Alternative Label {i}" for i in range(1, 7)]
REFERENCE_COLUMNS = [f"Reference {i}" for i in range(1, 9)]
# Columns not copied into specs.
_SKIPPED = re.compile(r"^(Empty|Photo .*|Die photo .*)$")
_IDENTITY = {"Manufacturer", "Family", "Part #", *ALIAS_COLUMNS, *REFERENCE_COLUMNS}

_WS = re.compile(r"\s+")


def _norm(value: str) -> str:
    return _WS.sub(" ", value.strip().lower())


def vendor_of(file: Path) -> str:
    """'cpu-db.Chips_and_Technology.csv' -> 'Chips and Technology'."""
    return file.name.removeprefix("cpu-db.").removesuffix(".csv").replace("_", " ")


def vendor_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(
        p
        for p in path.glob("cpu-db.*.csv")
        if p.name != "cpu-db.csv" and "DEBUGTEST" not in p.name
    )


class CpuDbAdapter(ReferenceAdapter):
    source = SourceInfo(
        key="cpu-db",
        name="CPU-DB",
        url="https://github.com/zymos/cpu-db",
        licence="Public Domain (per the maintainer's COPYING.txt)",
        attribution="CPU-DB by zymos and contributors; per-row sources are in the 'references' spec.",
    )

    def source_version(self, path: Path) -> str:
        digest = hashlib.sha1()
        for file in vendor_files(path):
            digest.update(file.name.encode())
            digest.update(file.read_bytes())
        return f"sha1:{digest.hexdigest()[:16]}"

    def read(self, path: Path) -> Iterator[ReferenceRecord | ParseIssue]:
        files = vendor_files(path)
        if not files:
            yield ParseIssue("error", f"no cpu-db.<Vendor>.csv files found in {path}")
            return
        seen: dict[tuple[str, str, str], list[str]] = {}
        for file in files:
            yield from self._read_file(file, seen)

    def _read_file(
        self, file: Path, seen: dict[tuple[str, str, str], list[str]]
    ) -> Iterator[ReferenceRecord | ParseIssue]:
        with open(file, encoding="utf-8-sig", newline="") as fh:
            reader = csv.reader(fh)
            try:
                header = next(reader)
            except StopIteration:
                yield ParseIssue("error", "empty file", file.name)
                return
            index: dict[str, int] = {}
            names: list[str | None] = []  # spec name per column position
            for position, raw in enumerate(header):
                name = raw.strip()
                index.setdefault(name, position)
                if _SKIPPED.match(name) or name in _IDENTITY:
                    names.append(None)
                elif index[name] != position:  # repeated non-Empty name: keep both
                    names.append(f"{name} (2)")
                else:
                    names.append(name)
            missing = [c for c in REQUIRED if c not in index]
            if missing:
                yield ParseIssue("error", f"header is missing required column(s): {', '.join(missing)}", file.name)
                return
            width = len(header)

            def cell(row: list[str], name: str) -> str:
                i = index.get(name)
                return row[i].strip() if i is not None and i < len(row) else ""

            for row in reader:
                where = f"{file.name}:{reader.line_num}"
                if not any(c.strip() for c in row):
                    continue
                if len(row) < width:
                    row = row + [""] * (width - len(row))
                manufacturer, family, part = cell(row, "Manufacturer"), cell(row, "Family"), cell(row, "Part #")
                inferred = False
                if not manufacturer and part and file.name != "cpu-db.csv":
                    # The vendor file's own name says who made it.
                    manufacturer, inferred = vendor_of(file), True
                if not manufacturer:
                    yield ParseIssue("error", "row has neither a manufacturer nor a part number", where)
                    continue
                if not part:
                    yield ParseIssue("error", f"row has no part number ({manufacturer} {family})", where)
                    continue

                specs: dict[str, object] = {}
                for position, name in enumerate(names):
                    if name is None:
                        continue
                    value = row[position].strip()
                    if not value:
                        continue
                    specs[name] = None if value.lower() in PLACEHOLDERS_NA else value
                refs = [cell(row, c) for c in REFERENCE_COLUMNS if cell(row, c)]
                if refs:
                    specs["references"] = refs

                aliases = [a for a in (cell(row, c) for c in ALIAS_COLUMNS) if a and a != part]
                record = ReferenceRecord(
                    upstream_id="",
                    kind="cpu",
                    model=part,
                    manufacturer=manufacturer,
                    family=family or None,
                    part_number=part,
                    revision=(specs.get("Core Stepping") or None) if isinstance(specs.get("Core Stepping"), str) else None,
                    aliases=aliases,
                    specs=specs,
                    provenance={"file": file.name, "line": reader.line_num, **({"manufacturer_inferred_from_filename": True} if inferred else {})},
                )

                key = (_norm(manufacturer), _norm(family), _norm(part))
                digest = record.content_hash()
                variants = seen.setdefault(key, [])
                if digest in variants:
                    yield ParseIssue("skipped", f"exact duplicate of an earlier row ({manufacturer} {part})", where)
                    continue
                variants.append(digest)
                base = "|".join(key)
                record.upstream_id = base if len(variants) == 1 else f"{base}#{len(variants)}"
                yield record
