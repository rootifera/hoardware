from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Item, StockLog
from app.schemas import StockChangeIn, StockLogOut, StockResultOut
from app.services import stock

router = APIRouter(prefix="/items", tags=["stock"])
SessionDep = Annotated[Session, Depends(get_session)]


@router.post("/{item_id}/stock", response_model=StockResultOut)
def change_stock(item_id: int, body: StockChangeIn, session: SessionDep):
    """Take out (negative change) or add (positive) stock; the quantity can never go below zero."""
    try:
        quantity, entry = stock.adjust(session, item_id, body.change, body.note)
    except stock.StockError as exc:
        session.rollback()
        raise HTTPException(exc.status, exc.message) from None
    session.commit()
    return StockResultOut(quantity=quantity, entry=StockLogOut.model_validate(entry))


@router.get("/{item_id}/stock-log", response_model=list[StockLogOut])
def stock_history(item_id: int, session: SessionDep, limit: Annotated[int, Query(ge=1, le=500)] = 100):
    if session.get(Item, item_id) is None:
        raise HTTPException(404, "item not found")
    return session.scalars(select(StockLog).where(StockLog.item_id == item_id).order_by(StockLog.id.desc()).limit(limit)).all()
