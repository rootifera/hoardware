from datetime import date, datetime
from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from app.enums import Condition, FileKind, IdentificationConfidence, PhotoRole, TestStatus


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


COLUMN_FIELDS = ("chipset_manufacturer", "chipset", "revision")


class CategoryField(BaseModel):
    name: Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=60)]
    hint: Annotated[str, BeforeValidator(_strip), Field(max_length=120)] = ""
    # Stored in this item column instead of the item's specs.
    column: Literal["chipset_manufacturer", "chipset", "revision"] | None = None
    # Predefined values offered when filling the field in; any other value can still be typed.
    options: list[Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=80)]] = Field(default_factory=list)


def _check_fields(fields: list[CategoryField]) -> list[CategoryField]:
    if len(fields) > 40:
        raise ValueError("at most 40 fields per category")
    seen: set[str] = set()
    columns: set[str] = set()
    for f in fields:
        if f.name.lower() in seen:
            raise ValueError(f"field “{f.name}” is listed twice")
        seen.add(f.name.lower())
        if len(f.options) > 60:
            raise ValueError(f"field “{f.name}” has more than 60 options")
        if len({o.lower() for o in f.options}) != len(f.options):
            raise ValueError(f"field “{f.name}” lists an option twice")
        if f.column:
            if f.column in columns:
                raise ValueError(f"more than one field uses the {f.column} column")
            columns.add(f.column)
    return fields


class CategoryIn(BaseModel):
    name: Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=100)]
    sort_order: int = 0
    fields: list[CategoryField] = Field(default_factory=list)

    _fields = field_validator("fields")(_check_fields)


class CategoryUpdate(BaseModel):
    name: Annotated[Annotated[str, Field(min_length=1, max_length=100)] | None, BeforeValidator(_strip)] = None
    sort_order: int | None = None
    fields: list[CategoryField] | None = None

    @field_validator("fields")
    @classmethod
    def _valid_fields(cls, value):
        return None if value is None else _check_fields(value)


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    sort_order: int
    fields: list[CategoryField]


# --- locations ----------------------------------------------------------------


OptType = Annotated[Annotated[str, Field(max_length=100)] | None, BeforeValidator(_blank_to_none)]


class LocationIn(BaseModel):
    name: Annotated[str, BeforeValidator(_strip), Field(min_length=1, max_length=200)]
    parent_id: int | None = None
    notes: OptText = None
    type: OptType = None


class LocationUpdate(BaseModel):
    name: Annotated[Annotated[str, Field(min_length=1, max_length=200)] | None, BeforeValidator(_strip)] = None
    parent_id: int | None = None
    notes: OptText = None
    type: OptType = None


class LocationRef(BaseModel):
    id: int
    name: str


class LocationOut(BaseModel):
    id: int
    name: str
    parent_id: int | None
    notes: str | None
    type: str | None
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


class FileOut(BaseModel):
    id: int
    item_id: int
    filename: str
    kind: FileKind
    description: str | None
    content_type: str
    size_bytes: int
    created_at: datetime
    url: str


class FileUpdate(BaseModel):
    kind: FileKind | None = None
    description: OptText = None
    filename: Annotated[str, Field(min_length=1, max_length=255)] | None = None


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
    order: int | None
    thumbnail_url: str | None
    # Key specs of the matched reference model, if any (one line).
    spec_line: str | None = None
    created_at: datetime
    updated_at: datetime


class ReferenceSourceOut(BaseModel):
    key: str
    name: str
    url: str | None
    licence: str | None
    attribution: str | None


class ReferenceSummary(BaseModel):
    id: int
    kind: str
    manufacturer: str | None
    family: str | None
    model: str
    part_number: str | None
    revision: str | None
    source_key: str
    highlights: dict[str, Any]
    # The part number split the way it is printed: the order code, and the
    # short S-Spec code on the chip (Intel). part_number is the two together.
    order_code: str | None = None
    s_spec: str | None = None
    # A readable name built from the record, e.g. "Celeron 300MHz 128KiB L2".
    display_name: str
    # Key specs on one line, e.g. "300MHz · 66MHz bus · 128KiB L2 · SEPP Rev. 1".
    spec_line: str


class ReferenceDetail(ReferenceSummary):
    aliases: list[str]
    specs: dict[str, Any]
    provenance: dict[str, Any]
    source: ReferenceSourceOut
    source_version: str
    imported_at: datetime


class ReferenceCandidate(BaseModel):
    reference: ReferenceSummary
    # exact: the part number equals the model's part number or an alias.
    # token: shares an identifier (e.g. the S-Spec) with it.
    # text: only the name/words look alike. Always a candidate, never a fact.
    match_type: Literal["exact", "token", "text"]
    matched_on: list[str]
    manufacturer_matches: bool | None


class ReferenceSourceStatus(ReferenceSourceOut):
    models: int
    source_version: str | None
    last_import_at: datetime | None


