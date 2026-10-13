"""Location tree maintenance.

Each row stores ``path`` ("/1/5/9/", ids from the root to the row itself) and
``full_name`` ("Workshop > Shelf 2 > Box 3"). Subtree queries are then simple
prefix matches on an indexed column, and results can show the full path
without joins. All structural writes take one advisory lock so concurrent
moves cannot race into a cycle.
"""

from fastapi import HTTPException
from sqlalchemy import exists, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Item, Location

SEPARATOR = " > "
_LOCK_KEY = 0x484F4152  # "HOAR"


def _lock(session: Session) -> None:
    session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})


def _get_or_404(session: Session, location_id: int) -> Location:
    location = session.get(Location, location_id)
    if location is None:
        raise HTTPException(404, "location not found")
    return location


def _parent_or_422(session: Session, parent_id: int) -> Location:
    parent = session.get(Location, parent_id)
    if parent is None:
        raise HTTPException(422, "parent location does not exist")
    return parent


def _conflict() -> HTTPException:
    return HTTPException(409, "a sibling location with this name already exists")


def create_location(session: Session, name: str, parent_id: int | None, notes: str | None) -> Location:
    _lock(session)
    parent = _parent_or_422(session, parent_id) if parent_id is not None else None
    location = Location(name=name, parent_id=parent_id, notes=notes)
    session.add(location)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise _conflict() from None
    location.path = f"{parent.path if parent else '/'}{location.id}/"
    location.full_name = f"{parent.full_name}{SEPARATOR}{name}" if parent else name
    session.commit()
    return location


def update_location(session: Session, location_id: int, changes: dict) -> Location:
    _lock(session)
    location = _get_or_404(session, location_id)

    new_name = changes.get("name", location.name)
    moving = "parent_id" in changes and changes["parent_id"] != location.parent_id
    new_parent_id = changes["parent_id"] if "parent_id" in changes else location.parent_id
    if "notes" in changes:
        location.notes = changes["notes"]

    if new_name != location.name or moving:
        parent = None
        if new_parent_id is not None:
            if new_parent_id == location.id:
                raise HTTPException(422, "a location cannot be its own parent")
            parent = _parent_or_422(session, new_parent_id)
            if parent.path.startswith(location.path):
                raise HTTPException(422, "a location cannot be moved into its own descendant")

        old_path, old_full = location.path, location.full_name
        new_path = f"{parent.path if parent else '/'}{location.id}/"
        new_full = f"{parent.full_name}{SEPARATOR}{new_name}" if parent else new_name

        location.name = new_name
        location.parent_id = new_parent_id
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            raise _conflict() from None

        # Rewrite this row and every descendant in one statement.
        session.execute(
            text(
                "UPDATE locations SET"
                " path = :new_path || substr(path, length(:old_path) + 1),"
                " full_name = :new_full || substr(full_name, length(:old_full) + 1)"
                " WHERE path LIKE :old_like"
            ),
            {
                "new_path": new_path,
                "old_path": old_path,
                "new_full": new_full,
                "old_full": old_full,
                "old_like": old_path + "%",
            },
        )
    session.commit()
    session.refresh(location)
    return location


def delete_location(session: Session, location_id: int) -> None:
    _lock(session)
    location = _get_or_404(session, location_id)
    if session.scalar(select(exists().where(Location.parent_id == location.id))):
        raise HTTPException(409, "location has child locations; move or delete them first")
    if session.scalar(select(exists().where(Item.location_id == location.id))):
        raise HTTPException(409, "location still contains items; move them first")
    session.delete(location)
    session.commit()
