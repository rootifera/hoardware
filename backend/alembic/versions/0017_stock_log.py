"""stock movements (take out / add) and an optional low-stock level

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("low_stock_level", sa.Integer))
    op.create_check_constraint("ck_items_low_stock_level", "items", "low_stock_level IS NULL OR (low_stock_level >= 0 AND low_stock_level <= 1000000000)")
    op.create_table(
        "stock_log",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("change", sa.BigInteger, nullable=False),
        sa.Column("quantity_after", sa.BigInteger, nullable=False),
        sa.Column("note", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_stock_log_item", "stock_log", ["item_id", sa.text("id DESC")])


def downgrade() -> None:
    op.drop_table("stock_log")
    op.drop_constraint("ck_items_low_stock_level", "items")
    op.drop_column("items", "low_stock_level")
