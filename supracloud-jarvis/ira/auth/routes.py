"""
Auth endpoints — /auth/token, /auth/logout, /auth/logout/all, /auth/refresh.

Registered directly on the app (not an APIRouter) exactly as they were in
`main.py`, so paths, decorators and rate limits are byte-for-byte unchanged.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, Form, Request
from fastapi.responses import JSONResponse
# OAuth2PasswordRequestForm is imported at MODULE scope. Under
# `from __future__ import annotations` FastAPI resolves the `form:` annotation as a
# ForwardRef against module globals; a local import leaves it unresolved -> the
# /auth/token route raises TypeError("ForwardRef(...) is not callable") at startup.
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.security import HTTPBearer as _HTTPBearer, HTTPAuthorizationCredentials as _Creds

from api.middleware.auth import (
    authenticate_user, create_login_tokens,
    decode_token, revoke_token, bump_token_version,
)
from utils.canary import check_canary_username

_bearer_dep = _HTTPBearer(auto_error=False)


def register_auth_routes(app: FastAPI, limiter) -> None:
    """Attach the auth endpoints to the app using the shared rate limiter."""

    @app.post("/auth/token", tags=["auth"], summary="Get JWT access + refresh tokens")
    @limiter.limit("5/minute")   # app-layer brute-force protection (nginx may be bypassed)
    async def login(
        request: Request,
        form: OAuth2PasswordRequestForm = Depends(OAuth2PasswordRequestForm),
        totp_code: str | None = Form(None),  # optional TOTP field
    ):
        from utils.account_lockout import is_locked, record_failure, clear_failures

        # P5.2: ghost-username tripwire — fires CRITICAL event, still returns 401
        source_ip = request.client.host if request.client else None
        if await check_canary_username(form.username, source_ip=source_ip):
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid credentials"},
            )

        # P2.3: check lockout BEFORE running bcrypt (avoid unnecessary CPU)
        if await is_locked(form.username):
            return JSONResponse(
                status_code=429,
                content={"detail": "Account temporarily locked due to too many failed attempts. Try again later."},
            )

        if not authenticate_user(form.username, form.password):
            _count, _locked = await record_failure(form.username)
            if _locked:
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Account locked after too many failed attempts. Try again in 15 minutes."},
                )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid credentials"},
            )

        # Only enforce TOTP once it has been enrolled and enabled
        from utils.db import acquire as _acquire
        async with _acquire() as conn:
            _totp_row = await conn.fetchrow(
                "SELECT secret FROM totp_secrets WHERE username=$1 AND enabled=TRUE", form.username
            )
        if _totp_row:
            import pyotp as _pyotp
            if not totp_code or not _pyotp.TOTP(_totp_row["secret"]).verify(totp_code, valid_window=1):
                await record_failure(form.username)
                return JSONResponse(
                    status_code=401,
                    content={"detail": "TOTP code required or invalid"},
                )

        # Successful login — clear the failure counter
        await clear_failures(form.username)
        # Record for the Trust Console (fail-soft: login never breaks on Redis)
        try:
            from datetime import datetime, timezone
            from api.routes.trust import LAST_LOGIN_KEY
            from utils.redis_client import get_redis
            await get_redis().set(LAST_LOGIN_KEY, datetime.now(timezone.utc).isoformat())
        except Exception:
            pass
        return await create_login_tokens(form.username)

    @app.post("/auth/logout", tags=["auth"], summary="Revoke the current access token")
    async def logout(
        request: Request,
        creds: _Creds | None = Depends(_bearer_dep),
    ):
        """Add the token's jti to the Redis revocation list so it can't be reused."""
        from datetime import datetime, timezone
        if creds is None:
            return JSONResponse(status_code=401, content={"detail": "No token provided"})
        try:
            payload = decode_token(creds.credentials)
            if payload.jti:
                remaining = int((payload.exp - datetime.now(timezone.utc)).total_seconds())
                await revoke_token(payload.jti, max(1, remaining))
        except Exception:
            pass  # always return success to avoid leaking token validity
        return {"message": "Logged out"}

    @app.post("/auth/logout/all", tags=["auth"], summary="Revoke ALL tokens for the current user")
    async def logout_all(
        request: Request,
        creds: _Creds | None = Depends(_bearer_dep),
    ):
        """Bump the per-user token version, invalidating every existing access token."""
        if creds is None:
            return JSONResponse(status_code=401, content={"detail": "No token provided"})
        payload = decode_token(creds.credentials)
        await bump_token_version(payload.sub)
        return {"message": f"All tokens for {payload.sub!r} have been invalidated"}

    @app.post("/auth/refresh", tags=["auth"], summary="Exchange a refresh token for a new access token")
    @limiter.limit("20/minute")
    async def refresh_token_endpoint(
        request: Request,
        creds: _Creds | None = Depends(_bearer_dep),
    ):
        """Verify the refresh token and issue a fresh short-lived access token."""
        from datetime import datetime, timezone
        from api.middleware.auth import _is_revoked, _get_token_version, _make_access_token
        if creds is None:
            return JSONResponse(status_code=401, content={"detail": "No token provided"})
        payload = decode_token(creds.credentials)
        if payload.tok != "refresh":
            return JSONResponse(status_code=400, content={"detail": "Not a refresh token"})
        if payload.jti and await _is_revoked(payload.jti):
            return JSONResponse(status_code=401, content={"detail": "Refresh token revoked"})
        ver = await _get_token_version(payload.sub)
        access_token, _, access_exp = _make_access_token(payload.sub, ver=ver)
        now = datetime.now(timezone.utc)
        from api.middleware.auth import TokenResponse as _TR
        return _TR(
            access_token=access_token,
            expires_in=max(0, int((access_exp - now).total_seconds())),
        )
