from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.routers.misc import items_csv_response
from app.schemas import BulkDeleteIn, BulkDeleteOut, BulkIn, BulkOut, BulkSelection, LabelOut
from app.services.bulk import apply_bulk, delete_bulk, resolve_ids
from app.models import Category, Item, Location
from app.services.items import ItemFilters

router = APIRouter(prefix="/items", tags=["bulk"])
SessionDep = Annotated[Session, Depends(get_session)]


@router.post("/bulk", response_model=BulkOut)
def bulk_update(body: BulkIn, session: SessionDep):
    """Apply the same change to many items: explicit ids, or everything that
    matches a filter. ``dry_run`` reports what would happen without changing anything."""
    return apply_bulk(session, body)


@router.post("/bulk-delete", response_model=BulkDeleteOut)
def bulk_delete(body: BulkDeleteIn, session: SessionDep):
    """Delete the selected items with their photos and files. ``dry_run`` only counts them."""
    return delete_bulk(session, body)


@router.post("/bulk-export")
def bulk_export(body: BulkSelection, session: SessionDep) -> StreamingResponse:
    """The selected items as a CSV file (same columns as the full export)."""
    ids = resolve_ids(session, body)
    return items_csv_response(ItemFilters(), ids)


MAX_LABELS = 1000


@router.post("/labels", response_model=list[LabelOut])
def labels(body: BulkSelection, session: SessionDep):
    """The data for printing labels for a selection (ids, or everything a filter matches)."""
    ids = resolve_ids(session, body)
    if len(ids) > MAX_LABELS:
        raise HTTPException(422, f"too many labels at once ({len(ids):,}); print at most {MAX_LABELS:,} at a time")
    rows = session.execute(
        select(Item.id, Item.inventory_code, Item.manufacturer, Item.model, Category.name, Location.full_name, Item.barcode)
        .join(Category, Category.id == Item.category_id)
        .outerjoin(Location, Location.id == Item.location_id)
        .where(Item.id.in_(ids))
        .order_by(Item.id)
    ).all()
    return [
        LabelOut(
            id=r[0],
            inventory_code=r[1],
            barcode=r[6] or r[1],
            manufacturer=r[2],
            model=r[3],
            category_name=r[4],
            location_path=r[5],
        )
        for r in rows
    ]
