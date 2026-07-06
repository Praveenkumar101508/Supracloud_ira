"""PR #68 — Command Center: parser, risk engine, and the route's safety rules.

Proven here:
  - low-risk commands auto-execute; medium risk is confirmation-gated;
  - private database creation is NEVER auto (confirmation required);
  - access grants can NEVER execute here — routed to the wizard;
  - unknown text returns a clarification, never a guessed execution;
  - relationship statements route to the people confirm-flow;
  - the risk engine's NEVER_AUTO / critical rules hold;
  - secrets are not returned or logged by the database executor;
  - destructive/outbound intents stay non-auto.
"""
from __future__ import annotations

import logging
import types
from unittest.mock import AsyncMock

import pytest

from commands import risk
from commands.parser import parse_command
from commands.planner import build_plan


# ── Parser ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,intent", [
    ("create a private database for project Aurora", "create_private_database"),
    ("make a db for this project", "create_private_database"),
    ("create a new project called Aurora", "create_project"),
    ("create a notes folder for project Aurora", "create_project_folder"),
    ("remember to buy milk", "save_memory"),
    ("save a memory that this project matters", "save_memory"),
    ("open memory vault", "open_panel"),
    ("create a backup", "create_backup"),
    ("check if my app is running", "check_system_status"),
    ("update project config for Aurora", "update_project_config"),
])
def test_parser_maps_known_commands(text, intent):
    assert parse_command(text)["intent"] == intent


def test_parser_access_phrases_route_to_grant_request_first():
    for text in ("give my wife access", "grant Rahul access", "give her the same access as me"):
        assert parse_command(text)["intent"] == "grant_access_request"


def test_parser_relationship_statement_routes_to_people_flow():
    out = parse_command("remember Rahul is my cousin")
    assert out["intent"] == "relationship_memory_request"
    assert out["params"]["relationship"] == "cousin"


@pytest.mark.parametrize("text", [
    "what is the meaning of life",
    "asdfghjkl",
    "delete everything now",
    "",
])
def test_parser_unknown_text_is_unknown(text):
    assert parse_command(text)["intent"] == "unknown"


def test_parser_extracts_project_name():
    assert parse_command("create a project called Aurora")["params"]["name"] == "Aurora"
    assert parse_command(
        "create a private database for project Aurora"
    )["params"]["project"] == "Aurora"


# ── Risk engine ──────────────────────────────────────────────────────────────

def test_low_risk_intents_auto_execute():
    for intent in ("save_memory", "open_panel", "check_system_status"):
        v = risk.classify(intent)
        assert v["risk"] == "low" and v["auto_execute"] is True


def test_database_creation_is_medium_and_not_auto():
    v = risk.classify("create_private_database")
    assert v["risk"] == "medium"
    assert v["auto_execute"] is False
    assert v["confirmation_required"] is True


def test_access_grant_is_high_never_auto():
    v = risk.classify("grant_access_request")
    assert v["risk"] == "high"
    assert v["auto_execute"] is False
    assert v["password_required"] is True
    assert "grant_access_request" in risk.NEVER_AUTO


def test_never_auto_and_critical_sets():
    for intent in ("delete_data", "send_email", "external_api_enable",
                   "security_change", "role_change"):
        assert intent in risk.NEVER_AUTO
    for intent in risk.CRITICAL_INTENTS:
        v = risk.classify(intent)
        assert v["blocked"] is True and v["auto_execute"] is False


def test_unknown_intent_gets_no_execution_path():
    v = risk.classify("totally_unmapped_intent")
    assert v["auto_execute"] is False
    assert v["blocked"] is True


def test_plan_carries_steps_and_risk():
    plan = build_plan("create_private_database", {"project": "Aurora"})
    assert plan["risk"] == "medium"
    assert plan["target"] == "Aurora"
    assert any("secret" in s.lower() or "credential" in s.lower() for s in plan["steps"])


# ── Route behaviour ──────────────────────────────────────────────────────────

def _req():
    return types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))


@pytest.fixture()
def no_record(monkeypatch):
    """Stub the history writer so route tests don't need a DB."""
    import api.routes.command_center as cc
    monkeypatch.setattr(cc, "_record", AsyncMock())
    return cc


