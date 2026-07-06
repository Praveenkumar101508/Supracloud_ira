"""Delegated access endpoints (PR #67) — /api/v1/access.

POST /access/grant   — create an account for a person (wizard backend)
POST /access/revoke  — deactivate a delegated account
POST /access/role    — change a delegated account's role
GET  /access/users   — list delegated accounts
GET  /access/audit   — access-change audit log

Access is a SECURITY EVENT, so every mutating endpoint stacks four gates:
  1. owner session (require_auth + is_owner — delegated users are 403 here
     and the scope middleware denies them earlier anyway);
  2. the OWNER'S PASSWORD, re-verified with no DEV_MODE bypass — a session
     token or a voice command alone can never grant access;
  3. channel check — requests marked as voice-originated are refused outright;
  4. a one-time confirmation token (the same guardrail as every destructive
     action) so the owner sees exactly what will happen before it does.

The primary owner (the .env admin account) is untouchable: never listed as
grantable, never revocable, never demotable. Every attempt — allowed or
denied — is written to the audit log.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware.auth import require_auth, is_owner
from security import delegated as _del
from security.roles import GRANTABLE_ROLES, scopes_for
from security.scope_enforcer import invalidate_role_cache
from utils.approval import owner_gated_action

router = APIRouter(prefix="/access", tags=["access"])


def _require_owner(user: str) -> None:
    if not is_owner(user):
        raise HTTPException(status_code=403, detail="Access management is restricted to the primary owner.")


async def _require_owner_password(user: str, password: str, action: str, target: str) -> None:
    """Gate 2: the owner's password, re-verified. Failures are audited."""
    if not _del.verify_owner_password(password):
        await _del.audit(user, f"{action}_denied", target, reason="owner password check failed")
        raise HTTPException(
            status_code=403,
            detail="Owner password confirmation failed. Access changes always require your password.",
        )


def _refuse_voice_channel(channel: str) -> None:
    """Gate 3: voice can ASK for access, but the flow itself must run from a
    logged-in UI/API session with the password typed — never from the mic."""
    if (channel or "").strip().lower() == "voice":
        raise HTTPException(
            status_code=403,
            detail="Access changes cannot be completed by voice. "
                   "Please finish this in the IRA app with your owner password.",
        )


class GrantBody(BaseModel):
    person_id: uuid.UUID | None = Field(None, description="Existing relationship record to link")
    person_name: str = Field(..., min_length=1, max_length=60)
    role: str = Field(..., description=f"One of: {', '.join(GRANTABLE_ROLES)}")
    new_username: str = Field(..., min_length=3, max_length=32)
    new_password: str = Field(..., min_length=8, max_length=128,
                              description="Chosen BY the new person — their own credential")
    owner_password: str = Field(..., min_length=1)
    channel: str = Field("ui", description="Origin of this request; 'voice' is refused")
    confirm_token: str | None = None


class RevokeBody(BaseModel):
    user_id: uuid.UUID
    owner_password: str = Field(..., min_length=1)
    channel: str = "ui"
    confirm_token: str | None = None


class RoleBody(BaseModel):
    user_id: uuid.UUID
    role: str
    owner_password: str = Field(..., min_length=1)
    channel: str = "ui"
    confirm_token: str | None = None


def _map_outcome(outcome: dict):
    if outcome["status"] == "forbidden":
        raise HTTPException(status_code=403, detail=outcome["detail"])
    if outcome["status"] in ("expired", "not_found"):
        raise HTTPException(status_code=409, detail=outcome["detail"])
    if outcome["status"] == "executed":
        return outcome["result"]
    return outcome  # confirmation_required


