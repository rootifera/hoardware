"""an optional original barcode per item (the one on the packaging)

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("barcode", sa.Text))
    # Scans look items up by exact barcode, ignoring case. Several items may share one.
    op.execute("CREATE INDEX ix_items_barcode ON items (lower(barcode)) WHERE barcode IS NOT NULL")


def downgrade() -> None:
    op.execute("DROP INDEX ix_items_barcode")
    op.drop_column("items", "barcode")
