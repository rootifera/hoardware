"""Item search, filtering and sorting (all in SQL)."""

import re
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import Select, String, cast, func, or_, select
from sqlalchemy.orm import Session

from app.enums import Condition, IdentificationConfidence, TestStatus
from app.models import Category, Item, Location

MAX_TOKENS = 8
_NUMERIC = re.compile(r"^(?:hw-?)?(\d{1,9})$")

SORTS = ("newest", "name", "category", "location", "position")


@dataclass
class ItemFilters:
    q: str | None = None
    category_ids: list[int] = field(default_factory=list)
    manufacturer: str | None = None
    conditions: list[Condition] = field(default_factory=list)
    test_statuses: list[TestStatus] = field(default_factory=list)
    confidences: list[IdentificationConfidence] = field(default_factory=list)
    location_id: int | None = None
    include_descendants: bool = True
    unassigned: bool = False


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def base_select(*columns) -> Select:
    return (
        select(*columns)
        .select_from(Item)
        .join(Category, Category.id == Item.category_id)
        .outerjoin(Location, Location.id == Item.location_id)
    )


def apply_filters(session: Session, stmt: Select, f: ItemFilters) -> Select:
    if f.q:
        tokens = f.q.lower().split()[:MAX_TOKENS]
        for token in tokens:
            # search_text is lowercase and trigram-indexed, so substring
            # matches on every token stay index-assisted.
            clause = Item.search_text.like(f"%{_like_escape(token)}%", escape="\\")
            numeric = _NUMERIC.match(token)
            if numeric:
                clause = or_(clause, Item.inventory_code == f"HW-{int(numeric.group(1)):06d}")
            stmt = stmt.where(clause)

    if f.category_ids:
        stmt = stmt.where(Item.category_id.in_(f.category_ids))
    if f.manufacturer:
        stmt = stmt.where(func.lower(Item.manufacturer) == f.manufacturer.strip().lower())
    if f.conditions:
        stmt = stmt.where(Item.condition.in_([c.value for c in f.conditions]))
    if f.test_statuses:
        stmt = stmt.where(Item.test_status.in_([s.value for s in f.test_statuses]))
    if f.confidences:
        stmt = stmt.where(Item.identification_confidence.in_([c.value for c in f.confidences]))

    if f.unassigned:
        stmt = stmt.where(Item.location_id.is_(None))
    elif f.location_id is not None:
        location = session.get(Location, f.location_id)
        if location is None:
            raise HTTPException(404, "location not found")
        if f.include_descendants:
            subtree = select(Location.id).where(Location.path.like(location.path + "%"))
            stmt = stmt.where(Item.location_id.in_(subtree))
        else:
            stmt = stmt.where(Item.location_id == location.id)
    return stmt


def sort_key(sort: str):
    """(key expression, descending-by-default) for a sort name."""
    if sort == "newest":
        return Item.id, True
    if sort == "name":
        return Item.sort_name, False
    if sort == "category":
        return func.lower(Category.name), False
    if sort == "location":
        return func.coalesce(Location.full_name, ""), False
    if sort == "position":
        # Position first (items without one last), then name: shelf order.
        number = func.lpad(func.coalesce(cast(Item.order, String), "9999999999"), 10, "0")
        return number + " " + Item.sort_name, False
    raise HTTPException(422, f"unknown sort: {sort}")


def cursor_value(sort: str, row) -> object:
    """Value of the sort key for a result row, for building the next cursor."""
    if sort == "newest":
        return row.id
    if sort == "name":
        return row.sort_name
    if sort == "category":
        return row.category_name.lower()
    if sort == "position":
        number = row.order if row.order is not None else 9999999999
        return f"{number:010d} {row.sort_name}"
    return row.location_path or ""


def ensure_position_free(session: Session, location_id: int | None, order: int | None, item_id: int | None = None) -> None:
    """Two items cannot share the same exact spot: a position is unique within
    its location. (The unique index enforces it under concurrency; this gives
    the friendly message.)"""
    if order is None:
        return
    if location_id is None:
        raise HTTPException(422, "a position only makes sense inside a location; choose a location first")
    taken = session.scalar(
        select(Item.inventory_code).where(Item.location_id == location_id, Item.order == order, Item.id != (item_id or -1))
    )
    if taken:
        location = session.get(Location, location_id)
        raise HTTPException(409, f"{location.full_name} position {order} is already taken by {taken}")
