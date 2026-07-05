"""
SupraCloud IRA — FastAPI application entry point (`uvicorn main:app`).

The application is assembled by `app.factory.create_app`:
  - startup/shutdown sequence  → app/lifespan.py
  - rate limit / CORS / IP block → app/middleware.py
  - auth endpoints             → auth/routes.py
  - router registration        → app/routers.py
"""

from __future__ import annotations

import logging

from app.factory import create_app
from app.middleware import limiter  # re-export: shared rate limiter instance

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("ira")

app = create_app()

# Auto-instrument FastAPI routes (adds trace spans for every HTTP request)
try:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app)
    logger.info("OpenTelemetry FastAPI instrumentation active")
except Exception:
    pass  # telemetry is always optional
