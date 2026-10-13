from fastapi import FastAPI

from app.routers import categories, items, locations, misc, photos

API_PREFIX = "/api/v1"

app = FastAPI(
    title="Hoardware",
    version="0.1.0",
    docs_url=f"{API_PREFIX}/docs",
    openapi_url=f"{API_PREFIX}/openapi.json",
    redoc_url=None,
)

for module in (categories, locations, items, photos, misc):
    app.include_router(module.router, prefix=API_PREFIX)
