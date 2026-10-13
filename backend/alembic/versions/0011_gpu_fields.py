"""richer starting fields for GPU/VGA (chip, memory bus, clocks)

Only a category still holding the original starting fields is changed; one the
user has edited is left alone.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-13
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

OLD_NAMES = ["Chipset maker", "Chipset", "Revision", "Memory size", "Memory type", "Bus", "Outputs"]


def f(name: str, hint: str = "", column: str | None = None) -> dict:
    return {"name": name, "hint": hint, "column": column}


NEW = [
    f("Chipset maker", "e.g. NVIDIA", "chipset_manufacturer"),
    f("Chipset", "e.g. RIVA TNT2 Ultra", "chipset"),
    f("GPU chip", "e.g. NV5, Avenger"),
    f("Revision", "board revision", "revision"),
    f("Memory size", "e.g. 32 MB"),
    f("Memory type", "e.g. SDR, SGRAM"),
    f("Memory bus", "e.g. 128 bit"),
    f("Bus", "e.g. AGP 4x, PCI, ISA"),
    f("GPU clock", "e.g. 150 MHz"),
    f("Memory clock", "e.g. 183 MHz"),
    f("Outputs", "e.g. VGA, DVI"),
]


def upgrade() -> None:
    conn = op.get_bind()
    for category_id, fields in conn.execute(sa.text("SELECT id, fields FROM categories WHERE lower(name) = 'gpu/vga'")).all():
        if [x.get("name") for x in fields] == OLD_NAMES:
            conn.execute(sa.text("UPDATE categories SET fields = CAST(:f AS jsonb) WHERE id = :id"), {"f": json.dumps(NEW), "id": category_id})


def downgrade() -> None:
    # The old list was a subset; nothing is lost that cannot be re-added by hand.
    pass
