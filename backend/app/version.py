"""The installed version (from version.json) and whether the git repository has a newer one."""

import json
import logging
import re
import threading
import time
import urllib.request
from pathlib import Path

from app.config import Settings, get_settings

log = logging.getLogger(__name__)

FIELDS = ("app_name", "version", "build_name", "build_time")
_FAILURE_RETRY_SECONDS = 30 * 60


def _candidates(settings: Settings) -> list[Path]:
    here = Path(__file__).resolve()
    return [p for p in (settings.version_file, Path("/srv/version.json"), here.parents[2] / "version.json") if p]


def check_url(settings: Settings) -> str | None:
    """The URL to check, or None when checking is switched off (VERSION_CHECK_URL=off)."""
    url = (settings.version_check_url or "").strip()
    return None if not url or url.lower() in ("off", "none", "false", "no") else url


def parse(raw: str) -> dict | None:
    """The version.json fields, or None if this is not a valid version file."""
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("version"), str):
            return None
        out = {
            "app_name": str(data.get("app_name") or "Hoardware"),
            "version": data["version"].strip(),
            "build_name": str(data["build_name"]) if data.get("build_name") else None,
            "build_time": int(data["build_time"]) if data.get("build_time") is not None else None,
        }
        return out if out["version"] else None
    except (ValueError, TypeError):
        return None


def installed(settings: Settings | None = None) -> dict:
    settings = settings or get_settings()
    for path in _candidates(settings):
        try:
            found = parse(path.read_text())
        except OSError:
            continue
        if found:
            return found
    return {"app_name": "Hoardware", "version": "unknown", "build_name": None, "build_time": None}


def _key(version: str) -> tuple[int, ...]:
    """1.10.2 -> (1, 10, 2); anything after a non-numeric part is ignored."""
    parts = []
    for piece in re.split(r"[.\-+]", version.lstrip("vV")):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    return tuple(parts)


def is_newer(candidate: dict, current: dict) -> bool:
    """Is ``candidate`` a newer release than ``current``? A higher version wins; at the same
    version a later build_time counts (a rebuilt release)."""
    a, b = _key(candidate["version"]), _key(current["version"])
    if a != b:
        return a > b
    return bool(candidate.get("build_time") and current.get("build_time") and candidate["build_time"] > current["build_time"])


_state: dict = {"data": None, "checked_at": 0.0, "ok_at": 0.0, "error": None, "running": False}
_lock = threading.Lock()


def _fetch(settings: Settings) -> dict:
    headers = {"User-Agent": "hoardware-update-check", "Accept": "application/json, text/plain"}
    if settings.version_check_token:
        headers["Authorization"] = f"token {settings.version_check_token}"
    request = urllib.request.Request(check_url(settings), headers=headers)
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read(64_000).decode("utf-8", "replace")
    found = parse(body)
    if found is None:
        raise ValueError("the file is not a valid version.json")
    return found


def refresh(settings: Settings | None = None) -> None:
    """Fetch the repository's version.json now (blocking). Never raises."""
    settings = settings or get_settings()
    if not check_url(settings):
        return
    try:
        data = _fetch(settings)
        error = None
    except Exception as exc:
        data, error = None, f"{type(exc).__name__}: {exc}"[:200]
        log.warning("update check failed: %s%s", error, " (a private repository needs VERSION_CHECK_TOKEN)" if "404" in error else "")
    with _lock:
        _state["checked_at"] = time.time()
        _state["error"] = error
        if data:
            _state["data"], _state["ok_at"] = data, time.time()
        _state["running"] = False


def _maybe_refresh(settings: Settings) -> None:
    """Start a background refresh when the cached answer is stale; requests never wait for the network."""
    if not check_url(settings):
        return
    with _lock:
        age = time.time() - _state["checked_at"]
        limit = _FAILURE_RETRY_SECONDS if _state["error"] else settings.version_check_interval_hours * 3600
        if _state["running"] or age < limit:
            return
        _state["running"] = True
    threading.Thread(target=refresh, args=(settings,), daemon=True, name="version-check").start()


def status(settings: Settings | None = None) -> dict:
    settings = settings or get_settings()
    now = installed(settings)
    _maybe_refresh(settings)
    with _lock:
        latest, checked_at, error = _state["data"], _state["checked_at"], _state["error"]
    update = latest if latest and is_newer(latest, now) else None
    return {
        **now,
        "update": update,
        "check": {
            "enabled": bool(check_url(settings)),
            "checked_at": int(checked_at) or None,
            "error": error,
        },
    }
