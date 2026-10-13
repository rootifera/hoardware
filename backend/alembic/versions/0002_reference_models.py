"""reference models, sources and imports

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reference_sources",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("url", sa.Text),
        sa.Column("licence", sa.Text),
        sa.Column("attribution", sa.Text),
    )
    op.create_table(
        "reference_imports",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("source_key", sa.Text, sa.ForeignKey("reference_sources.key"), nullable=False),
        sa.Column("source_version", sa.Text, nullable=False),
        sa.Column("path", sa.Text),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("added", sa.Integer, nullable=False, server_default="0"),
        sa.Column("changed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("unchanged", sa.Integer, nullable=False, server_default="0"),
        sa.Column("skipped", sa.Integer, nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer, nullable=False, server_default="0"),
        sa.Column("report", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_table(
        "reference_models",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("source_key", sa.Text, sa.ForeignKey("reference_sources.key"), nullable=False),
        sa.Column("upstream_id", sa.Text, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("manufacturer", sa.Text),
        sa.Column("family", sa.Text),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("part_number", sa.Text),
        sa.Column("revision", sa.Text),
        sa.Column("aliases", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("exact_keys", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("token_keys", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("specs", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("provenance", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("content_hash", sa.Text, nullable=False),
        sa.Column("source_version", sa.Text, nullable=False),
        sa.Column("import_id", sa.BigInteger, sa.ForeignKey("reference_imports.id"), nullable=False),
        sa.Column("last_seen_import_id", sa.BigInteger, sa.ForeignKey("reference_imports.id"), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("search_text", sa.Text, nullable=False),
        sa.Column("sort_name", sa.Text, nullable=False),
        sa.UniqueConstraint("source_key", "upstream_id", name="uq_reference_models_upstream"),
    )
    op.create_index(
        "ix_reference_models_search_trgm",
        "reference_models",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    op.execute("CREATE INDEX ix_reference_models_exact_keys ON reference_models USING gin (exact_keys)")
    op.execute("CREATE INDEX ix_reference_models_token_keys ON reference_models USING gin (token_keys)")
    op.execute("CREATE INDEX ix_reference_models_sort ON reference_models (sort_name, id)")
    op.execute("CREATE INDEX ix_reference_models_kind ON reference_models (kind, sort_name, id)")
    op.execute("CREATE INDEX ix_reference_models_last_seen ON reference_models (source_key, last_seen_import_id)")

    # Items link to a reference model; unlinking (or removing a source) must
    # never delete inventory.
    op.create_foreign_key(
        "fk_items_reference_model",
        "items",
        "reference_models",
        ["reference_model_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute("CREATE INDEX ix_items_reference_model ON items (reference_model_id) WHERE reference_model_id IS NOT NULL")


def downgrade() -> None:
    op.execute("DROP INDEX ix_items_reference_model")
    op.drop_constraint("fk_items_reference_model", "items", type_="foreignkey")
    op.drop_table("reference_models")
    op.drop_table("reference_imports")
    op.drop_table("reference_sources")
