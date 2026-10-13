from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Category
from app.schemas import CategoryIn, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/categories", tags=["categories"])
SessionDep = Annotated[Session, Depends(get_session)]

DUPLICATE = "a category with this name already exists"


@router.get("", response_model=list[CategoryOut])
def list_categories(session: SessionDep):
    # Categories are a small, admin-managed list, so no pagination.
    return session.scalars(select(Category).order_by(Category.sort_order, Category.name, Category.id)).all()


@router.post("", response_model=CategoryOut, status_code=201)
def create_category(body: CategoryIn, session: SessionDep):
    category = Category(**body.model_dump())
    session.add(category)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, DUPLICATE) from None
    return category


@router.patch("/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, body: CategoryUpdate, session: SessionDep):
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(404, "category not found")
    for name, value in body.model_dump(exclude_unset=True).items():
        if value is None:
            raise HTTPException(422, f"{name} cannot be null")
        setattr(category, name, value)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, DUPLICATE) from None
    return category


@router.delete("/{category_id}", status_code=204)
def delete_category(category_id: int, session: SessionDep):
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(404, "category not found")
    session.delete(category)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "category is still used by items; reassign them first") from None
    return Response(status_code=204)
