from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_session
from app.enums import Condition, IdentificationConfidence, TestStatus
from app.models import Category, Item, Location, Photo, ReferenceModel
from app.pagination import apply_keyset, encode_cursor, decode_cursor
from app.schemas import (
    ItemBatchCreated,
    ItemBatchIn,
    ItemBatchOut,
    ItemCreate,
    ItemDetail,
    ItemSummary,
    ItemUpdate,
    Page,
    PhotoOut,
)
from app.services import items as item_service
from app.services import locations as location_service
from app.services import reference as reference_service
from app.services.items import ItemFilters
from app.services.photos import process_pending_deletions, queue_deletions
from app.storage import StorageError, get_storage

router = APIRouter(prefix="/items", tags=["items"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def photo_url(photo_id: int) -> str:
    return f"/api/v1/photos/{photo_id}/file"


def thumbnail_url(photo_id: int) -> str:
    return f"/api/v1/photos/{photo_id}/thumbnail"


def photo_out(photo: Photo) -> PhotoOut:
    return PhotoOut(
        id=photo.id,
        item_id=photo.item_id,
        role=photo.role,
        caption=photo.caption,
        sort_order=photo.sort_order,
        content_type=photo.content_type,
        size_bytes=photo.size_bytes,
        created_at=photo.created_at,
        url=photo_url(photo.id),
        thumbnail_url=thumbnail_url(photo.id),
    )


SUMMARY_COLUMNS = (
    Item.id,
    Item.inventory_code,
    Item.category_id,
    Category.name.label("category_name"),
    Item.manufacturer,
    Item.model,
    Item.part_number,
    Item.revision,
    Item.chipset_manufacturer,
    Item.chipset,
    Item.condition,
    Item.test_status,
    Item.identification_confidence,
    Item.location_id,
    Location.full_name.label("location_path"),
    Item.order,
    Item.created_at,
    Item.updated_at,
    Item.sort_name,
)
DETAIL_COLUMNS = SUMMARY_COLUMNS + (
    Item.test_notes,
    Item.notes,
    Item.acquired_on,
    Item.reference_model_id,
    Item.attributes,
)


def _filters(
    q: Annotated[str | None, Query(max_length=200)] = None,
    category_id: Annotated[list[int] | None, Query()] = None,
    manufacturer: Annotated[str | None, Query(max_length=300)] = None,
    condition: Annotated[list[Condition] | None, Query()] = None,
    test_status: Annotated[list[TestStatus] | None, Query()] = None,
    identification_confidence: Annotated[list[IdentificationConfidence] | None, Query()] = None,
    location_id: int | None = None,
    include_descendants: bool = True,
    unassigned: bool = False,
) -> ItemFilters:
    return ItemFilters(
        q=q.strip() if q else None,
        category_ids=category_id or [],
        manufacturer=manufacturer,
        conditions=condition or [],
        test_statuses=test_status or [],
        confidences=identification_confidence or [],
        location_id=location_id,
        include_descendants=include_descendants,
        unassigned=unassigned,
    )


FiltersDep = Annotated[ItemFilters, Depends(_filters)]
SessionDep = Annotated[Session, Depends(get_session)]


def _thumbnails(session: Session, item_ids: list[int]) -> dict[int, int]:
    """First photo (by sort order) per item, in one query for the whole page."""
    if not item_ids:
        return {}
    rows = session.execute(
        select(Photo.item_id, Photo.id)
        .where(Photo.item_id.in_(item_ids))
        .distinct(Photo.item_id)
        .order_by(Photo.item_id, Photo.sort_order, Photo.id)
    )
    return {item_id: photo_id for item_id, photo_id in rows}


def _summary(row, thumbs: dict[int, int]) -> ItemSummary:
    photo_id = thumbs.get(row.id)
    return ItemSummary(
        **{name: getattr(row, name) for name in ItemSummary.model_fields if name not in ("thumbnail_url",)},
        thumbnail_url=thumbnail_url(photo_id) if photo_id else None,
    )


def load_detail(session: Session, item_id: int) -> ItemDetail:
    row = session.execute(item_service.base_select(*DETAIL_COLUMNS).where(Item.id == item_id)).first()
    if row is None:
        raise HTTPException(404, "item not found")
    photos = session.scalars(
        select(Photo).where(Photo.item_id == item_id).order_by(Photo.sort_order, Photo.id)
    ).all()
    fields = {
        name: getattr(row, name) for name in ItemDetail.model_fields if name not in ("thumbnail_url", "photos", "reference")
    }
    reference = session.get(ReferenceModel, row.reference_model_id) if row.reference_model_id else None
    return ItemDetail(
        **fields,
        reference=reference_service.detail_of(session, reference) if reference else None,
        thumbnail_url=thumbnail_url(photos[0].id) if photos else None,
        photos=[photo_out(p) for p in photos],
    )


def _check_refs(session: Session, category_id: int | None, location_id: int | None) -> None:
    if category_id is not None and session.get(Category, category_id) is None:
        raise HTTPException(422, "category does not exist")
    if location_id is not None and session.get(Location, location_id) is None:
        raise HTTPException(422, "location does not exist")


def _commit_or_position_conflict(session: Session) -> None:
    """Commit; losing a race for a position (caught by the unique index)
    becomes the same 409 as the up-front check."""
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        if "uq_items_location_order" in str(exc.orig):
            raise HTTPException(409, "that position in the location was just taken by another item") from None
        raise


@router.get("", response_model=Page[ItemSummary])
def list_items(
    session: SessionDep,
    filters: FiltersDep,
    sort: Annotated[str, Query(pattern="^(newest|name|category|location|position)$")] = "newest",
    order: Annotated[str | None, Query(pattern="^(asc|desc)$")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: str | None = None,
    with_total: bool = False,
):
    key_expr, default_desc = item_service.sort_key(sort)
    descending = default_desc if order is None else order == "desc"

    if cursor:
        key, _ = decode_cursor(cursor)
        if isinstance(key, int) != (sort == "newest"):
            raise HTTPException(422, "cursor does not match the requested sort")

    stmt = item_service.apply_filters(session, item_service.base_select(*SUMMARY_COLUMNS), filters)
    stmt = apply_keyset(stmt, key_expr, Item.id, cursor=cursor, descending=descending, limit=limit)
    rows = session.execute(stmt).all()

    has_more = len(rows) > limit
    rows = rows[:limit]
    thumbs = _thumbnails(session, [r.id for r in rows])
    next_cursor = encode_cursor(item_service.cursor_value(sort, rows[-1]), rows[-1].id) if has_more else None

    total = None
    if with_total:
        count_stmt = item_service.apply_filters(
            session, item_service.base_select(func.count(Item.id)), filters
        )
        total = session.scalar(count_stmt)
    return Page[ItemSummary](items=[_summary(r, thumbs) for r in rows], next_cursor=next_cursor, total=total)


@router.get("/by-code/{inventory_code}", response_model=ItemDetail)
def get_item_by_code(inventory_code: str, session: SessionDep):
    item_id = session.scalar(select(Item.id).where(Item.inventory_code == inventory_code.upper()))
    if item_id is None:
        raise HTTPException(404, "item not found")
    return load_detail(session, item_id)


@router.post("", response_model=ItemDetail, status_code=201)
def create_item(body: ItemCreate, session: SessionDep):
    _check_refs(session, body.category_id, body.location_id)
    item_service.ensure_position_free(session, body.location_id, body.order)
    item = Item(**body.model_dump(mode="json", exclude={"acquired_on"}), acquired_on=body.acquired_on)
    session.add(item)
    _commit_or_position_conflict(session)
    return load_detail(session, item.id)


@router.post("/batch", response_model=ItemBatchOut, status_code=201)
def create_items_batch(body: ItemBatchIn, session: SessionDep):
    """Create N separate items from one description. With ``order_start`` and a
    location, copy n takes position ``order_start + n``. All or nothing."""
    template = body.item
    if session.get(Category, template.category_id) is None:
        raise HTTPException(422, "category does not exist")
    if body.order_start is not None and template.location_id is None:
        raise HTTPException(422, "positions need a location; choose one or omit order_start")
    if template.order is not None:
        raise HTTPException(422, "use order_start (not item.order) when creating several copies")

    location = None
    if template.location_id is not None:
        location = session.get(Location, template.location_id)
        if location is None:
            raise HTTPException(422, "location does not exist")
    if body.order_start is not None:
        wanted = range(body.order_start, body.order_start + body.copies)
        taken = dict(
            session.execute(
                select(Item.order, Item.inventory_code).where(Item.location_id == location.id, Item.order.in_(list(wanted)))
            ).all()
        )
        if taken:
            first = min(taken)
            raise HTTPException(
                409,
                f"{location.full_name} position {first} is already taken by {taken[first]}"
                + (f" (and {len(taken) - 1} more)" if len(taken) > 1 else "")
                + "; nothing was created",
            )

    fields = template.model_dump(mode="json", exclude={"acquired_on", "order"})
    created: list[Item] = []
    for index in range(body.copies):
        order = body.order_start + index if body.order_start is not None else None
        item = Item(**fields, acquired_on=template.acquired_on, order=order)
        session.add(item)
        created.append(item)
    _commit_or_position_conflict(session)
    return ItemBatchOut(
        created=[
            ItemBatchCreated(
                id=i.id, inventory_code=i.inventory_code, location_path=location.full_name if location else None, order=i.order
            )
            for i in created
        ]
    )


@router.get("/{item_id}", response_model=ItemDetail)
def get_item(item_id: int, session: SessionDep):
    return load_detail(session, item_id)


@router.patch("/{item_id}", response_model=ItemDetail)
def update_item(item_id: int, body: ItemUpdate, session: SessionDep):
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    changes = body.model_dump(exclude_unset=True)
    _check_refs(session, changes.get("category_id"), changes.get("location_id"))
    new_location = changes.get("location_id", item.location_id)
    if "location_id" in changes and changes["location_id"] != item.location_id and "order" not in changes:
        changes["order"] = None  # the old position belonged to the old location
    new_order = changes.get("order", item.order)
    if new_order is not None and new_location is None:
        raise HTTPException(422, "a position only makes sense inside a location; choose a location first")
    if "order" in changes or "location_id" in changes:
        item_service.ensure_position_free(session, new_location, new_order, item_id)
    for name, value in changes.items():
        setattr(item, name, value.value if hasattr(value, "value") else value)
    _commit_or_position_conflict(session)
    return load_detail(session, item_id)


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, session: SessionDep):
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    keys = []
    for storage_key, thumb_key in session.execute(
        select(Photo.storage_key, Photo.thumb_key).where(Photo.item_id == item_id)
    ):
        keys += [storage_key, thumb_key]
    # Queue object deletions in the same transaction as the row deletion, then
    # try them straight away; anything that fails is retried by storage-gc.
    queue_deletions(session, keys)
    session.delete(item)
    session.commit()
    if keys:
        try:
            process_pending_deletions(session, get_storage())
        except StorageError:
            pass
    return Response(status_code=204)