class ReferenceMatchIn(BaseModel):
    reference_model_id: int
    # "candidate" = looks right but not verified; "confirmed" = the user checked.
    confidence: Literal["candidate", "confirmed"] = "confirmed"
    # Copy the record's specs onto the item (names it already has are kept).
    copy_specs: bool = True


class TestLogIn(BaseModel):
    __test__ = False

    status: TestStatus
    tested_on: date | None = None  # defaults to today
    notes: OptText = None


class TestLogOut(BaseModel):
    __test__ = False

    id: int
    tested_on: date
    status: TestStatus
    notes: str | None
    created_at: datetime


class ItemDetail(ItemSummary):
    last_tested_on: date | None = None  # date of the newest test-history entry
    test_notes: str | None
    notes: str | None
    acquired_on: date | None
    verified_on: date | None
    reference_model_id: int | None
    reference: ReferenceDetail | None = None
    attributes: dict[str, Any]
    photos: list[PhotoOut]
    files: list[FileOut] = []


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
    order: Annotated[int, Field(ge=0, le=1_000_000)] | None = None
    notes: OptText = None
    acquired_on: date | None = None
    verified_on: date | None = None
    # Set when the user picked a suggestion while adding the item.
    reference_model_id: int | None = None
    identification_confidence: IdentificationConfidence = IdentificationConfidence.UNIDENTIFIED
    attributes: dict[str, Any] = Field(default_factory=dict)


class ItemBatchIn(BaseModel):
    """Create several separate items from one description (each gets its own
    inventory code, condition and test status)."""

    item: ItemCreate
    copies: Annotated[int, Field(ge=1, le=200)] = 1
    # With a location chosen, copy n gets position order_start + n: ten CPUs
    # placed at positions 1-10 of one box. Omit for copies without positions.
    order_start: Annotated[int, Field(ge=0, le=1_000_000)] | None = None


class ItemBatchCreated(BaseModel):
    id: int
    inventory_code: str
    location_path: str | None
    order: int | None


class ItemBatchOut(BaseModel):
    created: list[ItemBatchCreated]


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
    order: Annotated[int, Field(ge=0, le=1_000_000)] | None = None
    notes: OptText = None
    acquired_on: date | None = None
    verified_on: date | None = None
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


# --- bulk actions ---------------------------------------------------------------

MAX_BULK_IDS = 10_000


class BulkFilter(BaseModel):
    """The inventory list filters, to select "everything matching" server-side."""

    q: Annotated[str | None, Field(max_length=200)] = None
    category_id: list[int] = Field(default_factory=list)
    manufacturer: Annotated[str | None, Field(max_length=300)] = None
    condition: list[Condition] = Field(default_factory=list)
    test_status: list[TestStatus] = Field(default_factory=list)
    identification_confidence: list[IdentificationConfidence] = Field(default_factory=list)
    location_id: int | None = None
    include_descendants: bool = True
    unassigned: bool = False
    never_verified: bool = False
    verified_before: date | None = None


class BulkSelection(BaseModel):
    """Either explicit ``ids`` or a ``filter`` (everything matching it), minus ``exclude_ids``."""

    ids: Annotated[list[int], Field(max_length=MAX_BULK_IDS)] | None = None
    filter: BulkFilter | None = None
    exclude_ids: Annotated[list[int], Field(max_length=MAX_BULK_IDS)] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exactly_one(self):
        if (self.ids is None) == (self.filter is None):
            raise ValueError("provide exactly one of ids or filter")
        return self


class BulkChanges(BaseModel):
    """Only the fields present are applied."""

    condition: Condition | None = None
    test_status: TestStatus | None = None
    test_notes: OptText = None  # null clears the notes
    category_id: int | None = None
    location_id: int | None = None  # null = no location
    verified: bool | None = None  # true = seen in place today, false = clear

    @field_validator("condition", "test_status", "category_id", "verified")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("this field cannot be null")
        return value


class BulkIn(BaseModel):
    selection: BulkSelection
    changes: BulkChanges
    # What happens to item positions when items move to another location:
    #   clear  - positions are dropped (default)
    #   keep   - each keeps its number; refused if any would clash
    #   append - numbered on after the highest position in the destination,
    #            keeping their relative order
    positions: Literal["clear", "keep", "append"] = "clear"
    dry_run: bool = False


class BulkOut(BaseModel):
    matched: int
    moved: int  # items whose location actually changed
    clashes: int  # positions that would collide (positions="keep")
    dry_run: bool


# --- CSV import -------------------------------------------------------------------


class ImportRowError(BaseModel):
    line: int
    message: str


class ImportReport(BaseModel):
    committed: bool  # rows were written
    blocked: bool  # commit requested but nothing written because of errors
    total_rows: int
    valid_rows: int
    error_rows: int
    imported: int
    errors: list[ImportRowError]
    errors_truncated: bool
    warnings: list[str]
    new_categories: list[str]  # would be (or were) created
    new_locations: list[str]
    preview: list[dict[str, Any]]
