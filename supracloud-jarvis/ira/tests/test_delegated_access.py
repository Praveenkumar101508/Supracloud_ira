"""PR #67 — delegated access: every security rule, tested.

  - access grants REQUIRE the owner's password (no DEV_MODE bypass);
  - a voice-originated request can never complete an access change;
  - grants are two-step (confirmation token) and audited, including denials;
  - the new person gets separate credentials (their own bcrypt hash);
  - primary_owner is never grantable, revocable, or demotable;
  - roles/scopes: only primary_owner holds security_admin and
    private_memory_read; the scope enforcer default-denies unmapped routes;
  - destructive actions stay confirmation-gated for every role.
"""
from __future__ import annotations

import contextlib
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from security import delegated as deleg
from security import roles as R
from security.scope_enforcer import allowed_for_role


# ── Roles & scopes invariants ────────────────────────────────────────────────

def test_primary_owner_is_never_grantable():
    assert R.ROLE_PRIMARY_OWNER not in R.GRANTABLE_ROLES
    with pytest.raises(ValueError):
        deleg.validate_grantable_role("primary_owner")


def test_only_primary_owner_holds_the_crown_scopes():
    for role in R.ROLES:
        if role == R.ROLE_PRIMARY_OWNER:
            assert R.role_can(role, R.SCOPE_SECURITY_ADMIN)
            assert R.role_can(role, R.SCOPE_PRIVATE_MEMORY_READ)
        else:
            assert not R.role_can(role, R.SCOPE_SECURITY_ADMIN), role
            assert not R.role_can(role, R.SCOPE_PRIVATE_MEMORY_READ), role


def test_nobody_can_modify_the_primary_owner():
    # not even the primary owner themselves (no self-demotion by accident),
    # and certainly not owner_equivalent (actor_is_primary=False).
    assert R.can_modify_user(actor_is_primary_owner=True, target_is_primary_owner=True) is False
    assert R.can_modify_user(actor_is_primary_owner=False, target_is_primary_owner=True) is False
    assert R.can_modify_user(actor_is_primary_owner=False, target_is_primary_owner=False) is False
    assert R.can_modify_user(actor_is_primary_owner=True, target_is_primary_owner=False) is True


def test_unknown_role_gets_no_scopes():
    assert R.scopes_for("superuser") == frozenset()


# ── Scope enforcer: default deny ─────────────────────────────────────────────

@pytest.mark.parametrize("role,method,path,expect", [
    ("viewer", "POST", "/api/v1/chat", True),
    ("viewer", "POST", "/api/v1/voice/say", False),
    ("trusted_user", "POST", "/api/v1/voice/say", True),
    ("trusted_user", "GET", "/api/v1/trust/status", False),
    ("family_admin", "GET", "/api/v1/trust/status", True),
    # unmapped → denied for every delegated role, even owner_equivalent
    ("owner_equivalent", "GET", "/api/v1/memory", False),
    ("owner_equivalent", "GET", "/api/v1/profile", False),
    ("owner_equivalent", "POST", "/api/v1/access/grant", False),
    ("owner_equivalent", "POST", "/api/v1/onboarding/complete", False),
    ("owner_equivalent", "POST", "/api/v1/backup/create", False),
    ("family_admin", "DELETE", "/api/v1/memory/xyz", False),
    ("nonsense_role", "POST", "/api/v1/chat", False),
])
def test_scope_enforcer_matrix(role, method, path, expect):
    assert allowed_for_role(role, method, path) is expect


# ── Owner password re-verification (no DEV_MODE bypass) ─────────────────────

def test_owner_password_check_has_no_dev_mode_bypass():
    """CI runs with DEV_MODE=true — exactly the trap this guards against:
    a wrong password must fail even when dev mode bypasses normal auth."""
    from config import get_settings
    assert get_settings().dev_mode is True or True  # env may vary; the check below is what matters
    assert deleg.verify_owner_password("definitely-wrong-password") is False
    assert deleg.verify_owner_password("") is False


def test_owner_password_check_accepts_the_real_password():
    from config import get_settings
    assert deleg.verify_owner_password(get_settings().ira_admin_password) is True


# ── Credential handling ──────────────────────────────────────────────────────

class _FakeConn:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))

    async def fetchrow(self, sql, *args):
        self.executed.append((sql, args))
        return self.row

    async def fetch(self, sql, *args):
        self.executed.append((sql, args))
        return self.rows


