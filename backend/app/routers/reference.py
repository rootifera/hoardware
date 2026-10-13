from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Item, ReferenceModel
from app.pagination import apply_keyset, decode_cursor, encode_cursor
from app.routers.items import load_detail
from app.schemas import (
    ItemDetail,
    Page,
    ReferenceCandidate,
    ReferenceDetail,
    ReferenceMatchIn,
    ReferenceSourceStatus,
    ReferenceSummary,
)
from app.services import reference as service
from app.services.items import _like_escape

router = APIRouter(tags=["reference"])
SessionDep = Annotated[Session, Depends(get_session)]


@router.get("/reference-sources", response_model=list[ReferenceSourceStatus])
def list_sources(session: SessionDep):
    """Datasets that have been imported (empty when none are loaded)."""
    return service.source_statuses(session)


@router.get("/reference-models", response_model=Page[ReferenceSummary])
def search_reference_models(
    session: SessionDep,
    q: Annotated[str | None, Query(max_length=200)] = None,
    kind: Annotated[str | None, Query(max_length=40)] = None,
    source: Annotated[str | None, Query(max_length=40)] = None,
    manufacturer: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: str | None = None,
):
    """Search imported reference models. Empty when no dataset is imported."""
    stmt = select(ReferenceModel)
    for token in (q or "").lower().split()[:8]:
        stmt = stmt.where(ReferenceModel.search_text.like(f"%{_like_escape(token)}%", escape="\\"))
    if kind:
        stmt = stmt.where(ReferenceModel.kind == kind)
    if source:
        stmt = stmt.where(ReferenceModel.source_key == source)
    if manufacturer:
        stmt = stmt.where(ReferenceModel.manufacturer.ilike(_like_escape(manufacturer.strip()), escape="\\"))
    if cursor:
        key, _ = decode_cursor(cursor)
        if not isinstance(key, str):
            raise HTTPException(422, "invalid cursor")
    stmt = apply_keyset(
        stmt, ReferenceModel.sort_name, ReferenceModel.id, cursor=cursor, descending=False, limit=limit
    )
    rows = list(session.scalars(stmt))
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = encode_cursor(rows[-1].sort_name, rows[-1].id) if has_more else None
    return Page[ReferenceSummary](items=[service.summary_of(r) for r in rows], next_cursor=next_cursor)


@router.get("/reference-models/{reference_id}", response_model=ReferenceDetail)
def get_reference_model(reference_id: int, session: SessionDep):
    ref = session.get(ReferenceModel, reference_id)
    if ref is None:
        raise HTTPException(404, "reference model not found")
    return service.detail_of(session, ref)


@router.get("/reference-suggestions", response_model=list[ReferenceCandidate])
def reference_suggestions(
    session: SessionDep,
    q: Annotated[str, Query(min_length=2, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=20)] = 6,
):
    """Suggestions for text typed while adding an item: a part number, an
    S-Spec or ordering code, or a name. Empty when no dataset is imported."""
    return service.find_candidates_for(session, part_number=q, model=q, limit=limit)


@router.get("/items/{item_id}/reference-candidates", response_model=list[ReferenceCandidate])
def reference_candidates(item_id: int, session: SessionDep, limit: Annotated[int, Query(ge=1, le=50)] = 15):
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    return service.find_candidates(session, item, limit)


@router.post("/items/{item_id}/reference-match", response_model=ItemDetail)
def link_reference(item_id: int, body: ReferenceMatchIn, session: SessionDep):
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    ref = session.get(ReferenceModel, body.reference_model_id)
    if ref is None:
        raise HTTPException(422, "reference model does not exist")
    if body.copy_specs:
        item.attributes = service.merge_specs(item.attributes or {}, service.spec_snapshot(ref))
        # An item saved before the S-Spec was its own field has the combined
        # "order code + S-Spec" as its part number: keep just the order code.
        order_code = service.order_code_of(ref.part_number, ref.specs.get("S-Spec"))
        if order_code and ref.specs.get("S-Spec") and (item.part_number or "").strip().lower() == (ref.part_number or "").lower():
            item.part_number = order_code
    item.reference_model_id = body.reference_model_id
    item.identification_confidence = body.confidence
    session.commit()
    return load_detail(session, item_id)


@router.delete("/items/{item_id}/reference-match", response_model=ItemDetail)
def unlink_reference(item_id: int, session: SessionDep):
    """Unlink a (bad) match. The item keeps its own fields and specs, including
    any copied from the match; only the link and the confirmation go."""
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    item.reference_model_id = None
    item.identification_confidence = "unidentified"
    session.commit()
    return load_detail(session, item_id)
