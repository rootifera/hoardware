from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Item, TestLog
from app.schemas import TestLogIn, TestLogOut
from app.services.testlog import log_test

router = APIRouter(prefix="/items/{item_id}/test-log", tags=["test history"])
SessionDep = Annotated[Session, Depends(get_session)]


def _item_or_404(session: Session, item_id: int) -> Item:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "item not found")
    return item


@router.get("", response_model=list[TestLogOut])
def list_test_log(item_id: int, session: SessionDep):
    """Newest first. (A single item has a short history, so no pagination.)"""
    _item_or_404(session, item_id)
    return session.scalars(
        select(TestLog).where(TestLog.item_id == item_id).order_by(TestLog.tested_on.desc(), TestLog.id.desc()).limit(500)
    ).all()


@router.post("", response_model=TestLogOut, status_code=201)
def add_test_log(item_id: int, body: TestLogIn, session: SessionDep):
    """Record a test. The item's current test status becomes the logged one, and
    its test notes are replaced when notes are given."""
    item = _item_or_404(session, item_id)
    item.test_status = body.status.value
    if body.notes is not None:
        item.test_notes = body.notes
    entry = log_test(session, item, body.status.value, body.notes, body.tested_on)
    session.commit()
    session.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_test_log_entry(item_id: int, entry_id: int, session: SessionDep):
    """Remove a mistaken entry. The item's current status is left as it is."""
    entry = session.scalar(select(TestLog).where(TestLog.id == entry_id, TestLog.item_id == item_id))
    if entry is None:
        raise HTTPException(404, "entry not found")
    session.delete(entry)
    session.commit()
    return Response(status_code=204)
