import csv
import io
import logging
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.db import SessionLocal, get_session
from app.models import Item
from app.routers.items import FiltersDep
from app.services import items as item_service
from app.services.items import _like_escape
from app.storage import StorageError, get_storage

log = logging.getLogger(__name__)

router = APIRouter()
SessionDep = Annotated[Session, Depends(get_session)]


@router.get("/health", tags=["health"])
def health(response: Response):
    db_ok = True
    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
    except Exception as exc:
        log.error("health: database check failed: %s", exc)
        db_ok = False
    try:
        get_storage().check()
        storage = {"status": "ok"}
    except StorageError as exc:
        storage = {"status": "error", "detail": str(exc)}
    if not db_ok:
        response.status_code = 503
    # Storage trouble is reported but does not fail the health check: the
    # inventory itself keeps working without photo storage.
    return {"status": "ok" if db_ok else "error", "database": "ok" if db_ok else "error", "storage": storage}


@router.get("/manufacturers", response_model=list[str], tags=["items"])
def list_manufacturers(
    session: SessionDep,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    """Distinct manufacturers starting with ``q`` (for filter/autocomplete)."""
    lowered = func.lower(Item.manufacturer)
    stmt = select(func.min(Item.manufacturer)).where(Item.manufacturer.is_not(None))
    if q and q.strip():
        stmt = stmt.where(lowered.like(_like_escape(q.strip().lower()) + "%", escape="\\"))
    stmt = stmt.group_by(lowered).order_by(lowered).limit(limit)
    return list(session.scalars(stmt))


EXPORT_COLUMNS = [
    "inventory_code",
    "category",
    "manufacturer",
    "model",
    "part_number",
    "revision",
    "chipset_manufacturer",
    "chipset",
    "condition",
    "test_status",
    "test_notes",
    "location",
    "position",
    "notes",
    "acquired_on",
    "identification_confidence",
    "created_at",
    "updated_at",
]


def _cell(value) -> str:
    if value is None:
        return ""
    text_value = value.isoformat() if hasattr(value, "isoformat") else str(value)
    # Neutralise spreadsheet formula injection.
    if text_value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text_value
    return text_value


@router.get("/export/items.csv", tags=["export"])
def export_items_csv(filters: FiltersDep):
    """Stream the (optionally filtered) inventory as CSV with constant memory."""
    from app.models import Category, Location

    def rows() -> Iterator[str]:
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(EXPORT_COLUMNS)
        yield buffer.getvalue()
        with SessionLocal() as session:
            stmt = item_service.apply_filters(
                session,
                item_service.base_select(
                    Item.inventory_code,
                    Category.name,
                    Item.manufacturer,
                    Item.model,
                    Item.part_number,
                    Item.revision,
                    Item.chipset_manufacturer,
                    Item.chipset,
                    Item.condition,
                    Item.test_status,
                    Item.test_notes,
                    Location.full_name,
                    Item.order,
                    Item.notes,
                    Item.acquired_on,
                    Item.identification_confidence,
                    Item.created_at,
                    Item.updated_at,
                ),
                filters,
            ).order_by(Item.id)
            result = session.execute(stmt.execution_options(stream_results=True, yield_per=1000))
            for batch in result.partitions():
                buffer.seek(0)
                buffer.truncate()
                for row in batch:
                    writer.writerow([_cell(v) for v in row])
                yield buffer.getvalue()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="hoardware-items-{stamp}.csv"'},
    )