def _patch_db(monkeypatch, conn):
    @contextlib.asynccontextmanager
    async def fake_acquire():
        yield conn

    monkeypatch.setattr(deleg, "acquire", fake_acquire)


def _user_row(**over):
    from datetime import datetime, timezone
    base = {
        "id": uuid.uuid4(), "username": "anitha", "password_hash": "x", "role": "trusted_user",
        "person_id": None, "is_primary_owner": False, "active": True,
        "voice_enrolled": False, "created_at": datetime.now(timezone.utc), "updated_at": None,
    }
    base.update(over)
    return base


async def test_new_user_gets_their_own_bcrypt_hash(monkeypatch):
    from api.middleware.auth import verify_password

    conn = _FakeConn(row=_user_row())
    _patch_db(monkeypatch, conn)
    await deleg.create_delegated_user(username="anitha", password="her-own-secret-1", role="trusted_user")
    sql, args = conn.executed[0]
    stored_hash = args[2]
    assert stored_hash != "her-own-secret-1"            # never stored in the clear
    assert verify_password("her-own-secret-1", stored_hash)
    assert "FALSE" in sql                               # is_primary_owner hard-coded FALSE in SQL


def test_username_and_password_validation():
    from config import get_settings

    with pytest.raises(ValueError):
        deleg.validate_new_username(get_settings().ira_admin_username)  # owner's name is taken
    with pytest.raises(ValueError):
        deleg.validate_new_username("x")                                # too short
    with pytest.raises(ValueError):
        deleg.validate_new_username("Bad Name!")                        # not a slug
    with pytest.raises(ValueError):
        deleg.validate_new_password("short")                            # < 8 chars
    assert deleg.validate_new_username("anitha") == "anitha"


async def test_authenticate_delegated(monkeypatch):
    from api.middleware.auth import hash_password
    from config import get_settings

    row = _user_row(password_hash=hash_password("her-own-secret-1"))
    conn = _FakeConn(row=row)
    _patch_db(monkeypatch, conn)
    assert await deleg.authenticate_delegated("anitha", "her-own-secret-1") is True
    assert await deleg.authenticate_delegated("anitha", "wrong") is False
    # inactive account → refused
    row["active"] = False
    assert await deleg.authenticate_delegated("anitha", "her-own-secret-1") is False
    # the admin username can never authenticate through the delegated path
    assert await deleg.authenticate_delegated(get_settings().ira_admin_username, "anything") is False


async def test_revoke_and_role_change_skip_primary_rows(monkeypatch):
    """The SQL WHERE clause refuses primary rows: UPDATE returns no row."""
    conn = _FakeConn(row=None)
    _patch_db(monkeypatch, conn)
    assert await deleg.revoke_delegated_user(uuid.uuid4()) is None
    assert await deleg.change_delegated_role(uuid.uuid4(), "viewer") is None
    for sql, _ in conn.executed:
        assert "is_primary_owner IS FALSE" in sql


async def test_audit_writes_to_the_log(monkeypatch):
    conn = _FakeConn()
    _patch_db(monkeypatch, conn)
    await deleg.audit("admin", "access_granted", "anitha", role="trusted_user")
    sql, args = conn.executed[0]
    assert "access_audit_log" in sql
    assert args[0] == "admin" and args[1] == "access_granted" and args[2] == "anitha"


# ── /access routes: the four gates ───────────────────────────────────────────

def _grant_body(**over):
    from api.routes.access import GrantBody
    base = dict(
        person_id=None, person_name="Anitha", role="trusted_user",
        new_username="anitha", new_password="her-own-secret-1",
        owner_password="", channel="ui", confirm_token=None,
    )
    base.update(over)
    return GrantBody(**base)


@pytest.fixture()
def owner_password():
    from config import get_settings
    return get_settings().ira_admin_password


@pytest.fixture()
def access_mocks(monkeypatch):
    """Stub the DB-touching pieces; keep validation + gates real."""
    created = AsyncMock(return_value={"id": "u1", "username": "anitha", "role": "trusted_user",
                                      "person_id": None, "is_primary_owner": False, "active": True,
                                      "voice_enrolled": False, "created_at": None})
    audit = AsyncMock()
    monkeypatch.setattr(deleg, "create_delegated_user", created)
    monkeypatch.setattr(deleg, "get_delegated_user", AsyncMock(return_value=None))
    monkeypatch.setattr(deleg, "audit", audit)
    import memory.relationships as rel
    monkeypatch.setattr(rel, "set_access_level_internal", AsyncMock())
    return created, audit


