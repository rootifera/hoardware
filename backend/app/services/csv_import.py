"""CSV import: validate every row first, then (optionally) insert.

Preview and commit share one code path, so what the preview promises is what
the commit does. Nothing is written unless the file is clean, or the caller
explicitly chooses to skip the bad rows.

The columns are the ones the export writes, plus friendly aliases (``name`` for
``model``, ``p/n`` for ``part_number``…). ``inventory_code`` is ignored: every
imported row becomes a new item with a freshly assigned code.
"""

import csv
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date

from fastapi import HTTPException
from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from app.enums import GONE_STATUSES, Condition, IdentificationConfidence, ItemStatus, TestStatus
from app.models import Category, Item, Location, StockLog
from app.schemas import ImportReport, ImportRowError
from app.services import locations as location_service

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 50_000
MAX_REPORTED_ERRORS = 200
PREVIEW_ROWS = 10
BATCH = 1000
SEPARATOR = ">"

ALIASES: dict[str, set[str]] = {
    "category": {"category", "categories", "cat"},
    "model": {"model", "name", "description", "title", "item"},
    "manufacturer": {"manufacturer", "maker", "brand", "make"},
    "part_number": {"part_number", "part", "pn", "p_n", "sku", "part_no"},
    "revision": {"revision", "rev"},
    "chipset_manufacturer": {"chipset_manufacturer", "chipset_maker"},
    "chipset": {"chipset"},
    "condition": {"condition"},
    "test_status": {"test_status", "status", "tested"},
    "test_notes": {"test_notes"},
    "location": {"location", "location_path", "where"},
    "position": {"position", "order", "slot", "pos"},
    "quantity": {"quantity", "qty", "count", "amount", "number"},
    "barcode": {"barcode", "ean", "upc", "gtin"},
    "item_status": {"item_status", "lifecycle", "state"},
    "status_note": {"status_note"},
    "price": {"price", "price_paid", "cost"},
    "source": {"source", "bought_from", "supplier", "vendor"},
    "notes": {"notes", "note", "comments", "comment"},
    "acquired_on": {"acquired_on", "acquired", "date_acquired", "purchase_date"},
    "verified_on": {"verified_on", "verified", "last_verified"},
    "specs": {"specs", "attributes", "specifications"},
    "identification_confidence": {"identification_confidence", "identification", "confidence"},
}
IGNORED = {"inventory_code", "id", "created_at", "updated_at"}
_LOOKUP = {alias: canonical for canonical, aliases in ALIASES.items() for alias in aliases}
_NONALNUM = re.compile(r"[^a-z0-9]+")

TEMPLATE_HEADER = [
    "category", "manufacturer", "model", "part_number", "revision", "chipset_manufacturer", "chipset",
    "condition", "test_status", "test_notes", "location", "position", "quantity", "barcode", "item_status", "status_note", "price", "source", "notes", "acquired_on",
    "verified_on", "identification_confidence", "specs",
]


def _norm_header(value: str) -> str:
    return _NONALNUM.sub("_", value.strip().lower()).strip("_")


def _enum_lookup(enum) -> dict[str, str]:
    return {m.value.lower(): m.value for m in enum}


_CONDITIONS = _enum_lookup(Condition)
_TEST_STATUSES = _enum_lookup(TestStatus)
_CONFIDENCES = _enum_lookup(IdentificationConfidence)
# "installed" is not importable: it needs a build to be installed in.
_ITEM_STATUSES = {
    **{s.value: s.value for s in ItemStatus if s != ItemStatus.INSTALLED},
    "in collection": "in_collection",
    "wishlist": "wanted",
}


@dataclass
class Row:
    line: int
    values: dict[str, str]
    errors: list[str] = field(default_factory=list)
    category_name: str = ""
    location_parts: list[str] | None = None
    location_id: int | None = None  # existing location
    position: int | None = None
    fields: dict = field(default_factory=dict)


def decode(content: bytes, warnings: list[str]) -> str:
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        warnings.append("The file is not UTF-8; it was read as Windows-1252 (Excel's default). Check accented characters.")
        return content.decode("cp1252", errors="replace")


