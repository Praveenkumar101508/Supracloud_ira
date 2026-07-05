"""Trust Console v1 — /api/v1/trust/status reports the true privacy posture.

Personal v1 requirement: the owner must be able to see, in one call, whether
IRA is fully local (external APIs off, model + DB local, no warnings) and what
needs attention. These tests pin:

  - local-first defaults report status=local_only with zero warnings
  - flipping IRA_ALLOW_EXTERNAL_API / DEV_MODE / a remote model URL each
    degrade status to "attention" with a matching warning
  - every probe is fail-soft: DB and Redis down -> unknowns, never a 500
"""
import os

for _k in ("IRA_SECRET_KEY", "IRA_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "VLLM_API_KEY"):
    os.environ.setdefault(_k, "test-placeholder")

import asyncio

import pytest

pytest.importorskip("fastapi")

import api.routes.trust as trust


class _Cfg:
    dev_mode = False
    ira_secret_key = "a-real-secret"
    ira_admin_password = "a-real-password"
    ira_allow_external_api = False
    ira_require_api_consent = True
    ira_privacy_mode = "local_first"
    web_search_enabled = False
    llm_backend = "ollama"
    ollama_base_url = "http://localhost:11434/v1"
    ira_model_profile = "balanced_local"
    postgres_host = "localhost"
    embedding_model = "BAAI/bge-large-en-v1.5"
    embedding_device = "cpu"


def _patch_env_probes(monkeypatch, cfg):
    monkeypatch.setattr(trust, "get_settings", lambda: cfg)
    # the sovereignty helpers read os.environ directly — keep them quiet
    monkeypatch.setattr(trust, "cortex_local_only_warning", lambda: None)
    monkeypatch.setattr(trust, "research_backends_warning", lambda: None)


async def _voice_ok():
    return True


async def _login_none():
    return None


def test_local_defaults_report_local_only(monkeypatch):
    cfg = _Cfg()
    _patch_env_probes(monkeypatch, cfg)
    monkeypatch.setattr(trust, "_voice_enrolled", _voice_ok)
    monkeypatch.setattr(trust, "_last_login", _login_none)
    monkeypatch.setattr(trust, "_pending_actions", lambda: 0)

    out = asyncio.run(trust.trust_status(_user="owner"))
    assert out["status"] == "local_only"
    assert out["security_warnings"] == []
    assert out["privacy"]["external_api_allowed"] is False
    assert out["model"]["local"] is True
    assert out["database"]["local"] is True
    assert out["memory"]["local"] is True
    assert out["voice_profile"]["enrolled"] is True
    assert out["pending_actions"] == 0


@pytest.mark.parametrize("attr,value,needle", [
    ("ira_allow_external_api", True, "IRA_ALLOW_EXTERNAL_API"),
    ("dev_mode", True, "DEV_MODE"),
    ("ollama_base_url", "https://api.example.com/v1", "not local"),
    ("ira_secret_key", "CHANGE_ME_ira_secret_key_here", "IRA_SECRET_KEY"),
])
def test_unsafe_setting_degrades_status_with_warning(monkeypatch, attr, value, needle):
    cfg = _Cfg()
    setattr(cfg, attr, value)
    _patch_env_probes(monkeypatch, cfg)
    monkeypatch.setattr(trust, "_voice_enrolled", _voice_ok)
    monkeypatch.setattr(trust, "_last_login", _login_none)
    monkeypatch.setattr(trust, "_pending_actions", lambda: 0)

    out = asyncio.run(trust.trust_status(_user="owner"))
    assert out["status"] == "attention"
    assert any(needle in w for w in out["security_warnings"]), out["security_warnings"]


def test_pending_actions_counted(monkeypatch):
    cfg = _Cfg()
    _patch_env_probes(monkeypatch, cfg)
    monkeypatch.setattr(trust, "_voice_enrolled", _voice_ok)
    monkeypatch.setattr(trust, "_last_login", _login_none)
    monkeypatch.setattr(trust, "_pending_actions", lambda: 3)

    out = asyncio.run(trust.trust_status(_user="owner"))
    assert out["pending_actions"] == 3


def test_fail_soft_when_db_and_redis_down(monkeypatch):
    """DB/Redis down -> unknown fields (None), never an exception."""
    cfg = _Cfg()
    _patch_env_probes(monkeypatch, cfg)
    # do NOT patch the probes — let them hit the stubbed (broken) utils.db /
    # utils.redis_client and prove they swallow the failure.
    out = asyncio.run(trust.trust_status(_user="owner"))
    assert out["voice_profile"]["enrolled"] is None
    assert out["last_login"] is None
    assert out["status"] in ("local_only", "attention")


def test_web_search_enabled_is_not_local_only(monkeypatch):
    cfg = _Cfg()
    cfg.web_search_enabled = True
    _patch_env_probes(monkeypatch, cfg)
    monkeypatch.setattr(trust, "_voice_enrolled", _voice_ok)
    monkeypatch.setattr(trust, "_last_login", _login_none)
    monkeypatch.setattr(trust, "_pending_actions", lambda: 0)

    out = asyncio.run(trust.trust_status(_user="owner"))
    assert out["status"] == "attention"
