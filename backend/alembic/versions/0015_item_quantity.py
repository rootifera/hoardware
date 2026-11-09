"""how many of an item you have (one record for 100 capacitors)

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("quantity", sa.Integer, nullable=False, server_default="1"))
    op.create_check_constraint("ck_items_quantity", "items", "quantity >= 0 AND quantity <= 1000000000")


def downgrade() -> None:
    op.drop_constraint("ck_items_quantity", "items")
    op.drop_column("items", "quantity")
