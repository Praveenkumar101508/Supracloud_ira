"""Command Center endpoints (PR #68) — /api/v1/command.

POST /command          — parse → plan → risk → (auto-execute | confirmation draft)
GET  /command/history  — recent runs with honest statuses

Flow per request:  the owner's text becomes a structured intent and a visible
plan. Low-risk reversible intents run immediately. Medium risk returns the
plan plus a one-time confirmation token; resubmitting with the token executes
that exact plan. High risk additionally requires the owner password. Unknown
text gets a clarification — never a guessed execution. Access grants NEVER
execute here: they are routed to the delegated-access wizard (PR #67) with
its own password + confirmation gates. Relationship statements route to the
people confirm-flow. Every run is recorded (fail-soft) in command_runs.
"""
from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware.auth import require_auth, is_owner
from commands.parser import parse_command
from commands.planner import build_plan
from commands.executor import (
    create_backup,
    create_private_database,
    create_project,
    create_project_folder,
    check_system_status,
    open_panel,
    save_memory,
    update_project_config,
)
from utils.approval import owner_gated_action

logger = logging.getLogger("ira.command_center")

router = APIRouter(prefix="/command", tags=["command"])


class CommandBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    channel: str = Field("ui", description="Origin; informational, access grants are refused regardless")
    confirm_token: str | None = None
    owner_password: str | None = Field(None, description="Required only for high-risk commands")


def _owner_only(user: str) -> None:
    if not is_owner(user):
        raise HTTPException(status_code=403, detail="The Command Center is owner-only.")


