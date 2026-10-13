"""test history

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TEST_STATUSES = "'Unknown', 'Untested', 'POST', 'Full Test', 'Dead'"


def upgrade() -> None:
    op.create_table(
        "test_log",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tested_on", sa.Date, nullable=False, server_default=sa.text("current_date")),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(f"status IN ({TEST_STATUSES})", name="ck_test_log_status"),
    )
    op.execute("CREATE INDEX ix_test_log_item ON test_log (item_id, tested_on DESC, id DESC)")


def downgrade() -> None:
    op.drop_table("test_log")
