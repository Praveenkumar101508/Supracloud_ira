"""commands/planner.py — the plan shown to the owner BEFORE anything runs.

A plan is honest paperwork: intent, target, the concrete steps, what it
touches, the risk verdict. The API returns it verbatim and the UI renders it;
for anything above low risk the owner approves this exact plan.
"""
from __future__ import annotations

from commands.risk import classify

_STEPS: dict[str, list[str]] = {
    "create_project": [
        "Create a local project record",
        "Create the project folder with a notes.md",
        "Save a project memory to the Memory Vault",
    ],
    "create_private_database": [
        "Create a local-only Postgres database for the project",
        "Create a project-specific database user with a generated strong password",
        "Write credentials to a chmod-600 file under the local secrets dir (never committed, never logged)",
        "Save database metadata (no secrets) to the Memory Vault",
    ],
    "create_project_folder": [
        "Create the project folder under the local projects dir",
        "Create a notes.md inside it",
    ],
    "save_memory": ["Save the text as a Memory Vault entry (data, not instructions)"],
    "open_panel": ["Tell the UI to switch to the requested panel (no side effects)"],
    "create_backup": ["Run the existing local database backup job"],
    "check_system_status": ["Probe Postgres, Redis and Ollama locally and report"],
    "grant_access_request": [
        "NOT executed here: open the Grant Access wizard",
        "The wizard requires your owner password, the person's own new credentials, and a final confirmation",
    ],
    "relationship_memory_request": [
        "Route to the relationship confirm-flow",
        "IRA asks before saving; saved people get no system access",
    ],
    "update_project_config": ["Append the change to the project's local config notes"],
    "unknown": ["Ask a clarifying question — never guess an execution"],
}

_TOUCHES: dict[str, list[str]] = {
    "create_project": ["projects table", "projects dir"],
    "create_private_database": ["local Postgres", "local secrets dir"],
    "create_project_folder": ["projects dir"],
    "save_memory": ["memory_embeddings table"],
    "open_panel": [],
    "create_backup": ["backup dir"],
    "check_system_status": [],
    "grant_access_request": ["(wizard) delegated_users table, audit log"],
    "relationship_memory_request": ["(confirm-flow) people table"],
    "update_project_config": ["projects dir"],
    "unknown": [],
}


def build_plan(intent: str, params: dict) -> dict:
    verdict = classify(intent)
    target = (
        params.get("project") or params.get("name") or params.get("panel")
        or params.get("person_name") or ""
    )
    return {
        "intent": intent,
        "target": target,
        "steps": _STEPS.get(intent, _STEPS["unknown"]),
        "touches": _TOUCHES.get(intent, []),
        "risk": verdict["risk"],
        "confirmation_required": verdict["confirmation_required"],
        "password_required": verdict["password_required"],
        "blocked": verdict["blocked"],
        "auto_execute": verdict["auto_execute"],
    }


__all__ = ["build_plan"]
