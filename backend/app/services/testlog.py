"""Test history: every change of an item's test status leaves an entry."""

from datetime import date

from sqlalchemy.orm import Session

from app.models import Item, TestLog


def log_test(session: Session, item: Item, status: str, notes: str | None, tested_on: date | None = None) -> TestLog:
    """Add a history entry for ``item`` (the item must already have an id)."""
    entry = TestLog(item_id=item.id, status=status, notes=notes, **({"tested_on": tested_on} if tested_on else {}))
    session.add(entry)
    return entry
