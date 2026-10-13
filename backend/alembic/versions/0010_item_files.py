"""downloadable files (manuals, drivers, tools) attached to items

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

KINDS = ("manual", "driver", "firmware", "tool", "datasheet", "other")


def upgrade() -> None:
    op.create_table(
        "item_files",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False, unique=True),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("kind", sa.Text, nullable=False, server_default="other"),
        sa.Column("description", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN (" + ", ".join(f"'{k}'" for k in KINDS) + ")", name="ck_item_files_kind"),
    )
    op.create_index("ix_item_files_item", "item_files", ["item_id"])


def downgrade() -> None:
    op.drop_table("item_files")
