"""Apply one change to many items at once.

The selection is resolved to a list of ids first (so a filter selection stays
stable while its own fields are being changed), then everything is applied in
one transaction. Ids are passed as a single array parameter rather than one
parameter each, so selecting tens of thousands of items stays cheap.
"""

from fastapi import HTTPException
from sqlalchemy import BigInteger, any_, bindparam, func, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session

from app.models import Category, Item, Location
from app.schemas import BulkFilter, BulkIn, BulkOut, BulkSelection
from app.services import items as item_service
from app.services import locations as location_service
from app.services.items import ItemFilters

MAX_SELECTED = 100_000


def _filters(f: BulkFilter) -> ItemFilters:
    return ItemFilters(
        q=f.q.strip() if f.q else None,
        category_ids=f.category_id,
        manufacturer=f.manufacturer,
        conditions=f.condition,
        test_statuses=f.test_status,
        confidences=f.identification_confidence,
        location_id=f.location_id,
        include_descendants=f.include_descendants,
        unassigned=f.unassigned,
        never_verified=f.never_verified,
        verified_before=f.verified_before,
    )


def resolve_ids(session: Session, selection: BulkSelection) -> list[int]:
    if selection.ids is not None:
        stmt = select(Item.id).where(Item.id.in_(selection.ids))
    else:
        stmt = item_service.apply_filters(session, item_service.base_select(Item.id), _filters(selection.filter))
    if selection.exclude_ids:
        stmt = stmt.where(Item.id.not_in(selection.exclude_ids))
    ids = list(session.scalars(stmt.order_by(Item.id).limit(MAX_SELECTED + 1)))
    if len(ids) > MAX_SELECTED:
        raise HTTPException(422, f"too many items selected (limit {MAX_SELECTED:,}); narrow the filter")
    return ids


def _ids_param(ids: list[int]):
    return bindparam("ids", ids, type_=ARRAY(BigInteger))


def _clashes(session: Session, ids: list[int], destination: int) -> int:
    """Positions that would collide if the moving items kept their numbers."""
    moving = 'FROM items WHERE id = ANY(:ids) AND location_id IS DISTINCT FROM :dest AND "order" IS NOT NULL'
    with_destination = session.scalar(
        text(
            f'SELECT count(*) {moving} AND EXISTS ('
            ' SELECT 1 FROM items d WHERE d.location_id = :dest AND d."order" = items."order")'
        ).bindparams(_ids_param(ids), dest=destination)
    )
    among_themselves = session.scalar(
        text(f'SELECT count(*) FROM (SELECT 1 {moving} GROUP BY "order" HAVING count(*) > 1) x').bindparams(
            _ids_param(ids), dest=destination
        )
    )
    return int(with_destination or 0) + int(among_themselves or 0)


def apply_bulk(session: Session, body: BulkIn) -> BulkOut:
    changes = body.changes.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(422, "no changes given")
    if "category_id" in changes and session.get(Category, changes["category_id"]) is None:
        raise HTTPException(422, "category does not exist")
    destination = changes.get("location_id")
    if "location_id" in changes and destination is not None and session.get(Location, destination) is None:
        raise HTTPException(422, "location does not exist")

    # Same lock as other structural changes: keeps concurrent bulk moves from
    # picking the same positions.
    location_service.lock_structure(session)
    ids = resolve_ids(session, body.selection)
    result = BulkOut(matched=len(ids), moved=0, clashes=0, dry_run=body.dry_run)
    if not ids:
        session.rollback()
        return result

    moves = "location_id" in changes
    if moves:
        if destination is None:
            result.moved = session.scalar(
                select(func.count()).select_from(Item).where(Item.id == any_(_ids_param(ids)), Item.location_id.is_not(None))
            ) or 0
        else:
            result.moved = session.scalar(
                select(func.count()).select_from(Item).where(
                    Item.id == any_(_ids_param(ids)), Item.location_id.is_distinct_from(destination)
                )
            ) or 0
            if body.positions == "keep":
                result.clashes = _clashes(session, ids, destination)
                if result.clashes and not body.dry_run:
                    session.rollback()
                    raise HTTPException(
                        409,
                        f"{result.clashes} position(s) would clash in the destination; "
                        "choose 'clear' or 'append' instead, or move fewer items",
                    )

    if body.dry_run:
        session.rollback()
        return result

    # 0) test history: one entry per item whose status actually changes
    if "test_status" in changes:
        status = changes["test_status"].value if hasattr(changes["test_status"], "value") else changes["test_status"]
        session.execute(
            text(
                "INSERT INTO test_log (item_id, status, notes) SELECT id, :status,"
                " CASE WHEN :set_notes THEN CAST(:notes AS text) ELSE test_notes END"
                " FROM items WHERE id = ANY(:ids) AND test_status IS DISTINCT FROM :status"
            ).bindparams(_ids_param(ids), status=status, set_notes="test_notes" in changes, notes=changes.get("test_notes"))
        )

    # 1) plain column changes for everything selected
    values = {k: (v.value if hasattr(v, "value") else v) for k, v in changes.items() if k not in ("location_id", "verified")}
    if "verified" in changes:
        values["verified_on"] = func.current_date() if changes["verified"] else None
    if values:
        session.execute(
            update(Item).where(Item.id == any_(_ids_param(ids))).values(**values, updated_at=func.now()),
            execution_options={"synchronize_session": False},
        )

    # 2) the move, with its position rule
    if moves and result.moved:
        if destination is None:
            session.execute(
                text('UPDATE items SET location_id = NULL, "order" = NULL, updated_at = now() WHERE id = ANY(:ids) AND location_id IS NOT NULL').bindparams(_ids_param(ids))
            )
        elif body.positions == "append":
            highest = session.scalar(select(func.max(Item.order)).where(Item.location_id == destination)) or 0
            session.execute(
                text(
                    'UPDATE items SET location_id = :dest, "order" = :base + s.rn, updated_at = now() FROM ('
                    ' SELECT id, row_number() OVER (ORDER BY "order" NULLS LAST, id) AS rn FROM items'
                    ' WHERE id = ANY(:ids) AND location_id IS DISTINCT FROM :dest) s WHERE items.id = s.id'
                ).bindparams(_ids_param(ids), dest=destination, base=highest)
            )
        elif body.positions == "keep":
            session.execute(
                text('UPDATE items SET location_id = :dest, updated_at = now() WHERE id = ANY(:ids) AND location_id IS DISTINCT FROM :dest').bindparams(
                    _ids_param(ids), dest=destination
                )
            )
        else:  # clear
            session.execute(
                text('UPDATE items SET location_id = :dest, "order" = NULL, updated_at = now() WHERE id = ANY(:ids) AND location_id IS DISTINCT FROM :dest').bindparams(
                    _ids_param(ids), dest=destination
                )
            )
    session.commit()
    return result
