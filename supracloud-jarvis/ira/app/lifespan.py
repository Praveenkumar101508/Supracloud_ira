"""
Application lifespan — startup and shutdown sequence.

Startup:
  1. Connect to PostgreSQL pool (+ run durable migrations)
  2. Connect to Redis
  3. Warm the BGE embedding model (background, CPU)
  4. Pre-warm the Supertonic TTS engine (background, fail-soft)
  5. Compile the LangGraph agent graph (persistent checkpointer)
  6. Start the optional brain / voice-output / wake-word loops (all OFF by default)

Shutdown: stop the loops, close the checkpointer, DB pool and Redis.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from config import get_settings

# NOTE: DB / Redis / embeddings / graph imports are deliberately lazy (inside the
# functions below). They pull native deps (asyncpg, sentence-transformers) that the
# lightweight test environment stubs out — importing them here would make the app
# factory untestable without the full stack, and startup behavior is unchanged.

logger = logging.getLogger("ira")


async def _validate_config(cfg) -> None:
    """Warn about common misconfiguration issues at startup."""
    warnings = []

    if cfg.owner_name in ("CHANGE_ME_your_name", "", "Change Me", "Your Name Here"):
        warnings.append("OWNER_NAME is not set to your real name")

    if cfg.ira_admin_password in ("CHANGE_ME_strong_password_here", "admin", "password"):
        warnings.append("IRA_ADMIN_PASSWORD is using the default placeholder — change it!")

    if cfg.ira_secret_key in ("CHANGE_ME_ira_secret_key_here", ""):
        warnings.append("IRA_SECRET_KEY is not set — JWT security is broken!")

    if not getattr(cfg, "telegram_bot_token", None) and not getattr(cfg, "smtp_host", None):
        warnings.append("No notification channel configured (Telegram or SMTP) — alerts will not be delivered")

    for w in warnings:
        logger.warning(f"⚠️  CONFIG WARNING: {w}")

    if any("broken" in w.lower() or "not set" in w.lower() for w in warnings):
        logger.warning("Fix the above config warnings before going to production.")

    # Sovereignty guard: if the Cortex engine is ON, its gateway MUST be local or
    # prompts could leave the box via a remote gateway. Warn loudly; never block.
    from config import cortex_local_only_warning, research_backends_warning
    _cortex_leak = cortex_local_only_warning()
    if _cortex_leak:
        logger.warning("=" * 70)
        logger.warning("⚠️  CORTEX SOVEREIGNTY WARNING  ⚠️")
        logger.warning(f"   {_cortex_leak}")
        logger.warning("   Point IRA_CORTEX_URL at 127.0.0.1/localhost unless you")
        logger.warning("   truly intend to route through a remote (cloud) gateway.")
        logger.warning("=" * 70)

    # Same for the web-research backends (SearXNG / Crawl4AI) — keep them local.
    _research_leak = research_backends_warning()
    if _research_leak:
        logger.warning("=" * 70)
        logger.warning("⚠️  WEB-RESEARCH SOVEREIGNTY WARNING  ⚠️")
        logger.warning(f"   {_research_leak}")
        logger.warning("   Point SEARXNG_URL / CRAWL4AI_URL at local/self-hosted endpoints.")
        logger.warning("=" * 70)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from utils.db import init_pool, close_pool
    from utils.redis_client import init_redis, close_redis
    from agents.graph import init_checkpointer, close_checkpointer

    cfg = get_settings()

    # Initialise OpenTelemetry (no-op if OTLP_ENDPOINT not set)
    from utils.telemetry import setup_telemetry
    setup_telemetry(service_name="ira-api")

    if cfg.dev_mode:
        # Fix P9: refuse to start DEV_MODE against a public domain to prevent
        # accidentally exposing a fully open admin endpoint on the internet.
        if not cfg.is_local_domain:
            raise RuntimeError(
                f"DEV_MODE=true is set but IRA_DOMAIN={cfg.ira_domain!r} is not a "
                "localhost/private address. Refusing to start — this would expose an "
                "unauthenticated admin endpoint on a public domain. "
                "Set DEV_MODE=false or use a local domain."
            )
        logger.warning("=" * 70)
        logger.warning("⚠️  DEV_MODE ENABLED — AUTH AND BIOMETRICS ARE DISABLED  ⚠️")
        logger.warning("   - Authentication bypassed (any token accepted)")
        logger.warning("   - Biometric gate disabled (all requests treated as owner)")
        logger.warning("   - All LLM calls routed to local Ollama")
        logger.warning("   NEVER USE IN PRODUCTION!")
        logger.warning("=" * 70)
    logger.info(f"IRA {cfg.ira_version} starting up...")

    # Initialise connections
    await init_pool()
    logger.info("PostgreSQL pool ready")

    # Fix P22: run durable schema migrations on every boot so upgrades work on
    # existing volumes (docker-entrypoint-initdb.d only fires on brand-new volumes).
    from utils.migrations import run_migrations
    from utils.db import get_pool
    await run_migrations(get_pool())

    await init_redis()
    logger.info("Redis connection ready")

    # Warm embedding model in background — don't block startup
    import asyncio
    _t = asyncio.create_task(_warm_embeddings())
    _t.add_done_callback(lambda t: t.exception() and logger.warning(f"Embedding warm-up failed: {t.exception()}"))

    # Pre-warm the on-device Supertonic TTS so the first POST /voice/say is not cold.
    _ts = asyncio.create_task(_warm_supertonic())
    _ts.add_done_callback(lambda t: t.exception() and logger.warning(f"Supertonic warm-up failed: {t.exception()}"))

    # Initialise LangGraph checkpointer (AsyncPostgresSaver → persistent state)
    await init_checkpointer(cfg.database_dsn)
    logger.info("LangGraph agent graph compiled")

    await _validate_config(cfg)

    # Continuous realtime brain — persistent background loop (OFF by default).
    from api.routes.brain import start_brain, stop_brain
    await start_brain(app)

    # Local voice output — speak brain replies aloud (OFF by default). After the brain.
    from voice.voice_output import start_voice_output, stop_voice_output
    await start_voice_output(app, getattr(app.state, "brain", None))

    # Always-on, owner-gated wake-word listener (OFF by default).
    from voice.wakeword import start_wakeword, stop_wakeword
    await start_wakeword(app)

    logger.info("IRA is online. Good morning.")
    yield

    # Graceful shutdown
    await stop_wakeword(app)
    await stop_voice_output(app)
    await stop_brain(app)
    await close_checkpointer()
    await close_pool()
    await close_redis()
    logger.info("IRA shutting down. Goodbye.")


async def _warm_embeddings():
    import asyncio
    await asyncio.sleep(2)  # Let the server finish starting first
    try:
        from memory.embeddings import preload_model
        preload_model()
        logger.info("BGE embedding model warmed and ready")
    except Exception as e:
        logger.warning(f"Embedding model warm-up failed: {e}")

    # A2: warm the reranker cross-encoder too (only if enabled) so the first
    # memory query isn't slowed by the one-time model load.
    cfg = get_settings()
    if cfg.reranker_enabled:
        try:
            from memory.reranker import preload_model as preload_reranker
            preload_reranker()
            logger.info("BGE reranker model warmed and ready")
        except Exception as e:
            logger.warning(f"Reranker model warm-up failed: {e}")


async def _warm_supertonic():
    """Load the on-device Supertonic TTS engine once at startup (fail-soft).

    Runs the blocking model load off the event loop. If Supertonic isn't installed
    (e.g. a text-only deployment), this is a no-op and POST /voice/say returns 503
    until the engine is available — it never blocks or fails startup.
    """
    import asyncio
    await asyncio.sleep(2)  # let the server finish starting first
    try:
        from voice.tts_supertonic import prewarm
        ready = await asyncio.to_thread(prewarm)
        if ready:
            logger.info("Supertonic TTS engine warmed and ready")
        else:
            logger.info("Supertonic TTS not available — /voice/say will 503 until installed")
    except Exception as e:
        logger.info(f"Supertonic warm-up skipped: {e}")
