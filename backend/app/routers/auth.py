import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app import auth
from app.config import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])

# Failed sign-ins in the last WINDOW seconds; one user, so one counter is enough.
MAX_FAILURES = 8
WINDOW = 600
_failures: list[float] = []
_lock = threading.Lock()


class LoginIn(BaseModel):
    username: str = Field(max_length=200)
    password: str = Field(max_length=1000)


class StatusOut(BaseModel):
    auth_required: bool
    authenticated: bool
    username: str | None = None


def _secure(request: Request) -> bool:
    mode = get_settings().auth_cookie_secure
    if mode != "auto":
        return mode == "always"
    return request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip() == "https"


@router.get("/status", response_model=StatusOut)
def status(request: Request):
    settings = get_settings()
    if not auth.auth_enabled(settings):
        return StatusOut(auth_required=False, authenticated=True, username=None)
    user = auth.current_user(request)
    return StatusOut(auth_required=True, authenticated=user is not None, username=user)


@router.post("/login", response_model=StatusOut)
def login(body: LoginIn, request: Request, response: Response):
    settings = get_settings()
    if not auth.auth_enabled(settings):
        raise HTTPException(400, "Login is not enabled")
    now = time.time()
    with _lock:
        _failures[:] = [t for t in _failures if now - t < WINDOW]
        if len(_failures) >= MAX_FAILURES:
            raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
    if not auth.check_credentials(settings, body.username, body.password):
        with _lock:
            _failures.append(now)
        raise HTTPException(401, "Wrong username or password")
    with _lock:
        _failures.clear()
    response.set_cookie(
        auth.COOKIE,
        auth.make_token(settings, settings.auth_username),
        max_age=settings.auth_session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        path="/",
    )
    return StatusOut(auth_required=True, authenticated=True, username=settings.auth_username)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    response.delete_cookie(auth.COOKIE, path="/", httponly=True, samesite="lax", secure=_secure(request))
    response.status_code = 204
    return response
