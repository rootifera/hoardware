"""Item search, filtering and sorting (all in SQL)."""

import re
from dataclasses import dataclass, field
from datetime import date

from fastapi import HTTPException
from sqlalchemy import Float, Select, String, cast, func, or_, select
from sqlalchemy.orm import Session

from app.enums import OWNED_STATUSES, Condition, IdentificationConfidence, ItemStatus, TestStatus
from app.models import Category, Item, Location
from app.services import appsettings

MAX_TOKENS = 8
_NUMERIC = re.compile(r"^(?:hw-?)?(\d{1,9})$")

SORTS = ("newest", "name", "category", "location", "position", "spec")
SPEC_OPS = ("eq", "min", "max")


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
    never_verified: bool = False
    verified_before: date | None = None  # verified earlier than this, or never
    low_stock: bool = False  # stock items at or under their low-stock level
    # Empty means what you own (not sold, scrapped, or only wished for).
    statuses: list[ItemStatus] = field(default_factory=list)
    # One spec condition: Socket is "Socket 7", or Speed at least / at most "200MHz". Numbers understand units.
    spec_key: str | None = None
    spec_op: str = "eq"
    spec_value: str | None = None


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
        prefix = appsettings.code_prefix(session)
        tokens = f.q.lower().split()[:MAX_TOKENS]
        for token in tokens:
            # search_text is lowercase and trigram-indexed, so substring
            # matches on every token stay index-assisted.
            clause = Item.search_text.like(f"%{_like_escape(token)}%", escape="\\")
            # A scanned barcode typed into the search box finds the items that carry it.
            if len(token) >= 4:
                clause = or_(clause, func.lower(Item.barcode) == token)
            numeric = _NUMERIC.match(token)
            if numeric:
                clause = or_(clause, Item.inventory_code == f"{prefix}-{int(numeric.group(1)):06d}")
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

    wanted_statuses = f.statuses or list(OWNED_STATUSES)
    if len(wanted_statuses) < len(ItemStatus):
        stmt = stmt.where(Item.status.in_([x.value for x in wanted_statuses]))

    if f.spec_key and f.spec_value:
        stored = Item.attributes[f.spec_key].astext
        if f.spec_op == "eq":
            stmt = stmt.where(func.lower(stored) == f.spec_value.strip().lower())
        else:
            threshold = session.scalar(select(func.hw_spec_number(f.spec_value)))
            if threshold is None:
                raise HTTPException(422, f"“{f.spec_value}” does not start with a number")
            number = func.hw_spec_number(stored)
            stmt = stmt.where(number >= threshold if f.spec_op == "min" else number <= threshold)

    if f.low_stock:
        stmt = stmt.where(Item.is_stock.is_(True), Item.low_stock_level.is_not(None), Item.quantity <= Item.low_stock_level)

    if f.never_verified:
        stmt = stmt.where(Item.verified_on.is_(None))
    elif f.verified_before is not None:
        stmt = stmt.where(or_(Item.verified_on.is_(None), Item.verified_on < f.verified_before))

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


def sort_key(sort: str, spec_key: str | None = None, descending: bool = False):
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
    if sort == "spec":
        if not spec_key:
            raise HTTPException(422, "sorting by a spec needs spec_key")
        # Items without that spec (or a number in it) go last in either direction.
        return func.coalesce(func.hw_spec_number(Item.attributes[spec_key].astext, type_=Float), -1e308 if descending else 1e308), False
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
    if sort == "spec":
        return row.sort_key
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
