import json

import pytest

from app import version
from app.config import get_settings

API = "/api/v1"
FILE = {"app_name": "Hoardware", "version": "1.0.0", "build_name": "Malachite", "build_time": 1790617897}


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch, tmp_path):
    settings = get_settings()
    path = tmp_path / "version.json"
    path.write_text(json.dumps(FILE))
    monkeypatch.setattr(settings, "version_file", path)
    monkeypatch.setattr(settings, "version_check_url", "https://example.test/version.json")
    monkeypatch.setattr(settings, "version_check_token", None)
    version._state.update(data=None, checked_at=0.0, ok_at=0.0, error=None, running=False)
    yield settings
    version._state.update(data=None, checked_at=0.0, ok_at=0.0, error=None, running=False)


def fake_remote(monkeypatch, payload=None, error=None, seen=None):
    class Resp:
        def __init__(self, body):
            self.body = body

        def read(self, n):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def opener(request, timeout):
        if seen is not None:
            seen.append(request)
        if error:
            raise error
        return Resp(json.dumps(payload).encode() if not isinstance(payload, bytes) else payload)

    monkeypatch.setattr("urllib.request.urlopen", opener)


def test_installed_version_comes_from_the_file(fresh_state):
    assert version.installed(fresh_state) == FILE


def test_unknown_when_there_is_no_file(monkeypatch, fresh_state):
    monkeypatch.setattr(fresh_state, "version_file", fresh_state.version_file.with_name("nope.json"))
    monkeypatch.setattr(version, "_candidates", lambda s: [s.version_file])
    assert version.installed(fresh_state)["version"] == "unknown"


@pytest.mark.parametrize(
    "candidate,current,newer",
    [
        ({"version": "1.0.1"}, {"version": "1.0.0"}, True),
        ({"version": "1.10.0"}, {"version": "1.9.9"}, True),  # numbers, not text order
        ({"version": "1.0.0"}, {"version": "1.0.0"}, False),
        ({"version": "0.9.0"}, {"version": "1.0.0"}, False),
        ({"version": "v2.0.0"}, {"version": "1.9.0"}, True),
        ({"version": "1.0.0", "build_time": 200}, {"version": "1.0.0", "build_time": 100}, True),  # rebuilt release
        ({"version": "1.0.0", "build_time": 100}, {"version": "1.0.0", "build_time": 200}, False),
        ({"version": "1.0.0", "build_time": 200}, {"version": "1.0.0"}, False),
    ],
)
def test_is_newer(candidate, current, newer):
    assert version.is_newer(candidate, current) is newer


def test_update_is_reported_when_the_repository_has_a_newer_version(client, monkeypatch, fresh_state):
    seen = []
    fake_remote(monkeypatch, {**FILE, "version": "1.1.0", "build_name": "Basalt", "build_time": 1800000000}, seen=seen)
    version.refresh(fresh_state)
    body = client.get(f"{API}/version").json()
    assert body["version"] == "1.0.0" and body["build_name"] == "Malachite"
    assert body["update"]["version"] == "1.1.0" and body["update"]["build_name"] == "Basalt"
    assert body["check"]["enabled"] is True and body["check"]["error"] is None
    assert "Authorization" not in {k.title() for k in seen[0].headers}


def test_no_update_when_the_repository_is_the_same(client, monkeypatch, fresh_state):
    fake_remote(monkeypatch, FILE)
    version.refresh(fresh_state)
    assert client.get(f"{API}/version").json()["update"] is None


def test_token_is_sent_for_private_repositories(monkeypatch, fresh_state):
    monkeypatch.setattr(fresh_state, "version_check_token", "ghp_secret")
    seen = []
    fake_remote(monkeypatch, FILE, seen=seen)
    version.refresh(fresh_state)
    assert seen[0].get_header("Authorization") == "token ghp_secret"


def test_failures_are_reported_not_raised_and_do_not_hide_the_installed_version(client, monkeypatch, fresh_state):
    fake_remote(monkeypatch, error=OSError("HTTP Error 404: Not Found"))
    version.refresh(fresh_state)
    body = client.get(f"{API}/version").json()
    assert body["version"] == "1.0.0" and body["update"] is None
    assert "404" in body["check"]["error"]
    fake_remote(monkeypatch, payload=b"<html>not json</html>")
    version.refresh(fresh_state)
    assert "valid version.json" in client.get(f"{API}/version").json()["check"]["error"]


def test_an_earlier_answer_survives_a_later_failure(client, monkeypatch, fresh_state):
    fake_remote(monkeypatch, {**FILE, "version": "2.0.0"})
    version.refresh(fresh_state)
    fake_remote(monkeypatch, error=OSError("offline"))
    version.refresh(fresh_state)
    body = client.get(f"{API}/version").json()
    assert body["update"]["version"] == "2.0.0" and body["check"]["error"]


def test_can_be_switched_off(client, monkeypatch, fresh_state):
    monkeypatch.setattr(fresh_state, "version_check_url", "off")
    called = []
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: called.append(1))
    body = client.get(f"{API}/version").json()
    assert body["check"]["enabled"] is False and body["update"] is None and not called


def test_endpoint_needs_login_when_login_is_on(client, monkeypatch, fresh_state):
    monkeypatch.setattr(fresh_state, "auth_password", "pw")
    assert client.get(f"{API}/version").status_code == 401
