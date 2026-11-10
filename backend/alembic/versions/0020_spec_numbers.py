"""a function that reads the number out of a spec value ("300MHz", "128 KiB", "4GB")

Lets the inventory filter and sort by specs numerically, with units understood.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-09
"""

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

FUNCTION = r"""
CREATE FUNCTION hw_spec_number(v text) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN m IS NULL THEN NULL ELSE
    replace(m[1], ',', '.')::double precision *
    CASE lower(coalesce(m[2], ''))
      WHEN 'kb' THEN 1024 WHEN 'kib' THEN 1024
      WHEN 'mb' THEN 1048576 WHEN 'mib' THEN 1048576
      WHEN 'gb' THEN 1073741824 WHEN 'gib' THEN 1073741824
      WHEN 'tb' THEN 1099511627776 WHEN 'tib' THEN 1099511627776
      WHEN 'khz' THEN 1e3 WHEN 'mhz' THEN 1e6 WHEN 'ghz' THEN 1e9
      ELSE 1
    END
  END
  FROM (SELECT regexp_match(v, '^\s*([0-9]{1,15}(?:[.,][0-9]+)?)\s*([a-zA-Z]*)') AS m) s
$$
"""


def upgrade() -> None:
    op.execute(FUNCTION)


def downgrade() -> None:
    op.execute("DROP FUNCTION hw_spec_number(text)")
