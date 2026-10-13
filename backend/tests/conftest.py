"""Test setup: a real PostgreSQL database (never SQLite, never mocked).

The suite connects with the same credentials as the application
(DATABASE_URL), creates a throwaway ``<db>_test`` database next to it, runs
the real Alembic migrations against it and points the app at it.
Run with: docker compose run --rm backend pytest
"""

import os
import shutil
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

_admin_url = make_url(os.environ.get("DATABASE_URL", "postgresql+psycopg://hoardware:hoardware@db:5432/hoardware"))
_test_url = _admin_url.set(database=f"{_admin_url.database}_test")

_photos_dir = Path(tempfile.mkdtemp(prefix="hoardware-test-photos-"))
os.environ.update(
    DATABASE_URL=_test_url.render_as_string(hide_password=False),
    STORAGE_BACKEND="local",
    PHOTOS_DIR=str(_photos_dir),
    MAX_UPLOAD_BYTES=str(1024 * 1024),
)


def _recreate_database() -> None:
    engine = create_engine(_admin_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with engine.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{_test_url.database}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{_test_url.database}"'))
    engine.dispose()


_recreate_database()

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

_alembic = Config(str(Path(__file__).resolve().parent.parent / "alembic.ini"))
_alembic.set_main_option("script_location", str(Path(__file__).resolve().parent.parent / "alembic"))
_alembic.set_main_option("sqlalchemy.url", _test_url.render_as_string(hide_password=False).replace("%", "%%"))
command.upgrade(_alembic, "head")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402

SEED = ["CPU", "GPU/VGA", "Motherboard", "Sound Card", "RAM", "Storage", "Other"]


@pytest.fixture(autouse=True)
def clean_state():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE items, photos, locations, categories, pending_deletions, reference_models, reference_imports, reference_sources RESTART IDENTITY CASCADE"))
        conn.execute(text("ALTER SEQUENCE inventory_code_seq RESTART"))
        for i, name in enumerate(SEED):
            conn.execute(text("INSERT INTO categories (name, sort_order) VALUES (:n, :o)"), {"n": name, "o": i * 10})
    shutil.rmtree(_photos_dir, ignore_errors=True)
    _photos_dir.mkdir(parents=True, exist_ok=True)
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session


@pytest.fixture
def cats(client):
    return {c["name"]: c["id"] for c in client.get("/api/v1/categories").json()}


@pytest.fixture
def make_item(client, cats):
    def make(model="Test part", category="CPU", **fields):
        response = client.post("/api/v1/items", json={"category_id": cats[category], "model": model, **fields})
        assert response.status_code == 201, response.text
        return response.json()

    return make


@pytest.fixture
def make_location(client):
    def make(name, parent_id=None, **fields):
        response = client.post("/api/v1/locations", json={"name": name, "parent_id": parent_id, **fields})
        assert response.status_code == 201, response.text
        return response.json()

    return make


@pytest.fixture
def photos_dir():
    return _photos_dir