def read_rows(content: bytes, warnings: list[str]) -> list[Row]:
    if len(content) > MAX_BYTES:
        raise HTTPException(413, f"the file is larger than {MAX_BYTES // (1024 * 1024)} MB")
    text = decode(content, warnings)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text, newline=""), dialect)
    try:
        header = next(reader)
    except StopIteration:
        raise HTTPException(422, "the file is empty") from None
    except csv.Error as exc:
        raise HTTPException(422, f"the file is not valid CSV: {exc}") from None

    columns: dict[int, str] = {}
    unknown: list[str] = []
    for position, raw in enumerate(header):
        key = _norm_header(raw)
        if not key:
            continue
        if key in IGNORED:
            if key == "inventory_code":
                warnings.append("inventory_code is ignored: every imported row becomes a new item with a new code.")
            continue
        canonical = _LOOKUP.get(key)
        if canonical is None:
            unknown.append(raw.strip())
        elif canonical in columns.values():
            warnings.append(f"Column “{raw.strip()}” duplicates another {canonical} column and is ignored.")
        else:
            columns[position] = canonical
    missing = [c for c in ("category", "model") if c not in columns.values()]
    if missing:
        raise HTTPException(422, f"required column(s) missing: {', '.join(missing)} (found: {', '.join(h.strip() for h in header if h.strip())})")
    if unknown:
        warnings.append(f"Ignored unknown column(s): {', '.join(unknown)}.")

    rows: list[Row] = []
    try:
        for raw_row in reader:
            if not any(cell.strip() for cell in raw_row):
                continue
            if len(rows) >= MAX_ROWS:
                raise HTTPException(422, f"more than {MAX_ROWS:,} rows; split the file")
            values = {name: _unprotect(raw_row[i].strip() if i < len(raw_row) else "") for i, name in columns.items()}
            rows.append(Row(line=reader.line_num, values=values))
    except csv.Error as exc:
        # e.g. a single cell larger than the parser's field limit, or a stray quote
        raise HTTPException(422, f"the file is not valid CSV near line {reader.line_num}: {exc}") from None
    return rows


def _unprotect(value: str) -> str:
    """The export prefixes cells starting with = + - @ with an apostrophe so
    spreadsheets do not run them as formulas; undo that on the way back in."""
    return value[1:] if value[:1] == "'" and value[1:2] in ("=", "+", "-", "@") else value


def _split_location(value: str) -> list[str]:
    return [part.strip() for part in value.split(SEPARATOR) if part.strip()]


