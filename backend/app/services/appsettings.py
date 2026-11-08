"""Installation-wide settings kept in the app_settings table, read through a short cache."""

import time
from typing import Any

from sqlalchemy.orm import Session

from app.models import AppSetting

DEFAULT_TITLE = "Hoardware"
DEFAULT_CODE_PREFIX = "HW"
_TTL = 30.0
_cache: dict[str, tuple[float, Any]] = {}


def get(session: Session, key: str, default: Any = None) -> Any:
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < _TTL:
        return cached[1]
    row = session.get(AppSetting, key)
    value = default if row is None else row.value
    _cache[key] = (time.monotonic(), value)
    return value


def put(session: Session, key: str, value: Any) -> None:
    """Store a setting (the caller commits)."""
    row = session.get(AppSetting, key)
    if row is None:
        session.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    _cache.pop(key, None)


def forget_all() -> None:
    _cache.clear()


def title(session: Session) -> str:
    return get(session, "title", DEFAULT_TITLE) or DEFAULT_TITLE


def code_prefix(session: Session) -> str:
    return get(session, "code_prefix", DEFAULT_CODE_PREFIX) or DEFAULT_CODE_PREFIX


def is_setup_complete(session: Session) -> bool:
    return bool(get(session, "setup_complete", False))
