"""
Router registration — every API router IRA exposes, in registration order.

Order matters in two places: canary honeypot paths must be registered before
any catch-all, and health stays unprefixed for probes.
"""

from __future__ import annotations

from fastapi import FastAPI

from api.routes.chat import router as chat_router
from api.routes.health import router as health_router
from api.routes.agents import router as agents_router
from api.routes.tasks import router as tasks_router
from api.routes.notifications import router as notifications_router
from api.routes.briefing import router as briefing_router
from api.routes.voice import router as voice_router
from api.routes.webhooks import router as webhooks_router
from api.routes.backup import router as backup_router
from api.routes.image_gen import router as image_gen_router
from api.routes.architect import router as architect_router
from api.routes.video_gen import router as video_gen_router
from api.routes.document_create import router as document_create_router
from api.routes.design_tools import router as design_tools_router
from api.routes.computer_use import router as computer_use_router
from api.routes.audio_gen import router as audio_gen_router
from api.routes.deep_research import router as deep_research_router
from api.routes.multimodal import router as multimodal_router
from api.routes.strategy import router as strategy_router
from utils.canary import canary_router


def register_routers(app: FastAPI) -> None:
    """Include every router on the app (same order as the old main.py)."""
    # P5.2: honeypot paths FIRST — must be registered before any catch-all 404
    app.include_router(canary_router)
    app.include_router(health_router)
    app.include_router(chat_router, prefix="/api/v1")
    app.include_router(agents_router, prefix="/api/v1")
    app.include_router(tasks_router, prefix="/api/v1")
    app.include_router(briefing_router, prefix="/api/v1")
    app.include_router(notifications_router)         # /notifications + /ws/notifications
    app.include_router(voice_router, prefix="/api/v1")   # /voice/token + /voice/enroll
    app.include_router(webhooks_router)              # /webhooks/lead + /webhooks/booking
    app.include_router(backup_router, prefix="/api/v1")      # /backup/list + /backup/download + /backup/restore
    app.include_router(image_gen_router, prefix="/api/v1")       # /image/generate + /image/edit
    app.include_router(architect_router, prefix="/api/v1")       # /architect/propose + /implement + /apply
    app.include_router(video_gen_router, prefix="/api/v1")       # /video/generate + /video/understand
    app.include_router(document_create_router, prefix="/api/v1") # /document/create + /document/download
    app.include_router(design_tools_router, prefix="/api/v1")    # /design/generate + /design/download
    app.include_router(computer_use_router, prefix="/api/v1")    # /computer/use + /computer/screenshot
    app.include_router(audio_gen_router, prefix="/api/v1")       # /audio/generate + /audio/tts + /audio/transcribe
    app.include_router(deep_research_router, prefix="/api/v1")   # /research/deep + /research/article + /research/report
    app.include_router(multimodal_router, prefix="/api/v1")      # /multimodal/analyse
    app.include_router(strategy_router, prefix="/api/v1")        # Phase 6: /strategy/outcome + /strategy/predictions

    from api.routes.files import router as files_router
    app.include_router(files_router, prefix="/api/v1")           # Feat P25: /files upload/list/download/delete

    from api.routes.totp import router as totp_router
    app.include_router(totp_router)                              # Feat P26: /auth/totp/enroll + /auth/totp/verify

    from api.routes.calendar import router as calendar_router
    app.include_router(calendar_router, prefix="/api/v1")        # Feat P27: /calendar/event create + cancel

    from api.routes.profile import router as profile_router
    app.include_router(profile_router, prefix="/api/v1")         # v1 1.4: /profile owner profile (GET/PUT)

    from api.routes.actions import router as actions_router
    app.include_router(actions_router, prefix="/api/v1")         # v1 2.3: /actions (email-with-approval, status)

    from api.routes.research import router as research_router
    app.include_router(research_router, prefix="/api/v1")        # v1 3B.2: /research (web search/read) + doctor

    from api.routes.notes import router as notes_router
    app.include_router(notes_router, prefix="/api/v1")           # Phase 3: /notes (local-first markdown, delete gated)

    from api.routes.calendar_dav import router as calendar_dav_router
    app.include_router(calendar_dav_router, prefix="/api/v1")    # Phase 3: /calendar/dav (local-first CalDAV, create/delete gated)

    from api.routes.android import router as android_router
    app.include_router(android_router, prefix="/api/v1")         # Phase 5: /android (experimental actuator, OFF by default)

    from api.routes.brain import router as brain_router
    app.include_router(brain_router)                             # /ws/brain (continuous brain, OFF by default)

    from api.routes.mobile import router as mobile_router
    app.include_router(mobile_router)                            # /mobile/* (mobile app support, push OFF by default)
