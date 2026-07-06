"""commands/parser.py — natural command → structured intent. Parsing NEVER executes.

Deliberately conservative: fixed patterns over a fixed intent list. Anything
that doesn't match cleanly becomes intent "unknown", which the API answers
with a safe clarification — never a hallucinated execution. Order matters:
access-sounding text must hit grant_access_request BEFORE the relationship
parser can read "give my wife access" as a memory about a wife.
"""
from __future__ import annotations

import re
from typing import Optional

INTENTS = (
    "create_project",
    "create_private_database",
    "create_project_folder",
    "save_memory",
    "open_panel",
    "create_backup",
    "check_system_status",
    "grant_access_request",
    "relationship_memory_request",
    "update_project_config",
    "unknown",
)

_MAX_LEN = 500

_PANELS = {
    "memory vault": "memory", "memory": "memory",
    "dashboard": "dashboard",
    "trust console": "trust", "trust": "trust",
    "voice setup": "voice", "voice": "voice",
    "owner profile": "owner",
    "command center": "command",
    "chat": "chat",
}
_PANEL_ALT = "|".join(sorted(map(re.escape, _PANELS), key=len, reverse=True))

_NAMEISH = r"[A-Za-z0-9][A-Za-z0-9 ._'\-]{0,58}"

# Access-granting phrasings — matched FIRST and never executed by the
# command center (they only ever point at the secure wizard).
_GRANT_RE = re.compile(
    r"\b(give|grant)\b.{0,40}\baccess\b"
    r"|\bset\s*up\b.{0,40}\bas an? (user|admin)\b"
    r"|\bsame access as me\b",
    re.IGNORECASE,
)

_DB_RE = re.compile(
    r"\b(create|make|set\s*up)\b.{0,30}\b(private|local)?\s*(database|db)\b", re.IGNORECASE)
_PROJECT_NAME_RE = re.compile(
    rf"\bproject\s+(?:called|named)\s+(?P<name>{_NAMEISH})", re.IGNORECASE)
_CREATE_PROJECT_RE = re.compile(
    r"\b(create|make|start)\b.{0,20}\b(new\s+)?project\b", re.IGNORECASE)
_FOLDER_RE = re.compile(
    r"\b(create|make)\b.{0,20}\b(notes?\s+)?folder\b", re.IGNORECASE)
_MEMORY_RE = re.compile(
    r"^\s*(?:ira[,:]?\s+)?(?:remember|save (?:a )?memory|add (?:a )?memory)\b[,:]?\s*(?:that\s+)?(?P<content>.+)$",
    re.IGNORECASE | re.DOTALL,
)
_OPEN_RE = re.compile(
    rf"\bopen\b.{{0,15}}\b(?P<panel>{_PANEL_ALT})\b", re.IGNORECASE)
_BACKUP_RE = re.compile(r"\b(create|make|run|take)\b.{0,15}\bbackup\b", re.IGNORECASE)
_STATUS_RE = re.compile(
    r"\b(system|app|ira)\b.{0,25}\b(status|running|up|healthy)\b"
    r"|\bcheck\b.{0,20}\b(system|status|running)\b",
    re.IGNORECASE,
)
_CONFIG_RE = re.compile(r"\b(update|change)\b.{0,20}\bproject config", re.IGNORECASE)


def _clean(text: str) -> str:
    return "".join(ch for ch in (text or "") if ch.isprintable()).strip()[:_MAX_LEN]


def _project_name(text: str) -> Optional[str]:
    m = _PROJECT_NAME_RE.search(text)
    if m:
        return m.group("name").strip()
    m = re.search(rf"\bfor\s+(?:the\s+)?project\s+(?P<name>{_NAMEISH})", text, re.IGNORECASE)
    if m:
        return m.group("name").strip()
    return None


def parse_command(text: str) -> dict:
    """Return {"intent": ..., "params": {...}}. Never raises, never executes."""
    cleaned = _clean(text)
    if not cleaned:
        return {"intent": "unknown", "params": {}}

    # 1. Access requests FIRST — these can only ever route to the wizard.
    if _GRANT_RE.search(cleaned):
        return {"intent": "grant_access_request", "params": {"statement": cleaned}}

    # 2. Relationship statements ("remember Rahul is my cousin") go to the
    #    people confirm-flow, not the generic memory store.
    from memory.relationships import parse_statement

    rel = parse_statement(cleaned)
    if rel is not None:
        return {"intent": "relationship_memory_request",
                "params": {"statement": cleaned, **rel}}

    if _DB_RE.search(cleaned):
        return {"intent": "create_private_database",
                "params": {"project": _project_name(cleaned)}}

    # Folder before create_project: "create a notes folder for project X" would
    # otherwise be read as "create … project".
    if _FOLDER_RE.search(cleaned):
        return {"intent": "create_project_folder",
                "params": {"project": _project_name(cleaned)}}

    if _CREATE_PROJECT_RE.search(cleaned):
        return {"intent": "create_project", "params": {"name": _project_name(cleaned)}}

    if _CONFIG_RE.search(cleaned):
        return {"intent": "update_project_config",
                "params": {"project": _project_name(cleaned), "note": cleaned}}

    if _BACKUP_RE.search(cleaned):
        return {"intent": "create_backup", "params": {}}

    m = _OPEN_RE.search(cleaned)
    if m:
        return {"intent": "open_panel", "params": {"panel": _PANELS[m.group("panel").lower()]}}

    if _STATUS_RE.search(cleaned):
        return {"intent": "check_system_status", "params": {}}

    m = _MEMORY_RE.match(cleaned)
    if m and m.group("content").strip():
        return {"intent": "save_memory", "params": {"content": m.group("content").strip()}}

    return {"intent": "unknown", "params": {"statement": cleaned}}


__all__ = ["INTENTS", "parse_command"]
