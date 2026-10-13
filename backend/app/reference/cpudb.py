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
  numbered variants;
* if ``supplemental_db/cpu-db.supplemetal.Intel.S-Spec_numbers.csv`` is present
  it enriches matching records (bus speed, and any speed / cache / package the
  main row lacks) and adds records for S-Specs the main files do not list.
"""

import csv
import hashlib
import re
from collections.abc import Iterator
from pathlib import Path

from app.reference.base import ParseIssue, ReferenceAdapter, ReferenceRecord, SourceInfo, build_keys, match_key

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


SSPEC_FILE = Path("supplemental_db") / "cpu-db.supplemetal.Intel.S-Spec_numbers.csv"
# S-Spec table column -> spec name used by the main files
_SSPEC_SPECS = {
    "Speed": "Frequency(internal max/typ)",
    "Bus speed": "Bus speed",
    "L2 cache size": "L2 cache",
    "Package type": "Package",
}


# Intel's S-Spec (sSpec) is the short code printed on the chip: SL32A, SY060,
# SU103 ... or a Q-spec such as Q0939. It is the last word of a CPU-DB part
# number ("BX80524R300128 SL32A"); the rest is the order code.
_SSPEC = re.compile(r"^(?=.*\d)(S[A-Z][A-Z0-9]{3}|Q[A-Z0-9]{3,4})$", re.IGNORECASE)


def split_sspec(part_number: str) -> tuple[str, str | None]:
    """("BX80524R300128 SL32A") -> ("BX80524R300128", "SL32A"); no S-Spec -> (part, None)."""
    words = part_number.split()
    if len(words) >= 2 and _SSPEC.match(words[-1]):
        return " ".join(words[:-1]), words[-1].upper()
    return part_number, None


def sspec_file(path: Path) -> Path | None:
    base = path if path.is_dir() else path.parent
    candidate = base / SSPEC_FILE
    return candidate if candidate.is_file() else None


def read_sspecs(file: Path) -> tuple[dict[str, dict], list[ParseIssue]]:
    """S-Spec table rows keyed by the normalised S-Spec ('SL32A' -> 'sl32a')."""
    rows: dict[str, dict] = {}
    issues: list[ParseIssue] = []
    with open(file, encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            clean = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            key = match_key(clean.get("S-Spec number"))
            if not key:
                continue
            if key in rows:
                issues.append(ParseIssue("skipped", f"duplicate S-Spec {clean['S-Spec number']}", f"{file.name}:{reader.line_num}"))
                continue
            clean["_line"] = reader.line_num
            rows[key] = clean
    return rows, issues


def _sspec_specs(row: dict) -> dict:
    specs = {name: row[col] for col, name in _SSPEC_SPECS.items() if row.get(col)}
    refs = [row[c] for c in (f"Reference {i}" for i in range(1, 6)) if row.get(c)]
    if refs:
        specs["references"] = refs
    return specs


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
        for file in [*vendor_files(path), *([f] if (f := sspec_file(path)) else [])]:
            digest.update(file.name.encode())
            digest.update(file.read_bytes())
        return f"sha1:{digest.hexdigest()[:16]}"

    def read(self, path: Path) -> Iterator[ReferenceRecord | ParseIssue]:
        files = vendor_files(path)
        if not files:
            yield ParseIssue("error", f"no cpu-db.<Vendor>.csv files found in {path}")
            return
        self._sspecs: dict[str, dict] = {}
        self._used: set[str] = set()
        table = sspec_file(path)
        if table:
            self._sspecs, issues = read_sspecs(table)
            yield from issues
        seen: dict[tuple[str, str, str], list[str]] = {}
        for file in files:
            yield from self._read_file(file, seen)
        # S-Specs the main files do not list become records of their own.
        for key, row in self._sspecs.items():
            if key in self._used:
                continue
            sspec = row["S-Spec number"]
            order_code = row.get("Part number", "")
            part = f"{order_code} {sspec}".strip()
            yield ReferenceRecord(
                upstream_id=f"sspec|{key}",
                kind="cpu",
                model=part,
                manufacturer=row.get("Manufacturer") or "Intel",
                family=row.get("Family") or None,
                part_number=part,
                aliases=[a for a in (row.get(f"Alternative part number {i}", "") for i in range(1, 7)) if a],
                specs={"S-Spec": sspec.upper(), **_sspec_specs(row)},
                provenance={"file": table.name, "line": row["_line"], "from_sspec_table": True},
            )

    def _enrich_from_sspec_table(self, record: ReferenceRecord) -> None:
        """Record the S-Spec of an Intel part and add what the S-Spec table
        knows about it (e.g. bus speed)."""
        if not (record.manufacturer or "").lower().startswith("intel"):
            return  # S-Specs and their table only cover Intel parts
        _, detected = split_sspec(record.part_number or "")
        if detected:
            record.specs.setdefault("S-Spec", detected)
        if not self._sspecs:
            return
        exact, tokens = build_keys(record.part_number, record.aliases)
        key = next((k for k in [*tokens, *exact] if k in self._sspecs), None)
        if key is None:
            return
        self._used.add(key)
        record.specs["S-Spec"] = self._sspecs[key]["S-Spec number"].upper()
        extra = _sspec_specs(self._sspecs[key])
        for name, value in extra.items():
            if name == "references":
                merged = list(record.specs.get("references", []))
                record.specs["references"] = merged + [r for r in value if r not in merged]
            elif name == "Bus speed" or record.specs.get(name) in (None, ""):
                record.specs[name] = value
        record.provenance["sspec_table"] = True

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

                self._enrich_from_sspec_table(record)

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
