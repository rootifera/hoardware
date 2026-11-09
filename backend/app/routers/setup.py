import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Category, Item
from app.services import appsettings, presets

router = APIRouter(tags=["setup"])
SessionDep = Annotated[Session, Depends(get_session)]

PREFIX = re.compile(r"^[A-Z0-9]{1,6}$")


class PresetOut(BaseModel):
    key: str
    name: str
    description: str
    code_prefix: str
    categories: list[str]


class SetupOut(BaseModel):
    complete: bool
    title: str
    code_prefix: str
    presets: list[PresetOut]


class SetupIn(BaseModel):
    mode: Literal["standard", "custom"]
    preset: str = "blank"
    title: Annotated[str, Field(max_length=60)] | None = None
    code_prefix: Annotated[str, Field(max_length=6)] | None = None


def _state(session: Session) -> SetupOut:
    return SetupOut(
        complete=appsettings.is_setup_complete(session),
        title=appsettings.title(session),
        code_prefix=appsettings.code_prefix(session),
        presets=[PresetOut(**p) for p in presets.summaries()],
    )


@router.get("/setup", response_model=SetupOut)
def get_setup(session: SessionDep):
    """Whether the first-run choice has been made, plus the title, item code prefix and starter sets."""
    return _state(session)


@router.post("/setup", response_model=SetupOut)
def run_setup(body: SetupIn, session: SessionDep):
    """The first-run choice. Standard keeps the PC hardware categories; custom replaces them with a
    starter set of your own choosing (only while there are no items yet)."""
    if appsettings.is_setup_complete(session):
        raise HTTPException(409, "setup has already been done")
    if body.mode == "custom":
        if body.preset not in presets.load_all():
            raise HTTPException(422, "unknown starter set")
        if session.scalar(select(func.count()).select_from(Item)):
            raise HTTPException(409, "a custom setup needs an empty inventory")
        prefix = (body.code_prefix or presets.load_all()[body.preset].get("code_prefix") or "HW").strip().upper()
        if not PREFIX.match(prefix):
            raise HTTPException(422, "the item code prefix is 1 to 6 letters or digits")
        title = (body.title or "").strip() or appsettings.DEFAULT_TITLE
        session.execute(delete(Category))
        presets.apply(session, body.preset)
        # New items get codes like MG-000001. DDL is transactional in PostgreSQL, so this is all-or-nothing.
        session.execute(text("ALTER SEQUENCE inventory_code_seq RESTART WITH 1"))
        session.execute(
            text(f"ALTER TABLE items ALTER COLUMN inventory_code SET DEFAULT '{prefix}-' || lpad(nextval('inventory_code_seq')::text, 6, '0')")
        )
        appsettings.put(session, "code_prefix", prefix)
        appsettings.put(session, "title", title)
    appsettings.put(session, "setup_complete", True)
    session.commit()
    appsettings.forget_all()
    return _state(session)


@router.get("/presets", response_model=list[PresetOut])
def list_presets():
    return [PresetOut(**p) for p in presets.summaries()]


@router.post("/presets/{key}/apply")
def apply_preset(key: str, session: SessionDep):
    """Add a starter set's categories to the ones you have (existing categories are left alone)."""
    if key not in presets.load_all():
        raise HTTPException(404, "unknown starter set")
    added = presets.apply(session, key)
    session.commit()
    return {"added": added}
