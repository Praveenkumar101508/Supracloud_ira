"""Owner profile endpoints — read/update the brain's "who I am" record.

GET  /api/v1/profile  -> the current owner profile
PUT  /api/v1/profile  -> overwrite-in-place (partial updates allowed)

The profile is small business data (Postgres) injected into every chat turn; see
ira/owner_profile.py. PR #66 adds the identity/onboarding fields (preferred_title,
wake_word, voice_enabled). `role` and `first_run_completed` are read-only here:
role is fixed to owner_admin, and the first-run flag is owned by the
/onboarding endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from api.middleware.auth import require_auth
import owner_profile as _profile

router = APIRouter(prefix="/profile", tags=["profile"])


class ProfileBody(BaseModel):
    name: str | None = None
    goals: str | None = None
    projects: str | None = None
    preferences: str | None = None
    preferred_title: str | None = Field(None, max_length=40)
    wake_word: str | None = Field(None, max_length=24)
    voice_enabled: bool | None = None


@router.get("")
async def get_owner_profile(_user: str = Depends(require_auth)) -> _profile.OwnerProfile:
    return await _profile.get_profile()


@router.put("")
async def put_owner_profile(
    body: ProfileBody,
    _user: str = Depends(require_auth),
) -> _profile.OwnerProfile:
    # Only send provided fields so omitted ones keep their current value.
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    return await _profile.update_profile(**fields)
