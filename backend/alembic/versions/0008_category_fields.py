"""category-specific field definitions

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-13
"""

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def f(name: str, hint: str = "", column: str | None = None) -> dict:
    return {"name": name, "hint": hint, "column": column}


# Sensible starting fields for the seeded categories (all editable in the UI).
DEFAULTS: dict[str, list[dict]] = {
    "cpu": [
        f("Family", "e.g. Pentium MMX"),
        f("Speed", "e.g. 200MHz"),
        f("Bus speed", "e.g. 66MHz"),
        f("L2 cache", "e.g. 256KiB"),
        f("Socket", "e.g. Socket 7"),
        f("Package", "e.g. SPGA"),
        f("Stepping"),
        f("Core"),
        f("Core voltage", "e.g. 2.8V"),
        f("Process", "e.g. 350nm"),
        f("CPUID"),
    ],
    "gpu/vga": [
        f("Chipset maker", "e.g. NVIDIA", "chipset_manufacturer"),
        f("Chipset", "e.g. RIVA TNT2 Ultra", "chipset"),
        f("Revision", "board revision", "revision"),
        f("Memory size", "e.g. 32MB"),
        f("Memory type", "e.g. SDRAM"),
        f("Bus", "e.g. AGP 4x, PCI, ISA"),
        f("Outputs", "e.g. VGA, DVI"),
    ],
    "motherboard": [
        f("Chipset", "e.g. Intel 440BX", "chipset"),
        f("Revision", "board revision", "revision"),
        f("Socket", "e.g. Socket 370"),
        f("Form factor", "e.g. ATX"),
        f("Memory type", "e.g. SDRAM DIMM"),
        f("Max memory", "e.g. 768MB"),
        f("Expansion slots", "e.g. 4x PCI, 1x AGP, 2x ISA"),
        f("BIOS"),
    ],
    "sound card": [
        f("Chipset", "e.g. Creative CT1747", "chipset"),
        f("Revision", "board revision", "revision"),
        f("Bus", "e.g. ISA 16-bit, PCI"),
        f("Features", "e.g. Wavetable header, MIDI"),
    ],
    "ram": [
        f("Type", "e.g. SDRAM, EDO, SIMM 72-pin"),
        f("Capacity", "e.g. 64MB"),
        f("Speed", "e.g. PC133, 60ns"),
        f("Pins"),
        f("Voltage", "e.g. 3.3V"),
        f("ECC", "yes / no"),
    ],
    "storage": [
        f("Type", "e.g. HDD, SSD, CD-ROM"),
        f("Interface", "e.g. IDE, SCSI, SATA"),
        f("Capacity", "e.g. 4.3GB"),
        f("RPM"),
        f("Cache"),
    ],
}


def upgrade() -> None:
    op.add_column("categories", sa.Column("fields", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")))
    conn = op.get_bind()
    for name, fields in DEFAULTS.items():
        conn.execute(
            sa.text("UPDATE categories SET fields = CAST(:fields AS jsonb) WHERE lower(name) = :name AND fields = '[]'::jsonb"),
            {"fields": json.dumps(fields), "name": name},
        )


def downgrade() -> None:
    op.drop_column("categories", "fields")
