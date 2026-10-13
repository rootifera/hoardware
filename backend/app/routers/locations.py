from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, aliased

from app.db import get_session
from app.models import Item, Location
from app.pagination import apply_keyset, decode_cursor, encode_cursor
from app.schemas import LocationDetail, LocationIn, LocationOut, LocationRef, LocationUpdate, Page
from app.services import locations as service
from app.services.items import _like_escape

router = APIRouter(prefix="/locations", tags=["locations"])
SessionDep = Annotated[Session, Depends(get_session)]


def _has_children():
    child = aliased(Location)
    return exists().where(child.parent_id == Location.id).label("has_children")


def _out(row) -> LocationOut:
    return LocationOut(
        id=row.id,
        name=row.name,
        parent_id=row.parent_id,
        notes=row.notes,
        type=row.type,
        full_name=row.full_name,
        has_children=row.has_children,
    )


def _select():
    return select(
        Location.id, Location.name, Location.parent_id, Location.notes, Location.type, Location.full_name, _has_children()
    )


@router.get("", response_model=Page[LocationOut])
def list_locations(
    session: SessionDep,
    parent_id: Annotated[int | None, Query(description="List the children of this location")] = None,
    q: Annotated[str | None, Query(max_length=200, description="Search by full path")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    cursor: str | None = None,
):
    """Without ``parent_id`` or ``q`` this returns the root locations, so the
    tree can be loaded lazily one level at a time."""
    stmt = _select()
    if q and q.strip():
        for token in q.lower().split()[:8]:
            stmt = stmt.where(func.lower(Location.full_name).like(f"%{_like_escape(token)}%", escape="\\"))
        key_expr = func.lower(Location.full_name)
    else:
        if parent_id is None:
            stmt = stmt.where(Location.parent_id.is_(None))
        else:
            stmt = stmt.where(Location.parent_id == parent_id)
        key_expr = func.lower(Location.name)
    if cursor:
        key, _ = decode_cursor(cursor)
        if not isinstance(key, str):
            raise HTTPException(422, "invalid cursor")
    stmt = apply_keyset(stmt, key_expr, Location.id, cursor=cursor, descending=False, limit=limit)
    rows = session.execute(stmt).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = encode_cursor(
            last.full_name.lower() if q and q.strip() else last.name.lower(), last.id
        )
    return Page[LocationOut](items=[_out(r) for r in rows], next_cursor=next_cursor)


@router.get("/types", response_model=list[str])
def list_location_types(session: SessionDep):
    """Types already in use, for suggestions."""
    return list(session.scalars(select(Location.type).where(Location.type.is_not(None)).group_by(Location.type).order_by(func.lower(Location.type))))


@router.get("/{location_id}/next-position", response_model=int)
def next_position(location_id: int, session: SessionDep):
    """The lowest position after the highest one in use (1 for an empty location)."""
    if session.get(Location, location_id) is None:
        raise HTTPException(404, "location not found")
    highest = session.scalar(select(func.max(Item.order)).where(Item.location_id == location_id))
    return 1 if highest is None else highest + 1


@router.get("/{location_id}", response_model=LocationDetail)
def get_location(location_id: int, session: SessionDep):
    row = session.execute(_select().where(Location.id == location_id)).first()
    if row is None:
        raise HTTPException(404, "location not found")
    location = session.get(Location, location_id)
    ancestor_ids = [int(p) for p in location.path.strip("/").split("/")[:-1]]
    ancestors = []
    if ancestor_ids:
        names = dict(session.execute(select(Location.id, Location.name).where(Location.id.in_(ancestor_ids))).all())
        ancestors = [LocationRef(id=i, name=names[i]) for i in ancestor_ids if i in names]
    return LocationDetail(**_out(row).model_dump(), ancestors=ancestors)


@router.post("", response_model=LocationDetail, status_code=201)
def create_location(body: LocationIn, session: SessionDep):
    location = service.create_location(session, body.name, body.parent_id, body.notes, body.type)
    return get_location(location.id, session)


@router.patch("/{location_id}", response_model=LocationDetail)
def update_location(location_id: int, body: LocationUpdate, session: SessionDep):
    changes = body.model_dump(exclude_unset=True)
    if changes.get("name", "x") is None:
        raise HTTPException(422, "name cannot be null")
    service.update_location(session, location_id, changes)
    return get_location(location_id, session)


@router.delete("/{location_id}", status_code=204)
def delete_location(location_id: int, session: SessionDep):
    service.delete_location(session, location_id)
    return Response(status_code=204)
