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
    "cpu": ["Frequency(internal max/typ)", "Socket", "Package", "Core", "CPUID", "L2 cache", "Core Stepping"],
}

_STOPWORDS = {
    "unknown", "card", "cards", "the", "and", "pci", "isa", "agp", "vga", "video", "cpu", "processor",
    "graphics", "sound", "board", "chip", "with", "for", "ram", "memory", "pcie", "eisa", "vlb",
}


def _words(*values: str | None) -> list[str]:
    found: list[str] = []
    for value in values:
        for word in re.split(r"[^a-z0-9]+", (value or "").lower()):
            if len(word) >= 2 and word not in _STOPWORDS and word not in found:
                found.append(word)
    return found[:8]


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
    """Suggest reference models for an item, best first. Precedence follows the
    spec: exact part number, then shared identifiers (S-Spec, ordering code),
    then name text. Every result is a *candidate* for the user to confirm."""
    whole = {k for k in (match_key(item.part_number), match_key(item.model)) if len(k) >= 3}
    tokens = token_keys_of(item.part_number) | token_keys_of(item.model)
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
                _manufacturer_matches(item.manufacturer, ref.manufacturer),
            )

    # Name-only guesses are a last resort: they would just be noise next to a
    # real identifier match, and a placeholder like "Unknown PCI video card"
    # has no distinctive words at all.
    if not scored and _words(item.model):
        words = _words(item.manufacturer, item.model)
        if words:
            stmt = select(ReferenceModel).limit(limit * 2)
            for word in words:
                stmt = stmt.where(ReferenceModel.search_text.like(f"%{_like_escape(word)}%", escape="\\"))
            for ref in session.scalars(stmt.order_by(ReferenceModel.sort_name, ReferenceModel.id)):
                scored.setdefault(
                    ref.id, _Scored(ref, "text", [], _manufacturer_matches(item.manufacturer, ref.manufacturer))
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