def _validate_row(row: Row) -> None:
    v = row.values
    row.category_name = v.get("category", "")
    if not row.category_name:
        row.errors.append("category is required")
    model = v.get("model", "")
    if not model:
        row.errors.append("model is required")
    elif len(model) > 300:
        row.errors.append("model is longer than 300 characters")
    for name in ("manufacturer", "part_number", "revision", "chipset_manufacturer", "chipset"):
        if len(v.get(name, "")) > 300:
            row.errors.append(f"{name} is longer than 300 characters")

    def choose(name: str, table: dict[str, str], default: str) -> str:
        raw = v.get(name, "")
        if not raw:
            return default
        found = table.get(raw.lower())
        if found is None:
            row.errors.append(f"{name} “{raw}” is not valid (use one of: {', '.join(table.values())})")
            return default
        return found

    condition = choose("condition", _CONDITIONS, Condition.UNKNOWN.value)
    test_status = choose("test_status", _TEST_STATUSES, TestStatus.UNTESTED.value)
    confidence = choose("identification_confidence", _CONFIDENCES, IdentificationConfidence.UNIDENTIFIED.value)

    acquired: date | None = None
    if v.get("acquired_on"):
        try:
            acquired = date.fromisoformat(v["acquired_on"])
        except ValueError:
            row.errors.append(f"acquired_on “{v['acquired_on']}” is not a date (use YYYY-MM-DD)")

    verified: date | None = None
    if v.get("verified_on"):
        try:
            verified = date.fromisoformat(v["verified_on"])
        except ValueError:
            row.errors.append(f"verified_on “{v['verified_on']}” is not a date (use YYYY-MM-DD)")

    status = choose("item_status", _ITEM_STATUSES, ItemStatus.IN_COLLECTION.value)
    price: float | None = None
    if v.get("price"):
        try:
            price = round(float(v["price"].replace(",", "").lstrip("$£€ ")), 2)
            if not 0 <= price <= 1_000_000_000:
                raise ValueError
        except ValueError:
            row.errors.append(f"price “{v['price']}” must be a number, 0 or more")
            price = None
    if len(v.get("source", "")) > 300 or len(v.get("status_note", "")) > 300:
        row.errors.append("source and status_note must be 300 characters at most")

    specs: dict = {}
    if v.get("specs"):
        try:
            parsed = json.loads(v["specs"])
            if not isinstance(parsed, dict):
                raise ValueError
            specs = parsed
        except ValueError:
            row.errors.append('specs must be a JSON object such as {"Socket": "7"}')

    barcode = v.get("barcode") or None
    if barcode and (len(barcode) > 100 or not all(32 <= ord(ch) < 127 for ch in barcode)):
        row.errors.append(f"barcode “{barcode[:30]}” must be 100 printable characters at most")
        barcode = None
    quantity = 1
    is_stock = bool(v.get("quantity"))
    if v.get("quantity"):
        try:
            quantity = int(v["quantity"])
            if not 0 <= quantity <= 1_000_000_000:
                raise ValueError
        except ValueError:
            row.errors.append(f"quantity “{v['quantity']}” must be a whole number from 0 to 1,000,000,000")
            quantity = 1

    row.location_parts = _split_location(v["location"]) if v.get("location") else None
    if v.get("position"):
        try:
            row.position = int(v["position"])
            if not 0 <= row.position <= 1_000_000:
                raise ValueError
        except ValueError:
            row.errors.append(f"position “{v['position']}” must be a whole number from 0 to 1,000,000")
            row.position = None
        else:
            if row.location_parts is None:
                row.errors.append("a position needs a location")

    if status in {s.value for s in GONE_STATUSES}:
        row.location_parts = None  # sold, scrapped and wishlist items have no place on a shelf
        row.position = None
    row.fields = {
        "status": status,
        "status_note": v.get("status_note") or None,
        "price": price,
        "source": v.get("source") or None,
        "model": model,
        "manufacturer": v.get("manufacturer") or None,
        "part_number": v.get("part_number") or None,
        "revision": v.get("revision") or None,
        "chipset_manufacturer": v.get("chipset_manufacturer") or None,
        "chipset": v.get("chipset") or None,
        "condition": condition,
        "test_status": test_status,
        "test_notes": v.get("test_notes") or None,
        "notes": v.get("notes") or None,
        "acquired_on": acquired,
        "verified_on": verified,
        "attributes": specs,
        "identification_confidence": confidence,
        "order": row.position,
        "quantity": quantity,
        "is_stock": is_stock,
        "barcode": barcode,
    }


