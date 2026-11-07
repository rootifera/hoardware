import json
from datetime import datetime, timedelta, timezone

import pytest

from app import backup
from app.config import get_settings


@pytest.fixture
def cfg(monkeypatch, tmp_path):
    settings = get_settings()
    monkeypatch.setattr(settings, "backup_local_dir", tmp_path)
    monkeypatch.setattr(settings, "backup_expected", True)
    monkeypatch.setattr(settings, "backup_interval_hours", 24)
    return settings


def make_backup(directory, age_hours):
    path = directory / "hoardware-20260101T000000Z.dump"
    path.write_bytes(b"x")
    import os, time

    stamp = time.time() - age_hours * 3600
    os.utime(path, (stamp, stamp))


def test_not_judged_unless_expected(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "backup_expected", False)
    assert backup.backup_status(settings) == {"status": "off"}


def test_none_ok_stale_and_failing(cfg, tmp_path):
    assert backup.backup_status(cfg)["status"] == "none"
    make_backup(tmp_path, 3)
    s = backup.backup_status(cfg)
    assert s["status"] == "ok" and s["age_hours"] == pytest.approx(3, abs=0.1)
    make_backup(tmp_path, 49.5)  # more than two intervals plus the hour of grace
    assert backup.backup_status(cfg)["status"] == "stale"
    make_backup(tmp_path, 3)
    assert backup.record_result(cfg, "pg_dump failed: boom") is False
    s = backup.backup_status(cfg)
    assert s["status"] == "failing" and "boom" in s["error"]
    assert backup.record_result(cfg, None) is True  # recovery is reported once
    assert backup.backup_status(cfg)["status"] == "ok"
    assert backup.record_result(cfg, None) is False


def test_health_reports_backups_without_failing(client, cfg):
    r = client.get("/api/v1/health")
    assert r.status_code == 200 and r.json()["backups"]["status"] == "none"


def test_notify_formats_and_never_raises(monkeypatch):
    settings = get_settings()
    sent = []

    class Resp:
        def close(self):
            pass

    def fake(request, timeout):
        sent.append((request.full_url, request.get_header("Content-type"), request.data))
        return Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake)
    monkeypatch.setattr(settings, "backup_notify_url", "https://hooks.example/slack")
    backup.notify(settings, "hello")
    assert sent[-1][1] == "application/json" and json.loads(sent[-1][2]) == {"text": "hello", "content": "hello"}
    monkeypatch.setattr(settings, "backup_notify_url", "https://ntfy.example/topic")
    backup.notify(settings, "hello")
    assert sent[-1][1].startswith("text/plain") and sent[-1][2] == b"hello"

    def broken(request, timeout):
        raise OSError("down")

    monkeypatch.setattr("urllib.request.urlopen", broken)
    backup.notify(settings, "still fine")  # must not raise
    monkeypatch.setattr(settings, "backup_notify_url", None)
    sent.clear()
    backup.notify(settings, "nobody listens")
