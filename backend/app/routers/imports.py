from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from sqlalchemy.orm import Session

from app.db import get_session
from app.schemas import ImportReport
from app.services import csv_import

router = APIRouter(prefix="/import", tags=["import"])
SessionDep = Annotated[Session, Depends(get_session)]


@router.get("/template.csv")
def import_template():
    """A header plus two example rows to start a spreadsheet from."""
    return Response(
        csv_import.template_csv(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="hoardware-import-template.csv"'},
    )


@router.post("/items.csv", response_model=ImportReport)
def import_items_csv(
    session: SessionDep,
    file: Annotated[UploadFile, File()],
    commit: Annotated[bool, Query(description="false = validate and preview only")] = False,
    skip_invalid: Annotated[bool, Query(description="import the valid rows even if others have errors")] = False,
    create_categories: bool = False,
    create_locations: bool = False,
):
    """Validate (and optionally import) a CSV of items. Every row becomes a new
    item. Nothing is written unless ``commit`` is true and the file is clean, or
    ``skip_invalid`` is set."""
    content = file.file.read(csv_import.MAX_BYTES + 1)
    return csv_import.run_import(
        session,
        content,
        commit=commit,
        skip_invalid=skip_invalid,
        create_categories=create_categories,
        create_locations=create_locations,
    )