async def _record(run_id, actor, text, parsed, plan, status, result) -> None:
    """Persist the run; fail-soft — history must never break a command."""
    try:
        from utils.db import acquire
        async with acquire() as conn:
            await conn.execute(
                """INSERT INTO command_runs (id, actor, raw_text, intent, params, plan, risk, status, result,
                                             executed_at)
                   VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb,
                           CASE WHEN $8 = 'executed' THEN NOW() ELSE NULL END)
                   ON CONFLICT (id) DO UPDATE
                       SET status = EXCLUDED.status, result = EXCLUDED.result,
                           executed_at = EXCLUDED.executed_at""",
                run_id, actor, text[:500], parsed["intent"],
                json.dumps(parsed["params"], default=str), json.dumps(plan),
                plan["risk"], status, json.dumps(result, default=str),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("command_runs write failed (non-fatal): %s", e)


async def _execute(intent: str, params: dict) -> dict:
    if intent == "create_project":
        return await create_project(params.get("name"))
    if intent == "create_private_database":
        return await create_private_database(params.get("project"))
    if intent == "create_project_folder":
        return await create_project_folder(params.get("project"))
    if intent == "save_memory":
        return await save_memory(params.get("content"))
    if intent == "open_panel":
        return await open_panel(params.get("panel"))
    if intent == "create_backup":
        return await create_backup()
    if intent == "check_system_status":
        return await check_system_status()
    if intent == "update_project_config":
        return await update_project_config(params.get("project"), params.get("note"))
    # No executor on purpose (grant_access_request & friends): refuse loudly.
    raise HTTPException(status_code=403, detail=f"{intent!r} cannot be executed by the Command Center.")


@router.post("")
async def run_command(body: CommandBody, _user: str = Depends(require_auth)):
    _owner_only(_user)
    parsed = parse_command(body.text)
    intent, params = parsed["intent"], parsed["params"]
    plan = build_plan(intent, params)
    run_id = uuid.uuid4()

    base = {"run_id": str(run_id), "plan": plan}

    # 1. Unknown → safe clarification, never a guessed execution.
    if intent == "unknown":
        result = {"detail": "I didn't recognise that as a command I can run. "
                            "Try e.g. \"create a private database for project Aurora\", "
                            "\"create a backup\", or \"open memory vault\"."}
        await _record(run_id, _user, body.text, parsed, plan, "clarification", result)
        return {**base, "status": "clarification", **result}

    # 2. Access grants NEVER execute here — wizard only (PR #67 gates).
    if intent == "grant_access_request":
        result = {"detail": "Access is a security event, so I can't do it from a plain "
                            "command. Open Memory Vault → People & Relationships → Access: "
                            "the wizard needs your owner password, the person's own new "
                            "credentials, and a final confirmation."}
        await _record(run_id, _user, body.text, parsed, plan, "needs_wizard", result)
        return {**base, "status": "needs_wizard", **result}

    # 3. Relationship statements route to the confirm-flow (people API).
    if intent == "relationship_memory_request":
        result = {"detail": "That sounds like a relationship to remember. Use "
                            "People & Relationships (or POST /api/v1/people/remember) — "
                            "I'll ask for confirmation before saving, and remembered "
                            "people get no system access.",
                  "proposal": {k: params.get(k) for k in ("person_name", "relationship", "needs_name")}}
        await _record(run_id, _user, body.text, parsed, plan, "routed_people_flow", result)
        return {**base, "status": "routed_people_flow", **result}

    # 4. Critical / unmapped → blocked outright.
    if plan["blocked"]:
        result = {"detail": f"{intent!r} is blocked by the risk engine."}
        await _record(run_id, _user, body.text, parsed, plan, "blocked", result)
        return {**base, "status": "blocked", **result}

    # 5. High risk → the owner password comes first, before any draft.
    if plan["password_required"]:
        from security.delegated import verify_owner_password
        if not verify_owner_password(body.owner_password or ""):
            raise HTTPException(
                status_code=403,
                detail="This is a high-risk command — it needs your owner password.",
            )

    # 6. Low risk → execute immediately.
    if plan["auto_execute"]:
        result = await _execute(intent, params)
        status = "executed" if result.get("ok") else "failed"
        await _record(run_id, _user, body.text, parsed, plan, status, result)
        return {**base, "status": status, "result": result}

    # 7. Medium/high → confirmation-token two-step over this exact plan.
    async def _do():
        return await _execute(intent, params)

    preview = (f"{intent} → {plan['target'] or '(no target)'} | risk {plan['risk']} | steps: "
               + "; ".join(plan["steps"]))
    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action=f"command:{intent}", preview=preview,
        execute=_do, confirm_token=body.confirm_token,
    )
    if outcome["status"] == "confirmation_required":
        await _record(run_id, _user, body.text, parsed, plan, "awaiting_confirmation",
                      {"preview": preview})
        return {**base, "status": "awaiting_confirmation",
                "token": outcome["token"], "preview": outcome["preview"],
                "expires_in": outcome["expires_in"]}
    if outcome["status"] in ("expired", "not_found"):
        raise HTTPException(status_code=409, detail=outcome["detail"])
    if outcome["status"] == "forbidden":
        raise HTTPException(status_code=403, detail=outcome["detail"])

    result = outcome["result"]
    status = "executed" if result.get("ok") else "failed"
    await _record(run_id, _user, body.text, parsed, plan, status, result)
    return {**base, "status": status, "result": result}


@router.get("/history")
async def command_history(limit: int = Query(50, ge=1, le=200), _user: str = Depends(require_auth)):
    _owner_only(_user)
    try:
        from utils.db import acquire
        async with acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM command_runs ORDER BY created_at DESC LIMIT $1", limit
            )
    except Exception:
        return {"runs": [], "count": 0, "detail": "History unavailable (database down or not migrated)."}
    runs = []
    for r in rows:
        def _j(v):
            if isinstance(v, str):
                try:
                    return json.loads(v)
                except ValueError:
                    return {}
            return v or {}
        runs.append({
            "id": str(r["id"]), "actor": r["actor"], "raw_text": r["raw_text"],
            "intent": r["intent"], "plan": _j(r["plan"]), "risk": r["risk"],
            "status": r["status"], "result": _j(r["result"]),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "executed_at": r["executed_at"].isoformat() if r["executed_at"] else None,
        })
    return {"runs": runs, "count": len(runs)}
