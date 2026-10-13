"""Keyset (cursor) pagination over (sort key, id)."""

import base64
import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy import Select, literal, tuple_
from sqlalchemy.sql.elements import ColumnElement


def encode_cursor(key: Any, row_id: int) -> str:
    raw = json.dumps([key, row_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[Any, int]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        key, row_id = json.loads(base64.urlsafe_b64decode(padded))
        if not isinstance(row_id, int) or isinstance(key, (list, dict)):
            raise ValueError
        return key, row_id
    except Exception:
        raise HTTPException(status_code=422, detail="invalid cursor") from None


def apply_keyset(
    stmt: Select,
    key_expr: ColumnElement,
    id_col: ColumnElement,
    *,
    cursor: str | None,
    descending: bool,
    limit: int,
) -> Select:
    """Order by (key, id) and resume after ``cursor``. Fetches limit + 1 rows so
    the caller can tell whether another page exists."""
    if cursor:
        key, row_id = decode_cursor(cursor)
        position = tuple_(literal(key, key_expr.type), literal(row_id, id_col.type))
        current = tuple_(key_expr, id_col)
        stmt = stmt.where(current < position if descending else current > position)
    if descending:
        stmt = stmt.order_by(key_expr.desc(), id_col.desc())
    else:
        stmt = stmt.order_by(key_expr.asc(), id_col.asc())
    return stmt.limit(limit + 1)
