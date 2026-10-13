from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_session
from app.schemas import BulkIn, BulkOut
from app.services.bulk import apply_bulk

router = APIRouter(prefix="/items", tags=["bulk"])
SessionDep = Annotated[Session, Depends(get_session)]


@router.post("/bulk", response_model=BulkOut)
def bulk_update(body: BulkIn, session: SessionDep):
    """Apply the same change to many items: explicit ids, or everything that
    matches a filter. ``dry_run`` reports what would happen without changing anything."""
    return apply_bulk(session, body)
