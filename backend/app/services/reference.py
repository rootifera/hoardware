"""Reference model lookup and candidate matching for inventory items."""

import re
from dataclasses import dataclass

from sqlalchemy import Text, bindparam, func, or_, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session

from app.models import Item, ReferenceImport, ReferenceModel, ReferenceSource
from app.reference.base import match_key, token_keys_of
from app.schemas import (
    ReferenceCandidate,
    ReferenceDetail,
    ReferenceSourceOut,
    ReferenceSourceStatus,
    ReferenceSummary,
)

# Specs worth showing in lists, per kind (names are the source's own).
HIGHLIGHT_SPECS: dict[str, list[str]] = {
    "cpu": ["Frequency(internal max/typ)", "Bus speed", "L2 cache", "Package", "Socket", "Core", "CPUID", "Core Stepping"],
}

_NO_CACHE = {"none", "0kib", "0 kib", "0", "na"}


def spec_line_of(freq: object, bus: object, l2: object, package: object, sspec: object = None) -> str:
    """The handful of specs a collector wants at a glance, on one line."""
    parts: list[str] = []
    if isinstance(sspec, str) and sspec:
        parts.append(sspec)
    if isinstance(freq, str) and freq:
        parts.append(freq)
    if isinstance(bus, str) and bus:
        parts.append(f"{bus} bus")
    if isinstance(l2, str) and l2:
        parts.append("no L2" if l2.lower() in _NO_CACHE else f"{l2} L2")
    if isinstance(package, str) and package:
        parts.append(package)
    return " · ".join(parts)


# Dataset column names -> the plain names an item's own specs use.
_FRIENDLY = {
    "Frequency(internal max/typ)": "Speed",
    "Frequency(internal min)": "Speed (min)",
    "Frequency(ext)": "External clock",
    "Core Stepping": "Stepping",
    "Process Size": "Process",
    "Vcc(core range)": "Core voltage",
    "Vcc(core typical)": "Core voltage (typical)",
    "Vcc(I/O)": "I/O voltage",
    "Data Bus(ext)": "Data bus",
    "Power Thermal Design": "TDP",
}
_SKIP_COPY = {"references", "Comments", "Chip Type"}
MAX_COPIED_SPECS = 40


def spec_snapshot(ref: ReferenceModel) -> dict[str, str]:
    """The record's specs under plain names, for copying onto an item. Only
    values the source actually states: not-applicable and blank are left out."""
    out: dict[str, str] = {}
    if ref.family:
        out["Family"] = ref.family
    for name, value in ref.specs.items():
        if name in _SKIP_COPY or not isinstance(value, str) or not value.strip():
            continue
        out.setdefault(_FRIENDLY.get(name, name), value.strip())
    refs = ref.specs.get("references")
    if isinstance(refs, list) and refs and isinstance(refs[0], str):
        out["Source link"] = refs[0]
    out["Source"] = ref.source_key.upper() if ref.source_key == "cpu-db" else ref.source_key
    return dict(list(out.items())[:MAX_COPIED_SPECS])


def merge_specs(existing: dict, snapshot: dict[str, str]) -> dict:
    """Add snapshot entries the item does not already have (names compared
    case-insensitively). Whatever the user entered always wins."""
    have = {k.lower() for k in existing}
    merged = dict(existing)
    for name, value in snapshot.items():
        if name.lower() not in have:
            merged[name] = value
    return merged


def display_name_of(kind: str, family: str | None, model: str, specs: dict) -> str:
    """A readable name. CPU-DB names chips only by family and speed, so the
    cache is added to tell, say, a 300 MHz Celeron without cache from one with."""
    if kind == "cpu":
        freq, l2 = specs.get("Frequency(internal max/typ)"), specs.get("L2 cache")
        parts = [family, freq if isinstance(freq, str) else None]
        if isinstance(l2, str) and l2 and l2.lower() not in _NO_CACHE:
            parts.append(f"{l2} L2")
        name = " ".join(p for p in parts if p)
        if name:
            return name
    return model

_STOPWORDS = {
    "unknown", "card", "cards", "the", "and", "pci", "isa", "agp", "vga", "video", "cpu", "processor",
    "graphics", "sound", "board", "chip", "with", "for", "ram", "memory", "pcie", "eisa", "vlb",
}


def _words(*values: str | None) -> list[str]:
    found: list[str] = []
    for value in values:
        for word in re.split(r"[^a-z0-9]+", (value or "").lower()):
            # Distinctive words only: "pentium", "486", "k6" -- not fragments like "ac" or "ab".
            meaningful = len(word) >= 3 or (len(word) == 2 and any(ch.isdigit() for ch in word))
            if meaningful and word not in _STOPWORDS and word not in found:
                found.append(word)
    return found[:8]


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def order_code_of(part_number: str | None, sspec: object) -> str | None:
    """The part number without its S-Spec word ("BX80524R300128 SL32A" -> "BX80524R300128")."""
    if not part_number:
        return None
    if isinstance(sspec, str) and sspec:
        words = [w for w in part_number.split() if w.upper() != sspec.upper()]
        return " ".join(words) or None
    return part_number


def summary_of(ref: ReferenceModel) -> ReferenceSummary:
    keys = HIGHLIGHT_SPECS.get(ref.kind, [])
    highlights = {k: ref.specs[k] for k in keys if ref.specs.get(k) not in (None, "")}
    return ReferenceSummary(
        id=ref.id,
        kind=ref.kind,
        manufacturer=ref.manufacturer,
        family=ref.family,
        model=ref.model,
        part_number=ref.part_number,
        revision=ref.revision,
        source_key=ref.source_key,
        highlights=highlights,
        order_code=order_code_of(ref.part_number, ref.specs.get("S-Spec")),
        s_spec=ref.specs.get("S-Spec") if isinstance(ref.specs.get("S-Spec"), str) else None,
        display_name=display_name_of(ref.kind, ref.family, ref.model, ref.specs),
        spec_line=spec_line_of(
            ref.specs.get("Frequency(internal max/typ)"),
            ref.specs.get("Bus speed"),
            ref.specs.get("L2 cache"),
            ref.specs.get("Package"),
            ref.specs.get("S-Spec"),
        ),
    )


