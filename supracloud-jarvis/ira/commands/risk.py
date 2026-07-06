"""commands/risk.py — the risk engine: how much friction before execution.

  low       reversible, local, additive          → auto-execute
  medium    changes local system state           → confirmation token
  high      security / destructive / outbound    → owner password + confirmation
  critical  catastrophic                         → blocked outright

Two rules are structural, not configurable:
  - access grants, deletions, external-API use, email sending, security and
    role changes can NEVER auto-execute (NEVER_AUTO);
  - grant_access_request additionally never executes here at all — the
    command center only points at the delegated-access wizard, which has its
    own password + confirmation gates (PR #67).
"""
from __future__ import annotations

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"
RISK_CRITICAL = "critical"

RISK_LEVELS = (RISK_LOW, RISK_MEDIUM, RISK_HIGH, RISK_CRITICAL)

INTENT_RISK: dict[str, str] = {
    # low — reversible, additive, read-only
    "save_memory": RISK_LOW,
    "open_panel": RISK_LOW,
    "check_system_status": RISK_LOW,
    "relationship_memory_request": RISK_LOW,   # its own confirm flow does the gating
    # medium — creates/changes local system state
    "create_project": RISK_MEDIUM,
    "create_project_folder": RISK_MEDIUM,
    "create_private_database": RISK_MEDIUM,
    "update_project_config": RISK_MEDIUM,
    "create_backup": RISK_MEDIUM,
    # high — security-sensitive; never auto
    "grant_access_request": RISK_HIGH,
}

# Intents that may NEVER auto-execute regardless of any future re-mapping.
NEVER_AUTO = frozenset({
    "grant_access_request",     # access grants
    "delete_data",              # deletions            (reserved for future intents)
    "send_email",               # outbound email       (reserved)
    "external_api_enable",      # external API use     (reserved)
    "security_change",          # security settings    (reserved)
    "role_change",              # role changes         (reserved)
})

# Reserved catastrophic intents: blocked until explicitly implemented WITH
# their own protection. Nothing maps to these today.
CRITICAL_INTENTS = frozenset({"wipe_data", "remove_owner", "expose_secrets"})


def classify(intent: str) -> dict:
    """Risk verdict for an intent. Unknown intents get NO execution path."""
    if intent in CRITICAL_INTENTS:
        return {"risk": RISK_CRITICAL, "auto_execute": False,
                "confirmation_required": True, "password_required": True, "blocked": True}
    risk = INTENT_RISK.get(intent)
    if risk is None:  # unknown / unmapped → never executable
        return {"risk": RISK_HIGH, "auto_execute": False,
                "confirmation_required": True, "password_required": True, "blocked": True}
    auto = risk == RISK_LOW and intent not in NEVER_AUTO
    return {
        "risk": risk,
        "auto_execute": auto,
        "confirmation_required": not auto,
        "password_required": risk in (RISK_HIGH, RISK_CRITICAL),
        "blocked": False,
    }


__all__ = ["RISK_LOW", "RISK_MEDIUM", "RISK_HIGH", "RISK_CRITICAL", "RISK_LEVELS",
           "INTENT_RISK", "NEVER_AUTO", "CRITICAL_INTENTS", "classify"]
