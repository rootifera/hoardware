"""Starter sets of categories (fields, predefined values, field names) shipped as JSON files."""

import json
from functools import lru_cache
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Category
from app.schemas import CategoryIn

DIRECTORY = Path(__file__).resolve().parent.parent / "presets"
# Shown in this order; the PC set is the default.
ORDER = ["pc", "music", "cards", "electronics", "blank"]


@lru_cache
def load_all() -> dict[str, dict]:
    found: dict[str, dict] = {}
    for path in sorted(DIRECTORY.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        # Every category is validated like one entered by hand, so a broken file fails loudly (and in the tests).
        data["categories"] = [CategoryIn(**c).model_dump(mode="json") for c in data["categories"]]
        found[data["key"]] = data
    return dict(sorted(found.items(), key=lambda kv: ORDER.index(kv[0]) if kv[0] in ORDER else len(ORDER)))


def summaries() -> list[dict]:
    return [
        {
            "key": p["key"],
            "name": p["name"],
            "description": p["description"],
            "code_prefix": p.get("code_prefix", "HW"),
            "categories": [c["name"] for c in p["categories"]],
        }
        for p in load_all().values()
    ]


def apply(session: Session, key: str) -> list[str]:
    """Add the preset's categories that do not exist yet (compared by name, ignoring case).
    Existing categories are never touched. Returns the names that were added. The caller commits."""
    preset = load_all()[key]
    existing = {name.lower() for name in session.scalars(select(Category.name))}
    top = session.scalar(select(func.coalesce(func.max(Category.sort_order), -10))) + 10
    added = []
    for category in preset["categories"]:
        if category["name"].lower() in existing:
            continue
        session.add(Category(**{**category, "sort_order": top + 10 * len(added)}))
        added.append(category["name"])
    return added
