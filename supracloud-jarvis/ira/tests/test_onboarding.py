"""PR #66 — first-run onboarding + owner identity fields.

Covers: first-run detection, completing setup (name/title/wake word stored,
first_run_completed flips only via /complete), the role staying read-only,
input cleaning, the preferred-address block in the prompt summary, and — the
safety rule — destructive actions staying confirmation-gated for the owner
regardless of role/onboarding state.

The DB is faked at the owner_profile.acquire seam so the real SQL paths
(field filtering, parameter building) are exercised without Postgres.
"""
from __future__ import annotations

import contextlib
from unittest.mock import AsyncMock

import pytest

import owner_profile


# ── Fake DB seam ─────────────────────────────────────────────────────────────

class _FakeConn:
    """Records execute() calls; fetchrow returns a canned row (or None)."""

    def __init__(self, row=None):
        self.row = row
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))

    async def fetchrow(self, sql, *args):
        return self.row


class _FakeRow(dict):
    def keys(self):  # asyncpg.Record-style keys()
        return list(super().keys())


def _patch_db(monkeypatch, conn: _FakeConn):
    @contextlib.asynccontextmanager
    async def fake_acquire():
        yield conn

    monkeypatch.setattr(owner_profile, "acquire", fake_acquire)


# ── First-run detection ──────────────────────────────────────────────────────

async def test_first_run_is_false_when_profile_missing(monkeypatch):
    """No row / fresh install → first_run_completed False → wizard shows."""
    _patch_db(monkeypatch, _FakeConn(row=None))
    profile = await owner_profile.get_profile()
    assert profile["first_run_completed"] is False
    assert profile["role"] == "owner_admin"
    assert profile["wake_word"] == "ira"


async def test_first_run_is_false_when_db_down(monkeypatch):
    """DB unavailable must fail safe to 'not completed', never crash."""
    @contextlib.asynccontextmanager
    async def broken_acquire():
        raise RuntimeError("db down")
        yield  # pragma: no cover

    monkeypatch.setattr(owner_profile, "acquire", broken_acquire)
    profile = await owner_profile.get_profile()
    assert profile["first_run_completed"] is False


async def test_status_route_reports_first_run(monkeypatch):
    from api.routes.onboarding import onboarding_status

    monkeypatch.setattr(
        owner_profile, "get_profile", AsyncMock(return_value=dict(owner_profile._EMPTY))
    )
    out = await onboarding_status(_user="owner")
    assert out.first_run_completed is False
    assert out.role == "owner_admin"


# ── Completing onboarding ────────────────────────────────────────────────────

async def test_complete_onboarding_stores_choices_and_flips_flag(monkeypatch):
    captured: dict = {}

    async def fake_update(**kwargs):
        captured.update(kwargs)
        return {**owner_profile._EMPTY, **kwargs, "name": kwargs.get("name", "")}

    monkeypatch.setattr(owner_profile, "update_profile", fake_update)

    from api.routes.onboarding import complete_onboarding, CompleteBody

    out = await complete_onboarding(
        CompleteBody(owner_name="Praveen", preferred_title="Boss", wake_word="IRA", voice_enabled=True),
        _user="owner",
    )
    assert captured["name"] == "Praveen"
    assert captured["preferred_title"] == "Boss"
    assert captured["wake_word"] == "ira"          # normalised to lowercase
    assert captured["voice_enabled"] is True
    assert captured["first_run_completed"] is True  # flips ONLY here
    assert "role" not in captured                   # role is never written
    assert out.preferred_title == "Boss"


async def test_complete_rejects_blank_name(monkeypatch):
    from fastapi import HTTPException
    from api.routes.onboarding import complete_onboarding, CompleteBody

    monkeypatch.setattr(owner_profile, "update_profile", AsyncMock())
    with pytest.raises(HTTPException) as exc:
        await complete_onboarding(CompleteBody(owner_name="\x00\x01 "), _user="owner")
    assert exc.value.status_code == 400


