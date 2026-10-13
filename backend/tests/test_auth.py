import pytest

from app import auth
from app.config import get_settings

API = "/api/v1"


@pytest.fixture
def login_on(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_password", "s3cret pass")
    monkeypatch.setattr(settings, "auth_username", "me")
    auth_router_failures()
    return settings


def auth_router_failures():
    from app.routers import auth as router

    router._failures.clear()


def test_no_password_means_no_login(client):
    assert client.get(f"{API}/auth/status").json() == {"auth_required": False, "authenticated": True, "username": None}
    assert client.get(f"{API}/categories").status_code == 200


def test_everything_but_health_and_login_needs_a_session(client, login_on):
    assert client.get(f"{API}/categories").status_code == 401
    assert client.get(f"{API}/items").status_code == 401
    assert client.post(f"{API}/items", json={"category_id": 1, "model": "x"}).status_code == 401
    assert client.get(f"{API}/photos/1/thumbnail").status_code == 401
    assert client.get(f"{API}/files/1/download").status_code == 401
    assert client.get(f"{API}/export/items.csv").status_code == 401
    assert client.get(f"{API}/health").status_code in (200, 503)  # reachable without a session
    s = client.get(f"{API}/auth/status").json()
    assert s == {"auth_required": True, "authenticated": False, "username": None}


def test_login_sets_a_httponly_cookie_and_unlocks_the_api(client, login_on):
    bad = client.post(f"{API}/auth/login", json={"username": "me", "password": "nope"})
    assert bad.status_code == 401 and "hoardware_session" not in bad.cookies
    assert client.post(f"{API}/auth/login", json={"username": "other", "password": "s3cret pass"}).status_code == 401

    ok = client.post(f"{API}/auth/login", json={"username": "me", "password": "s3cret pass"})
    assert ok.status_code == 200 and ok.json()["authenticated"] is True
    cookie = ok.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" not in cookie
    assert client.get(f"{API}/categories").status_code == 200
    assert client.get(f"{API}/auth/status").json()["username"] == "me"

    assert client.post(f"{API}/auth/logout").status_code == 204
    assert client.get(f"{API}/categories").status_code == 401


def test_cookie_is_secure_behind_https_proxy(client, login_on):
    r = client.post(f"{API}/auth/login", json={"username": "me", "password": "s3cret pass"}, headers={"X-Forwarded-Proto": "https"})
    assert "secure" in r.headers["set-cookie"].lower()


def test_forged_expired_and_other_password_tokens_are_rejected(client, login_on):
    settings = login_on
    good = auth.make_token(settings, "me")
    assert auth.read_token(settings, good) == "me"
    assert auth.read_token(settings, good + "x") is None
    assert auth.read_token(settings, "me.9999999999.AAAA") is None
    assert auth.read_token(settings, auth.make_token(settings, "me", now=0)) is None  # long expired
    client.cookies.set("hoardware_session", good[:-2] + "zz")
    assert client.get(f"{API}/categories").status_code == 401
    client.cookies.set("hoardware_session", good)
    assert client.get(f"{API}/categories").status_code == 200
    # Changing the password signs every session out.
    settings.auth_password = "another"
    assert client.get(f"{API}/categories").status_code == 401


def test_failed_attempts_are_throttled(client, login_on):
    for _ in range(8):
        assert client.post(f"{API}/auth/login", json={"username": "me", "password": "x"}).status_code == 401
    assert client.post(f"{API}/auth/login", json={"username": "me", "password": "s3cret pass"}).status_code == 429


def test_hashed_password(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_password_hash", auth.hash_password("hunter2", iterations=1000))
    auth_router_failures()
    assert auth.check_credentials(settings, settings.auth_username, "hunter2")
    assert not auth.check_credentials(settings, settings.auth_username, "hunter3")
    assert client.post(f"{API}/auth/login", json={"username": settings.auth_username, "password": "hunter2"}).status_code == 200
    assert client.get(f"{API}/categories").status_code == 200
