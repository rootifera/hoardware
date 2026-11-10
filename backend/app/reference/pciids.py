"""PCI ID adapter: the community pci.ids list (https://github.com/pciutils/pciids).

Every PCI chip is known by a ``vendor:device`` pair, the "1102:0002" that ``lspci -nn`` prints. The
list names them: 1102 is Creative Labs, 0002 is the SB Live! EMU10k1. That identifies sound cards,
network cards, controllers and the chips on them. It cannot describe ISA cards (they have no IDs).

The file is plain text: a vendor per unindented line, its devices indented once, their subsystems
twice (not used here); the device classes after the vendors are ignored.
"""

import hashlib
import re
from collections.abc import Iterator
from pathlib import Path

from app.reference.base import ParseIssue, ReferenceAdapter, ReferenceRecord, SourceInfo

_VENDOR = re.compile(r"^([0-9a-f]{4})\s+(.+?)\s*$")
_DEVICE = re.compile(r"^\t([0-9a-f]{4})\s+(.+?)\s*$")
_VERSION = re.compile(r"^#\s*Version:\s*(\S+)")


def data_file(path: Path) -> Path | None:
    if path.is_file():
        return path
    found = path / "pci.ids"
    return found if found.is_file() else None


class PciIdsAdapter(ReferenceAdapter):
    source = SourceInfo(
        key="pci-ids",
        name="PCI ID Repository",
        url="https://github.com/pciutils/pciids",
        licence="BSD-3-Clause or GPL-2.0-or-later",
        attribution="The PCI ID Repository (pci-ids.ucw.cz)",
    )

    def source_version(self, path: Path) -> str:
        file = data_file(path)
        if file is None:
            return "empty"
        for line in file.read_text(encoding="utf-8", errors="replace").splitlines()[:20]:
            found = _VERSION.match(line)
            if found:
                return found.group(1)
        return f"sha1:{hashlib.sha1(file.read_bytes()).hexdigest()[:16]}"

    def read(self, path: Path) -> Iterator[ReferenceRecord | ParseIssue]:
        file = data_file(path)
        if file is None:
            yield ParseIssue("error", f"no pci.ids found in {path}")
            return
        vendor_id: str | None = None
        vendor_name: str | None = None
        with open(file, encoding="utf-8", errors="replace") as fh:
            for number, raw in enumerate(fh, start=1):
                line = raw.rstrip("\n")
                if not line.strip() or line.startswith("#"):
                    continue
                if line.startswith("C "):  # the device classes start here: nothing more to read
                    break
                if line.startswith("\t\t"):
                    continue  # subsystem
                device = _DEVICE.match(line)
                if device:
                    if vendor_id is None:
                        yield ParseIssue("error", "device before any vendor", f"{file.name}:{number}")
                        continue
                    code = f"{vendor_id}:{device.group(1)}"
                    yield ReferenceRecord(
                        upstream_id=code,
                        kind="pci",
                        model=device.group(2),
                        manufacturer=vendor_name,
                        part_number=code,
                        specs={"Vendor ID": vendor_id, "Device ID": device.group(1), "PCI ID": code},
                        provenance={"file": file.name, "line": number},
                    )
                    continue
                vendor = _VENDOR.match(line)
                if vendor:
                    vendor_id, vendor_name = vendor.group(1), vendor.group(2)
                else:
                    yield ParseIssue("skipped", f"unrecognised line: {line[:60]}", f"{file.name}:{number}")