def run_import(
    session: Session,
    content: bytes,
    *,
    commit: bool,
    skip_invalid: bool = False,
    create_categories: bool = False,
    create_locations: bool = False,
) -> ImportReport:
    warnings: list[str] = []
    rows = read_rows(content, warnings)
    for row in rows:
        _validate_row(row)

    # --- categories (case-insensitive) ------------------------------------
    categories = {name.lower(): cid for cid, name in session.execute(select(Category.id, Category.name))}
    new_categories: dict[str, str] = {}  # lower -> display name
    for row in rows:
        if row.category_name and row.category_name.lower() not in categories:
            if create_categories:
                new_categories.setdefault(row.category_name.lower(), row.category_name)
            else:
                row.errors.append(f"unknown category “{row.category_name}” (create it first, or tick “create missing categories”)")

    # --- locations: match existing full paths ------------------------------
    wanted = {" > ".join(r.location_parts).lower() for r in rows if r.location_parts}
    existing: dict[str, list[int]] = {}
    names = sorted(wanted)
    for start in range(0, len(names), 1000):
        chunk = names[start : start + 1000]
        for lid, full in session.execute(
            select(Location.id, func.lower(Location.full_name)).where(func.lower(Location.full_name).in_(chunk)).order_by(Location.id)
        ):
            existing.setdefault(full, []).append(lid)
    new_locations: dict[str, str] = {}  # lower -> display path
    for row in rows:
        if not row.location_parts:
            continue
        path = " > ".join(row.location_parts)
        found = existing.get(path.lower(), [])
        if len(found) > 1:
            row.errors.append(f"location “{path}” is ambiguous: {len(found)} locations have that exact path")
        elif found:
            row.location_id = found[0]
        elif create_locations:
            new_locations.setdefault(path.lower(), path)
        else:
            row.errors.append(f"unknown location “{path}” (create it first, or tick “create missing locations”)")

    # --- positions: unique in the file and against what is already stored --
    taken_in_file: dict[tuple[str, int], int] = {}
    for row in rows:
        if row.position is None or not row.location_parts:
            continue
        key = (" > ".join(row.location_parts).lower(), row.position)
        if key in taken_in_file:
            row.errors.append(f"position {row.position} in “{' > '.join(row.location_parts)}” is already used by line {taken_in_file[key]}")
        else:
            taken_in_file[key] = row.line
    location_ids = sorted({r.location_id for r in rows if r.location_id is not None and r.position is not None})
    if location_ids:
        wanted_positions = sorted({r.position for r in rows if r.position is not None and r.location_id is not None})
        held = {
            (lid, order): code
            for lid, order, code in session.execute(
                select(Item.location_id, Item.order, Item.inventory_code).where(
                    Item.location_id.in_(location_ids), Item.order.in_(wanted_positions)
                )
            )
        }
        for row in rows:
            code = held.get((row.location_id, row.position)) if row.location_id is not None and row.position is not None else None
            if code:
                row.errors.append(f"position {row.position} in “{' > '.join(row.location_parts or [])}” is already taken by {code}")

    bad = [r for r in rows if r.errors]
    good = [r for r in rows if not r.errors]
    report = ImportReport(
        committed=False,
        blocked=False,
        total_rows=len(rows),
        valid_rows=len(good),
        error_rows=len(bad),
        imported=0,
        errors=[ImportRowError(line=r.line, message="; ".join(r.errors)) for r in bad[:MAX_REPORTED_ERRORS]],
        errors_truncated=len(bad) > MAX_REPORTED_ERRORS,
        warnings=warnings,
        new_categories=sorted(new_categories.values(), key=str.lower),
        new_locations=sorted(new_locations.values(), key=str.lower),
        preview=[
            {
                "line": r.line,
                "category": r.category_name,
                "model": r.fields["model"],
                "manufacturer": r.fields["manufacturer"],
                "condition": r.fields["condition"],
                "test_status": r.fields["test_status"],
                "location": " > ".join(r.location_parts) if r.location_parts else None,
                "position": r.position,
            }
            for r in good[:PREVIEW_ROWS]
        ],
    )
    if not commit:
        return report
    if bad and not skip_invalid:
        report.blocked = True
        return report
    if not good:
        return report

    # --- write everything in one transaction -------------------------------
    location_service.lock_structure(session)
    next_sort = (session.scalar(select(func.max(Category.sort_order))) or 0) + 10
    for lower, display in sorted(new_categories.items()):
        # Only categories still used by a row that is being imported.
        if any(r.category_name.lower() == lower for r in good):
            category = Category(name=display, sort_order=next_sort)
            session.add(category)
            session.flush()
            categories[lower] = category.id
            next_sort += 10
    cache: dict[tuple[int | None, str], Location] = {}
    planned: dict[str, int] = {}
    for row in good:
        if row.location_parts and row.location_id is None:
            lower = " > ".join(row.location_parts).lower()
            if lower not in planned:
                planned[lower] = location_service.ensure_path(session, row.location_parts, cache).id
            row.location_id = planned[lower]
    batch: list[dict] = []
    for row in good:
        batch.append({**row.fields, "category_id": categories[row.category_name.lower()], "location_id": row.location_id})
        if len(batch) >= BATCH:
            _insert_items(session, batch)
            batch.clear()
    if batch:
        _insert_items(session, batch)
    session.commit()
    report.committed = True
    report.imported = len(good)
    return report


def _insert_items(session: Session, batch: list[dict]) -> None:
    """Insert a batch of items; stock items also get their "Starting stock" history entry."""
    rows = session.execute(insert(Item).returning(Item.id, Item.is_stock, Item.quantity), batch).all()
    entries = [
        {"item_id": item_id, "change": quantity, "quantity_after": quantity, "note": "Starting stock"}
        for item_id, is_stock, quantity in rows
        if is_stock and quantity
    ]
    if entries:
        session.execute(insert(StockLog), entries)


def template_csv() -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(TEMPLATE_HEADER)
    writer.writerow(["CPU", "Intel", "Pentium MMX 200", "", "", "", "", "Good", "Full Test", "", "Workshop > CPU Tray", "1", "", "", "", "", "", "", '{"Socket":"Socket 7"}'])
    writer.writerow(["GPU/VGA", "", "Unknown PCI video card", "", "", "", "", "Unknown", "Untested", "Needs a PCI test machine", "", "", "", "", "", "", "", "", ""])
    return out.getvalue()
