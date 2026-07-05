"""
HTTP middleware — rate limiting, CORS and the IP blocklist.

`limiter` lives here so both the app factory and the auth routes share one
instance (the same object `main.py` used to define at module scope).
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as _Response

# ── Rate limiter ───────────────────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)


class _IPBlockMiddleware(BaseHTTPMiddleware):
    # P6.2: IP blocklist middleware — runs before all routes; blocked IPs get 403
    async def dispatch(self, request: Request, call_next):
        if request.client:
            from utils.playbooks import is_ip_blocked
            if await is_ip_blocked(request.client.host):
                return _Response(
                    content='{"detail":"Access denied"}',
                    status_code=403,
                    media_type="application/json",
                )
        return await call_next(request)


def install_middleware(app: FastAPI, cfg) -> None:
    """Attach rate limiting, CORS and the IP blocklist to the app."""
    # Rate limiting
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # CORS — only allow localhost in development; production uses domain only
    allowed_origins = [f"https://{cfg.ira_domain}"]
    if cfg.dev_mode:
        allowed_origins += ["http://localhost:3000", "http://127.0.0.1:3000"]
    # Phone access over Tailscale Serve (HTTPS) — allow the *.ts.net origin so the
    # mobile PWA's mic (getUserMedia needs a secure context) and API calls work.
    if getattr(cfg, "ira_ts_host", ""):
        allowed_origins.append(f"https://{cfg.ira_ts_host}")
    # Fix #45: PATCH and PUT were missing — endpoints that use them (architect
    # apply, profile updates) would fail CORS preflight in the browser. OPTIONS
    # is implied by CORSMiddleware but listed explicitly for clarity.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.add_middleware(_IPBlockMiddleware)
