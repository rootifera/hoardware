import dataclasses
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_session
from app.enums import Condition, IdentificationConfidence, TestStatus
from app.models import Category, Item, ItemFile, Location, Photo, ReferenceModel, TestLog
from app.pagination import apply_keyset, encode_cursor, decode_cursor
from app.routers.files import file_out
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
    ScanMatch,
)
from app.services import items as item_service
from app.services import reference as reference_service
from app.services.testlog import log_test
from app.services.items import ItemFilters
from app.services import stock as stock_service
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
    Item.is_stock,
    Item.quantity,
    Item.low_stock_level,
    Item.barcode,
    Item.created_at,
    Item.updated_at,
    Item.sort_name,
    # A few specs of the matched reference model, for the one-line summary.
    func.coalesce(Item.attributes["Speed"].astext, ReferenceModel.specs["Frequency(internal max/typ)"].astext).label("ref_freq"),
    func.coalesce(Item.attributes["Bus speed"].astext, ReferenceModel.specs["Bus speed"].astext).label("ref_bus"),
    func.coalesce(Item.attributes["L2 cache"].astext, ReferenceModel.specs["L2 cache"].astext).label("ref_l2"),
    func.coalesce(Item.attributes["Package"].astext, ReferenceModel.specs["Package"].astext).label("ref_package"),
    func.coalesce(Item.attributes["S-Spec"].astext, ReferenceModel.specs["S-Spec"].astext).label("ref_sspec"),
    # Graphics cards: chip, memory, bus, clock (the item's own values first).
    func.coalesce(Item.chipset, ReferenceModel.specs["Chipset"].astext).label("gpu_chipset"),
    func.coalesce(Item.attributes["Memory size"].astext, ReferenceModel.specs["Memory size"].astext).label("gpu_mem_size"),
    func.coalesce(Item.attributes["Memory type"].astext, ReferenceModel.specs["Memory type"].astext).label("gpu_mem_type"),
    func.coalesce(Item.attributes["Bus"].astext, ReferenceModel.specs["Bus"].astext).label("gpu_bus"),
    func.coalesce(Item.attributes["GPU clock"].astext, ReferenceModel.specs["GPU clock"].astext).label("gpu_clock"),
)
DETAIL_COLUMNS = SUMMARY_COLUMNS + (
    Item.test_notes,
    Item.notes,
    Item.acquired_on,
    Item.verified_on,
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
    never_verified: bool = False,
    verified_before: date | None = None,
    low_stock: bool = False,
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
        never_verified=never_verified,
        verified_before=verified_before,
        low_stock=low_stock,
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


def _spec_line(row) -> str | None:
    # Built from the item's own specs (copied from a match or typed in), so the
    # line is the item's information; an older match without copied specs still shows.
    cpu = reference_service.spec_line_of(row.ref_freq, row.ref_bus, row.ref_l2, row.ref_package, row.ref_sspec)
    if cpu:
        return cpu
    return (
        reference_service.gpu_spec_line_of(row.gpu_chipset, row.gpu_mem_size, row.gpu_mem_type, row.gpu_bus, row.gpu_clock)
        or None
    )


def _summary(row, thumbs: dict[int, int]) -> ItemSummary:
    photo_id = thumbs.get(row.id)
    return ItemSummary(
        **{name: getattr(row, name) for name in ItemSummary.model_fields if name not in ("thumbnail_url", "spec_line")},
        thumbnail_url=thumbnail_url(photo_id) if photo_id else None,
        spec_line=_spec_line(row),
    )


def _with_reference(stmt):
    """Join the matched reference model (one row per item at most)."""
    return stmt.outerjoin(ReferenceModel, ReferenceModel.id == Item.reference_model_id)


def load_detail(session: Session, item_id: int) -> ItemDetail:
    row = session.execute(_with_reference(item_service.base_select(*DETAIL_COLUMNS)).where(Item.id == item_id)).first()
    if row is None:
        raise HTTPException(404, "item not found")
    photos = session.scalars(
        select(Photo).where(Photo.item_id == item_id).order_by(Photo.sort_order, Photo.id)
    ).all()
    files = session.scalars(select(ItemFile).where(ItemFile.item_id == item_id).order_by(ItemFile.kind, ItemFile.filename, ItemFile.id)).all()
    fields = {
        name: getattr(row, name)
        for name in ItemDetail.model_fields
        if name not in ("thumbnail_url", "photos", "files", "reference", "last_tested_on", "spec_line")
    }
    reference = session.get(ReferenceModel, row.reference_model_id) if row.reference_model_id else None
    last_tested = session.scalar(select(func.max(TestLog.tested_on)).where(TestLog.item_id == item_id))
    return ItemDetail(
        **fields,
        last_tested_on=last_tested,
        spec_line=_spec_line(row),
        reference=reference_service.detail_of(session, reference) if reference else None,
        thumbnail_url=thumbnail_url(photos[0].id) if photos else None,
        photos=[photo_out(p) for p in photos],
        files=[file_out(f) for f in files],
    )


def _check_refs(
    session: Session, category_id: int | None, location_id: int | None, reference_model_id: int | None = None
) -> None:
    if category_id is not None and session.get(Category, category_id) is None:
        raise HTTPException(422, "category does not exist")
    if reference_model_id is not None and session.get(ReferenceModel, reference_model_id) is None:
        raise HTTPException(422, "reference model does not exist")
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

    stmt = item_service.apply_filters(session, _with_reference(item_service.base_select(*SUMMARY_COLUMNS)), filters)
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


@router.get("/facets", response_model=dict[str, int])
def test_status_facets(session: SessionDep, filters: FiltersDep):
    """How many of the items matching the other filters have each test status.
    The test-status filter itself is ignored so every option shows its count."""
    others = dataclasses.replace(filters, test_statuses=[])
    stmt = item_service.apply_filters(session, select(Item.test_status, func.count(Item.id)).group_by(Item.test_status), others)
    counts = dict(session.execute(stmt).all())
    return {status.value: counts.get(status.value, 0) for status in TestStatus}


@router.get("/lookup", response_model=list[ScanMatch])
def lookup_scan(session: SessionDep, code: Annotated[str, Query(min_length=1, max_length=100)]):
    """What a scan finds: the item with that inventory code, plus every item whose original barcode
    is that value (several can share one). Case does not matter."""
    value = code.strip()
    rows = session.execute(
        select(Item.id, Item.inventory_code, Item.manufacturer, Item.model, Item.barcode)
        .where(or_(Item.inventory_code == value.upper(), func.lower(Item.barcode) == value.lower()))
        .order_by(Item.id)
        .limit(20)
    ).all()
    return [ScanMatch(id=r[0], inventory_code=r[1], manufacturer=r[2], model=r[3], barcode=r[4]) for r in rows]


@router.get("/by-code/{inventory_code}", response_model=ItemDetail)
def get_item_by_code(inventory_code: str, session: SessionDep):
    item_id = session.scalar(select(Item.id).where(Item.inventory_code == inventory_code.upper()))
    if item_id is None:
        raise HTTPException(404, "item not found")
    return load_detail(session, item_id)


@router.post("", response_model=ItemDetail, status_code=201)
def create_item(body: ItemCreate, session: SessionDep):
    _check_refs(session, body.category_id, body.location_id, body.reference_model_id)
    item_service.ensure_position_free(session, body.location_id, body.order)
    fields = body.model_dump(mode="json", exclude={"acquired_on"})
    if body.reference_model_id is not None:
        # The match's specs become the item's own (what the user typed wins).
        ref = session.get(ReferenceModel, body.reference_model_id)
        fields["attributes"] = reference_service.merge_specs(fields["attributes"], reference_service.spec_snapshot(ref))
        for column, value in reference_service.column_values(ref).items():
            if not fields.get(column):
                fields[column] = value
    item = Item(**fields, acquired_on=body.acquired_on)
    session.add(item)
    session.flush()
    if item.test_status != TestStatus.UNTESTED.value:
        log_test(session, item, item.test_status, item.test_notes)
    if item.is_stock and item.quantity:
        stock_service.record(session, item.id, item.quantity, item.quantity, "Starting stock")
    _commit_or_position_conflict(session)
    return load_detail(session, item.id)


@router.post("/batch", response_model=ItemBatchOut, status_code=201)
def create_items_batch(body: ItemBatchIn, session: SessionDep):
    """Create N separate items from one description. With ``order_start`` and a
    location, copy n takes position ``order_start + n``. All or nothing."""
    template = body.item
    if session.get(Category, template.category_id) is None:
        raise HTTPException(422, "category does not exist")
    if template.reference_model_id is not None and session.get(ReferenceModel, template.reference_model_id) is None:
        raise HTTPException(422, "reference model does not exist")
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
    if template.reference_model_id is not None:
        ref = session.get(ReferenceModel, template.reference_model_id)
        fields["attributes"] = reference_service.merge_specs(fields["attributes"], reference_service.spec_snapshot(ref))
        for column, value in reference_service.column_values(ref).items():
            if not fields.get(column):
                fields[column] = value
    created: list[Item] = []
    for index in range(body.copies):
        order = body.order_start + index if body.order_start is not None else None
        item = Item(**fields, acquired_on=template.acquired_on, order=order)
        session.add(item)
        created.append(item)
    session.flush()
    for item in created:
        if item.test_status != TestStatus.UNTESTED.value:
            log_test(session, item, item.test_status, item.test_notes)
        if item.is_stock and item.quantity:
            stock_service.record(session, item.id, item.quantity, item.quantity, "Starting stock")
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
    previous_status = item.test_status
    was_stock, previous_quantity = item.is_stock, item.quantity
    for name, value in changes.items():
        setattr(item, name, value.value if hasattr(value, "value") else value)
    if item.test_status != previous_status:
        log_test(session, item, item.test_status, item.test_notes)
    # The history of a stock item also records changes made by editing the quantity itself.
    if item.is_stock and not was_stock and item.quantity:
        stock_service.record(session, item.id, item.quantity, item.quantity, "Started tracking as stock")
    elif item.is_stock and was_stock and item.quantity != previous_quantity:
        stock_service.record(session, item.id, item.quantity - previous_quantity, item.quantity, "Quantity edited")
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
    keys += session.scalars(select(ItemFile.storage_key).where(ItemFile.item_id == item_id)).all()
    queue_deletions(session, keys)
    session.delete(item)
    session.commit()
    if keys:
        try:
            process_pending_deletions(session, get_storage())
        except StorageError:
            pass
    return Response(status_code=204)
