"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

CONDITIONS = "'Unknown', 'New / Sealed', 'Excellent', 'Good', 'Fair', 'Poor', 'Damaged'"
TEST_STATUSES = "'Unknown', 'Untested', 'POST', 'Full Test', 'Dead'"
CONFIDENCES = "'unidentified', 'candidate', 'confirmed'"
PHOTO_ROLES = "'front', 'back', 'label', 'chipset', 'other'"

SEARCH_TEXT = (
    "lower(inventory_code || ' ' || coalesce(manufacturer, '') || ' ' || model"
    " || ' ' || coalesce(part_number, '') || ' ' || coalesce(revision, '')"
    " || ' ' || coalesce(chipset_manufacturer, '') || ' ' || coalesce(chipset, '')"
    " || ' ' || coalesce(notes, ''))"
)
SORT_NAME = "lower(coalesce(manufacturer, '') || ' ' || model)"

SEED_CATEGORIES = ["CPU", "GPU/VGA", "Motherboard", "Sound Card", "RAM", "Storage", "Other"]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE SEQUENCE inventory_code_seq")

    # --- categories -------------------------------------------------------
    op.create_table(
        "categories",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("CREATE UNIQUE INDEX uq_categories_name ON categories (lower(name))")
    categories = sa.table("categories", sa.column("name", sa.Text), sa.column("sort_order", sa.Integer))
    op.bulk_insert(
        categories,
        [{"name": name, "sort_order": i * 10} for i, name in enumerate(SEED_CATEGORIES)],
    )

    # --- locations --------------------------------------------------------
    op.create_table(
        "locations",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("parent_id", sa.BigInteger, sa.ForeignKey("locations.id", ondelete="RESTRICT")),
        sa.Column("notes", sa.Text),
        sa.Column("path", sa.Text, nullable=False, server_default=""),
        sa.Column("full_name", sa.Text, nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("char_length(btrim(name)) > 0", name="ck_locations_name_not_blank"),
    )
    # Sibling names are unique (case-insensitive); roots share parent 0.
    op.execute("CREATE UNIQUE INDEX uq_locations_sibling_name ON locations (coalesce(parent_id, 0), lower(name))")
    op.execute("CREATE INDEX ix_locations_children ON locations (parent_id, lower(name), id)")
    # Subtree lookups: path LIKE '/1/5/%'
    op.execute("CREATE INDEX ix_locations_path ON locations (path text_pattern_ops)")
    op.execute("CREATE INDEX ix_locations_full_name_trgm ON locations USING gin (lower(full_name) gin_trgm_ops)")

    # --- items ------------------------------------------------------------
    op.create_table(
        "items",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "inventory_code",
            sa.Text,
            nullable=False,
            server_default=sa.text("'HW-' || lpad(nextval('inventory_code_seq')::text, 6, '0')"),
        ),
        sa.Column("category_id", sa.BigInteger, sa.ForeignKey("categories.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("manufacturer", sa.Text),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("part_number", sa.Text),
        sa.Column("revision", sa.Text),
        sa.Column("chipset_manufacturer", sa.Text),
        sa.Column("chipset", sa.Text),
        sa.Column("condition", sa.Text, nullable=False, server_default="Unknown"),
        sa.Column("test_status", sa.Text, nullable=False, server_default="Untested"),
        sa.Column("test_notes", sa.Text),
        sa.Column("location_id", sa.BigInteger, sa.ForeignKey("locations.id", ondelete="RESTRICT")),
        sa.Column("notes", sa.Text),
        sa.Column("acquired_on", sa.Date),
        sa.Column("reference_model_id", sa.BigInteger),
        sa.Column("identification_confidence", sa.Text, nullable=False, server_default="unidentified"),
        sa.Column("attributes", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("search_text", sa.Text, sa.Computed(SEARCH_TEXT, persisted=True)),
        sa.Column("sort_name", sa.Text, sa.Computed(SORT_NAME, persisted=True)),
        sa.UniqueConstraint("inventory_code", name="uq_items_inventory_code"),
        sa.CheckConstraint(f"condition IN ({CONDITIONS})", name="ck_items_condition"),
        sa.CheckConstraint(f"test_status IN ({TEST_STATUSES})", name="ck_items_test_status"),
        sa.CheckConstraint(f"identification_confidence IN ({CONFIDENCES})", name="ck_items_identification_confidence"),
        sa.CheckConstraint("char_length(btrim(model)) > 0", name="ck_items_model_not_blank"),
    )
    op.create_index(
        "ix_items_search_text_trgm",
        "items",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    # Filter + default sort (newest first) combinations.
    op.execute("CREATE INDEX ix_items_category ON items (category_id, id DESC)")
    op.execute("CREATE INDEX ix_items_test_status ON items (test_status, id DESC)")
    op.execute("CREATE INDEX ix_items_condition ON items (condition, id DESC)")
    op.execute("CREATE INDEX ix_items_confidence ON items (identification_confidence, id DESC)")
    op.execute("CREATE INDEX ix_items_location ON items (location_id, id DESC)")
    op.execute("CREATE INDEX ix_items_manufacturer ON items (lower(manufacturer), id DESC)")
    op.execute("CREATE INDEX ix_items_manufacturer_prefix ON items (lower(manufacturer) text_pattern_ops)")
    op.execute("CREATE INDEX ix_items_sort_name ON items (sort_name, id)")
    op.execute("CREATE INDEX ix_items_attributes ON items USING gin (attributes jsonb_path_ops)")

    # --- photos -----------------------------------------------------------
    op.create_table(
        "photos",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("item_id", sa.BigInteger, sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("thumb_key", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("original_filename", sa.Text),
        sa.Column("role", sa.Text, nullable=False, server_default="other"),
        sa.Column("caption", sa.Text),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("storage_key", name="uq_photos_storage_key"),
        sa.UniqueConstraint("thumb_key", name="uq_photos_thumb_key"),
        sa.CheckConstraint(f"role IN ({PHOTO_ROLES})", name="ck_photos_role"),
    )
    op.create_index("ix_photos_item", "photos", ["item_id", "sort_order", "id"])

    # --- pending storage deletions ---------------------------------------
    op.create_table(
        "pending_deletions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text),
    )


def downgrade() -> None:
    op.drop_table("pending_deletions")
    op.drop_table("photos")
    op.drop_table("items")
    op.drop_table("locations")
    op.drop_table("categories")
    op.execute("DROP SEQUENCE inventory_code_seq")
