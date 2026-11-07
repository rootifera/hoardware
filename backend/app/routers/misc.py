import csv
import io
import json
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
    from app.backup import backup_status

    # Backups are reported too, and likewise never fail the check: a late backup needs attention, not a restart.
    return {
        "status": "ok" if db_ok else "error",
        "database": "ok" if db_ok else "error",
        "storage": storage,
        "backups": backup_status(),
    }


@router.get("/version", tags=["health"])
def get_version():
    """The installed version, and the newer one if the git repository has published one."""
    from app import version

    return version.status()


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


@router.get("/attribute-keys", response_model=list[str], tags=["items"])
def list_attribute_keys(
    session: SessionDep,
    category_id: int | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    """Spec names already used in items' own specifications (most used first),
    optionally within one category, so new entries reuse the same wording."""
    where = "WHERE attributes <> '{}'::jsonb" + (" AND category_id = :category" if category_id is not None else "")
    rows = session.execute(
        text(
            f"SELECT k, count(*) AS uses FROM items, jsonb_object_keys(attributes) AS k {where}"
            " GROUP BY k ORDER BY uses DESC, k LIMIT :limit"
        ),
        {"limit": limit, **({"category": category_id} if category_id is not None else {})},
    )
    return [name for name, _ in rows]


@router.get("/attribute-values", response_model=list[str], tags=["items"])
def list_attribute_values(
    session: SessionDep,
    key: Annotated[str, Query(min_length=1, max_length=60)],
    category_id: int | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    """Values already used for one spec name (most used first), for suggestions."""
    where = "WHERE attributes ? :key" + (" AND category_id = :category" if category_id is not None else "")
    rows = session.execute(
        text(
            f"SELECT v, count(*) AS uses FROM (SELECT attributes ->> :key AS v FROM items {where}) s"
            " WHERE v IS NOT NULL AND v <> '' GROUP BY v ORDER BY uses DESC, v LIMIT :limit"
        ),
        {"key": key, "limit": limit, **({"category": category_id} if category_id is not None else {})},
    )
    return [value for value, _ in rows]


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
    "verified_on",
    "identification_confidence",
    "specs",
    "created_at",
    "updated_at",
]


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):  # the item's own specs, as JSON
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")) if value else ""
    text_value = value.isoformat() if hasattr(value, "isoformat") else str(value)
    # Neutralise spreadsheet formula injection.
    if text_value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text_value
    return text_value


def items_csv_response(filters, ids: list[int] | None = None) -> StreamingResponse:
    """Stream items as CSV with constant memory: the filtered inventory, or just the given ids."""
    from sqlalchemy import BigInteger, any_, bindparam
    from sqlalchemy.dialects.postgresql import ARRAY

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
                    Item.verified_on,
                    Item.identification_confidence,
                    Item.attributes,
                    Item.created_at,
                    Item.updated_at,
                ),
                filters,
            )
            if ids is not None:
                stmt = stmt.where(Item.id == any_(bindparam("ids", ids, type_=ARRAY(BigInteger))))
            result = session.execute(stmt.order_by(Item.id).execution_options(stream_results=True, yield_per=1000))
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


@router.get("/export/items.csv", tags=["export"])
def export_items_csv(filters: FiltersDep):
    """Stream the (optionally filtered) inventory as CSV with constant memory."""
    return items_csv_response(filters)
