"""
App factory — assembles the FastAPI application.

Pieces: lifespan (app.lifespan), middleware (app.middleware), auth endpoints
(auth.routes) and all routers (app.routers). Behavior is identical to the old
inline main.py; only the layout changed.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import get_settings

from app.lifespan import lifespan
from app.middleware import install_middleware, limiter
from app.routers import register_routers
from auth.routes import register_auth_routes

logger = logging.getLogger("ira")


def create_app() -> FastAPI:
    cfg = get_settings()

    app = FastAPI(
        title="SupraCloud IRA",
        description="Private sovereign AI assistant — fully self-hosted.",
        version=cfg.ira_version,
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    install_middleware(app, cfg)
    register_auth_routes(app, limiter)
    register_routers(app)

    # ── Global error handler ──────────────────────────────────────────────────
    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        logger.error(f"Unhandled error: {exc}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"detail": "An internal error occurred. IRA is investigating."},
        )

    return app
