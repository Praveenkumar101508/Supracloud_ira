"""People / relationship-memory endpoints (PR #67) — /api/v1/people.

POST   /people/remember      — parse a statement; confirm-token two-step save
GET    /people               — list relationship records (owner only)
PUT    /people/{id}          — edit the relationship label (owner only)
DELETE /people/{id}          — forget a person (owner + confirmation gated)

Remembering is easy; access is not: nothing in this router can change an
access level. A saved person is always no_access — granting anything goes
through /api/v1/access with the owner's password.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware.auth import require_auth, is_owner
from memory import relationships as _rel
from utils.approval import owner_gated_action

router = APIRouter(prefix="/people", tags=["people"])


def _owner_only(user: str) -> None:
    if not is_owner(user):
        raise HTTPException(status_code=403, detail="Relationship memory is owner-only.")


class RememberBody(BaseModel):
    statement: str = Field(..., min_length=1, max_length=400,
                           description='e.g. "Remember Rahul is my cousin"')
    person_name: str | None = Field(None, max_length=60,
                                    description='Name, when the statement used a pronoun ("this is my wife")')
    confirm_token: str | None = Field(None, description="Omit to receive a confirmation draft")


class UpdateRelationshipBody(BaseModel):
    relationship: str = Field(..., max_length=40)


@router.post("/remember")
async def remember_person(body: RememberBody, _user: str = Depends(require_auth)):
    """Two-step save: parse → confirmation draft → (with token) store.

    Without a confirm_token nothing is written — the response carries the
    draft ("Should I remember NAME as your RELATIONSHIP?"). Pronoun statements
    without a name ask for the name first instead of guessing.
    """
    _owner_only(_user)
    proposal = _rel.parse_statement(body.statement)
    if proposal is None:
        return {
            "status": "no_match",
            "detail": "That doesn't look like a relationship statement I can store.",
        }

    name = (body.person_name or proposal["person_name"] or "").strip()
    if not name:
        return {
            "status": "needs_name",
            "relationship": proposal["relationship"],
            "detail": f"Who should I remember as your {proposal['relationship']}? "
                      "Repeat the request with their name.",
        }

    relationship = proposal["relationship"]

    async def _do():
        person = await _rel.save_person(person_name=name, relationship=relationship)
        return {"saved": person,
                "detail": f"Remembered. {name} is your {relationship} — no system access."}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="remember_relationship",
        preview=f"Remember that {name} is your {relationship}? "
                "(Stored as data only — this grants no system access.)",
        execute=_do, confirm_token=body.confirm_token,
    )
    if outcome["status"] == "forbidden":
        raise HTTPException(status_code=403, detail=outcome["detail"])
    if outcome["status"] in ("expired", "not_found"):
        raise HTTPException(status_code=409, detail=outcome["detail"])
    if outcome["status"] == "executed":
        return outcome["result"]
    return outcome  # confirmation_required


@router.get("")
async def get_people(_user: str = Depends(require_auth)):
    _owner_only(_user)
    people = await _rel.list_people()
    return {"people": people, "count": len(people)}


@router.put("/{person_id}")
async def edit_relationship(
    person_id: uuid.UUID, body: UpdateRelationshipBody, _user: str = Depends(require_auth)
):
    _owner_only(_user)
    try:
        person = await _rel.update_relationship(person_id, body.relationship)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found.")
    return person


@router.delete("/{person_id}")
async def forget_person(
    person_id: uuid.UUID,
    confirm_token: str | None = Query(None, description="Approval token; omit to receive a draft"),
    _user: str = Depends(require_auth),
):
    """Forget a person — confirmation-gated like every destructive action."""
    _owner_only(_user)
    person = await _rel.get_person(person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found.")

    async def _do():
        await _rel.delete_person(person_id)
        return {"deleted": str(person_id)}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="forget_relationship",
        preview=f"Forget {person['person_name']} ({person['relationship']})? "
                "Any delegated account they have stays and must be revoked separately.",
        execute=_do, confirm_token=confirm_token,
    )
    if outcome["status"] == "forbidden":
        raise HTTPException(status_code=403, detail=outcome["detail"])
    if outcome["status"] in ("expired", "not_found"):
        raise HTTPException(status_code=409, detail=outcome["detail"])
    if outcome["status"] == "executed":
        return outcome["result"]
    return outcome
