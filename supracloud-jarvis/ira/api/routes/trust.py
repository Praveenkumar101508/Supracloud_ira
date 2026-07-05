"""
Trust Console v1 — GET /api/v1/trust/status.

One owner-facing endpoint that answers the question "is IRA actually local and
safe right now?" in a single glance:

  - privacy mode + external-API master switch (+ consent flag)
  - where the model runs (backend, URL, is it local?)
  - where the database / memory lives (is it local?)
  - voice profile enrollment state
  - pending approval-gated actions
  - last successful owner login
  - active security warnings (placeholder secrets, DEV_MODE, sovereignty leaks)

Every probe is fail-soft: a subsystem being down yields "unknown" for that
field, never a 500 — the console must work exactly when things are broken.
"""

from __future__ import annotations

import logging
from urllib.parse import urlparse

from fastapi import APIRouter, Depends

from api.middleware.auth import require_auth
from config import (
    get_settings,
    cortex_local_only_warning,
    research_backends_warning,
    _is_local_or_private_host,
)

logger = logging.getLogger("ira.trust")

router = APIRouter(prefix="/trust", tags=["trust"])

LAST_LOGIN_KEY = "ira:last_login"


def _url_is_local(url: str) -> bool:
    return _is_local_or_private_host(urlparse(url).hostname or "")


async def _voice_enrolled() -> bool | None:
    """True/False from the voice_profiles table; None when the DB is unreachable."""
    try:
        from utils.db import acquire
        async with acquire() as conn:
            row = await conn.fetchrow("SELECT 1 FROM voice_profiles LIMIT 1")
        return row is not None
    except Exception:
        return None


async def _last_login() -> str | None:
    """ISO timestamp of the last successful login (recorded by /auth/token)."""
    try:
        from utils.redis_client import get_redis
        raw = await get_redis().get(LAST_LOGIN_KEY)
        return raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
    except Exception:
        return None


def _pending_actions() -> int | None:
    try:
        from utils.approval import guardrail
        return guardrail.pending_count()
    except Exception:
        return None


def _security_warnings(cfg) -> list[str]:
    warnings: list[str] = []
    if cfg.dev_mode:
        warnings.append("DEV_MODE is ON — auth and biometrics are bypassed")
    if cfg.ira_secret_key in ("CHANGE_ME_ira_secret_key_here", ""):
        warnings.append("IRA_SECRET_KEY is a placeholder — JWT security is broken")
    if cfg.ira_admin_password in ("CHANGE_ME_strong_password_here", "admin", "password"):
        warnings.append("IRA_ADMIN_PASSWORD is a default placeholder")
    if cfg.ira_allow_external_api:
        warnings.append("IRA_ALLOW_EXTERNAL_API is ON — cloud API calls are permitted")
    _cortex = cortex_local_only_warning()
    if _cortex:
        warnings.append(_cortex)
    _research = research_backends_warning()
    if _research:
        warnings.append(_research)
    if not _url_is_local(cfg.ollama_base_url):
        warnings.append(
            f"OLLAMA_BASE_URL={cfg.ollama_base_url!r} is not local — prompts would leave the box"
        )
    return warnings


@router.get("/status")
async def trust_status(_user: str = Depends(require_auth)):
    """Owner-only snapshot of IRA's privacy / locality posture."""
    cfg = get_settings()

    model_local = _url_is_local(cfg.ollama_base_url)
    db_local = _is_local_or_private_host(cfg.postgres_host)
    warnings = _security_warnings(cfg)

    external_off = not cfg.ira_allow_external_api and not cfg.web_search_enabled
    all_local = model_local and db_local
    status = "local_only" if (external_off and all_local and not warnings) else "attention"

    return {
        "status": status,
        "privacy": {
            "mode": cfg.ira_privacy_mode,
            "external_api_allowed": cfg.ira_allow_external_api,
            "api_consent_required": cfg.ira_require_api_consent,
            "web_search_enabled": cfg.web_search_enabled,
        },
        "model": {
            "backend": cfg.llm_backend,
            "base_url": cfg.ollama_base_url,
            "local": model_local,
            "profile": cfg.ira_model_profile,
        },
        "database": {
            "host": cfg.postgres_host,
            "local": db_local,
        },
        "memory": {
            "store": "postgres+pgvector",
            "local": db_local,
            "embedding_model": cfg.embedding_model,
            "embedding_device": cfg.embedding_device,
        },
        "voice_profile": {
            "enrolled": await _voice_enrolled(),
        },
        "pending_actions": _pending_actions(),
        "last_login": await _last_login(),
        "security_warnings": warnings,
    }
