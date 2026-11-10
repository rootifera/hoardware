"""item status, builds (installed in), price/source, and a history of moves

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-09
"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

STATUSES = "'in_collection', 'installed', 'lent', 'sold', 'scrapped', 'wanted'"


def upgrade() -> None:
    op.add_column("items", sa.Column("status", sa.Text, server_default="in_collection", nullable=False))
    op.create_check_constraint("ck_items_status", "items", f"status IN ({STATUSES})")
    op.add_column("items", sa.Column("status_note", sa.Text))
    op.add_column("items", sa.Column("installed_in_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="SET NULL")))
    op.add_column("items", sa.Column("price", sa.Numeric(12, 2)))
    op.add_column("items", sa.Column("source", sa.Text))
    op.execute("CREATE INDEX ix_items_installed_in ON items (installed_in_id) WHERE installed_in_id IS NOT NULL")
    op.execute("CREATE INDEX ix_items_status ON items (status) WHERE status <> 'in_collection'")
    op.create_table(
        "item_history",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("old", sa.Text),
        sa.Column("new", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('location', 'status', 'installed_in')", name="ck_item_history_kind"),
    )
    op.create_index("ix_item_history_item", "item_history", ["item_id", "id"])


def downgrade() -> None:
    op.drop_table("item_history")
    op.execute("DROP INDEX ix_items_status")
    op.execute("DROP INDEX ix_items_installed_in")
    for column in ("source", "price", "installed_in_id", "status_note"):
        op.drop_column("items", column)
    op.drop_constraint("ck_items_status", "items")
    op.drop_column("items", "status")
