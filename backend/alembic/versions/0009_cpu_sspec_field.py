"""add an S-Spec field to the CPU category

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-13
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

SSPEC_FIELD = {"name": "S-Spec", "hint": "code on the chip, e.g. SL32A", "column": None}


def with_sspec(fields: list[dict]) -> list[dict]:
    """Insert the S-Spec field after Family (or first), unless already there."""
    if any(f.get("name", "").lower() == "s-spec" for f in fields):
        return fields
    at = next((i + 1 for i, f in enumerate(fields) if f.get("name", "").lower() == "family"), 0)
    return [*fields[:at], SSPEC_FIELD, *fields[at:]]


def upgrade() -> None:
    conn = op.get_bind()
    for category_id, fields in conn.execute(sa.text("SELECT id, fields FROM categories WHERE lower(name) = 'cpu'")).all():
        conn.execute(
            sa.text("UPDATE categories SET fields = CAST(:f AS jsonb) WHERE id = :id"),
            {"f": json.dumps(with_sspec(list(fields))), "id": category_id},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for category_id, fields in conn.execute(sa.text("SELECT id, fields FROM categories WHERE lower(name) = 'cpu'")).all():
        kept = [f for f in fields if f.get("name", "").lower() != "s-spec"]
        conn.execute(sa.text("UPDATE categories SET fields = CAST(:f AS jsonb) WHERE id = :id"), {"f": json.dumps(kept), "id": category_id})
