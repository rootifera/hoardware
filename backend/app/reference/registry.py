from app.reference.base import ReferenceAdapter
from app.reference.cpudb import CpuDbAdapter
from app.reference.gpuspecs import GpuSpecsAdapter
from app.reference.pciids import PciIdsAdapter

# Importers selectable from the CLI: `python -m app.cli import-reference <key> <path>`.
ADAPTERS: dict[str, type[ReferenceAdapter]] = {
    "cpu-db": CpuDbAdapter,
    "gpus-specs": GpuSpecsAdapter,
    "pci-ids": PciIdsAdapter,
}