async def test_low_risk_command_auto_executes(no_record, monkeypatch):
    from api.routes.command_center import run_command, CommandBody

    saver = AsyncMock(return_value={"ok": True, "detail": "Saved."})
    monkeypatch.setattr(no_record, "save_memory", saver)

    out = await run_command(CommandBody(text="remember to call the bank"), _user="admin")
    assert out["status"] == "executed"
    saver.assert_awaited_once()


async def test_database_creation_requires_confirmation(no_record, monkeypatch):
    from api.routes.command_center import run_command, CommandBody

    creator = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(no_record, "create_private_database", creator)

    draft = await run_command(
        CommandBody(text="create a private database for project Aurora"), _user="admin"
    )
    assert draft["status"] == "awaiting_confirmation"
    assert draft["token"]
    creator.assert_not_called()                       # nothing ran without the token

    done = await run_command(
        CommandBody(text="create a private database for project Aurora",
                    confirm_token=draft["token"]),
        _user="admin",
    )
    assert done["status"] == "executed"
    creator.assert_awaited_once()


async def test_access_grant_never_executes_here(no_record):
    from api.routes.command_center import run_command, CommandBody

    out = await run_command(CommandBody(text="give my wife access"), _user="admin")
    assert out["status"] == "needs_wizard"
    assert "wizard" in out["detail"].lower() or "People" in out["detail"]


async def test_unknown_command_asks_for_clarification(no_record):
    from api.routes.command_center import run_command, CommandBody

    out = await run_command(CommandBody(text="do the thing with the stuff"), _user="admin")
    assert out["status"] == "clarification"
    assert "didn't recognise" in out["detail"] or "didn't recognize" in out["detail"]


async def test_relationship_statement_routes_to_people_flow(no_record):
    from api.routes.command_center import run_command, CommandBody

    out = await run_command(CommandBody(text="remember Rahul is my cousin"), _user="admin")
    assert out["status"] == "routed_people_flow"
    assert out["proposal"]["relationship"] == "cousin"


async def test_command_center_is_owner_only(no_record, monkeypatch):
    from fastapi import HTTPException
    from api.routes import command_center as cc
    from api.routes.command_center import run_command, CommandBody

    monkeypatch.setattr(cc, "is_owner", lambda u: False)
    with pytest.raises(HTTPException) as exc:
        await run_command(CommandBody(text="create a backup"), _user="delegate")
    assert exc.value.status_code == 403


# ── Executor: secrets are not returned or logged ─────────────────────────────

async def test_private_database_executor_does_not_leak_secret(monkeypatch, tmp_path, caplog):
    """The generated password must never appear in the return value or the logs."""
    import contextlib
    from commands import executor as ex

    captured_password = {}

    class _Conn:
        async def fetchrow(self, sql, *a):
            return None  # db + role don't exist yet
        async def execute(self, sql, *a):
            # capture whatever CREATE USER password was interpolated
            if "PASSWORD" in sql:
                captured_password["sql"] = sql

    @contextlib.asynccontextmanager
    async def fake_acquire():
        yield _Conn()

    # executor imports acquire lazily from utils.db; patch the module object
    import utils.db as _db
    monkeypatch.setattr(_db, "acquire", fake_acquire, raising=False)
    monkeypatch.setattr(ex, "_save_vault_memory", AsyncMock(return_value=True))
    monkeypatch.setattr(ex, "_projects_dir", lambda: tmp_path / "projects")
    monkeypatch.setattr(ex, "_secrets_dir", lambda: tmp_path / "secrets")

    with caplog.at_level(logging.DEBUG):
        result = await ex.create_private_database("Aurora")

    assert result["ok"] is True
    # The secret file exists with 0600 perms and holds the password...
    cred_file = tmp_path / "secrets" / "aurora.env"
    assert cred_file.exists()
    import stat
    assert stat.S_IMODE(cred_file.stat().st_mode) == 0o600
    secret_line = cred_file.read_text()
    # ...but the password is NOT in the API result...
    assert "DATABASE_URL" not in str(result)
    result_blob = str(result)
    # extract the password from the file and confirm it's absent from result + logs
    pw = secret_line.split(":")[2].split("@")[0]
    assert pw and pw not in result_blob
    assert pw not in caplog.text


async def test_check_system_status_returns_per_service(monkeypatch):
    from commands import executor as ex

    out = await ex.check_system_status()
    assert set(out["services"]) == {"database", "redis", "ollama"}
    assert "ok" in out  # honest boolean summary present
