from datetime import date, datetime
from typing import Annotated, Any, Generic, TypeVar

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from app.enums import Condition, IdentificationConfidence, PhotoRole, TestStatus


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


# Optional text: surrounding whitespace is trimmed and "" becomes null.
OptText = Annotated[Annotated[str, Field(max_length=10_000)] | None, BeforeValidator(_blank_to_none)]
OptShort = Annotated[Annotated[str, Field(max_length=300)] | None, BeforeValidator(_blank_to_none)]
ReqShort = Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=300)]

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None
    total: int | None = None


# --- categories ---------------------------------------------------------------


class CategoryIn(BaseModel):
    name: Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=100)]
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    name: Annotated[Annotated[str, Field(min_length=1, max_length=100)] | None, BeforeValidator(_strip)] = None
    sort_order: int | None = None


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    sort_order: int


# --- locations ----------------------------------------------------------------


class LocationIn(BaseModel):
    name: Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=200)]
    parent_id: int | None = None
    notes: OptText = None


class LocationUpdate(BaseModel):
    name: Annotated[Annotated[str, Field(min_length=1, max_length=200)] | None, BeforeValidator(_strip)] = None
    parent_id: int | None = None
    notes: OptText = None


class LocationRef(BaseModel):
    id: int
    name: str


class LocationOut(BaseModel):
    id: int
    name: str
    parent_id: int | None
    notes: str | None
    full_name: str
    has_children: bool


class LocationDetail(LocationOut):
    ancestors: list[LocationRef]


# --- photos -------------------------------------------------------------------


class PhotoOut(BaseModel):
    id: int
    item_id: int
    role: PhotoRole
    caption: str | None
    sort_order: int
    content_type: str
    size_bytes: int
    created_at: datetime
    url: str
    thumbnail_url: str


class PhotoUpdate(BaseModel):
    role: PhotoRole | None = None
    caption: OptText = None
    sort_order: int | None = None


# --- items --------------------------------------------------------------------


class ItemSummary(BaseModel):
    id: int
    inventory_code: str
    category_id: int
    category_name: str
    manufacturer: str | None
    model: str
    part_number: str | None
    revision: str | None
    chipset_manufacturer: str | None
    chipset: str | None
    condition: Condition
    test_status: TestStatus
    identification_confidence: IdentificationConfidence
    location_id: int | None
    location_path: str | None
    thumbnail_url: str | None
    created_at: datetime
    updated_at: datetime


class ItemDetail(ItemSummary):
    test_notes: str | None
    notes: str | None
    acquired_on: date | None
    reference_model_id: int | None
    attributes: dict[str, Any]
    photos: list[PhotoOut]


class _ItemFields(BaseModel):
    @field_validator("attributes", check_fields=False)
    @classmethod
    def _attributes_size(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and len(str(value)) > 64_000:
            raise ValueError("attributes are too large")
        return value


class ItemCreate(_ItemFields):
    category_id: int
    model: ReqShort
    manufacturer: OptShort = None
    part_number: OptShort = None
    revision: OptShort = None
    chipset_manufacturer: OptShort = None
    chipset: OptShort = None
    condition: Condition = Condition.UNKNOWN
    test_status: TestStatus = TestStatus.UNTESTED
    test_notes: OptText = None
    location_id: int | None = None
    notes: OptText = None
    acquired_on: date | None = None
    identification_confidence: IdentificationConfidence = IdentificationConfidence.UNIDENTIFIED
    attributes: dict[str, Any] = Field(default_factory=dict)


class ItemUpdate(_ItemFields):
    """PATCH body: only fields present in the request are changed."""

    category_id: int | None = None
    model: Annotated[Annotated[str, Field(min_length=1, max_length=300)] | None, BeforeValidator(_strip)] = None
    manufacturer: OptShort = None
    part_number: OptShort = None
    revision: OptShort = None
    chipset_manufacturer: OptShort = None
    chipset: OptShort = None
    condition: Condition | None = None
    test_status: TestStatus | None = None
    test_notes: OptText = None
    location_id: int | None = None
    notes: OptText = None
    acquired_on: date | None = None
    identification_confidence: IdentificationConfidence | None = None
    attributes: dict[str, Any] | None = None

    # Columns that are NOT NULL: an explicit null is rejected instead of
    # failing later in the database.
    @field_validator("category_id", "model", "condition", "test_status", "identification_confidence", "attributes")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value