async def test_complete_strips_control_characters(monkeypatch):
    captured: dict = {}

    async def fake_update(**kwargs):
        captured.update(kwargs)
        return {**owner_profile._EMPTY, **kwargs}

    monkeypatch.setattr(owner_profile, "update_profile", fake_update)

    from api.routes.onboarding import complete_onboarding, CompleteBody

    await complete_onboarding(
        CompleteBody(owner_name="Pra\x00veen\n", preferred_title="bo\x07ss"),
        _user="owner",
    )
    assert captured["name"] == "Praveen"
    assert captured["preferred_title"] == "boss"


async def test_reset_rearms_the_wizard(monkeypatch):
    captured: dict = {}

    async def fake_update(**kwargs):
        captured.update(kwargs)
        return {**owner_profile._EMPTY, **kwargs}

    monkeypatch.setattr(owner_profile, "update_profile", fake_update)

    from api.routes.onboarding import reset_onboarding

    out = await reset_onboarding(_user="owner")
    assert captured == {"first_run_completed": False}
    assert out.first_run_completed is False


# ── Role is read-only; store filters unknown fields ──────────────────────────

async def test_update_profile_never_writes_role(monkeypatch):
    conn = _FakeConn(row=None)
    _patch_db(monkeypatch, conn)
    await owner_profile.update_profile(role="super_admin", name="Praveen")
    updates = [sql for sql, _ in conn.executed if sql.strip().startswith("UPDATE")]
    assert len(updates) == 1
    assert "role" not in updates[0]
    assert "name = $1" in updates[0]


async def test_update_profile_handles_bools_and_text(monkeypatch):
    conn = _FakeConn(row=None)
    _patch_db(monkeypatch, conn)
    await owner_profile.update_profile(voice_enabled=True, preferred_title="boss")
    sql, args = [c for c in conn.executed if c[0].strip().startswith("UPDATE")][0]
    assert set(args) == {True, "boss"}


async def test_get_profile_returns_extended_fields(monkeypatch):
    row = _FakeRow(
        name="Praveen", goals="", projects="", preferences="",
        preferred_title="boss", wake_word="ira", role="owner_admin",
        first_run_completed=True, voice_enabled=False,
    )
    _patch_db(monkeypatch, _FakeConn(row=row))
    profile = await owner_profile.get_profile()
    assert profile["preferred_title"] == "boss"
    assert profile["first_run_completed"] is True
    assert profile["role"] == "owner_admin"


# ── Preferred address reaches the brain (via the injected summary) ──────────

def test_summarize_includes_preferred_address():
    s = owner_profile.summarize(
        {**owner_profile._EMPTY, "name": "Praveen", "preferred_title": "boss"}
    )
    assert "Preferred address" in s
    assert "'boss'" in s
    assert "not in every sentence" in s   # anti-overuse guidance ships with it


def test_summarize_without_title_has_no_address_block():
    s = owner_profile.summarize({**owner_profile._EMPTY, "name": "Praveen"})
    assert "Preferred address" not in s


def test_summarize_stays_compatible_with_legacy_four_field_profiles():
    # Callers may still pass the pre-#66 four-key dict.
    s = owner_profile.summarize(
        {"name": "Praveen", "goals": "Ship v1", "projects": "IRA", "preferences": ""}
    )
    assert s.startswith("Owner profile")
    assert "Ship v1" in s


# ── Safety: owner still confirms destructive actions ────────────────────────

async def test_destructive_actions_still_require_confirmation_for_owner():
    """owner_admin + completed onboarding grants NO bypass: without a token the
    guardrail stages a draft and nothing executes."""
    from utils.approval import owner_gated_action, ApprovalGuardrail

    executed = []

    async def _do():
        executed.append(True)
        return {"done": True}

    outcome = await owner_gated_action(
        owner_username="owner", is_owner=True,
        action="forget_memory", preview="delete something",
        execute=_do, confirm_token=None, guard=ApprovalGuardrail(),
    )
    assert outcome["status"] == "confirmation_required"
    assert executed == []
