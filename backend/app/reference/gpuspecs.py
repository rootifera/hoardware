"""Graphics-card adapter for the GPUs-Specs CSV (https://github.com/RonnyMuthomi/GPUs-Specs).

Written against the real file, see docs/reference-data-findings.md:

* one ``gpu_*.csv`` with 134 sparse columns named ``Group__Field``; rows are
  chip / reference-product level (``Voodoo3 3000 AGP``, chip ``Avenger``), never a
  specific board: ``Brand`` is the chip vendor, not the card maker;
* only a curated set of columns is kept, under the plain names an item uses
  (Chipset, Memory size, Bus...). Desktop columns win, then mobile, then
  integrated, for fields that live in several groups;
* "unknown", "N/A" and blanks are not values and are dropped;
* (brand, name) is not unique (variants launched in different years, regional
  duplicates): identical rows collapse, different ones become numbered variants;
* ``Board Number`` / ``Part Number`` (ATI ``109-49800-10`` style, 1,400 rows)
  become the record's part number, so a number printed on the board matches.
"""

import csv
import hashlib
import re
from collections.abc import Iterator
from pathlib import Path

from app.reference.base import ParseIssue, ReferenceAdapter, ReferenceRecord, SourceInfo

_BLANK = {"", "na", "n/a", "nan", "unknown", "none specified"}

# spec name -> dataset columns to try, in order.
COLUMNS: dict[str, list[str]] = {
    "GPU chip": ["Graphics Processor__GPU Name"],
    "Chip variant": ["Graphics Processor__GPU Variant"],
    "Architecture": ["Graphics Processor__Architecture"],
    "Memory size": ["Memory__Memory Size"],
    "Memory type": ["Memory__Memory Type"],
    "Memory bus": ["Memory__Memory Bus"],
    "Bus": ["Graphics Card__Bus Interface", "Mobile Graphics__Bus Interface", "Integrated Graphics__Bus Interface"],
    "GPU clock": ["Clock Speeds__GPU Clock", "Clock Speeds__Base Clock"],
    "Boost clock": ["Clock Speeds__Boost Clock"],
    "Memory clock": ["Clock Speeds__Memory Clock"],
    "Process": ["Graphics Processor__Process Size"],
    "Transistors": ["Graphics Processor__Transistors"],
    "Die size": ["Graphics Processor__Die Size"],
    "Foundry": ["Graphics Processor__Foundry"],
    "Released": ["Graphics Card__Release Date", "Mobile Graphics__Release Date", "Integrated Graphics__Release Date"],
    "Board number": ["Board Design__Board Number"],
    "Outputs": ["Board Design__Outputs"],
    "Slot width": ["Board Design__Slot Width"],
    "Board length": ["Board Design__Length"],
    "TDP": ["Board Design__TDP"],
    "Suggested PSU": ["Board Design__Suggested PSU"],
    "Pixel shaders": ["Render Config__Shading Units"],
    "TMUs": ["Render Config__TMUs"],
    "ROPs": ["Render Config__ROPs"],
    "Pixel rate": ["Theoretical Performance__Pixel Rate"],
    "Texture rate": ["Theoretical Performance__Texture Rate"],
    "Bandwidth": ["Memory__Bandwidth"],
    "DirectX": ["Graphics Features__DirectX"],
    "OpenGL": ["Graphics Features__OpenGL"],
    "Vulkan": ["Graphics Features__Vulkan"],
    "Shader model": ["Graphics Features__Shader Model"],
}
REQUIRED = ("Brand", "Name")
_WS = re.compile(r"\s+")


def _clean(value: str | None) -> str | None:
    value = _WS.sub(" ", (value or "").strip())
    return None if value.lower() in _BLANK else value


def data_file(path: Path) -> Path | None:
    if path.is_file():
        return path
    files = sorted(path.glob("gpu_*.csv"))
    return files[0] if files else None


class GpuSpecsAdapter(ReferenceAdapter):
    source = SourceInfo(
        key="gpus-specs",
        name="GPUs-Specs (TechPowerUp-derived)",
        url="https://github.com/RonnyMuthomi/GPUs-Specs",
        licence="none stated (personal use)",
        attribution="Chip-level graphics data compiled from TechPowerUp's GPU database",
    )

    def source_version(self, path: Path) -> str:
        file = data_file(path)
        digest = hashlib.sha1(file.read_bytes() if file else b"")
        return f"sha1:{digest.hexdigest()[:16]}"

    def read(self, path: Path) -> Iterator[ReferenceRecord | ParseIssue]:
        file = data_file(path)
        if file is None:
            yield ParseIssue("error", f"no gpu_*.csv found in {path}")
            return
        with open(file, encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
            if missing:
                yield ParseIssue("error", f"{file.name}: missing column(s) {', '.join(missing)}")
                return
            seen: dict[str, list[dict]] = {}
            for line, row in enumerate(reader, start=2):
                where = f"{file.name}:{line}"
                brand, name = _clean(row.get("Brand")), _clean(row.get("Name"))
                if not brand or not name:
                    yield ParseIssue("error", "row has no brand or name", where)
                    continue
                specs: dict[str, str] = {}
                for spec, columns in COLUMNS.items():
                    for column in columns:
                        value = _clean(row.get(column))
                        if value:
                            specs[spec] = value
                            break
                specs["Chipset maker"] = brand
                specs["Chipset"] = name
                # Same chip vendor + name: collapse exact repeats, number real variants.
                key = f"{brand}|{name}".lower()
                group = seen.setdefault(key, [])
                if specs in group:
                    yield ParseIssue("skipped", f"{brand} {name}: exact duplicate row", where)
                    continue
                group.append(specs)
                variant = len(group)
                number = specs.get("Board number") or _clean(row.get("Board Design__Part Number"))
                yield ReferenceRecord(
                    upstream_id=f"{key}|{variant}",
                    kind="gpu",
                    model=name,
                    manufacturer=brand,
                    family=specs.get("GPU chip"),
                    part_number=number,
                    specs=specs,
                    provenance={"file": file.name, "line": line, "source_file": row.get("source_file") or None},
                )