def detail_of(session: Session, ref: ReferenceModel) -> ReferenceDetail:
    source = session.get(ReferenceSource, ref.source_key)
    return ReferenceDetail(
        **summary_of(ref).model_dump(),
        aliases=ref.aliases,
        specs=ref.specs,
        provenance=ref.provenance,
        source=ReferenceSourceOut(
            key=source.key, name=source.name, url=source.url, licence=source.licence, attribution=source.attribution
        ),
        source_version=ref.source_version,
        imported_at=ref.imported_at,
    )


def source_statuses(session: Session) -> list[ReferenceSourceStatus]:
    rows = session.execute(
        select(ReferenceSource, func.count(ReferenceModel.id))
        .outerjoin(ReferenceModel, ReferenceModel.source_key == ReferenceSource.key)
        .group_by(ReferenceSource.key)
        .order_by(ReferenceSource.name)
    ).all()
    out = []
    for source, count in rows:
        last = session.execute(
            select(ReferenceImport.source_version, ReferenceImport.finished_at)
            .where(ReferenceImport.source_key == source.key, ReferenceImport.finished_at.is_not(None))
            .order_by(ReferenceImport.id.desc())
            .limit(1)
        ).first()
        out.append(
            ReferenceSourceStatus(
                key=source.key,
                name=source.name,
                url=source.url,
                licence=source.licence,
                attribution=source.attribution,
                models=count,
                source_version=last[0] if last else None,
                last_import_at=last[1] if last else None,
            )
        )
    return out


@dataclass
class _Scored:
    ref: ReferenceModel
    match_type: str
    matched: list[str]
    manufacturer_matches: bool | None


def _manufacturer_matches(item_manufacturer: str | None, ref_manufacturer: str | None) -> bool | None:
    a, b = match_key(item_manufacturer), match_key(ref_manufacturer)
    if not a or not b:
        return None
    return a == b or a in b or b in a


def find_candidates(session: Session, item: Item, limit: int = 15) -> list[ReferenceCandidate]:
    """Suggest reference models for a stored item (see find_candidates_for)."""
    sspec = (item.attributes or {}).get("S-Spec")
    # The S-Spec is an identifier too: "BX80524R300128" + S-Spec "SL32A" together name the record.
    part = " ".join(p for p in (item.part_number, sspec if isinstance(sspec, str) else None) if p) or None
    return find_candidates_for(session, part_number=part, model=item.model, manufacturer=item.manufacturer, limit=limit)


def find_candidates_for(
    session: Session,
    *,
    part_number: str | None,
    model: str | None,
    manufacturer: str | None = None,
    limit: int = 15,
) -> list[ReferenceCandidate]:
    """Suggest reference models, best first. Precedence follows the spec: exact
    part number, then shared identifiers (S-Spec, ordering code), then name
    text. Every result is a *candidate* for the user to confirm."""
    whole = {k for k in (match_key(part_number), match_key(model)) if len(k) >= 3}
    tokens = token_keys_of(part_number) | token_keys_of(model)
    probe = sorted(whole | tokens)

    scored: dict[int, _Scored] = {}
    if probe:
        probe_array = bindparam("probe", probe, type_=ARRAY(Text))
        rows = session.scalars(
            select(ReferenceModel)
            .where(or_(ReferenceModel.exact_keys.overlap(probe_array), ReferenceModel.token_keys.overlap(probe_array)))
            .limit(200)
        ).all()
        for ref in rows:
            exact_hit = sorted(whole & set(ref.exact_keys))
            other_hit = sorted((set(probe) & (set(ref.exact_keys) | set(ref.token_keys))) - set(exact_hit))
            scored[ref.id] = _Scored(
                ref,
                "exact" if exact_hit else "token",
                exact_hit or other_hit,
                _manufacturer_matches(manufacturer, ref.manufacturer),
            )

    # Name-only guesses are a last resort: they would just be noise next to a
    # real identifier match, and a placeholder like "Unknown PCI video card"
    # has no distinctive words at all.
    if not scored and _words(model):
        words = _words(manufacturer, model)
        if words:
            stmt = select(ReferenceModel).limit(limit * 2)
            for word in words:
                stmt = stmt.where(ReferenceModel.search_text.like(f"%{_like_escape(word)}%", escape="\\"))
            for ref in session.scalars(stmt.order_by(ReferenceModel.sort_name, ReferenceModel.id)):
                scored.setdefault(
                    ref.id, _Scored(ref, "text", [], _manufacturer_matches(manufacturer, ref.manufacturer))
                )

    rank = {"exact": 0, "token": 1, "text": 2}

    def sort_key(s: _Scored):
        mismatch = 0 if s.manufacturer_matches is True else (1 if s.manufacturer_matches is None else 2)
        return (rank[s.match_type], mismatch, -len(s.matched), s.ref.sort_name, s.ref.id)

    ordered = sorted(scored.values(), key=sort_key)[:limit]
    return [
        ReferenceCandidate(
            reference=summary_of(s.ref),
            match_type=s.match_type,
            matched_on=s.matched,
            manufacturer_matches=s.manufacturer_matches,
        )
        for s in ordered
    ]