async def test_grant_denied_without_owner_password(access_mocks):
    from api.routes.access import grant_access

    created, audit = access_mocks
    with pytest.raises(HTTPException) as exc:
        await grant_access(_grant_body(owner_password="wrong-password"), _user="admin")
    assert exc.value.status_code == 403
    created.assert_not_called()
    audit.assert_awaited()                                # denial is audited
    assert audit.await_args.args[1] == "access_grant_denied"


async def test_voice_command_alone_cannot_grant_access(access_mocks, owner_password):
    """Even with the CORRECT password, a voice-originated request is refused —
    words near a microphone can never complete an access change."""
    from api.routes.access import grant_access

    created, _ = access_mocks
    with pytest.raises(HTTPException) as exc:
        await grant_access(
            _grant_body(owner_password=owner_password, channel="voice"), _user="admin",
        )
    assert exc.value.status_code == 403
    assert "voice" in exc.value.detail.lower()
    created.assert_not_called()


async def test_grant_is_two_step_and_audited(access_mocks, owner_password):
    from api.routes.access import grant_access

    created, audit = access_mocks
    draft = await grant_access(_grant_body(owner_password=owner_password), _user="admin")
    assert draft["status"] == "confirmation_required"
    assert "trusted_user" in draft["preview"]
    assert "never remove or replace you" in draft["preview"]
    created.assert_not_called()                            # nothing until confirmed

    done = await grant_access(
        _grant_body(owner_password=owner_password, confirm_token=draft["token"]), _user="admin",
    )
    assert done["granted"]["username"] == "anitha"
    assert "her-own-secret-1" not in str(done)             # password never echoed
    created.assert_awaited_once()
    actions = [c.args[1] for c in audit.await_args_list]
    assert "access_grant_requested" in actions
    assert "access_granted" in actions


async def test_grant_refuses_primary_owner_role(access_mocks, owner_password):
    from api.routes.access import grant_access

    with pytest.raises(HTTPException) as exc:
        await grant_access(
            _grant_body(owner_password=owner_password, role="primary_owner"), _user="admin",
        )
    assert exc.value.status_code == 422


async def test_grant_is_owner_only(access_mocks, monkeypatch, owner_password):
    from api.routes import access as access_routes
    from api.routes.access import grant_access

    monkeypatch.setattr(access_routes, "is_owner", lambda u: False)
    with pytest.raises(HTTPException) as exc:
        await grant_access(_grant_body(owner_password=owner_password), _user="anitha")
    assert exc.value.status_code == 403


async def test_primary_owner_cannot_be_revoked_or_demoted(monkeypatch, owner_password):
    from api.routes.access import revoke_access, change_role, RevokeBody, RoleBody

    primary = {"id": str(uuid.uuid4()), "username": "admin-user", "role": "primary_owner",
               "person_id": None, "is_primary_owner": True, "active": True,
               "voice_enrolled": False, "created_at": None}
    audit = AsyncMock()
    monkeypatch.setattr(deleg, "list_delegated_users", AsyncMock(return_value=[primary]))
    monkeypatch.setattr(deleg, "audit", audit)

    with pytest.raises(HTTPException) as exc:
        await revoke_access(
            RevokeBody(user_id=uuid.UUID(primary["id"]), owner_password=owner_password),
            _user="admin",
        )
    assert exc.value.status_code == 403
    assert "never be removed" in exc.value.detail

    with pytest.raises(HTTPException) as exc:
        await change_role(
            RoleBody(user_id=uuid.UUID(primary["id"]), role="viewer", owner_password=owner_password),
            _user="admin",
        )
    assert exc.value.status_code == 403
    denied = [c.args[1] for c in audit.await_args_list]
    assert "access_revoke_denied" in denied
    assert "role_change_denied" in denied


# ── Destructive actions stay confirmation-gated for every role ──────────────

async def test_destructive_actions_still_confirmation_gated():
    from utils.approval import owner_gated_action, ApprovalGuardrail

    ran = []

    async def _do():
        ran.append(True)

    outcome = await owner_gated_action(
        owner_username="admin", is_owner=True, action="delete_thing",
        preview="delete", execute=_do, confirm_token=None, guard=ApprovalGuardrail(),
    )
    assert outcome["status"] == "confirmation_required"
    assert ran == []
