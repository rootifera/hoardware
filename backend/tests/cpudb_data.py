"""Synthetic CPU-DB style files for tests.

The header mirrors the real quirks found in the upstream data (see
docs/reference-data-findings.md): repeated "Empty" columns, photo columns and
rows that are shorter than the header. The rows are made up and are not
catalogued hardware.
"""

import csv
from pathlib import Path

HEADER = [
    "Manufacturer", "Family", "Part #",
    "Alternative Label 1", "Alternative Label 2", "Alternative Label 3",
    "Alternative Label 4", "Alternative Label 5", "Alternative Label 6",
    "Empty", "Empty", "Chip Type", "Core", "CPUID",
    "Frequency(internal max/typ)", "Core Stepping", "L2 cache", "Package", "Socket",
    "Empty", "Comments",
    "Reference 1", "Reference 2",
    "Empty", "Photo front filename 1", "Photo front creator 1", "Empty",
]


def row(manufacturer="Acme", family="Widget", part="W100", extra: dict[str, str] | None = None, *, short=False) -> list[str]:
    """Build a row; ``extra`` maps header names (e.g. "Socket") to values."""
    values = {"Manufacturer": manufacturer, "Family": family, "Part #": part, **(extra or {})}
    out = [values.get(name, "") if name != "Empty" else "" for name in HEADER]
    if short:  # trailing empties trimmed, as in the real files
        while out and out[-1] == "":
            out.pop()
    return out


def write_vendor(directory: Path, name: str, rows: list[list[str]], header: list[str] | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"cpu-db.{name}.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header or HEADER)
        writer.writerows(rows)
    return path
