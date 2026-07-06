"""
ira/owner_profile.py — the owner's "who I am" profile store.

A single, overwrite-in-place record (Postgres = business data) holding the owner's
name, goals, current projects, and preferences. A compact summary is injected into
the brain's context on every chat turn so IRA stays grounded in who it serves — this
is distinct from conversational recall, which Cortex owns (project rule 5).

PR #66 extends the record with first-run onboarding + identity fields: how IRA
should address the owner (preferred_title, e.g. "boss"/"sir"), the fixed
owner_admin role, whether onboarding completed, the wake word, and whether voice
was enabled during setup. The role is NOT updatable — IRA is single-owner and
destructive/outbound actions stay confirmation-gated regardless of role.

Reads degrade gracefully: if the DB is unavailable the profile is treated as empty
so a chat turn is never broken by a missing/locked profile row.
"""
from __future__ import annotations

from typing_extensions import TypedDict  # pydantic <3.12 requires this variant

from utils.db import acquire

# Free-text columns accepted by update_profile.
FIELDS = ("name", "goals", "projects", "preferences", "preferred_title", "wake_word")
# Boolean columns accepted by update_profile.
BOOL_FIELDS = ("first_run_completed", "voice_enabled")
# Read-only columns: exposed on reads, never writable through update_profile.
# `role` is fixed at 'owner_admin' — there is exactly one owner and no role can
# bypass approval gates, so allowing writes would only invite confusion.
READONLY_FIELDS = ("role",)

# Keep free-text fields bounded so a runaway payload can't bloat the prompt.
_MAX_TEXT_LEN = 2000


class OwnerProfile(TypedDict):
    name: str
    goals: str
    projects: str
    preferences: str
    preferred_title: str
    wake_word: str
    role: str
    first_run_completed: bool
    voice_enabled: bool


_EMPTY: OwnerProfile = {
    "name": "",
    "goals": "",
    "projects": "",
    "preferences": "",
    "preferred_title": "",
    "wake_word": "ira",
    "role": "owner_admin",
    "first_run_completed": False,
    "voice_enabled": False,
}


async def get_profile() -> OwnerProfile:
    """Return the single owner-profile record, or an empty profile if unset/unavailable."""
    try:
        async with acquire() as conn:
            row = await conn.fetchrow(
                "SELECT name, goals, projects, preferences, preferred_title, wake_word, "
                "role, first_run_completed, voice_enabled "
                "FROM owner_profile WHERE id IS TRUE"
            )
    except Exception:
        return dict(_EMPTY)  # DB down / not migrated yet -> never break the turn
    if not row:
        return dict(_EMPTY)
    out: dict = {}
    for key, default in _EMPTY.items():
        val = row[key] if key in row.keys() else None
        if isinstance(default, bool):
            out[key] = bool(val)
        else:
            # Empty wake_word/role fall back to their non-empty defaults.
            out[key] = val or default
    return out  # type: ignore[return-value]


async def update_profile(**fields) -> OwnerProfile:
    """Overwrite-in-place the single owner-profile record; return the new state.

    Only known FIELDS/BOOL_FIELDS are written; unknown keys (including `role`)
    are ignored. Ensures the singleton row exists first so a partial update
    always lands.
    """
    updates: dict = {}
    for k, v in fields.items():
        if k in FIELDS:
            updates[k] = ("" if v is None else str(v))[:_MAX_TEXT_LEN]
        elif k in BOOL_FIELDS:
            updates[k] = bool(v)
    async with acquire() as conn:
        await conn.execute(
            "INSERT INTO owner_profile (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING"
        )
        if updates:
            set_clause = ", ".join(f"{col} = ${i}" for i, col in enumerate(updates, start=1))
            await conn.execute(
                f"UPDATE owner_profile SET {set_clause}, updated_at = NOW() WHERE id IS TRUE",
                *updates.values(),
            )
    return await get_profile()


async def complete_onboarding(
    *,
    owner_name: str,
    preferred_title: str = "",
    wake_word: str = "ira",
    voice_enabled: bool = False,
) -> OwnerProfile:
    """Persist the first-run setup choices and mark onboarding complete.

    first_run_completed flips to True only here — i.e. only once the wizard has
    actually finished — so an interrupted setup shows the wizard again.
    """
    return await update_profile(
        name=owner_name,
        preferred_title=preferred_title,
        wake_word=wake_word or "ira",
        voice_enabled=voice_enabled,
        first_run_completed=True,
    )


async def reset_onboarding() -> OwnerProfile:
    """Clear the first-run flag so the setup wizard runs again (testing/support)."""
    return await update_profile(first_run_completed=False)


def summarize(profile: OwnerProfile) -> str:
    """Compact one-block summary for prompt injection; '' when nothing is set."""
    labels = (
        ("name", "Name"),
        ("goals", "Goals"),
        ("projects", "Current projects"),
        ("preferences", "Preferences"),
    )
    parts = [f"{label}: {profile[key]}" for key, label in labels if profile.get(key)]
    title = str(profile.get("preferred_title") or "").strip()
    if title:
        parts.append(
            f"Preferred address: the owner likes being called '{title}'. Use it naturally — "
            "e.g. when greeting, confirming, or flagging something important — "
            "not in every sentence."
        )
    if not parts:
        return ""
    return "Owner profile —\n" + "\n".join(parts)


async def get_profile_summary() -> str:
    """Convenience: fetch the profile and return its compact summary ('' if empty)."""
    return summarize(await get_profile())


__all__ = [
    "OwnerProfile", "FIELDS", "BOOL_FIELDS", "READONLY_FIELDS",
    "get_profile", "update_profile", "complete_onboarding", "reset_onboarding",
    "summarize", "get_profile_summary",
]
