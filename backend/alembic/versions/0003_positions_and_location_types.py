"""item positions, location types, duplicate sibling names

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-13

* locations.type: free-text label (shelf, box, drawer...).
* items."order": the item's exact position inside its location; unique per
  location whenever it is set.
* sibling locations may share a name (the unique index is dropped).
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("locations", sa.Column("type", sa.Text))
    op.execute("DROP INDEX uq_locations_sibling_name")

    op.add_column("items", sa.Column("order", sa.Integer))
    op.create_check_constraint("ck_items_order_range", "items", '"order" IS NULL OR "order" >= 0')
    # A position only means something inside a location.
    op.create_check_constraint("ck_items_order_needs_location", "items", '"order" IS NULL OR location_id IS NOT NULL')
    # Two items cannot share the same exact spot. Race-safe: enforced by the index.
    op.execute(
        'CREATE UNIQUE INDEX uq_items_location_order ON items (location_id, "order") WHERE "order" IS NOT NULL'
    )


def downgrade() -> None:
    op.execute("DROP INDEX uq_items_location_order")
    op.drop_constraint("ck_items_order_needs_location", "items", type_="check")
    op.drop_constraint("ck_items_order_range", "items", type_="check")
    op.drop_column("items", "order")
    op.execute("CREATE UNIQUE INDEX uq_locations_sibling_name ON locations (coalesce(parent_id, 0), lower(name))")
    op.drop_column("locations", "type")
