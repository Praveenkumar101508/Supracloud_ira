"""App-factory refactor equivalence — main.py's behavior moved, not changed.

The old main.py defined lifespan, middleware, auth endpoints and router
registration inline. They now live in app/lifespan.py, app/middleware.py,
auth/routes.py and app/routers.py, assembled by app.factory.create_app().
These tests prove the assembled app still exposes the same surface:

  - every auth endpoint at its original path
  - the canary honeypots registered BEFORE anything else (P5.2 ordering)
  - CORS + IP-blocklist middleware installed
  - the shared rate limiter attached to app.state
  - the /api/v1 prefix on every prefixed router
"""
import os
import sys

for _k in ("IRA_SECRET_KEY", "IRA_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "VLLM_API_KEY"):
    os.environ.setdefault(_k, "test-placeholder")

# The full app import pulls memory.embeddings and worker.notifier. conftest
# stubs those modules but leaves attributes the import chain references unset;
# fill them in (classes are never instantiated by these tests).
_st = sys.modules.get("sentence_transformers")
if _st is not None and not hasattr(_st, "SentenceTransformer"):
    _st.SentenceTransformer = object
    _st.CrossEncoder = object
_wn = sys.modules.get("worker.notifier")
if _wn is not None and not hasattr(_wn, "REDIS_NOTIFY_CHANNEL"):
    _wn.REDIS_NOTIFY_CHANNEL = "ira:notify"

import pytest

fastapi = pytest.importorskip("fastapi")
pytest.importorskip("slowapi")

from app.factory import create_app  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return create_app()


def _paths(app):
    return [getattr(r, "path", "") for r in app.routes]


def test_auth_endpoints_present_at_original_paths(app):
    paths = _paths(app)
    for p in ("/auth/token", "/auth/logout", "/auth/logout/all", "/auth/refresh"):
        assert p in paths, f"auth endpoint {p} missing after refactor"


def test_core_routes_present(app):
    paths = _paths(app)
    for p in ("/health", "/health/detail", "/api/v1/chat", "/api/v1/agents",
              "/api/v1/voice/transcribe", "/api/v1/voice/enroll"):
        assert p in paths, f"route {p} missing after refactor"


def test_canary_honeypots_registered_before_api_routes(app):
    """P5.2: honeypot paths must stay FIRST so no catch-all shadows them."""
    paths = _paths(app)
    api_indexes = [i for i, p in enumerate(paths) if p.startswith("/api/v1/")]
    canary_indexes = [i for i, p in enumerate(paths)
                      if "admin" in p or "wp-login" in p or ".env" in p]
    assert canary_indexes, "canary honeypot routes missing"
    assert min(canary_indexes) < min(api_indexes), "canary routes no longer registered first"


def test_middleware_installed(app):
    names = [m.cls.__name__ for m in app.user_middleware]
    assert "CORSMiddleware" in names
    assert "_IPBlockMiddleware" in names


def test_rate_limiter_attached_and_shared(app):
    from app.middleware import limiter
    assert app.state.limiter is limiter
    # main.py re-exports the same instance for backward compatibility
    import main as main_module
    assert main_module.limiter is limiter


def test_login_rate_limit_decorator_survived():
    """/auth/token keeps its 5/minute brute-force limit."""
    import inspect
    from auth import routes as auth_routes
    src = inspect.getsource(auth_routes)
    assert '@limiter.limit("5/minute")' in src
    assert '@limiter.limit("20/minute")' in src  # /auth/refresh


def test_lifespan_is_wired(app):
    """FastAPI may merge/wrap the lifespan; ours must be reachable inside it."""
    from app.lifespan import lifespan

    def _contains(fn, target, depth=0):
        if fn is target:
            return True
        # Starlette merges every router-level lifespan into a nested chain of
        # merged_lifespan closures — one level per included router.
        if depth > 100:
            return False
        for cell in getattr(fn, "__closure__", None) or ():
            try:
                inner = cell.cell_contents
            except ValueError:
                continue
            if callable(inner) and _contains(inner, target, depth + 1):
                return True
        return False

    assert _contains(app.router.lifespan_context, lifespan), \
        "app.lifespan.lifespan is not wired into the app"
