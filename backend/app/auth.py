"""Single-user login.

The browser only ever talks to the Next.js proxy, which forwards the session
cookie. A session is an HMAC-signed ``user.expiry`` token in an HttpOnly,
SameSite=Lax cookie; the key is derived from the configured password, so it
survives restarts and changing the password signs everyone out.
"""

import base64
import hashlib
import hmac
import secrets
import time
from typing import Annotated

from fastapi import Depends, HTTPException, Request

from app.config import Settings, get_settings

COOKIE = "hoardware_session"
# Reachable without a session: the login endpoints and the health check.
OPEN_PATHS = {"/api/v1/health", "/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/status"}

_ITERATIONS = 240_000


def auth_enabled(settings: Settings) -> bool:
    return bool(settings.auth_password or settings.auth_password_hash)


def hash_password(password: str, *, iterations: int = _ITERATIONS) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    return f"pbkdf2_sha256:{iterations}:{salt}:{digest}"


def _check_hash(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, digest = stored.split(":")
        if scheme != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    except ValueError:
        return False
    return hmac.compare_digest(candidate, digest)


def check_credentials(settings: Settings, username: str, password: str) -> bool:
    # Both checks always run, so timing does not reveal which one was wrong.
    user_ok = hmac.compare_digest(username.encode(), settings.auth_username.encode())
    if settings.auth_password_hash:
        pass_ok = _check_hash(password, settings.auth_password_hash)
    else:
        pass_ok = hmac.compare_digest(password.encode(), (settings.auth_password or "").encode())
    return user_ok and pass_ok


def _key(settings: Settings) -> bytes:
    secret = settings.auth_password_hash or settings.auth_password or ""
    return hashlib.sha256(b"hoardware-session|" + secret.encode()).digest()


def _sign(settings: Settings, payload: str) -> str:
    mac = hmac.new(_key(settings), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def make_token(settings: Settings, username: str, now: float | None = None) -> str:
    expires = int((now if now is not None else time.time()) + settings.auth_session_days * 86400)
    payload = f"{base64.urlsafe_b64encode(username.encode()).decode().rstrip('=')}.{expires}"
    return f"{payload}.{_sign(settings, payload)}"


def read_token(settings: Settings, token: str | None, now: float | None = None) -> str | None:
    """The username a valid, unexpired token was issued to, else None."""
    if not token:
        return None
    try:
        user_b64, expires, signature = token.split(".")
        payload = f"{user_b64}.{expires}"
        if not hmac.compare_digest(signature, _sign(settings, payload)):
            return None
        if int(expires) < (now if now is not None else time.time()):
            return None
        return base64.urlsafe_b64decode(user_b64 + "=" * (-len(user_b64) % 4)).decode()
    except (ValueError, UnicodeDecodeError):
        return None


def current_user(request: Request) -> str | None:
    settings = get_settings()
    if not auth_enabled(settings):
        return settings.auth_username
    return read_token(settings, request.cookies.get(COOKIE))


def require_auth(request: Request) -> None:
    """App-wide dependency: everything but OPEN_PATHS needs a valid session."""
    if request.url.path in OPEN_PATHS:
        return
    if current_user(request) is None:
        raise HTTPException(401, "Sign in required", headers={"WWW-Authenticate": "Cookie"})


AuthDep = Annotated[None, Depends(require_auth)]
