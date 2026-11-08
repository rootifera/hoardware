"""Stock items: one record that says how many you have, with a history of every change."""

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app.models import Item, StockLog


class StockError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


def record(session: Session, item_id: int, change: int, quantity_after: int, note: str | None) -> StockLog:
    entry = StockLog(item_id=item_id, change=change, quantity_after=quantity_after, note=note)
    session.add(entry)
    return entry


def adjust(session: Session, item_id: int, change: int, note: str | None) -> tuple[int, StockLog]:
    """Take out (negative) or add (positive). The new quantity is computed by the database in one
    statement, so two people taking from the same bin at once cannot both succeed on the last piece."""
    row = session.execute(
        update(Item)
        .where(Item.id == item_id, Item.is_stock.is_(True), Item.quantity + change >= 0)
        .values(quantity=Item.quantity + change, updated_at=text("now()"))
        .returning(Item.quantity)
    ).first()
    if row is None:
        current = session.execute(select(Item.is_stock, Item.quantity).where(Item.id == item_id)).first()
        if current is None:
            raise StockError(404, "item not found")
        if not current.is_stock:
            raise StockError(409, "this item is not tracked as stock")
        raise StockError(409, f"only {current.quantity:,} left: you cannot take out {-change:,}")
    entry = record(session, item_id, change, row[0], note)
    session.flush()
    return row[0], entry
