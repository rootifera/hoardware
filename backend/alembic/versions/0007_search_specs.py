"""include the item's own specs in the search index

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

OLD = (
    "lower(inventory_code || ' ' || coalesce(manufacturer, '') || ' ' || model"
    " || ' ' || coalesce(part_number, '') || ' ' || coalesce(revision, '')"
    " || ' ' || coalesce(chipset_manufacturer, '') || ' ' || coalesce(chipset, '')"
    " || ' ' || coalesce(notes, '') || ' ' || coalesce(test_notes, ''))"
)
NEW = OLD[:-1] + " || ' ' || coalesce(attributes::text, ''))"


def _rebuild(expression: str) -> None:
    op.execute("DROP INDEX ix_items_search_text_trgm")
    op.drop_column("items", "search_text")
    op.add_column("items", sa.Column("search_text", sa.Text, sa.Computed(expression, persisted=True)))
    op.create_index(
        "ix_items_search_text_trgm",
        "items",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )


def upgrade() -> None:
    _rebuild(NEW)


def downgrade() -> None:
    _rebuild(OLD)
