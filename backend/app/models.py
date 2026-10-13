"""ORM models.

The Alembic migrations are hand-written (generated columns, trigram indexes,
sequences) and are the source of truth for indexes; keep this file in step.
"""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Integer,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.enums import Condition, IdentificationConfidence, PhotoRole, TestStatus, sql_in


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Location(Base):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="RESTRICT"))
    notes: Mapped[str | None] = mapped_column(Text)
    # Materialised ancestry as "/1/5/9/" (ids, ending with this row's own id)
    # and the human-readable "Workshop > Shelf 2 > Box 3". Both are maintained
    # by app.services.locations.
    path: Mapped[str] = mapped_column(Text, server_default="")
    full_name: Mapped[str] = mapped_column(Text, server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Item(Base):
    __tablename__ = "items"
    __table_args__ = (
        CheckConstraint(f"condition IN ({sql_in(Condition)})", name="ck_items_condition"),
        CheckConstraint(f"test_status IN ({sql_in(TestStatus)})", name="ck_items_test_status"),
        CheckConstraint(
            f"identification_confidence IN ({sql_in(IdentificationConfidence)})",
            name="ck_items_identification_confidence",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    inventory_code: Mapped[str] = mapped_column(
        Text,
        unique=True,
        server_default=text("'HW-' || lpad(nextval('inventory_code_seq')::text, 6, '0')"),
    )
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="RESTRICT"))
    manufacturer: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    part_number: Mapped[str | None] = mapped_column(Text)
    revision: Mapped[str | None] = mapped_column(Text)
    # GPU chipset maker/chipset, distinct from the board maker/model above.
    chipset_manufacturer: Mapped[str | None] = mapped_column(Text)
    chipset: Mapped[str | None] = mapped_column(Text)
    condition: Mapped[str] = mapped_column(Text, server_default=Condition.UNKNOWN.value)
    test_status: Mapped[str] = mapped_column(Text, server_default=TestStatus.UNTESTED.value)
    test_notes: Mapped[str | None] = mapped_column(Text)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="RESTRICT"))
    notes: Mapped[str | None] = mapped_column(Text)
    acquired_on: Mapped[date | None] = mapped_column(Date)
    # FK to reference_models is added in Phase 2.
    reference_model_id: Mapped[int | None] = mapped_column(BigInteger)
    identification_confidence: Mapped[str] = mapped_column(
        Text, server_default=IdentificationConfidence.UNIDENTIFIED.value
    )
    attributes: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    search_text: Mapped[str] = mapped_column(
        Text,
        Computed(
            "lower(inventory_code || ' ' || coalesce(manufacturer, '') || ' ' || model"
            " || ' ' || coalesce(part_number, '') || ' ' || coalesce(revision, '')"
            " || ' ' || coalesce(chipset_manufacturer, '') || ' ' || coalesce(chipset, '')"
            " || ' ' || coalesce(notes, ''))",
            persisted=True,
        ),
    )
    sort_name: Mapped[str] = mapped_column(
        Text,
        Computed("lower(coalesce(manufacturer, '') || ' ' || model)", persisted=True),
    )

    photos: Mapped[list["Photo"]] = relationship(
        order_by="Photo.sort_order, Photo.id", cascade="all, delete-orphan", passive_deletes=True
    )


class Photo(Base):
    __tablename__ = "photos"
    __table_args__ = (
        CheckConstraint(f"role IN ({sql_in(PhotoRole)})", name="ck_photos_role"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    storage_key: Mapped[str] = mapped_column(Text, unique=True)
    thumb_key: Mapped[str] = mapped_column(Text, unique=True)
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    original_filename: Mapped[str | None] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text, server_default=PhotoRole.OTHER.value)
    caption: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PendingDeletion(Base):
    """Storage keys whose object deletion has not been confirmed yet.

    Rows are inserted in the same transaction that removes the photo rows and
    deleted once the object is gone, so a storage outage never orphans files
    silently. `python -m app.cli storage-gc` retries them.
    """

    __tablename__ = "pending_deletions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    storage_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
