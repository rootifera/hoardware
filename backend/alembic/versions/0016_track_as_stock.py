"""items can be tracked as stock (counted, with take out / add); the category setting becomes a default

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("is_stock", sa.Boolean, nullable=False, server_default=sa.text("false")))
    # Items that already had a quantity other than one were counted.
    op.execute("UPDATE items SET is_stock = true WHERE quantity <> 1")
    # The category setting "quantity" (shown or not) is now "stock": start new items as stock items.
    op.execute(
        "UPDATE categories SET settings = jsonb_set(settings #- '{core,quantity}', '{core,stock}', settings #> '{core,quantity}')"
        " WHERE settings #> '{core,quantity}' IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE categories SET settings = jsonb_set(settings #- '{core,stock}', '{core,quantity}', settings #> '{core,stock}')"
        " WHERE settings #> '{core,stock}' IS NOT NULL"
    )
    op.drop_column("items", "is_stock")
