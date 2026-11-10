"""An item's life: its status (in the collection, installed in a build, lent, sold, scrapped,
on the wishlist), what it is installed in, and a history of where it has been.

Nothing is deleted when an item leaves the collection; it keeps its record and its history."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.enums import GONE_STATUSES, ItemStatus
from app.models import Item, ItemHistory, Location

GONE_VALUES = {s.value for s in GONE_STATUSES}
MAX_DEPTH = 20


def _location_name(session: Session, location_id: int | None) -> str | None:
    return session.scalar(select(Location.full_name).where(Location.id == location_id)) if location_id else None


def _item_label(session: Session, item_id: int | None) -> str | None:
    if item_id is None:
        return None
    row = session.execute(select(Item.inventory_code, Item.manufacturer, Item.model).where(Item.id == item_id)).first()
    if row is None:
        return None
    return f"{row[0]} {' '.join(p for p in (row[1], row[2]) if p)}"


def log(session: Session, item_id: int, kind: str, old: str | None, new: str | None) -> None:
    if old != new:
        session.add(ItemHistory(item_id=item_id, kind=kind, old=old, new=new))


def check_parent(session: Session, item_id: int | None, parent_id: int) -> None:
    """The thing an item is installed in must exist, and a build cannot sit inside its own part."""
    if parent_id == item_id:
        raise HTTPException(422, "an item cannot be installed in itself")
    if session.get(Item, parent_id) is None:
        raise HTTPException(422, "the item it is installed in does not exist")
    seen, cursor = 0, parent_id
    while cursor is not None and item_id is not None and seen < MAX_DEPTH:
        if cursor == item_id:
            raise HTTPException(422, "that would put a build inside one of its own parts")
        cursor = session.scalar(select(Item.installed_in_id).where(Item.id == cursor))
        seen += 1


def settle(session: Session, current: dict[str, Any], changes: dict[str, Any], item_id: int | None) -> dict[str, Any]:
    """Apply the rules that tie status, build and location together, to a set of changes made to
    an item whose present values are ``current`` (an empty-ish dict for a new item). Returns the
    changes to apply (the input plus the consequences)."""
    out = dict(changes)
    status = out.get("status", current.get("status", ItemStatus.IN_COLLECTION.value))
    status = status.value if hasattr(status, "value") else status
    out["status"] = status
    parent = out.get("installed_in_id", current.get("installed_in_id"))
    if parent is not None and "installed_in_id" in changes:
        check_parent(session, item_id, parent)
        if "status" in changes and status != ItemStatus.INSTALLED.value:
            raise HTTPException(422, "an item installed in a build has the status “installed”")
        if status in GONE_VALUES:
            raise HTTPException(422, "a sold, scrapped or wished-for item cannot be installed in a build")
        # Putting something into a build marks it installed (also when it was lent out: it is in the build now).
        status = out["status"] = ItemStatus.INSTALLED.value
    elif parent is None and "installed_in_id" in changes and "status" not in changes:
        # Taking it out of the build returns it to the collection.
        if status == ItemStatus.INSTALLED.value:
            status = out["status"] = ItemStatus.IN_COLLECTION.value
    if status != ItemStatus.INSTALLED.value and parent is not None:
        out["installed_in_id"] = None  # lent, sold, scrapped… parts are no longer in the build
    if status in GONE_VALUES:
        out["location_id"] = None
        out["order"] = None
    if status != current.get("status") and "status_note" not in changes and current.get("status") is not None:
        out["status_note"] = None
    return out


def record_changes(session: Session, item: Item, before: dict[str, Any]) -> None:
    """History entries for whatever differs between ``before`` and the item as it is now."""
    log(session, item.id, "status", before["status"], item.status)
    log(session, item.id, "installed_in", _item_label(session, before["installed_in_id"]), _item_label(session, item.installed_in_id))
    if before["location_id"] != item.location_id:
        log(session, item.id, "location", before["location_name"], _location_name(session, item.location_id))


def snapshot(session: Session, item: Item) -> dict[str, Any]:
    return {
        "status": item.status,
        "installed_in_id": item.installed_in_id,
        "location_id": item.location_id,
        "location_name": _location_name(session, item.location_id),
    }


def release_parts(session: Session, build_ids: list[int]) -> None:
    """Parts installed in builds that are about to be deleted go back to the collection (the
    database already clears the link; this fixes their status and records it)."""
    if not build_ids:
        return
    parts = session.scalars(
        select(Item.id).where(Item.installed_in_id.in_(build_ids), Item.status == ItemStatus.INSTALLED.value)
    ).all()
    if not parts:
        return
    for part_id in parts:
        log(session, part_id, "status", ItemStatus.INSTALLED.value, ItemStatus.IN_COLLECTION.value)
    session.execute(
        update(Item).where(Item.id.in_(parts)).values(status=ItemStatus.IN_COLLECTION.value, updated_at=text("now()")),
        execution_options={"synchronize_session": False},
    )
