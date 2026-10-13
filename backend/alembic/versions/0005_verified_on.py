"""stock-take: when an item was last physically checked

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("items", sa.Column("verified_on", sa.Date))
    op.execute("CREATE INDEX ix_items_verified ON items (verified_on)")


def downgrade() -> None:
    op.execute("DROP INDEX ix_items_verified")
    op.drop_column("items", "verified_on")
