from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db import get_session
from app.routers.misc import items_csv_response
from app.schemas import BulkDeleteIn, BulkDeleteOut, BulkIn, BulkOut, BulkSelection
from app.services.bulk import apply_bulk, delete_bulk, resolve_ids
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
