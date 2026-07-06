"""security/roles.py — role and permission-scope definitions (PR #67).

Single source of truth for who may do what. Two hard rules are encoded here,
not left to callers:

  1. primary_owner is ONLY the original owner (the .env admin account). It is
     never grantable, and no other role includes security_admin — so nobody
     can remove or replace the primary owner or weaken their security.
  2. Remembering a person grants nothing: relationship records default to
     ACCESS_NONE, and turning a person into a user goes through the delegated
     access wizard (owner password + confirmation), never through speech.

Destructive/outbound actions remain confirmation-gated for every role,
including primary_owner — roles gate what you may ASK for, the approval
guardrail gates what actually EXECUTES.
"""
from __future__ import annotations

# ── Roles ─────────────────────────────────────────────────────────────────────

ROLE_VIEWER = "viewer"
ROLE_TRUSTED_USER = "trusted_user"
ROLE_FAMILY_ADMIN = "family_admin"
ROLE_OWNER_EQUIVALENT = "owner_equivalent"
ROLE_PRIMARY_OWNER = "primary_owner"

ROLES = (
    ROLE_VIEWER,
    ROLE_TRUSTED_USER,
    ROLE_FAMILY_ADMIN,
    ROLE_OWNER_EQUIVALENT,
    ROLE_PRIMARY_OWNER,
)

# Roles the owner may grant to someone else. primary_owner is deliberately
# absent — there is exactly one, forever.
GRANTABLE_ROLES = (
    ROLE_VIEWER,
    ROLE_TRUSTED_USER,
    ROLE_FAMILY_ADMIN,
    ROLE_OWNER_EQUIVALENT,
)

# ── Permission scopes ────────────────────────────────────────────────────────

SCOPE_CHAT = "chat"
SCOPE_VOICE = "voice"
SCOPE_SHARED_MEMORY_READ = "shared_memory_read"
SCOPE_SHARED_MEMORY_WRITE = "shared_memory_write"
SCOPE_PRIVATE_MEMORY_READ = "private_memory_read"
SCOPE_ACTIONS_REQUEST = "actions_request"
SCOPE_ACTIONS_APPROVE = "actions_approve"
SCOPE_SETTINGS_READ = "settings_read"
SCOPE_SETTINGS_WRITE = "settings_write"
SCOPE_SECURITY_ADMIN = "security_admin"

SCOPES = (
    SCOPE_CHAT,
    SCOPE_VOICE,
    SCOPE_SHARED_MEMORY_READ,
    SCOPE_SHARED_MEMORY_WRITE,
    SCOPE_PRIVATE_MEMORY_READ,
    SCOPE_ACTIONS_REQUEST,
    SCOPE_ACTIONS_APPROVE,
    SCOPE_SETTINGS_READ,
    SCOPE_SETTINGS_WRITE,
    SCOPE_SECURITY_ADMIN,
)

# What each role may ask for. Note the two invariants:
#   - only primary_owner has security_admin (protects the owner's account),
#   - only primary_owner has private_memory_read (owner-private memories stay private).
ROLE_SCOPES: dict[str, frozenset[str]] = {
    ROLE_VIEWER: frozenset({SCOPE_CHAT}),
    ROLE_TRUSTED_USER: frozenset({SCOPE_CHAT, SCOPE_VOICE, SCOPE_SHARED_MEMORY_READ}),
    ROLE_FAMILY_ADMIN: frozenset({
        SCOPE_CHAT, SCOPE_VOICE,
        SCOPE_SHARED_MEMORY_READ, SCOPE_SHARED_MEMORY_WRITE,
        SCOPE_ACTIONS_REQUEST, SCOPE_SETTINGS_READ,
    }),
    ROLE_OWNER_EQUIVALENT: frozenset({
        SCOPE_CHAT, SCOPE_VOICE,
        SCOPE_SHARED_MEMORY_READ, SCOPE_SHARED_MEMORY_WRITE,
        SCOPE_ACTIONS_REQUEST, SCOPE_ACTIONS_APPROVE,
        SCOPE_SETTINGS_READ, SCOPE_SETTINGS_WRITE,
    }),
    ROLE_PRIMARY_OWNER: frozenset(SCOPES),
}

# ── People access levels (relationship records) ─────────────────────────────

ACCESS_NONE = "no_access"
# A person's access_level is either no_access or the role of the delegated
# account created for them through the wizard.
ACCESS_LEVELS = (ACCESS_NONE,) + GRANTABLE_ROLES


def scopes_for(role: str) -> frozenset[str]:
    """Scopes for a role; unknown roles get NO scopes (fail closed)."""
    return ROLE_SCOPES.get(role, frozenset())


def role_can(role: str, scope: str) -> bool:
    return scope in scopes_for(role)


def can_modify_user(actor_is_primary_owner: bool, target_is_primary_owner: bool) -> bool:
    """May the actor change/remove the target account?

    Nobody — not even owner_equivalent — may touch the primary owner. The
    primary owner may manage everyone else. (The API additionally restricts
    all account management to the primary owner.)
    """
    if target_is_primary_owner:
        return False
    return actor_is_primary_owner


__all__ = [
    "ROLES", "GRANTABLE_ROLES", "SCOPES", "ROLE_SCOPES", "ACCESS_LEVELS", "ACCESS_NONE",
    "ROLE_VIEWER", "ROLE_TRUSTED_USER", "ROLE_FAMILY_ADMIN", "ROLE_OWNER_EQUIVALENT",
    "ROLE_PRIMARY_OWNER",
    "SCOPE_CHAT", "SCOPE_VOICE", "SCOPE_SHARED_MEMORY_READ", "SCOPE_SHARED_MEMORY_WRITE",
    "SCOPE_PRIVATE_MEMORY_READ", "SCOPE_ACTIONS_REQUEST", "SCOPE_ACTIONS_APPROVE",
    "SCOPE_SETTINGS_READ", "SCOPE_SETTINGS_WRITE", "SCOPE_SECURITY_ADMIN",
    "scopes_for", "role_can", "can_modify_user",
]
