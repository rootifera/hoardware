import logging

from fastapi import Depends, FastAPI

from app.auth import auth_enabled, require_auth
from app.config import get_settings
from app.routers import auth as auth_router
from app.routers import bulk, categories, files, imports, items, locations, misc, photos, reference, testlog

API_PREFIX = "/api/v1"
log = logging.getLogger("hoardware")

_protected = auth_enabled(get_settings())
if not _protected:
    log.warning("AUTH_PASSWORD is not set: anyone who can reach the app can read and change everything")

app = FastAPI(
    title="Hoardware",
    version="0.1.0",
    # The interactive docs are not behind the session check, so they are off when login is on.
    docs_url=None if _protected else f"{API_PREFIX}/docs",
    openapi_url=None if _protected else f"{API_PREFIX}/openapi.json",
    redoc_url=None,
    dependencies=[Depends(require_auth)],
)

for module in (auth_router, categories, locations, bulk, items, photos, files, reference, testlog, imports, misc):
    app.include_router(module.router, prefix=API_PREFIX)