@router.post("/grant")
async def grant_access(body: GrantBody, _user: str = Depends(require_auth)):
    """Create a delegated account for a person (the wizard's final step)."""
    _require_owner(_user)
    _refuse_voice_channel(body.channel)
    await _require_owner_password(_user, body.owner_password, "access_grant", body.new_username)

    try:
        role = _del.validate_grantable_role(body.role)
        username = _del.validate_new_username(body.new_username)
        _del.validate_new_password(body.new_password)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if await _del.get_delegated_user(username):
        raise HTTPException(status_code=409, detail=f"An account named {username!r} already exists.")

    person_id = body.person_id
    person_name = body.person_name.strip()
    new_password = body.new_password  # captured for the draft closure; never logged

    async def _do():
        user = await _del.create_delegated_user(
            username=username, password=new_password, role=role, person_id=person_id,
        )
        if person_id is not None:
            from memory.relationships import set_access_level_internal
            await set_access_level_internal(person_id, role)
        await _del.audit(_user, "access_granted", username, role=role, person=person_name)
        invalidate_role_cache(username)
        return {"granted": user,
                "detail": f"{person_name} now has a separate account ({username}, role {role}). "
                          "They log in with their own password; yours was never shared."}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="grant_access",
        preview=(f"Grant {person_name} the role {role!r} via new account {username!r}? "
                 f"Scopes: {', '.join(sorted(scopes_for(role)))}. "
                 "They set their own password; they can never remove or replace you."),
        execute=_do, confirm_token=body.confirm_token,
    )
    if outcome["status"] == "confirmation_required":
        await _del.audit(_user, "access_grant_requested", username, role=role, person=person_name)
    return _map_outcome(outcome)


@router.post("/revoke")
async def revoke_access(body: RevokeBody, _user: str = Depends(require_auth)):
    """Deactivate a delegated account. The primary owner cannot be revoked."""
    _require_owner(_user)
    _refuse_voice_channel(body.channel)
    await _require_owner_password(_user, body.owner_password, "access_revoke", str(body.user_id))

    target = next((u for u in await _del.list_delegated_users() if u["id"] == str(body.user_id)), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Delegated account not found.")
    if target["is_primary_owner"] or _del.is_primary_owner_username(target["username"]):
        await _del.audit(_user, "access_revoke_denied", target["username"],
                         reason="primary owner cannot be revoked")
        raise HTTPException(status_code=403, detail="The primary owner can never be removed.")

    async def _do():
        revoked = await _del.revoke_delegated_user(body.user_id)
        await _del.audit(_user, "access_revoked", target["username"])
        invalidate_role_cache(target["username"])
        return {"revoked": revoked}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="revoke_access",
        preview=f"Revoke {target['username']!r} (role {target['role']})? "
                "Their sessions stop working within moments.",
        execute=_do, confirm_token=body.confirm_token,
    )
    return _map_outcome(outcome)


@router.post("/role")
async def change_role(body: RoleBody, _user: str = Depends(require_auth)):
    """Change a delegated account's role. primary_owner is never assignable."""
    _require_owner(_user)
    _refuse_voice_channel(body.channel)
    await _require_owner_password(_user, body.owner_password, "role_change", str(body.user_id))

    try:
        role = _del.validate_grantable_role(body.role)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    target = next((u for u in await _del.list_delegated_users() if u["id"] == str(body.user_id)), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Delegated account not found.")
    if target["is_primary_owner"] or _del.is_primary_owner_username(target["username"]):
        await _del.audit(_user, "role_change_denied", target["username"],
                         reason="primary owner role is fixed")
        raise HTTPException(status_code=403, detail="The primary owner's role can never be changed.")

    async def _do():
        changed = await _del.change_delegated_role(body.user_id, role)
        await _del.audit(_user, "role_changed", target["username"],
                         old_role=target["role"], new_role=role)
        invalidate_role_cache(target["username"])
        return {"user": changed}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="change_role",
        preview=f"Change {target['username']!r} from {target['role']} to {role}?",
        execute=_do, confirm_token=body.confirm_token,
    )
    return _map_outcome(outcome)


@router.get("/users")
async def list_users(_user: str = Depends(require_auth)):
    _require_owner(_user)
    users = await _del.list_delegated_users()
    return {"users": users, "count": len(users)}


@router.get("/audit")
async def audit_log(limit: int = Query(100, ge=1, le=500), _user: str = Depends(require_auth)):
    _require_owner(_user)
    entries = await _del.list_audit_log(limit)
    return {"entries": entries, "count": len(entries)}
