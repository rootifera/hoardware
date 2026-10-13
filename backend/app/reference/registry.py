from app.reference.base import ReferenceAdapter
from app.reference.cpudb import CpuDbAdapter

# Importers selectable from the CLI: `python -m app.cli import-reference <key> <path>`.
# A GPU adapter would be registered here; see docs/reference-data-findings.md.
ADAPTERS: dict[str, type[ReferenceAdapter]] = {
    "cpu-db": CpuDbAdapter,
}
