"""security/delegated.py — delegated user accounts + audit log (PR #67).

Backs the secure access wizard. Hard rules enforced at this layer:

  - Creating/changing/revoking access ALWAYS requires the owner's password,
    re-verified here with NO DEV_MODE bypass (verify_owner_password) — a live
    session token, or words spoken near a microphone, are never enough.
  - Every new person gets their OWN account with their OWN bcrypt-hashed
    password. The owner's credentials are never shared or returned.
  - The primary owner is the .env admin account. It is never stored in
    delegated_users, never grantable, and no function here can touch it.
  - Every grant / revoke / role change / denied attempt lands in
    access_audit_log.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Optional

from config import get_settings
from security.roles import GRANTABLE_ROLES
from utils.db import acquire

logger = logging.getLogger("ira.delegated")

_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_\-.]{2,31}$")
_MIN_PASSWORD_LEN = 8


# ── Owner password re-verification (never bypassed) ─────────────────────────

def verify_owner_password(password: str) -> bool:
    """Constant-time check of the OWNER's password for security-sensitive flows.

    Deliberately ignores DEV_MODE: granting access is a security event even on
    a dev box, and a voice/UI session must never stand in for the password.
    """
    from api.middleware.auth import verify_password, _admin_password_hash

    if not password:
        return False
    try:
        return verify_password(password, _admin_password_hash())
    except Exception:  # unknown hash error → fail closed
        return False


def is_primary_owner_username(username: str) -> bool:
    """The primary owner is exactly the configured admin account."""
    try:
        return (username or "") == get_settings().ira_admin_username
    except Exception:
        return False


# ── Validation helpers ───────────────────────────────────────────────────────

def validate_new_username(username: str) -> str:
    username = (username or "").strip().lower()
    if not _USERNAME_RE.match(username):
        raise ValueError(
            "username must be 3-32 chars: lowercase letters, digits, '.', '-' or '_'"
        )
    if is_primary_owner_username(username):
        raise ValueError("that username belongs to the primary owner")
    return username


def validate_new_password(password: str) -> str:
    if not password or len(password) < _MIN_PASSWORD_LEN:
        raise ValueError(f"the new user's password must be at least {_MIN_PASSWORD_LEN} characters")
    return password


def validate_grantable_role(role: str) -> str:
    role = (role or "").strip().lower()
    if role not in GRANTABLE_ROLES:
        raise ValueError(
            f"role must be one of {', '.join(GRANTABLE_ROLES)} — primary_owner is never grantable"
        )
    return role


# ── Account store ────────────────────────────────────────────────────────────

def _row_out(row) -> dict:
    """Public shape — the password hash NEVER leaves this module."""
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "role": row["role"],
        "person_id": str(row["person_id"]) if row["person_id"] else None,
        "is_primary_owner": bool(row["is_primary_owner"]),
        "active": bool(row["active"]),
        "voice_enrolled": bool(row["voice_enrolled"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def create_delegated_user(
    *, username: str, password: str, role: str, person_id: Optional[uuid.UUID] = None
) -> dict:
    """Create a delegated account with its own bcrypt hash. Never primary owner."""
    from api.middleware.auth import hash_password

    username = validate_new_username(username)
    password = validate_new_password(password)
    role = validate_grantable_role(role)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO delegated_users
                   (id, username, password_hash, role, person_id, is_primary_owner)
               VALUES ($1, $2, $3, $4, $5, FALSE)
               RETURNING *""",
            uuid.uuid4(), username, hash_password(password), role, person_id,
        )
    return _row_out(row)


async def get_delegated_user(username: str) -> Optional[dict]:
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM delegated_users WHERE username = $1", (username or "").lower()
        )
    return _row_out(row) if row else None


async def list_delegated_users() -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch("SELECT * FROM delegated_users ORDER BY created_at DESC")
    return [_row_out(r) for r in rows]


async def authenticate_delegated(username: str, password: str) -> bool:
    """Password check for a delegated account (login fallback after the admin
    check). Inactive accounts and the admin username always fail here."""
    from api.middleware.auth import verify_password

    username = (username or "").strip().lower()
    if not username or not password or is_primary_owner_username(username):
        return False
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT password_hash, active FROM delegated_users WHERE username = $1",
                username,
            )
    except Exception:
        return False  # DB down → fail closed
    if not row or not row["active"]:
        return False
    try:
        return verify_password(password, row["password_hash"])
    except Exception:
        return False


async def get_delegated_role(username: str) -> Optional[str]:
    """Role for an ACTIVE delegated account, else None (fail closed)."""
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT role, active FROM delegated_users WHERE username = $1",
                (username or "").lower(),
            )
    except Exception:
        return None
    if not row or not row["active"]:
        return None
    return row["role"]


async def revoke_delegated_user(user_id: uuid.UUID) -> Optional[dict]:
    """Deactivate an account. Refuses primary-owner rows at the SQL level too."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE delegated_users SET active = FALSE, updated_at = NOW()
               WHERE id = $1 AND is_primary_owner IS FALSE
               RETURNING *""",
            user_id,
        )
    return _row_out(row) if row else None


async def change_delegated_role(user_id: uuid.UUID, role: str) -> Optional[dict]:
    """Change a delegated account's role. primary_owner is not assignable and
    primary-owner rows are untouchable (WHERE clause)."""
    role = validate_grantable_role(role)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE delegated_users SET role = $2, updated_at = NOW()
               WHERE id = $1 AND is_primary_owner IS FALSE
               RETURNING *""",
            user_id, role,
        )
    return _row_out(row) if row else None


# ── Audit log ────────────────────────────────────────────────────────────────

async def audit(actor: str, action: str, target: str = "", **details) -> None:
    """Record an access change (or denied attempt). Fail-soft: auditing must
    never break the flow, but failures are logged loudly."""
    import json

    try:
        async with acquire() as conn:
            await conn.execute(
                """INSERT INTO access_audit_log (actor, action, target, details)
                   VALUES ($1, $2, $3, $4::jsonb)""",
                (actor or "")[:80], (action or "")[:80], (target or "")[:120],
                json.dumps({k: str(v)[:200] for k, v in details.items()}),
            )
    except Exception as e:  # noqa: BLE001
        logger.error("access audit write FAILED (%s %s→%s): %s", actor, action, target, e)


async def list_audit_log(limit: int = 100) -> list[dict]:
    async with acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM access_audit_log ORDER BY created_at DESC LIMIT $1", limit
        )
    out = []
    for r in rows:
        details = r["details"]
        if isinstance(details, str):
            import json
            try:
                details = json.loads(details)
            except ValueError:
                details = {}
        out.append({
            "id": r["id"],
            "actor": r["actor"],
            "action": r["action"],
            "target": r["target"],
            "details": details or {},
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        })
    return out


__all__ = [
    "verify_owner_password", "is_primary_owner_username",
    "validate_new_username", "validate_new_password", "validate_grantable_role",
    "create_delegated_user", "get_delegated_user", "list_delegated_users",
    "authenticate_delegated", "get_delegated_role",
    "revoke_delegated_user", "change_delegated_role",
    "audit", "list_audit_log",
]
