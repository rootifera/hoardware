"""predefined values for the starting category fields (RAM, storage, ...)

Only a field that has no options yet gets them, so options the user has set are kept.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-13
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

RAM_SIZES = ["256KB", "512KB", "1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB", "256MB", "512MB", "1GB", "2GB", "4GB", "8GB", "16GB", "32GB"]
HDD_SIZES = ["20MB", "40MB", "80MB", "120MB", "250MB", "500MB", "1GB", "2.1GB", "4.3GB", "6.4GB", "10GB", "20GB", "40GB", "80GB", "120GB", "160GB", "250GB", "320GB", "500GB", "1TB", "2TB", "4TB"]
CACHE = ["64KB", "128KB", "256KB", "512KB", "1MB", "2MB", "8MB", "16MB", "32MB", "64MB", "128MB"]

# category (lower case) -> field name (lower case) -> options
OPTIONS: dict[str, dict[str, list[str]]] = {
    "ram": {
        "type": ["FPM", "EDO", "SDRAM", "DDR", "DDR2", "DDR3", "DDR4", "DDR5", "RDRAM", "SRAM", "VRAM", "SGRAM"],
        "capacity": RAM_SIZES,
        "speed": ["80ns", "70ns", "60ns", "50ns", "PC66", "PC100", "PC133", "PC1600", "PC2100", "PC2700", "PC3200", "PC2-4200", "PC2-5300", "PC2-6400", "PC3-8500", "PC3-10600", "PC3-12800", "PC4-2133", "PC4-2400", "PC4-2666", "PC4-3200"],
        "pins": ["30", "72", "100", "144", "168", "184", "200", "204", "240", "260", "288"],
        "voltage": ["5V", "3.3V", "2.5V", "1.8V", "1.5V", "1.35V", "1.2V"],
        "ecc": ["Yes", "No", "Parity"],
    },
    "storage": {
        "type": ["HDD", "SSD", "CD-ROM", "CD-RW", "DVD-ROM", "DVD-RW", "Floppy drive", "Zip drive", "Tape drive", "CompactFlash", "SD card", "Disk on Module"],
        "interface": ["IDE (PATA)", "SCSI", "SCSI-2", "Ultra SCSI", "Ultra2 SCSI", "Ultra160 SCSI", "Ultra320 SCSI", "SAS", "SATA I", "SATA II", "SATA III", "ESDI", "MFM", "RLL", "ST-506", "NVMe", "M.2 SATA", "USB", "FireWire", "Floppy", "Parallel port"],
        "capacity": [*HDD_SIZES, "720KB", "1.44MB", "100MB (Zip)", "250MB (Zip)", "650MB", "700MB", "4.7GB"],
        "rpm": ["3600", "4200", "5400", "7200", "10000", "15000"],
        "cache": CACHE,
    },
    "cpu": {
        "socket": ["Socket 3", "Socket 4", "Socket 5", "Socket 7", "Super Socket 7", "Socket 8", "Slot 1", "Slot 2", "Slot A", "Socket 370", "Socket 462 (A)", "Socket 478", "Socket 423", "Socket 775", "Socket 939", "Socket 754", "Socket AM2", "Socket AM3"],
        "package": ["PGA", "SPGA", "CPGA", "PPGA", "FC-PGA", "FC-PGA2", "SECC", "SECC2", "SEPP", "PLCC", "PQFP", "DIP"],
    },
    "gpu/vga": {
        "memory size": ["256KB", "512KB", "1 MB", "2 MB", "4 MB", "8 MB", "16 MB", "32 MB", "64 MB", "128 MB", "256 MB", "512 MB", "1 GB", "2 GB", "4 GB", "8 GB"],
        "memory type": ["DRAM", "EDO", "SDR", "SGRAM", "SGR", "DDR", "DDR2", "DDR3", "GDDR3", "GDDR5", "WRAM", "VRAM"],
        "memory bus": ["32 bit", "64 bit", "128 bit", "192 bit", "256 bit", "384 bit"],
        "bus": ["ISA 8-bit", "ISA 16-bit", "VLB", "PCI", "AGP 1x", "AGP 2x", "AGP 4x", "AGP 8x", "PCIe x16"],
        "outputs": ["VGA", "VGA + DVI", "VGA + S-Video", "DVI", "HDMI", "DisplayPort"],
    },
    "motherboard": {
        "socket": ["Socket 3", "Socket 5", "Socket 7", "Super Socket 7", "Socket 8", "Slot 1", "Slot A", "Socket 370", "Socket 462 (A)", "Socket 478", "Socket 775", "Socket 939", "Socket AM2", "Socket AM3"],
        "form factor": ["AT", "Baby AT", "ATX", "Micro ATX", "Mini ATX", "NLX", "LPX", "Mini ITX", "Flex ATX"],
        "memory type": ["30-pin SIMM", "72-pin SIMM", "SDRAM DIMM", "DDR DIMM", "DDR2 DIMM", "DDR3 DIMM", "RIMM"],
    },
    "sound card": {
        "bus": ["ISA 8-bit", "ISA 16-bit", "PCI", "PCIe", "USB", "Parallel port"],
    },
}


def with_options(category: str, fields: list[dict]) -> list[dict]:
    wanted = OPTIONS.get(category.lower(), {})
    out = []
    for f in fields:
        options = wanted.get(f.get("name", "").lower())
        out.append({**f, "options": options} if options and not f.get("options") else f)
    return out


def upgrade() -> None:
    conn = op.get_bind()
    for category_id, name, fields in conn.execute(sa.text("SELECT id, name, fields FROM categories")).all():
        updated = with_options(name, list(fields))
        if updated != list(fields):
            conn.execute(sa.text("UPDATE categories SET fields = CAST(:f AS jsonb) WHERE id = :id"), {"f": json.dumps(updated), "id": category_id})


def downgrade() -> None:
    conn = op.get_bind()
    for category_id, fields in conn.execute(sa.text("SELECT id, fields FROM categories")).all():
        conn.execute(
            sa.text("UPDATE categories SET fields = CAST(:f AS jsonb) WHERE id = :id"),
            {"f": json.dumps([{k: v for k, v in f.items() if k != "options"} for f in fields]), "id": category_id},
        )
