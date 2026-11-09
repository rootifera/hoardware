"""app settings (first-run setup, title, item code prefix)

An install that already has items counts as set up; an empty one shows the first-run choice.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("value", JSONB, nullable=False),
    )
    op.execute(
        "INSERT INTO app_settings (key, value) SELECT 'setup_complete', 'true'::jsonb WHERE EXISTS (SELECT 1 FROM items)"
    )


def downgrade() -> None:
    op.drop_table("app_settings")
